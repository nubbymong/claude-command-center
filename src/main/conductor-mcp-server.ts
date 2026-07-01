/**
 * Conductor MCP SSE Server -- exposes Conductor tools to Claude Code (and
 * Codex sessions in P5+) via MCP protocol.
 *
 * Tool categories:
 *   1. Vision (browser automation via CDP) -- requires a connected VisionManager.
 *      Tools return "vision not connected" if the manager is unavailable.
 *   2. Host file access (screenshots, storyboards) -- always available.
 *      Used for cross-session image transfer (works for local AND SSH sessions).
 *   3. Codex review (P6) -- always advertised; ACL'd per-CCC-session via the
 *      codexReviewOptedIn set, populated by pty-manager on Claude spawn when
 *      the user has toggled "Enable Codex code review" in the session config.
 *
 * The server is started at app launch and stays running for the app lifetime.
 * Claude CLI discovers it via mcpServers in ~/.claude.json (the canonical
 * registry; --settings mcpServers is ignored). CCC-spawned sessions also get
 * per-session `--mcp-config` overrides written to ~/.claude/mcp-<sid>.json by
 * writeLocalSessionMcpConfig. SSH sessions reach it via reverse tunnel.
 *
 * Naming: the server identifier is `conductor` as of P7.7.5 (was
 * `conductor-vision` through v1.4). Both removeMcpSettings (the boot heal) and
 * the Codex TOML writer strip legacy `conductor-vision` entries so users
 * upgrading from <=v1.4 don't end up with a dead entry alongside.
 */

import * as http from 'http'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { logInfo, logError, logDebug, logWarn } from './debug-logger'
import { getResourcesDirectory } from './ipc/setup-handlers'
import { mimeForImage } from './clipboard-file'
import { removeConductorVisionFromCodexConfig } from './providers/codex/mcp-config'
import { getGlobalManager, startGlobalVision, launchBrowser } from './vision-manager'
import type { VisionCommand, VisionResult } from './vision-manager'
import { readConfig } from './config-manager'
import { isPackagedApp } from './update-watcher'
import { resolveCdpPort, CDP_PORT_PROD } from '../shared/cdp-ports'
import type { GlobalVisionConfig } from '../shared/types'
import { registerCodexReviewTool } from './codex-review-mcp-tool'

/** P6.9: Parse the `source` query string from the SSE request URL.
 *  The Codex TOML writer appends `?source=codex` so the server can skip
 *  registering the codex_review tool for Codex sessions (avoids
 *  Codex-self-review confusion). Unknown / missing source defaults to
 *  'unknown' which behaves like 'claude' (codex_review IS advertised). */
