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

  constructor(opts: HooksGatewayOptions) {
    this.defaultPort = opts.defaultPort ?? DEFAULT_HOOKS_PORT
    this.emit = opts.emit
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
        this.handleHttp(req, res).catch(() => {
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
          res.end('{}')
          req.destroy()
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
    const result = await this._handleRequestForTest({
      remoteAddress: req.socket.remoteAddress,
      url: req.url,
      headers: req.headers as Record<string, string | string[] | undefined>,
      body,
    })
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

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(args.body) as Record<string, unknown>
    } catch {
      return { status: 400, body: '{}' }
    }

    this.ingest(sid, parsed)
    return { status: 200, body: '{}' }
  }

  private ingest(sid: string, parsed: Record<string, unknown>): void {
    // Reject payloads with a missing/non-string event field rather than
    // forging an 'Unknown' sentinel: the shared HookEventKind union
    // doesn't include it, so forging would propagate a type-contract
    // violation into the renderer (where KIND_LABEL / KIND_COLOR keyed
    // lookups would miss). The redactor test's malformed-payload case
    // is the only in-tree caller that hits this; returning early means
    // it gets dropped silently, matching the spec's "strict contract"
    // posture.
    if (typeof parsed.event !== 'string') return
    const event = parsed.event as HookEventKind
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
