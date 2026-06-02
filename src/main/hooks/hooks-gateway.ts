import http from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_HOOKS_PORT,
  PORT_RETRY_COUNT,
  PORT_RETRY_OFFSET_MAX,
  RING_BUFFER_CAP,
  type RingBufferEntry,
} from './hooks-types'
import { redactHookPayload } from './hook-payload-redactor'
import { IPC } from '../../shared/ipc-channels'
import type {
  HookEvent,
  HookEventKind,
  HooksGatewayStatus,
} from '../../shared/hook-types'
// Responder registry lives in its own module so we can import it directly --
// the old lazy-require workaround for the channel-permissions circular
// dependency is no longer needed (#483).
import { registerResponder, deregisterResponder } from '../permission-responders'
import { logTrace, logWarn, logError } from '../debug-logger'

// Diagnostics (opt-in, verbose-gated): module-level in-flight counter for the
// hooks HTTP handler. Incremented on handler entry, decremented when the
// handler returns. Logged on receipt + response so a heavy parallel tool-use
// workload (ultracode) shows whether requests are piling up at the gateway.
// Metadata only -- never reflects payload contents.
let hooksInFlight = 0

// Cap the incoming HTTP body at 256 KiB. Claude Code hook payloads top out
// around a few KB; anything beyond this is either a misbehaving client or
// a local-process attack attempt. 413 back before buffering avoids memory
// pressure from a single fat request tying up the main process.
const MAX_REQUEST_BODY_BYTES = 256 * 1024

export interface HooksGatewayOptions {
  defaultPort?: number
  emit: (channel: string, payload: unknown) => void
}

interface HandleArgs {
  remoteAddress: string | undefined
  url: string | undefined
  headers: Record<string, string | string[] | undefined>
  body: string
  /**
   * Optional pre-parsed body. The live HTTP path parses the request body once
   * and threads the result through here so ingest does NOT re-parse it (the
   * body used to be JSON.parsed up to 3x per request on the single-main-thread
   * hot path). `null` means "already attempted and the body was invalid JSON".
   * Undefined (the unit-test entrypoint) falls back to parsing `body`.
   */
  parsedBody?: Record<string, unknown> | null
}

interface HandleResult {
  status: number
  body: string
}

export class HooksGateway {
  private server: http.Server | null = null
  private _status: HooksGatewayStatus = { enabled: true, listening: false, port: null }
  private defaultPort: number
  private emit: HooksGatewayOptions['emit']

  private secrets = new Map<string, string>()
  private buffers = new Map<string, RingBufferEntry[]>()
  private overflowLatched = new Set<string>()
  private subscribers = new Set<(e: HookEvent) => void>()
  private gateActive = false

  constructor(opts: HooksGatewayOptions) {
    this.defaultPort = opts.defaultPort ?? DEFAULT_HOOKS_PORT
    this.emit = opts.emit
  }

  subscribe(cb: (e: HookEvent) => void): () => void {
    this.subscribers.add(cb)
    return () => { this.subscribers.delete(cb) }
  }

  // When true, the held-open + responder path applies to EVERY PreToolUse (so the
  // tray can Allow/Deny any tool), not just Bash. Default false so a live gateway
  // with no renderer mounted to answer does not hold tool calls open for 120s.
  setPermissionGateActive(active: boolean): void { this.gateActive = active }

  // Test seam: runs the post-redaction dispatch path without HTTP.
  dispatchForTest(event: HookEvent): void { this.fanOut(event) }

  private fanOut(event: HookEvent): void {
    for (const cb of [...this.subscribers]) {
      try { cb(event) } catch { /* a bad subscriber must not break ingestion */ }
    }
  }

  status(): HooksGatewayStatus {
    return { ...this._status }
  }

  async start(): Promise<HooksGatewayStatus> {
    if (this.server) return this.status()
    this._status = { ...this._status, enabled: true }
    const port = await this.bindWithRetry(this.defaultPort)
    if (port === null) {
      this._status = {
        enabled: false,
        listening: false,
        port: null,
        error: `bind-failed after ${PORT_RETRY_COUNT} attempts`,
      }
      return this.status()
    }
    this._status = { enabled: true, listening: true, port }
    return this.status()
  }