export function parseSourceFromUrl(reqUrl: string): 'claude' | 'codex' | 'unknown' {
  try {
    const url = new URL(reqUrl, 'http://localhost')
    const param = url.searchParams.get('source')
    if (param === 'codex') return 'codex'
    if (param === 'claude') return 'claude'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** P7.7.10: Parse the `cccSessionId` query string from the SSE request URL.
 *  The per-session --mcp-config writer bakes the CCC session id into the
 *  URL so the server can resolve it from the transport rather than trusting
 *  an LLM-provided tool arg (which Claude has been observed to cache stale
 *  from prior conversations). Returns null for global / external connections
 *  that didn't include the param; callers fall back to the tool arg in that
 *  case (back-compat for in-flight sessions written by older CCC builds).
 *
 *  Length-capped at 256 chars so a malformed / oversized value can't bloat
 *  log lines or downstream error messages. CCC session ids are nanoid-style
 *  ~12-char identifiers in practice; 256 is generous and defensive. */
const MAX_SESSION_ID_LENGTH = 256

export function parseCccSessionIdFromUrl(reqUrl: string): string | null {
  try {
    const url = new URL(reqUrl, 'http://localhost')
    const param = url.searchParams.get('cccSessionId')
    if (!param || param.length === 0) return null
    if (param.length > MAX_SESSION_ID_LENGTH) return null
    return param
  } catch {
    return null
  }
}

// === R-DEC-3: per-launch auth secret ===
//
// The MCP server listens on a loopback port and exposes vision_* tools --
// including vision_eval (arbitrary JS in the embedded browser) -- plus
// cross-session actions. Loopback is NOT an authorisation boundary: any
// local process (or a malicious page in a browser the user opened) could
// drive it. We mint a 32-byte random secret once per app launch and require
// it on EVERY request. The secret never persists to disk on its own; it is
// embedded into the MCP registration URLs CCC writes for Claude/Codex
// (?token=<secret>) so legitimate sessions authenticate transparently.
const conductorMcpSecret = crypto.randomBytes(32).toString('hex')

/** The per-launch MCP auth secret. Stable for the process lifetime. Consumed
 *  by every MCP-URL writer (global ~/.claude.json, per-session --mcp-config,
 *  SSH shim, Codex TOML) so registered sessions carry the token. */
export function getConductorMcpSecret(): string {
  return conductorMcpSecret
}

/** Extract the presented token from either an `Authorization: Bearer <token>`
 *  header or a `?token=<token>` query param, then compare against the expected
 *  secret in constant time. The header is checked first (cheaper, and the
 *  cleaner channel); the query param is the fallback because the registration
 *  formats can only emit a URL. Returns false for any malformed input rather
 *  than throwing. Pure -- no I/O, no http types -- so the auth contract is
 *  unit-testable directly (see conductor-mcp-auth.test.ts). */
export function isAuthorizedMcpRequest(
  reqUrl: string | undefined,
  authHeader: string | undefined,
  expectedSecret: string,
): boolean {
  let presented: string | null = null
  if (authHeader) {
    const m = /^bearer\s+(.+)$/i.exec(authHeader.trim())
    if (m) presented = m[1]
  }
  if (presented === null && reqUrl) {
    try {
      presented = new URL(reqUrl, 'http://localhost').searchParams.get('token')
    } catch {
      presented = null
    }
  }
  if (presented === null) return false
  return tokensMatch(presented, expectedSecret)
}

/** Length-checked, constant-time token comparison. timingSafeEqual throws on
 *  unequal-length buffers, so the length guard runs first (and also short-
 *  circuits the obvious mismatch). */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/** #435: diagnostic payload for the /messages 404 branch.
 *
 *  When a POST /messages?sessionId=<sid> arrives but no transport is
 *  registered under that id, the bare "Session not found" body that
 *  used to be returned was unactionable -- the LLM consumer surfaced
 *  it verbatim and the user had no recovery hint. This helper builds
 *  both:
 *
 *    - logMessage: a single-line server-side WARN suitable for
 *      logError(). Includes the truncated requested sid, the current
 *      transport count, up to 3 sample sids (8-char prefixes only --
 *      we deliberately do NOT log full sids to keep this grep-safe
 *      against accidental sharing of logs), and the requesting
 *      user-agent (capped at 64 chars to bound log-line size).
 *
 *    - body: the HTTP response body, plain ASCII (no em dashes, no
 *      JSON wrapping), explaining the three common root causes and
 *      the recovery path (restart the Claude session inside CCC, which
 *      re-binds a fresh SSE connection via the per-session
 *      --mcp-config writer).
 *
 *  The HTTP status stays 404 -- MCP clients (Claude CLI in particular)
 *  rely on 404 to identify "session lost" and trigger their own
 *  reconnect logic. Changing the code to e.g. 410 would mask real
 *  wiring failures elsewhere in the stack.
 *
 *  Pure helper -- no I/O, no http types -- so it can be unit-tested
 *  directly against a synthetic transports map. See
 *  conductor-mcp-server-404.test.ts for the contract. */
export interface NotFoundDiagnostic {
  status: 404
  body: string
  logMessage: string
}

const SID_PREFIX_LEN = 8
const SAMPLE_CAP = 3
const UA_MAX_LEN = 64

export function buildSessionNotFoundResponse(
  requestedSessionId: string,
  transports: ReadonlyMap<string, unknown>,
  userAgent: string | undefined,
): NotFoundDiagnostic {
  const requestedPrefix = requestedSessionId.slice(0, SID_PREFIX_LEN)
  const samples: string[] = []
  for (const sid of transports.keys()) {
    if (samples.length >= SAMPLE_CAP) break
    samples.push(sid.slice(0, SID_PREFIX_LEN))
  }
  const samplesStr = samples.join(',')
  const ua = userAgent && userAgent.length > 0
    ? userAgent.slice(0, UA_MAX_LEN)
    : 'unknown'

  const logMessage =
    `[vision-mcp] POST /messages 404: unknown transport sessionId=${requestedPrefix}… ` +
    `(have ${transports.size} active transports, samples=[${samplesStr}]) ua="${ua}"`

  const body =
    `MCP transport session not found: ${requestedPrefix}…\n` +
    `\n` +
    `The SSE connection that owned this transport sessionId is no longer registered. This typically means:\n` +
    `  1. Claude Code is reusing a stale sessionId from a previous SSE connection\n` +
    `  2. The CCC MCP server restarted while Claude was idle\n` +
    `  3. Network interruption dropped the SSE stream\n` +
    `\n` +
    `Recovery: restart the Claude session inside CCC (the per-session --mcp-config writer re-binds a fresh SSE connection on spawn).\n`

  return { status: 404, body, logMessage }
}

// Lazy-load MCP SDK to avoid import issues in test environments
let McpServer: any = null
let SSEServerTransport: any = null
let StreamableHTTPServerTransport: any = null
let z: any = null

function loadMcpDeps(): void {
  if (!McpServer) {
    McpServer = require('@modelcontextprotocol/sdk/server/mcp.js').McpServer
    SSEServerTransport = require('@modelcontextprotocol/sdk/server/sse.js').SSEServerTransport
    // P9.6: streamable HTTP transport for Codex 0.128+. The rmcp client used
    // by recent Codex CLI versions wraps everything in StreamableHttpClientAdapter
    // and POSTs `initialize` to the configured URL expecting JSON back. The
    // legacy SSE transport returns 202 + pushes the response down the event
    // stream, which the new client mis-reads as "missing-content-type".
    StreamableHTTPServerTransport = require('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport
    z = require('zod')
  }
}

interface VisionManagerInterface {
  executeCommand(cmd: VisionCommand): Promise<VisionResult>
  isConnected(): boolean
  getBrowser(): string
  getDebugPort(): number
}

/** Getter so the MCP server can run before the vision manager exists (or with no browser at all). */
type GetVisionManager = () => VisionManagerInterface | null

let httpServer: http.Server | null = null
let mcpPort: number = 0
const transports = new Map<string, any>()

// R-DEC-3: latch so an unauthenticated request logs at most ONE warning per
// process lifetime per bound port. Without this a probing/misconfigured client
// could spam the log. Keyed by port so a port-change restart re-arms the warn.
const authWarnedForPort = new Set<number>()

// P6: per-session opt-in for codex_review tool. Populated by pty-manager on
// Claude spawn; cleared on dispose. Soft ACL (the LLM passes its own session
// id; not a hard authorisation boundary -- see spec section 8 for rationale).
const codexReviewOptedIn = new Set<string>()
const sessionCwds = new Map<string, string>()

export function registerCodexReviewSession(sessionId: string, cwd: string): void {
  codexReviewOptedIn.add(sessionId)
  sessionCwds.set(sessionId, cwd)
}

export function unregisterCodexReviewSession(sessionId: string): void {
  codexReviewOptedIn.delete(sessionId)
  sessionCwds.delete(sessionId)
}

function resultToMcpContent(result: VisionResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    isError: !result.ok
  }
}

function visionUnavailable() {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Vision not connected. Open Settings > Vision and launch a browser to enable browser automation tools.' }) }],
    isError: true
  }
}

/**
 * Read an image file from the host's screenshots directory and return it as
 * inline MCP image content. Sandboxed: filename must not contain path separators
 * or '..' segments to prevent escaping the screenshots dir.
 */
function imageFileToMcpContent(filename: string) {
  // Reject anything that isn't a plain filename in the screenshots dir
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Invalid filename — must be a bare filename in the host screenshots directory' }) }],
      isError: true
    }
  }
  try {
    const screenshotsDir = path.join(getResourcesDirectory(), 'screenshots')
    const filePath = path.join(screenshotsDir, filename)
    // Resolve to absolute path and verify containment as a defence-in-depth check
    const resolved = path.resolve(filePath)
    const dirResolved = path.resolve(screenshotsDir)
    if (!resolved.startsWith(dirResolved + path.sep) && resolved !== dirResolved) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Path escape attempt rejected' }) }],
        isError: true
      }
    }
    if (!fs.existsSync(resolved)) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `File not found: ${filename}` }) }],
        isError: true
      }
    }
    const buffer = fs.readFileSync(resolved)
    const mimeType = mimeForImage(filename)
    return {
      content: [{
        type: 'image' as const,
        data: buffer.toString('base64'),
        mimeType
      }]
    }
  } catch (err: any) {
    logError('[vision-mcp] imageFileToMcpContent failed:', err?.message)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: err?.message || 'Read failed' }) }],
      isError: true
    }
  }
}

