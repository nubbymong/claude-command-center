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
 * `conductor-vision` through v1.4). Both injectMcpSettings and the Codex TOML
 * writer strip legacy `conductor-vision` entries during migration so users
 * upgrading from <=v1.4 don't end up with a dead entry alongside.
 */

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { logInfo, logError } from './debug-logger'
import { getResourcesDirectory } from './ipc/setup-handlers'
import { injectConductorVisionInCodexConfig, removeConductorVisionFromCodexConfig } from './providers/codex/mcp-config'
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

// Lazy-load MCP SDK to avoid import issues in test environments
let McpServer: any = null
let SSEServerTransport: any = null
let z: any = null

function loadMcpDeps(): void {
  if (!McpServer) {
    McpServer = require('@modelcontextprotocol/sdk/server/mcp.js').McpServer
    SSEServerTransport = require('@modelcontextprotocol/sdk/server/sse.js').SSEServerTransport
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
    const lower = filename.toLowerCase()
    const mimeType = lower.endsWith('.png') ? 'image/png'
      : lower.endsWith('.webp') ? 'image/webp'
      : 'image/jpeg'
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

  // Helper: run a command if vision is connected, otherwise return unavailable
  const withVision = async (cmd: VisionCommand) => {
    const vm = getVisionManager()
    if (!vm) return visionUnavailable()
    return resultToMcpContent(await vm.executeCommand(cmd))
  }

  const createServer = (
    source: 'claude' | 'codex' | 'unknown' = 'unknown',
    boundSessionId: string | null = null,
  ) => {
    const server = new McpServer(
      { name: 'conductor', version: '1.1.0' },
      { capabilities: {} }
    )

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
      return resultToMcpContent(await vm.executeCommand({ command: 'status', args: [] }))
    })

    // -- Screenshot --
    // Returns inline image content directly (no separate Read tool call needed).
    server.tool('vision_screenshot', 'Capture a screenshot of the current browser page and return it as inline image content. No need to call Read afterwards — the image is included in the response.', {}, async () => {
      const vm = getVisionManager()
      if (!vm) return visionUnavailable()
      const result = await vm.executeCommand({ command: 'screenshot', args: [] })
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === 'GET' && req.url && req.url.startsWith('/sse')) {
        const source = parseSourceFromUrl(req.url)
        const boundSessionId = parseCccSessionIdFromUrl(req.url)
        logInfo(`[vision-mcp] New SSE connection (source=${source}, sid=${boundSessionId ?? 'none'})`)
        const server = createServer(source, boundSessionId)
        const transport = new SSEServerTransport('/messages', res)
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
          res.writeHead(404)
          res.end('Session not found')
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

function injectMcpSettings(mcpPort: number): void {
  const entry = {
    type: 'sse',
    url: `http://localhost:${mcpPort}/sse`,
  }

  // Defensive merge into ~/.claude.json: preserve every other top-level key
  // and every other mcpServers entry. Only touch mcpServers['conductor']
  // (and strip any legacy 'conductor-vision' entry for migration).
  //
  // Safety: distinguish ENOENT (fresh install, start from {}) from any other
  // read/parse failure (corrupted file, EACCES, etc.) -- in the latter case
  // ABORT rather than overwrite the user's global with our partial config.
  // ~/.claude.json holds the user's projects map, OAuth account, settings
  // cache, etc.; overwriting it with {} would be catastrophic.
  try {
    const claudeJsonPath = path.join(os.homedir(), '.claude.json')
    let cj: Record<string, unknown> = {}
    let exists = true
    try {
      const raw = fs.readFileSync(claudeJsonPath, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object') {
        logError(`[vision] ~/.claude.json parsed to non-object (type=${typeof parsed}); aborting MCP injection to avoid clobbering.`)
        return
      }
      cj = parsed as Record<string, unknown>
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        exists = false
      } else {
        logError(`[vision] Cannot read ~/.claude.json (${err?.code ?? err?.message}); aborting MCP injection to avoid clobbering.`)
        return
      }
    }
    void exists
    const servers = (cj.mcpServers && typeof cj.mcpServers === 'object')
      ? cj.mcpServers as Record<string, unknown>
      : {}
    // Preserve extra fields (headers, oauth, env) on the existing entry
    // if any. We only own type + url.
    const existing = (servers['conductor'] && typeof servers['conductor'] === 'object')
      ? servers['conductor'] as Record<string, unknown>
      : {}
    servers['conductor'] = { ...existing, ...entry }
    // P7.7.5 migration: strip legacy 'conductor-vision' name so users
    // upgrading from <=v1.4 don't end up with a dead entry alongside.
    if ('conductor-vision' in servers) {
      delete servers['conductor-vision']
    }
    cj.mcpServers = servers
    strictAtomicWriteJson(claudeJsonPath, cj)
  } catch (err: any) {
    logError('[vision] Failed to inject ~/.claude.json MCP:', err?.message)
  }

  logInfo(`[vision] Registered conductor in ~/.claude.json (port ${mcpPort})`)
}

function removeMcpSettings(): void {
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
  injectMcpSettings(port)
  // Codex sessions read MCP config from ~/.codex/config.toml; mirror the
  // entry there so they reach the same vision MCP endpoint Claude does.
  // Gated on ~/.codex existing -- skips silently for users without Codex.
  injectConductorVisionInCodexConfig(port)
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