  async stop(): Promise<void> {
    if (!this.server) {
      this._status = { ...this._status, enabled: false, listening: false, port: null }
      this.secrets.clear()
      this.buffers.clear()
      this.overflowLatched.clear()
      return
    }
    // Flip `enabled` SYNCHRONOUSLY before awaiting socket close so any
    // in-flight request that makes it through the loopback check inside
    // _handleRequestForTest short-circuits at the `!this._status.enabled`
    // guard and returns 503. Without this, a request landing during the
    // `server.close()` await window would still pass the enabled gate and
    // hit secret validation against the cleared secrets map.
    this._status = { enabled: false, listening: false, port: null }
    const s = this.server
    this.server = null
    await new Promise<void>((resolve) => s.close(() => resolve()))
    // Clear ALL per-session state so a subsequent start() (e.g. via the
    // port-change restart) doesn't carry stale buffers/latches from the
    // previous run.
    this.secrets.clear()
    this.buffers.clear()
    this.overflowLatched.clear()
  }

  registerSession(sessionId: string): string {
    const secret = randomUUID()
    this.secrets.set(sessionId, secret)
    return secret
  }

  unregisterSession(sessionId: string): void {
    this.secrets.delete(sessionId)
    this.buffers.delete(sessionId)
    this.overflowLatched.delete(sessionId)
    try {
      this.emit(IPC.HOOKS_SESSION_ENDED, sessionId)
    } catch {
      /* webContents destroyed — drop silently */
    }
  }

  getBuffer(sessionId: string): RingBufferEntry[] {
    return [...(this.buffers.get(sessionId) ?? [])]
  }

  private async bindWithRetry(startPort: number): Promise<number | null> {
    for (let i = 0; i < PORT_RETRY_COUNT; i++) {
      const candidate =
        i === 0
          ? startPort
          : startPort + Math.floor(Math.random() * PORT_RETRY_OFFSET_MAX) + 1
      try {
        const port = await this.bindOnce(candidate)
        return port
      } catch {
        /* try next */
      }
    }
    return null
  }