export async function startMcpServer(port: number, getVisionManager: GetVisionManager): Promise<void> {
  if (httpServer) {
    logInfo('[vision-mcp] Server already running, stopping first')
    stopMcpServer()
  }

  loadMcpDeps()

  // Helper: run a command if vision is connected, otherwise return unavailable.
  // createServer wraps this with the connection's bound CCC session id so the
  // VisionManager routes to that session's own pinned target (Bug 4).
  const runVision = async (cmd: VisionCommand) => {
    const vm = getVisionManager()
    if (!vm) return visionUnavailable()
    return resultToMcpContent(await vm.executeCommand(cmd))
  }

  const createServer = (
    source: 'claude' | 'codex' | 'unknown' = 'unknown',
    boundSessionId: string | null = null,
    transport: 'sse' | 'http' = 'sse',
  ) => {
    const server = new McpServer(
      { name: 'conductor', version: '1.1.0' },
      { capabilities: {} }
    )

    // Diagnostics (opt-in, verbose-gated): wrap server.tool ONCE so every tool
    // request is logged at a single narrow point -- name + resolved cccSessionId
    // + transport on entry, ok/duration on completion (logWarn on failure with
    // the error MESSAGE only). The MCP SDK always passes the handler as the LAST
    // argument to server.tool(...); we replace just that function with a
    // transparent wrapper that forwards the SAME args/`this`, returns the
    // original result unchanged, and rethrows on error. Tool ARGUMENTS and
    // RESULTS are never logged -- metadata only. Zero behavior change.
    const rawTool = server.tool.bind(server)
    server.tool = (...toolArgs: any[]) => {
      const toolName = typeof toolArgs[0] === 'string' ? toolArgs[0] : 'unknown'
      const handlerIdx = toolArgs.length - 1
      const originalHandler = toolArgs[handlerIdx]
      if (typeof originalHandler === 'function') {
        toolArgs[handlerIdx] = function (this: unknown, ...handlerArgs: any[]) {
          const sid = boundSessionId ?? 'unresolved'
          const startedAt = Date.now()
          logDebug(`[mcp] tool=${toolName} sid=${sid} transport=${transport}`)
          let result: any
          try {
            result = originalHandler.apply(this, handlerArgs)
          } catch (err: any) {
            // Synchronous throw (rare for these handlers, but be faithful).
            logWarn(`[mcp] tool=${toolName} FAILED dur=${Date.now() - startedAt}ms`, err?.message ?? String(err))
            throw err
          }
          if (result && typeof result.then === 'function') {
            return result.then(
              (value: any) => {
                logDebug(`[mcp] tool=${toolName} done ok=${value?.isError ? 'false' : 'true'} dur=${Date.now() - startedAt}ms`)
                return value
              },
              (err: any) => {
                logWarn(`[mcp] tool=${toolName} FAILED dur=${Date.now() - startedAt}ms`, err?.message ?? String(err))
                throw err
              },
            )
          }
          logDebug(`[mcp] tool=${toolName} done ok=${result?.isError ? 'false' : 'true'} dur=${Date.now() - startedAt}ms`)
          return result
        }
      }
      return rawTool(...toolArgs)
    }

    // Bug 4: every vision tool on THIS connection routes to its bound CCC
    // session's own pinned browser target, so concurrent sessions never collide.
    const withVision = (cmd: VisionCommand) => runVision({ ...cmd, sessionId: boundSessionId ?? undefined })

    // ── Host file access (always available, no vision required) ────────────

    // -- fetch_host_screenshot --
    // Returns an image from the host's screenshots dir as inline MCP image content.
    // Used by snap, storyboard, and clipboard paste in BOTH local and SSH sessions.
    // SSH sessions reach the MCP server via the existing reverse tunnel.
    server.tool(
      'fetch_host_screenshot',
      'Fetch an image file from the Conductor host\'s screenshots directory and return it as inline image content. The Conductor app saves clipboard pastes, snap captures, and storyboard frames here so they can be viewed by Claude regardless of session type (local or SSH). Use the filename the user references (e.g. "clipboard-1234.jpg" or "screenshot-2026-04-08-...jpg").',
      {
        filename: z.string().describe('Bare filename (no path separators) of an image in the Conductor screenshots directory')
      },
      async ({ filename }: { filename: string }) => {
        return imageFileToMcpContent(filename)
      }
    )

    // ── Vision tools (require connected browser) ────────────────────────────

    // -- Status --
    server.tool('vision_status', 'Check browser connection status', {}, async () => {
      const vm = getVisionManager()
      if (!vm) return resultToMcpContent({ ok: true, data: { connected: false, browser: null } })
      return resultToMcpContent(await vm.executeCommand({ command: 'status', args: [], sessionId: boundSessionId ?? undefined }))
    })

    // -- Screenshot --
    // Returns inline image content directly (no separate Read tool call needed).
    server.tool('vision_screenshot', 'Capture a screenshot of the current browser page and return it as inline image content. No need to call Read afterwards — the image is included in the response.', {}, async () => {
      const vm = getVisionManager()
      if (!vm) return visionUnavailable()
      const result = await vm.executeCommand({ command: 'screenshot', args: [], sessionId: boundSessionId ?? undefined })
      if (!result.ok || !result.path) return resultToMcpContent(result)
      // Extract bare filename and return as inline image
      const filename = path.basename(result.path)
      return imageFileToMcpContent(filename)
    })

    // -- Navigate --
    server.tool('vision_navigate', 'Navigate the browser to a URL', {
      url: z.string().describe('URL to navigate to')
    }, async ({ url }: { url: string }) => withVision({ command: 'navigate', args: [url] }))

    // -- Click --
    server.tool('vision_click', 'Click an element by CSS selector or x,y coordinates', {
      target: z.string().describe('CSS selector or "x,y" coordinates')
    }, async ({ target }: { target: string }) => withVision({ command: 'click', args: [target] }))

    // -- Type --
    server.tool('vision_type', 'Type text into an element', {
      selector: z.string().describe('CSS selector of the input element'),
      text: z.string().describe('Text to type')
    }, async ({ selector, text }: { selector: string; text: string }) =>
      withVision({ command: 'type', args: [selector, text] }))

    // -- Eval --
    server.tool('vision_eval', 'Execute JavaScript in the browser and return the result', {
      expression: z.string().describe('JavaScript expression to evaluate')
    }, async ({ expression }: { expression: string }) =>
      withVision({ command: 'eval', args: [expression] }))

    // -- Wait --
    server.tool('vision_wait', 'Wait for a CSS selector to appear on the page', {
      selector: z.string().describe('CSS selector to wait for'),
      timeout: z.number().optional().describe('Timeout in milliseconds (default 5000)')
    }, async ({ selector, timeout }: { selector: string; timeout?: number }) => {
      const args = [selector]
      if (timeout) args.push(String(timeout))
      return withVision({ command: 'wait', args })
    })

    // -- HTML --
    server.tool('vision_html', 'Get the innerHTML of an element', {
      selector: z.string().optional().describe('CSS selector (default: body)')
    }, async ({ selector }: { selector?: string }) =>
      withVision({ command: 'html', args: selector ? [selector] : [] }))

    // -- Text --
    server.tool('vision_text', 'Get the textContent of an element', {
      selector: z.string().optional().describe('CSS selector (default: body)')
    }, async ({ selector }: { selector?: string }) =>
      withVision({ command: 'text', args: selector ? [selector] : [] }))

    // -- Title --
    server.tool('vision_title', 'Get the page title', {}, async () =>
      withVision({ command: 'title', args: [] }))

    // -- URL --
    server.tool('vision_url', 'Get the current page URL', {}, async () =>
      withVision({ command: 'url', args: [] }))

    // -- Tabs --
    server.tool('vision_tabs', 'List all open browser tabs', {}, async () =>
      withVision({ command: 'tabs', args: [] }))

    // -- Tab --
    server.tool('vision_tab', 'Switch to a browser tab by index', {
      index: z.number().describe('Tab index (0-based)')
    }, async ({ index }: { index: number }) =>
      withVision({ command: 'tab', args: [String(index)] }))

    // -- Back --
    server.tool('vision_back', 'Navigate back in browser history', {}, async () =>
      withVision({ command: 'back', args: [] }))

    // -- Forward --
    server.tool('vision_forward', 'Navigate forward in browser history', {}, async () =>
      withVision({ command: 'forward', args: [] }))

    // -- Reload --
    server.tool('vision_reload', 'Reload the current page', {}, async () =>
      withVision({ command: 'reload', args: [] }))

    // -- Scroll --
    server.tool('vision_scroll', 'Scroll the page', {
      direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Scroll direction (default: down)'),
      pixels: z.number().optional().describe('Pixels to scroll (default: 400)')
    }, async ({ direction, pixels }: { direction?: string; pixels?: number }) => {
      const args: string[] = []
      if (direction) args.push(direction)
      if (pixels) args.push(String(pixels))
      return withVision({ command: 'scroll', args })
    })

    // -- Set viewport (Bug 4) --
    server.tool('vision_setViewport', 'Set the browser viewport size (and optional deviceScaleFactor) for THIS session. The default headless viewport is ~800x600, which trips responsive layouts and clips wide content -- set e.g. 1440x900 to render at desktop size.', {
      width: z.number().describe('Viewport width in CSS pixels'),
      height: z.number().describe('Viewport height in CSS pixels'),
      deviceScaleFactor: z.number().optional().describe('Device pixel ratio (default 1)')
    }, async ({ width, height, deviceScaleFactor }: { width: number; height: number; deviceScaleFactor?: number }) => {
      const args = [String(width), String(height)]
      if (deviceScaleFactor !== undefined) args.push(String(deviceScaleFactor))
      return withVision({ command: 'setViewport', args })
    })

    // P6.9: codex_review is intentionally NOT advertised to Codex sessions.
    // Codex calling itself would be confusing UX in v1.5; v1.5.x can
    // reconsider if reciprocal review demand surfaces.
    if (source !== 'codex') {
      registerCodexReviewTool(
        server,
        z,
        () => codexReviewOptedIn,
        (sessionId: string) => sessionCwds.get(sessionId) ?? null,
        () => boundSessionId,
      )
    }

    return server
  }

  return new Promise((resolve, reject) => {
    httpServer = http.createServer(async (req, res) => {
      // CORS headers for cross-origin MCP clients
      res.setHeader('Access-Control-Allow-Origin', `http://localhost:${port}`)
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      // R-DEC-3: allow Authorization so a browser-origin caller could present
      // the Bearer token across a preflight. Non-browser MCP clients (Claude
      // CLI, Codex rmcp, SSH tunnel) use the ?token= query param and skip CORS.
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      // R-DEC-3: gate EVERY request (tool calls, SSE/streams, /messages, /mcp,
      // /health) on the per-launch secret. The CORS preflight above is the only
      // unauthenticated path -- it carries no data and the spec forbids custom
      // headers on it. We deliberately gate /health too: it leaks vision
      // connection state + browser name + session count, none of which an
      // unauthenticated caller should see.
      if (!isAuthorizedMcpRequest(req.url, req.headers['authorization'], conductorMcpSecret)) {
        if (!authWarnedForPort.has(port)) {
          authWarnedForPort.add(port)
          const ua = req.headers['user-agent']
          logWarn(`[vision-mcp] Rejected unauthenticated request on port ${port} (method=${req.method} ua="${typeof ua === 'string' ? ua.slice(0, UA_MAX_LEN) : 'unknown'}"); suppressing further auth warnings for this port.`)
        }
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Unauthorized')
        return
      }

      if (req.method === 'GET' && req.url && req.url.startsWith('/sse')) {
        const source = parseSourceFromUrl(req.url)
        const boundSessionId = parseCccSessionIdFromUrl(req.url)
        logInfo(`[vision-mcp] New SSE connection (source=${source}, sid=${boundSessionId ?? 'none'})`)
        const server = createServer(source, boundSessionId, 'sse')
        // R-DEC-3: bake the token into the /messages endpoint the SDK advertises
        // to the client via the SSE `endpoint` event. SSEServerTransport.start()
        // does `new URL(endpoint).searchParams.set('sessionId', ...)`, which
        // PRESERVES our token param, so the client's follow-up POSTs arrive as
        // /messages?token=<secret>&sessionId=<sid> and clear the auth gate.
        const transport = new SSEServerTransport(`/messages?token=${conductorMcpSecret}`, res)
        transports.set(transport.sessionId, transport)

        res.on('close', () => {
          transports.delete(transport.sessionId)
          logInfo(`[vision-mcp] SSE connection closed (${transports.size} remaining)`)
        })

        try {
          await server.connect(transport)
        } catch (err: any) {
          logError('[vision-mcp] SSE connect error:', err?.message)
        }
        return
      }

      if (req.method === 'POST' && req.url?.startsWith('/messages')) {
        const url = new URL(req.url, `http://localhost:${port}`)
        const sessionId = url.searchParams.get('sessionId')

        if (!sessionId) {
          res.writeHead(400)
          res.end('Missing sessionId')
          return
        }

        const transport = transports.get(sessionId)
        if (!transport) {
          // #435: log a diagnostic line and return an actionable body
          // instead of the bare "Session not found" that the LLM used
          // to surface verbatim. The HTTP status stays 404 so MCP
          // clients can keep their existing reconnect heuristics.
          const ua = req.headers['user-agent']
          const diagnostic = buildSessionNotFoundResponse(
            sessionId,
            transports,
            typeof ua === 'string' ? ua : undefined,
          )
          logError(diagnostic.logMessage)
          res.writeHead(diagnostic.status, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(diagnostic.body)
          return
        }

        try {
          await transport.handlePostMessage(req, res)
        } catch (err: any) {
          logError('[vision-mcp] POST handler error:', err?.message)
          if (!res.headersSent) {
            res.writeHead(500)
            res.end('Internal error')
          }
        }
        return
      }

      // P9.6: Streamable HTTP transport endpoint for Codex 0.128+ (rmcp client).
      // Stateless mode -- each request creates a fresh server + transport pair
      // and tears them down after the response is sent. Conductor's tools are
      // either stateless (vision, fetch_host_screenshot) or read state from
      // closures (codexReviewOptedIn, sessionCwds) so no per-MCP-session
      // continuity is needed across requests.
      //
      // The legacy /sse route is unchanged -- Claude clients continue to use
      // SSEServerTransport which is the only route their MCP client supports.
      if (req.url?.startsWith('/mcp') && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
        try {
          const source = parseSourceFromUrl(req.url)
          const boundSessionId = parseCccSessionIdFromUrl(req.url)
          const server = createServer(source, boundSessionId, 'http')
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,  // stateless
            enableJsonResponse: true,       // prefer JSON for unary responses (what rmcp expects)
          })
          // handleRequest reads the body itself when not provided.
          await server.connect(transport)
          await transport.handleRequest(req, res)
          res.on('close', () => {
            try { transport.close() } catch { /* already closed */ }
            try { server.close() } catch { /* already closed */ }
          })
        } catch (err: any) {
          logError(`[vision-mcp] /mcp handler error: ${err?.message ?? err}`)
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: err?.message ?? 'Internal error' } }))
          }
        }
        return
      }

      // Health check endpoint
      if (req.method === 'GET' && req.url === '/health') {
        const vm = getVisionManager()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          connected: vm?.isConnected() ?? false,
          browser: vm?.getBrowser() ?? null,
          sessions: transports.size
        }))
        return
      }

      res.writeHead(404)
      res.end()
    })

    // Listen on localhost only — SSH reverse tunnels connect to localhost on the remote end
    httpServer.listen(port, '127.0.0.1', () => {
      mcpPort = port
      logInfo(`[vision-mcp] MCP SSE server listening on 127.0.0.1:${port}`)
      resolve()
    })

    httpServer.on('error', (err: any) => {
      logError('[vision-mcp] Server error:', err?.message)
      httpServer = null
      reject(err)
    })
  })
}

export function stopMcpServer(): void {
  if (httpServer) {
    // Close all active transports
    for (const [sessionId, transport] of transports) {
      try { transport.close?.() } catch { /* ignore */ }
    }
    transports.clear()

    httpServer.close()
    httpServer = null
    mcpPort = 0
    logInfo('[vision-mcp] MCP SSE server stopped')
  }
}

export function isMcpServerRunning(): boolean {
  return httpServer !== null
}

export function getMcpPort(): number {
  return mcpPort
}

// === Global MCP server registration in ~/.claude.json ===
//
// P7.7.3: Claude CLI reads mcpServers ONLY from ~/.claude.json or
// --mcp-config <path>; the ~/.claude/settings.json mcpServers block is
// ignored. We register the 'conductor' server in ~/.claude.json so anyone
// invoking `claude` outside CCC also sees the tools. Per-session
// --mcp-config (written by pty-manager) overrides this for in-CCC
// sessions, which handles the dev/prod port-resolution race.
//
// P7.7.5: server identifier renamed from 'conductor-vision' (the v1.4
// name, kept for back-compat through P7.7.4) to 'conductor' (the umbrella
// brand introduced by the P7 UI rebrand). Legacy 'conductor-vision'
// entries are stripped from ~/.claude.json during the same write so
// users upgrading from an earlier CCC don't carry a dead entry.