  private bindOnce(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleHttp(req, res).catch((err) => {
          // Diagnostics: a thrown handler error is a genuine fault -- log it
          // (always written) before producing the same 500 response as before.
          // Behavior is unchanged; only the log line is new.
          logError('[hooks] handler error', err)
          try {
            res.statusCode = 500
            res.end('{}')
          } catch {
            /* socket may be dead */
          }
        })
      })
      srv.once('error', (err) => reject(err))
      srv.listen(port, '127.0.0.1', () => {
        const addr = srv.address()
        this.server = srv
        srv.removeAllListeners('error')
        srv.on('error', () => {
          /* swallowed — don't crash app on a socket hiccup */
        })
        resolve(typeof addr === 'object' && addr ? addr.port : port)
      })
    })
  }

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Diagnostics (opt-in, verbose-gated): capture the request shape + timing
    // for every hook POST so a heavy parallel tool-use workload can be
    // diagnosed from app.log. Metadata only -- method, request path, body size,
    // in-flight count, response status, duration. NEVER the body itself.
    const startTime = Date.now()
    hooksInFlight++
    const reqMethod = req.method ?? '?'
    const reqPath = redactHookPath(req.url)
    const reqLen = headerValue(req.headers as Record<string, string | string[] | undefined>, 'content-length') ?? '?'
    logTrace(`[hooks] req method=${reqMethod} path=${reqPath} len=${reqLen} inflight=${hooksInFlight}`)
    // The response may be written synchronously here OR held open (the
    // PermissionRequest / gateActive path) and closed later by the responder
    // or the 120s timeout. Hook the response lifecycle event so the in-flight
    // decrement + response log fire EXACTLY ONCE on every exit path without
    // restructuring the control flow below (zero behavior change).
    let settled = false
    const onSettled = () => {
      if (settled) return
      settled = true
      hooksInFlight--
      const dur = Date.now() - startTime
      logTrace(`[hooks] resp path=${reqPath} status=${res.statusCode} dur=${dur}ms inflight=${hooksInFlight}`)
    }
    res.once('finish', onSettled)
    res.once('close', onSettled)
    // Send Connection: close on every response so Node's fetch client
    // doesn't put the socket back into its keep-alive pool. Pool reuse
    // surfaced as "socket connection was closed unexpectedly" errors
    // on subsequent hook POSTs when Node aged the connection out
    // between calls. Hook events are low-frequency enough that the
    // per-request handshake cost is negligible.
    res.setHeader('Connection', 'close')
    // Body-size cap: stream chunks into a running total, bail with 413
    // and destroy the socket as soon as the cap is exceeded. Avoids the
    // previous unbounded buffering path that a local process could abuse.
    const chunks: Buffer[] = []
    let total = 0
    try {
      for await (const c of req) {
        const buf = c as Buffer
        total += buf.length
        if (total > MAX_REQUEST_BODY_BYTES) {
          res.statusCode = 413
          res.setHeader('content-type', 'application/json')
          // Destroy the socket only after the 413 body has flushed, else
          // a fast client may see a reset instead of a clean 413.
          res.end('{}', () => { req.destroy() })
          return
        }
        chunks.push(buf)
      }
    } catch {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json')
      res.end('{}')
      return
    }
    const body = Buffer.concat(chunks).toString('utf-8')

    // Parse the body ONCE here and thread the result through the peek logic, the
    // requestId injection, and ingest. Every tool call in every session funnels
    // through this single main-thread server, and the body used to be JSON.parsed
    // up to three times per request (peek + requestId inject + ingest) -- pure
    // waste on the hot path. `null` => invalid JSON; ingest returns 400 for it.
    let parsedBody: Record<string, unknown> | null = null
    try { parsedBody = JSON.parse(body) as Record<string, unknown> } catch { /* ingest path returns 400 */ }

    // For held-open events (PermissionRequest, or PreToolUse while gateActive),
    // hold the HTTP response open and register a responder so a resolver can
    // write the hook decision back to the Claude Code process. gateActive is
    // never set in production (v1.5.17 genuine-only), so this path is dormant.
    // The responder is registered BEFORE ingest runs (via _handleRequestForTest)
    // to avoid a race on the auto-allow path.
    let isPermissionRequest = false
    let permissionRequestId: string | undefined
    // cleanup is defined here so the auth-fail branch (after _handleRequestForTest)
    // can call it even though it is set inside the try block below.
    let cleanup: (() => void) = () => { /* no-op until PermissionRequest block runs */ }
    if (parsedBody) {
      const peeked = parsedBody
      // Claude Code's real hook POST uses `hook_event_name` (not `event`) and
      // snake_case fields; accept both so the gateway works with the live CLI as
      // well as the spec'd PermissionRequest shape used by tests.
      const peekedEvent = typeof peeked.hook_event_name === 'string'
        ? (peeked.hook_event_name as string)
        : typeof peeked.event === 'string' ? (peeked.event as string) : undefined
      // Genuine-only (v1.5.17): CCC is no longer the permission gate. Hold a
      // PreToolUse open ONLY when gateActive is explicitly set (a dormant path
      // reserved for a possible future inline-for-high-risk feature). gateActive
      // is never flipped in production now, so every PreToolUse is fire-and-
      // forget and Claude's own settings fully decide -> no flood, no stalls.
      const isHeldOpenTool = this.gateActive && peekedEvent === 'PreToolUse'
      if (peekedEvent === 'PermissionRequest' || isHeldOpenTool) {
        isPermissionRequest = true
        const payload = peeked.payload && typeof peeked.payload === 'object'
          ? (peeked.payload as Record<string, unknown>)
          : peeked
        // Prefer Claude's real per-call id `tool_use_id`; fall back to the spec'd
        // `requestId`, then a synthetic id. Using the same field the pending card
        // derives its id from keeps the responder key and the card key in lockstep.
        const rid = typeof payload.tool_use_id === 'string'
          ? (payload.tool_use_id as string)
          : typeof payload.requestId === 'string' ? (payload.requestId as string) : undefined
        permissionRequestId = rid ?? `${String(peeked.session_id ?? peeked.sessionId ?? 'unknown')}-${Date.now()}`
        const capturedRes = res
        const capturedId = permissionRequestId
        let done = false
        cleanup = () => {
          if (done) return
          done = true
          clearTimeout(timeout)
          deregisterResponder(capturedId)
        }
        const timeout = setTimeout(() => {
          if (done) return
          done = true
          try {
            capturedRes.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' })
            capturedRes.end('{}')
          } catch { /* response already closed */ }
          deregisterResponder(capturedId)
        }, 120_000)
        timeout.unref?.()
        req.on('close', () => cleanup())
        registerResponder(capturedId, (decision) => {
          if (done) return  // timeout already fired or client aborted
          done = true
          clearTimeout(timeout)
          try {
            capturedRes.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' })
            // 'defer' -> empty 2xx body = no decision, Claude proceeds with its own
            // permission flow (used on tray overflow so the call is NOT stalled for
            // the full 120s timeout). Otherwise emit the allow/deny decision.
            capturedRes.end(decision === 'defer'
              ? '{}'
              : JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision === 'approved' ? 'allow' : 'deny' } }))
          } catch { /* response already closed; CC falls back to its own UI */ }
          // The responder entry is removed by cleanup() (on req close / 120s
          // timeout). This whole hold-open branch is dormant in prod (gateActive
          // is never set true post-v1.5.17); it remains for a possible future
          // inline-for-high-risk path.
        })
      }
    }

    // The held-open responder is keyed by `permissionRequestId`. Downstream, the
    // pending tray card derives its own id from `payload.requestId` (falling back
    // to `${sessionId}-${entry.ts}`). Claude Code's real PreToolUse hook sends NO
    // requestId, so without this both sides would invent DIFFERENT synthetic ids
    // (two separate Date.now() reads) and Allow/Deny would target a responder that
    // does not exist -> the request silently stalls until the 120s timeout. Inject
    // the resolved id into the already-parsed body so ingest -> normalizePermission
    // key the card on the SAME value we registered the responder under.
    if (isPermissionRequest && permissionRequestId && parsedBody) {
      const pl = (parsedBody.payload && typeof parsedBody.payload === 'object')
        ? (parsedBody.payload as Record<string, unknown>)
        : parsedBody
      if (pl.requestId == null) pl.requestId = permissionRequestId
    }

    const result = await this._handleRequestForTest({
      remoteAddress: req.socket.remoteAddress,
      url: req.url,
      headers: req.headers as Record<string, string | string[] | undefined>,
      body,
      parsedBody,
    })

    // Diagnostics: surface the session-match outcome. A 404 here is the
    // "unmatched / stale endpoint" misroute the user already hit -- log it as a
    // genuine warning (always written) so it's visible even outside verbose
    // mode. Path only -- never the body. Matched/other outcomes are verbose.
    const sid = parseSidFromUrl(req.url)
    if (result.status === 404) {
      logWarn(`[hooks] unmatched/stale endpoint -> 404 path=${reqPath} sid=${sid ?? 'none'}`)
    } else {
      logTrace(`[hooks] matched sid=${sid ?? 'none'} status=${result.status}`)
    }

    // For PermissionRequest events that passed auth, the response is held open
    // and will be closed by the responder or the 120s timeout above.
    if (isPermissionRequest && result.status === 200) return

    // Auth/dispatch failed for a PermissionRequest — clean up the dangling
    // responder and timeout so the Map and event loop don't leak.
    if (isPermissionRequest && result.status !== 200) cleanup()

    res.statusCode = result.status
    res.setHeader('content-type', 'application/json')
    res.end(result.body)
  }

  /**
   * Public for unit tests only. Named with _test suffix so it doesn't
   * look like intended public API.
   */
  async _handleRequestForTest(args: HandleArgs): Promise<HandleResult> {
    if (!isLoopback(args.remoteAddress)) return { status: 403, body: '{}' }
    if (!this._status.enabled) return { status: 503, body: '{}' }

    const sid = parseSidFromUrl(args.url)
    if (!sid) return { status: 404, body: '{}' }
    const expected = this.secrets.get(sid)
    if (!expected) return { status: 404, body: '{}' }

    const token = headerValue(args.headers, 'x-ccc-hook-token')
    if (token !== expected) return { status: 404, body: '{}' }

    // Reuse the body parsed once by the live HTTP path; only parse here when the
    // caller is the unit-test entrypoint (parsedBody undefined).
    let parsed: Record<string, unknown> | null | undefined = args.parsedBody
    if (parsed === undefined) {
      try {
        parsed = JSON.parse(args.body) as Record<string, unknown>
      } catch {
        return { status: 400, body: '{}' }
      }
    }
    if (parsed === null) return { status: 400, body: '{}' }

    this.ingest(sid, parsed)
    return { status: 200, body: '{}' }
  }

  private ingest(sid: string, parsed: Record<string, unknown>): void {
    // Diagnostic (verbose only): log the raw shape of every incoming hook POST
    // BEFORE the strict `event` check below drops anything. This reveals exactly
    // what Claude Code sends (e.g. `event` vs `hook_event_name`), which the unit
    // tests cannot, and is the fastest way to confirm the gateway parses CC's
    // real PreToolUse during the dev-demo permission round-trip.
    logTrace(`[hooks] ingest sid=${sid} keys=[${Object.keys(parsed).join(',')}] event=${String(parsed.event)} hook_event_name=${String((parsed as Record<string, unknown>).hook_event_name)} tool_name=${String(parsed.tool_name)}`)
    // Reject payloads with a missing/non-string event field rather than
    // forging an 'Unknown' sentinel: the shared HookEventKind union
    // doesn't include it, so forging would propagate a type-contract
    // violation into the renderer (where KIND_LABEL / KIND_COLOR keyed
    // lookups would miss). The redactor test's malformed-payload case
    // is the only in-tree caller that hits this; returning early means
    // it gets dropped silently, matching the spec's "strict contract"
    // posture.
    // Accept Claude Code's real `hook_event_name` as well as the spec'd `event`.
    // Without this the gateway silently drops EVERY live hook (CC sends
    // `hook_event_name`), which is why the events feed + tray appeared dead.
    const eventName = typeof parsed.hook_event_name === 'string'
      ? (parsed.hook_event_name as string)
      : typeof parsed.event === 'string' ? (parsed.event as string) : undefined
    if (eventName === undefined) return
    const event = eventName as HookEventKind
    const toolName =
      typeof parsed.tool_name === 'string'
        ? (parsed.tool_name as string)
        : typeof parsed.toolName === 'string'
          ? (parsed.toolName as string)
          : undefined
    const rawPayload =
      parsed.payload && typeof parsed.payload === 'object'
        ? (parsed.payload as Record<string, unknown>)
        : (parsed as Record<string, unknown>)

    let redacted: Record<string, unknown>
    try {
      redacted = redactHookPayload(rawPayload)
    } catch {
      redacted = { error: 'redaction-failed' }
    }

    const entry: RingBufferEntry = {
      sessionId: sid,
      event,
      toolName,
      summary: buildSummary(event, toolName, redacted),
      payload: redacted,
      ts: Date.now(),
    }

    const buf = this.buffers.get(sid) ?? []
    buf.push(entry)
    if (buf.length > RING_BUFFER_CAP) {
      buf.splice(0, buf.length - RING_BUFFER_CAP)
      if (!this.overflowLatched.has(sid)) {
        this.overflowLatched.add(sid)
        try {
          this.emit(IPC.HOOKS_DROPPED, { sessionId: sid })
        } catch {
          /* destroyed window */
        }
      }
    }
    this.buffers.set(sid, buf)

    this.fanOut(entry as HookEvent) // forward to channel subscribers (synchronous -- subscribers must not block the ingest path)

    try {
      this.emit(IPC.HOOKS_EVENT, entry as HookEvent)
    } catch {
      /* webContents destroyed — spec §Error handling says drop silently */
    }
  }
}

function isLoopback(a: string | undefined): boolean {
  return (
    a === '127.0.0.1' ||
    a === '::1' ||
    a === '::ffff:127.0.0.1'
  )
}

/** Diagnostics helper: derive a log-safe request path from the raw URL.
 *  Strips any query string (the HARD RULE forbids logging URLs with query)
 *  and caps length so a malformed/oversized URL can't bloat a log line.
 *  Returns just the path portion (e.g. `/hook/<sid>`); never the query. */
function redactHookPath(url: string | undefined): string {
  if (!url) return '?'
  const q = url.indexOf('?')
  const pathOnly = q === -1 ? url : url.slice(0, q)
  return pathOnly.length > 128 ? pathOnly.slice(0, 128) : pathOnly
}

function parseSidFromUrl(url: string | undefined): string | null {
  if (!url) return null
  // URL arrives as /hook/<sid> — possibly with trailing query from a
  // stale settings file written by a prior build.
  const m = /^\/hook\/([A-Za-z0-9_\-]+)(?:[/?].*)?$/.exec(url)
  return m ? m[1] : null
}

function headerValue(
  h: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = h[name.toLowerCase()]
  if (Array.isArray(raw)) return raw[0]
  return raw
}

function buildSummary(
  event: string,
  toolName: string | undefined,
  payload: Record<string, unknown>,
): string {
  if (toolName) {
    const file =
      typeof payload.file_path === 'string'
        ? payload.file_path
        : typeof payload.filePath === 'string'
          ? payload.filePath
          : undefined
    return file ? `${toolName} ${file}` : toolName
  }
  return event
}