/**
 * Strict atomic write for ~/.claude.json: tmp + rename only. On rename
 * failure, we ABORT (delete tmp, log) rather than fall back to a
 * non-atomic direct write that could truncate the user's global config
 * mid-write. A stale-but-intact entry is safer than a corrupted file
 * full of unrelated state (projects map, OAuth tokens, growthbook cache).
 */
function strictAtomicWriteJson(filePath: string, data: unknown): boolean {
  const tmp = `${filePath}.tmp.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  try {
    fs.renameSync(tmp, filePath)
    return true
  } catch (err: any) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    logError(`[vision] Atomic rename failed for ${filePath} (${err?.code ?? err?.message}); leaving the existing file untouched.`)
    return false
  }
}

export function removeMcpSettings(): void {
  // Defensive remove from ~/.claude.json: only delete the conductor (and
  // legacy conductor-vision) keys; preserve every other mcpServers entry
  // and every other top-level key. Same safety stance as injectMcpSettings
  // -- abort on parse failure rather than risk clobbering the user's
  // global config.
  try {
    const claudeJsonPath = path.join(os.homedir(), '.claude.json')
    let raw: string
    try {
      raw = fs.readFileSync(claudeJsonPath, 'utf-8')
    } catch (err: any) {
      if (err?.code === 'ENOENT') return
      logError(`[vision] Cannot read ~/.claude.json (${err?.code ?? err?.message}); aborting MCP cleanup.`)
      return
    }
    let cj: Record<string, unknown>
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object') {
        logError('[vision] ~/.claude.json parsed to non-object; aborting MCP cleanup.')
        return
      }
      cj = parsed as Record<string, unknown>
    } catch (err: any) {
      logError(`[vision] ~/.claude.json parse failed (${err?.message}); aborting MCP cleanup.`)
      return
    }
    const servers = (cj.mcpServers && typeof cj.mcpServers === 'object')
      ? cj.mcpServers as Record<string, unknown>
      : null
    if (!servers) return
    const hadConductor = 'conductor' in servers
    const hadLegacy = 'conductor-vision' in servers
    if (!hadConductor && !hadLegacy) return
    if (hadConductor) delete servers['conductor']
    if (hadLegacy) delete servers['conductor-vision']
    if (Object.keys(servers).length === 0) {
      delete cj.mcpServers
    } else {
      cj.mcpServers = servers
    }
    strictAtomicWriteJson(claudeJsonPath, cj)
  } catch (err: any) {
    logError('[vision] Failed to remove ~/.claude.json MCP:', err?.message)
  }

  logInfo('[vision] Removed MCP server config')
}

// === Public API (global singleton) ===

/** Default MCP port used when no visionGlobal config exists. */
export const DEFAULT_MCP_PORT = 19333

let conductorMcpPort: number = 0

/**
 * Start the Conductor MCP server independently of vision/browser config.
 * This runs at app launch so the fetch_host_screenshot tool is always available
 * for image transfer between the Conductor and Claude Code (local + SSH sessions).
 *
 * Vision/browser tools become available later when startGlobalVision is called.
 * The MCP server uses a getter for the vision manager so tools can check at
 * call time whether browser automation is available.
 */
export async function startConductorMcpServer(
  preferredPort?: number
): Promise<void> {
  const port = preferredPort || DEFAULT_MCP_PORT
  if (conductorMcpPort === port) {
    logInfo(`[mcp] Conductor MCP server already running on port ${port}`)
    return
  }
  await startMcpServer(port, () => getGlobalManager())
  conductorMcpPort = port
  // U3: CCC sessions get the conductor MCP per-session via --mcp-config
  // (writeLocalSessionMcpConfig); we no longer write it into the global
  // ~/.claude.json. Heal any stale entry a pre-U3 version / crash left behind so
  // plain `claude` outside CCC doesn't try a dead endpoint.
  removeMcpSettings()
  // U6: Codex gets the conductor MCP per-spawn via `-c` overrides
  // (buildCodexSpawn), NOT a global ~/.codex/config.toml write. Heal any stale
  // block a pre-U6 version / crash left behind so plain `codex` outside CCC
  // doesn't try the dead endpoint.
  removeConductorVisionFromCodexConfig()
  logInfo(`[mcp] Conductor MCP server started on port ${port} (vision: ${getGlobalManager() ? 'connected' : 'idle'})`)
}

export function getConductorMcpPort(): number {
  return conductorMcpPort
}

/**
 * Fully shut down the Conductor MCP server. Called only at app quit.
 */
export function stopConductorMcpServer(): void {
  if (conductorMcpPort !== 0) {
    stopMcpServer()
    removeMcpSettings()
    removeConductorVisionFromCodexConfig()
    conductorMcpPort = 0
    logInfo('[mcp] Conductor MCP server stopped')
  }
}

/**
 * Reset the tracked port to zero after stopMcpServer() has been called.
 * Used by vision-manager.startGlobalVision when the user reconfigures the
 * MCP port -- it stops the existing server then needs the wrapper state
 * to allow startConductorMcpServer() to bind the new port. Keeping this
 * as a tiny exported helper avoids leaking the conductorMcpPort variable.
 */
export function resetConductorMcpPort(): void {
  conductorMcpPort = 0
}

/**
 * P7.3: Launch the browser-vision sub-tool at CCC boot.
 *
 * Previously gated on visionConfig.enabled; now unconditional. The
 * MCP server itself has always been unconditional. Eliminates the
 * spawn-vs-launch race where Claude Code cached "vision tools
 * advertised but unavailable" at session start because the user
 * hadn't clicked Launch Chrome yet.
 *
 * P7.7.1: Actually spawn Chrome (headless). Previously this only
 * initialized the CDP heartbeat without launching the browser, so
 * the UI sat at "Browser launching..." indefinitely. We now spawn
 * Chrome via launchBrowser BEFORE startGlobalVision so the
 * VisionManager's heartbeat attaches to a real debug server.
 *
 * Users who want vision off can click Stop in the Vision sub-tool
 * card; restart of CCC re-enables it.
 */
export async function startBrowserAtBoot(
  getWindow: () => import('electron').BrowserWindow | null,
): Promise<void> {
  const visionConfig = readConfig<GlobalVisionConfig>('visionGlobal') ?? {
    enabled: true,
    browser: 'chrome',
    debugPort: CDP_PORT_PROD,
    headless: true,
  }
  // P7.7: override config.debugPort with the resolved CDP port so dev
  // mode binds 9322 instead of colliding with production's 9222. The
  // legacy debugPort field on saved configs is ignored.
  const debugPort = resolveCdpPort(isPackagedApp())
  // Narrow defensively -- readConfig returns parsed JSON, so a corrupted
  // saved value (e.g. browser: "firefox") could slip past TS without this.
  const browser: 'chrome' | 'edge' = visionConfig.browser === 'edge' ? 'edge' : 'chrome'
  const headless = visionConfig.headless !== false
  try {
    launchBrowser(browser, debugPort, visionConfig.url, headless)
  } catch (err) {
    logError(`[vision] Browser spawn at boot failed: ${(err as Error)?.message}. Heartbeat will retry if browser becomes reachable.`)
  }
  await startGlobalVision({
    ...visionConfig,
    enabled: true,
    debugPort,
  }, getWindow)
}
