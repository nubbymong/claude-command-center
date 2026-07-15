/**
 * Vision Manager -- global CDP browser automation for Claude Code via MCP.
 * Manages a single VisionManager instance (singleton) with CDP connection,
 * heartbeat, and browser launching. The MCP SSE server (conductor-mcp-server.ts)
 * wraps this to expose tools to Claude Code sessions.
 *
 * PER-SESSION ROUTER (Bug 4): the browser is shared (one Chrome on one debug
 * port), but each CCC session gets its OWN pinned CDP target inside its OWN
 * BrowserContext (incognito-like: isolated cookies/storage). A tool call carries
 * the calling session id, so a second session activating a tab can NEVER repoint
 * another session's calls -- the prior "shared single client" model leaked across
 * sessions. The per-session target is allocated lazily on a session's first vision
 * call and torn down when the session ends. BrowserContext creation degrades
 * gracefully to a plain pinned target (still bleed-proof) if the Chrome build
 * rejects the Target.* calls.
 */

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { spawn, execSync } from 'child_process'
import { BrowserWindow, nativeImage } from 'electron'
import { getResourcesDirectory } from './ipc/setup-handlers'
import { logInfo, logError } from './debug-logger'
import { getConductorMcpPort } from './conductor-mcp-server'
import type { GlobalVisionConfig } from '../shared/types'

// chrome-remote-interface (lazy require so a missing optional dep never crashes
// boot). Test seam: _setCdpForTest injects a fake so the router logic is unit-
// testable without a real browser.
let CDP: any = null
let cdpOverride: any = null
function getCDP(): any {
  if (cdpOverride) return cdpOverride
  if (!CDP) CDP = require('chrome-remote-interface')
  return CDP
}
/** Test seam: inject a fake chrome-remote-interface. Pass null to restore. */
export function _setCdpForTest(fake: any): void { cdpOverride = fake }

export interface VisionCommand {
  command: string
  args: string[]
  /** The CCC session that issued this call. Routes to that session's pinned
   *  target/context. Undefined falls back to a single shared "__global__" lane
   *  (legacy / external connections that don't bind a CCC session). */
  sessionId?: string
}

export interface VisionResult {
  ok: boolean
  data?: any
  error?: string
  path?: string
}

// === Singleton state ===

let globalManager: VisionManager | null = null
let globalConfig: GlobalVisionConfig | null = null

const GLOBAL_LANE = '__global__'

interface SessionBrowser {
  client: any
  /** browserContextId when an isolated context was created; undefined when we
   *  fell back to the default context. */
  contextId: string | undefined
  targetId: string
  /** true when WE created this target (so teardown may close it). false when the
   *  session pinned a PRE-EXISTING page (via fallback or vision_tab) -- closing
   *  that on teardown could kill another session's / the user's own tab. */
  owned: boolean
}

export class VisionManager {
  private debugPort: number
  private browser: string
  private rootClient: any = null            // browser-level client for Target.* + listing
  private sessions = new Map<string, SessionBrowser>() // cccSessionId -> pinned target/context
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private connected: boolean = false
  private getWindow: (() => BrowserWindow | null) | null = null

  constructor(debugPort: number, browser: string) {
    this.debugPort = debugPort
    this.browser = browser
  }

  async start(getWindow: () => BrowserWindow | null): Promise<void> {
    this.getWindow = getWindow
    try {
      await this.connectRoot()
    } catch {
      logInfo(`[vision] Browser not reachable yet on port ${this.debugPort} — heartbeat will reconnect when it launches`)
    }
    this.startHeartbeat()
  }

  async stop(): Promise<void> {
    this.stopHeartbeat()
    await this.teardownAll()
    await this.disconnectRoot()
    this.connected = false
    logInfo(`[vision] Stopped VisionManager for port ${this.debugPort}`)
  }

  isConnected(): boolean { return this.connected }
  getBrowser(): string { return this.browser }
  getDebugPort(): number { return this.debugPort }

  private async connectRoot(): Promise<void> {
    try {
      const cdp = getCDP()
      this.rootClient = await cdp({ port: this.debugPort })
      this.connected = true
      logInfo(`[vision] CDP root connected to ${this.browser} on port ${this.debugPort}`)
    } catch {
      this.connected = false
      throw new Error(`Cannot connect to browser on port ${this.debugPort}`)
    }
  }

  private async disconnectRoot(): Promise<void> {
    if (this.rootClient) {
      try { await this.rootClient.close() } catch { /* ignore */ }
      this.rootClient = null
    }
  }

  private async ensureRoot(): Promise<any> {
    if (!this.rootClient) await this.connectRoot()
    return this.rootClient
  }

  /** Drop every per-session client (close its socket best-effort) so they
   *  re-allocate lazily against the fresh browser; avoids leaking sockets on a
   *  transient reconnect to a still-live browser. */
  private dropSessions(): void {
    for (const sb of this.sessions.values()) { try { sb.client.close() } catch { /* ignore */ } }
    this.sessions.clear()
  }

  private async reconnectRoot(): Promise<void> {
    const wasConnected = this.connected
    // A dropped browser invalidates every per-session client -- drop them so they
    // re-allocate lazily against the fresh browser on the next call.
    this.dropSessions()
    await this.disconnectRoot()
    try {
      await this.connectRoot()
      if (!wasConnected) this.notifyStatusChange()
    } catch {
      if (wasConnected) { this.connected = false; this.notifyStatusChange() }
    }
  }

  private notifyStatusChange(): void {
    const win = this.getWindow?.()
    if (!win || win.isDestroyed()) return
    win.webContents.send('vision:statusChanged', {
      connected: this.connected,
      browser: this.browser,
      mcpPort: getConductorMcpPort(),
    })
  }

  async tryReconnectNow(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(r => setTimeout(r, 1500))
      try {
        await this.connectRoot()
        this.notifyStatusChange()
        return
      } catch { /* keep trying */ }
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const req = http.request({ hostname: '127.0.0.1', port: this.debugPort, path: '/json/version', method: 'GET', timeout: 5000 }, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          if (!this.connected) {
            logInfo(`[vision] Browser heartbeat restored on port ${this.debugPort}, reconnecting...`)
            this.reconnectRoot()
          }
        })
      })
      req.on('error', () => {
        if (this.connected) {
          logInfo(`[vision] Browser heartbeat lost on port ${this.debugPort}`)
          this.connected = false
          this.dropSessions()
          this.notifyStatusChange()
        }
        // Whether or not we were ever connected: the endpoint is dead, so
        // relaunch OUR browser (cooldown-limited). Pre-fix this branch did
        // nothing when the browser died before the FIRST connect, so the
        // Vision panel sat on "Browser launching…" forever.
        maybeAutoRelaunchBrowser(this.debugPort)
      })
      req.on('timeout', () => {
        req.destroy()
        if (this.connected) { this.connected = false; this.dropSessions(); this.notifyStatusChange() }
        maybeAutoRelaunchBrowser(this.debugPort)
      })
      req.end()
    }, 30000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }

  /** List every page target across the whole browser (all contexts). */
  private async listPages(): Promise<any[]> {
    const cdp = getCDP()
    const targets = await cdp.List({ port: this.debugPort })
    return targets.filter((t: any) => t.type === 'page')
  }

  /** Allocate (or return) a session's pinned target inside its own isolated
   *  BrowserContext. Falls back to the default context, then to the first
   *  existing page, so a Target.* rejection never disables vision. */
  private async ensureSessionBrowser(sessionId: string): Promise<SessionBrowser> {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const cdp = getCDP()
    const root = await this.ensureRoot()

    // Preferred: isolated BrowserContext + a fresh target inside it.
    try {
      const { browserContextId } = await root.Target.createBrowserContext({ disposeOnDetach: false })
      const { targetId } = await root.Target.createTarget({ url: 'about:blank', browserContextId })
      const client = await cdp({ port: this.debugPort, target: targetId })
      await client.Page.enable(); await client.Runtime.enable()
      const sb: SessionBrowser = { client, contextId: browserContextId, targetId, owned: true }
      this.sessions.set(sessionId, sb)
      logInfo(`[vision] session ${sessionId}: isolated context ${browserContextId} target ${targetId}`)
      return sb
    } catch (e: any) {
      logInfo(`[vision] session ${sessionId}: BrowserContext unavailable (${e?.message ?? e}); falling back to a pinned default-context target`)
    }

    // Fallback A: a fresh target in the default context (still pinned + owned).
    try {
      const { targetId } = await root.Target.createTarget({ url: 'about:blank' })
      const client = await cdp({ port: this.debugPort, target: targetId })
      await client.Page.enable(); await client.Runtime.enable()
      const sb: SessionBrowser = { client, contextId: undefined, targetId, owned: true }
      this.sessions.set(sessionId, sb)
      return sb
    } catch (e: any) {
      logInfo(`[vision] session ${sessionId}: createTarget failed (${e?.message ?? e}); pinning the first existing page`)
    }

    // Fallback B: pin the first existing page target (NOT owned -- never close it).
    const pages = await this.listPages()
    if (!pages.length) throw new Error('no browser page targets available')
    const target = pages[0]
    const client = await cdp({ port: this.debugPort, target })
    await client.Page.enable(); await client.Runtime.enable()
    const sb: SessionBrowser = { client, contextId: undefined, targetId: target.id, owned: false }
    this.sessions.set(sessionId, sb)
    return sb
  }

  /** Tear down one session's target/context + client. Best-effort. */
  async teardownSession(sessionId: string): Promise<void> {
    const sb = this.sessions.get(sessionId)
    if (!sb) return
    this.sessions.delete(sessionId)
    try { await sb.client.close() } catch { /* ignore */ }
    try {
      const root = await this.ensureRoot()
      // Only close a target WE created -- never a pre-existing page the session
      // merely pinned/tabbed to (that could belong to another session or the user).
      if (sb.owned) { try { await root.Target.closeTarget({ targetId: sb.targetId }) } catch { /* may already be gone */ } }
      if (sb.contextId) { try { await root.Target.disposeBrowserContext({ browserContextId: sb.contextId }) } catch { /* ignore */ } }
    } catch { /* root unavailable */ }
  }

  private async teardownAll(): Promise<void> {
    const ids = [...this.sessions.keys()]
    for (const id of ids) await this.teardownSession(id)
  }

  /** True when the session's pinned target still exists in the browser. */
  private async targetAlive(targetId: string): Promise<boolean> {
    try {
      const pages = await this.listPages()
      return pages.some((t: any) => t.id === targetId)
    } catch { return false }
  }

  /** Execute a vision command for a specific session against its pinned target. */
  async executeCommand(cmd: VisionCommand): Promise<VisionResult> {
    if (!this.connected) {
      return { ok: false, error: 'Not connected to browser. Launch it from the Vision page or check that it is running with --remote-debugging-port.' }
    }
    const sid = cmd.sessionId || GLOBAL_LANE

    // Browser-wide commands need no pinned target.
    if (cmd.command === 'status') {
      return { ok: true, data: { connected: true, browser: this.browser, debugPort: this.debugPort, sessions: this.sessions.size } }
    }
    if (cmd.command === 'tabs') {
      try {
        const pages = await this.listPages()
        const mine = this.sessions.get(sid)?.targetId
        const tabs = pages.map((t: any, i: number) => ({ index: i, title: t.title, url: t.url, current: t.id === mine }))
        return { ok: true, data: tabs }
      } catch (err: any) { return { ok: false, error: err?.message || 'tabs failed' } }
    }

    let sb: SessionBrowser
    try {
      sb = await this.ensureSessionBrowser(sid)
    } catch (err: any) {
      return { ok: false, error: err?.message || 'could not allocate a browser target for this session' }
    }

    // Guard: never operate on a target that has been closed/navigated away from
    // under this session. Drop it so the NEXT call re-allocates a fresh one.
    if (!(await this.targetAlive(sb.targetId))) {
      this.sessions.delete(sid)
      try { await sb.client.close() } catch { /* ignore */ }
      return { ok: false, error: `This session's browser tab was closed; run vision_navigate to start a fresh one.` }
    }

    const client = sb.client
    try {
      switch (cmd.command) {
        case 'tab': {
          const idx = parseInt(cmd.args[0], 10)
          if (isNaN(idx)) return { ok: false, error: 'tab requires a numeric index' }
          const pages = await this.listPages()
          if (idx < 0 || idx >= pages.length) return { ok: false, error: `Tab index ${idx} out of range (0-${pages.length - 1})` }
          const cdp = getCDP()
          try { await client.close() } catch { /* ignore */ }
          // Release the target/context WE created for this session before pinning a
          // pre-existing page, so they aren't orphaned -- and so teardown later
          // never closes the tabbed-to page (it belongs to someone else).
          if (pages[idx].id !== sb.targetId) {
            try {
              const root = await this.ensureRoot()
              if (sb.owned) { try { await root.Target.closeTarget({ targetId: sb.targetId }) } catch { /* gone */ } }
              if (sb.contextId) { try { await root.Target.disposeBrowserContext({ browserContextId: sb.contextId }) } catch { /* ignore */ } }
            } catch { /* root unavailable */ }
          }
          const newClient = await cdp({ port: this.debugPort, target: pages[idx] })
          await newClient.Page.enable(); await newClient.Runtime.enable()
          // Re-pin to the chosen pre-existing page -- NOT owned (don't close it on teardown).
          this.sessions.set(sid, { client: newClient, contextId: undefined, targetId: pages[idx].id, owned: false })
          return { ok: true, data: { index: idx, title: pages[idx].title, url: pages[idx].url } }
        }

        case 'setViewport': {
          const width = parseInt(cmd.args[0], 10)
          const height = parseInt(cmd.args[1], 10)
          const dsf = cmd.args[2] !== undefined ? parseFloat(cmd.args[2]) : 1
          if (isNaN(width) || isNaN(height) || width <= 0 || height <= 0) {
            return { ok: false, error: 'setViewport requires positive width and height' }
          }
          await client.Emulation.setDeviceMetricsOverride({
            width, height,
            deviceScaleFactor: isNaN(dsf) || dsf <= 0 ? 1 : dsf,
            mobile: false,
          })
          return { ok: true, data: { width, height, deviceScaleFactor: isNaN(dsf) || dsf <= 0 ? 1 : dsf } }
        }

        case 'screenshot': {
          const { data } = await client.Page.captureScreenshot({ format: 'jpeg', quality: 75 })
          const screenshotsDir = path.join(getResourcesDirectory(), 'screenshots')
          if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true })
          const filename = `vision-${Date.now()}.jpg`
          const filePath = path.join(screenshotsDir, filename)
          const MAX_WIDTH = 1280
          const rawBuffer = Buffer.from(data, 'base64')
          const img = nativeImage.createFromBuffer(rawBuffer)
          const size = img.getSize()
          if (size.width > MAX_WIDTH) {
            const scale = MAX_WIDTH / size.width
            const resized = img.resize({ width: MAX_WIDTH, height: Math.round(size.height * scale) })
            fs.writeFileSync(filePath, resized.toJPEG(75))
            logInfo(`[vision] Screenshot downscaled ${size.width}x${size.height} -> ${MAX_WIDTH}x${Math.round(size.height * scale)}`)
          } else {
            fs.writeFileSync(filePath, rawBuffer)
          }
          return { ok: true, path: filePath }
        }

        case 'navigate': {
          const url = cmd.args[0]
          if (!url) return { ok: false, error: 'navigate requires a URL' }
          await client.Page.navigate({ url })
          await client.Page.loadEventFired()
          return { ok: true, data: { url } }
        }

        case 'click': {
          const target = cmd.args[0]
          if (!target) return { ok: false, error: 'click requires a CSS selector or x,y coordinates' }
          const coordMatch = target.match(/^(\d+),(\d+)$/)
          if (coordMatch) {
            const x = parseInt(coordMatch[1], 10), y = parseInt(coordMatch[2], 10)
            await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
            await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
            return { ok: true, data: { x, y } }
          }
          const { result } = await client.Runtime.evaluate({
            expression: `(() => {
              const el = document.querySelector(${JSON.stringify(target)});
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: r.x + r.width/2, y: r.y + r.height/2 };
            })()`,
            returnByValue: true
          })
          if (!result.value) return { ok: false, error: `Element not found: ${target}` }
          const { x, y } = result.value
          await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
          await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
          return { ok: true, data: { selector: target, x, y } }
        }

        case 'type': {
          const selector = cmd.args[0]
          const text = cmd.args.slice(1).join(' ')
          if (!selector || !text) return { ok: false, error: 'type requires <selector> <text>' }
          await client.Runtime.evaluate({ expression: `document.querySelector(${JSON.stringify(selector)})?.focus()` })
          for (const char of text) {
            await client.Input.dispatchKeyEvent({ type: 'keyDown', text: char })
            await client.Input.dispatchKeyEvent({ type: 'keyUp', text: char })
          }
          return { ok: true, data: { selector, text } }
        }

        case 'eval': {
          const expression = cmd.args.join(' ')
          if (!expression) return { ok: false, error: 'eval requires an expression' }
          const { result, exceptionDetails } = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true })
          if (exceptionDetails) return { ok: false, error: exceptionDetails.text || 'Evaluation error' }
          return { ok: true, data: result.value }
        }

        case 'wait': {
          const selector = cmd.args[0]
          const timeoutMs = parseInt(cmd.args[1], 10) || 5000
          if (!selector) return { ok: false, error: 'wait requires a CSS selector' }
          const startTime = Date.now()
          while (Date.now() - startTime < timeoutMs) {
            const { result } = await client.Runtime.evaluate({ expression: `!!document.querySelector(${JSON.stringify(selector)})`, returnByValue: true })
            if (result.value) return { ok: true, data: { selector, elapsed: Date.now() - startTime } }
            await new Promise(r => setTimeout(r, 200))
          }
          return { ok: false, error: `Timeout waiting for ${selector} (${timeoutMs}ms)` }
        }

        case 'html': {
          const selector = cmd.args[0] || 'body'
          const { result } = await client.Runtime.evaluate({ expression: `document.querySelector(${JSON.stringify(selector)})?.innerHTML`, returnByValue: true })
          if (result.value === undefined) return { ok: false, error: `Element not found: ${selector}` }
          return { ok: true, data: result.value }
        }

        case 'text': {
          const selector = cmd.args[0] || 'body'
          const { result } = await client.Runtime.evaluate({ expression: `document.querySelector(${JSON.stringify(selector)})?.textContent`, returnByValue: true })
          if (result.value === undefined) return { ok: false, error: `Element not found: ${selector}` }
          return { ok: true, data: result.value }
        }

        case 'title': {
          const { result } = await client.Runtime.evaluate({ expression: 'document.title', returnByValue: true })
          return { ok: true, data: result.value }
        }

        case 'url': {
          const { result } = await client.Runtime.evaluate({ expression: 'window.location.href', returnByValue: true })
          return { ok: true, data: result.value }
        }

        case 'back':
          await client.Runtime.evaluate({ expression: 'window.history.back()' })
          await new Promise(r => setTimeout(r, 500))
          return { ok: true, data: 'navigated back' }

        case 'forward':
          await client.Runtime.evaluate({ expression: 'window.history.forward()' })
          await new Promise(r => setTimeout(r, 500))
          return { ok: true, data: 'navigated forward' }

        case 'reload':
          await client.Page.reload()
          await client.Page.loadEventFired()
          return { ok: true, data: 'reloaded' }

        case 'scroll': {
          const direction = cmd.args[0] || 'down'
          const px = parseInt(cmd.args[1], 10) || 400
          const scrollMap: Record<string, string> = {
            down: `window.scrollBy(0, ${px})`, up: `window.scrollBy(0, -${px})`,
            left: `window.scrollBy(-${px}, 0)`, right: `window.scrollBy(${px}, 0)`,
          }
          const expr = scrollMap[direction]
          if (!expr) return { ok: false, error: `Invalid scroll direction: ${direction}. Use up/down/left/right.` }
          await client.Runtime.evaluate({ expression: expr })
          return { ok: true, data: { direction, px } }
        }

        default:
          return { ok: false, error: `Unknown command: ${cmd.command}. Available: status, tabs, tab, setViewport, screenshot, navigate, click, type, eval, wait, html, text, title, url, back, forward, reload, scroll` }
      }
    } catch (err: any) {
      logError(`[vision] Command '${cmd.command}' failed:`, err?.message || err)
      if (err?.message?.includes('not attached') || err?.message?.includes('ECONNREFUSED') || err?.message?.includes('WebSocket')) {
        // This session's client is dead -- drop it so the next call re-allocates.
        this.sessions.delete(sid)
      }
      return { ok: false, error: err?.message || 'Command failed' }
    }
  }
}

/** One-time cleanup: remove old CLAUDE.md vision markers from the legacy per-session system. */
export function cleanupLegacyVisionMarkers(
  claudeMdPath: string = path.join(os.homedir(), '.claude', 'CLAUDE.md'),
): void {
  try {
    if (!fs.existsSync(claudeMdPath)) return
    const content = fs.readFileSync(claudeMdPath, 'utf-8')
    const markerRegex = /\n?\n?<!-- VISION-INSTRUCTIONS-START -->[\s\S]*?<!-- VISION-INSTRUCTIONS-END -->\n?/g
    if (markerRegex.test(content)) {
      const cleaned = content.replace(markerRegex, '').trim()
      // Never unlink the user's file -- if the strip empties it, leave it empty.
      fs.writeFileSync(claudeMdPath, cleaned.length === 0 ? '' : cleaned + '\n')
      logInfo('[vision] Cleaned up legacy vision markers from ~/.claude/CLAUDE.md')
    }
  } catch (err: any) {
    logError('[vision] Failed to clean legacy CLAUDE.md markers:', err?.message)
  }
}

// === Public API (global singleton) ===

export function getGlobalManager(): VisionManager | null { return globalManager }

export async function startGlobalVision(
  config: GlobalVisionConfig,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  if (globalManager) await stopGlobalVision()
  globalConfig = config
  const manager = new VisionManager(config.debugPort, config.browser)
  await manager.start(getWindow)
  globalManager = manager
  cleanupLegacyVisionMarkers()
  logInfo(`[vision] Global vision started: CDP port ${config.debugPort}, MCP port ${getConductorMcpPort()}`)
}

export async function stopGlobalVision(): Promise<void> {
  if (globalManager) {
    await globalManager.stop()
    globalManager = null
    logInfo('[vision] Browser automation stopped (MCP server continues running)')
  }
  globalConfig = null
  // Deterministic teardown of the headless browser CCC spawned, so it never
  // survives stop/app-quit (called from before-quit's stopGlobalVision()).
  killSpawnedBrowser()
}

/** Tear down a session's pinned browser target/context (called on PTY exit). */
export function teardownVisionSession(sessionId: string): void {
  globalManager?.teardownSession(sessionId).catch(() => { /* best-effort */ })
}

export function getGlobalVisionStatus(): { running: boolean; connected: boolean; browser: string; mcpPort: number } {
  if (!globalManager || !globalConfig) {
    return { running: false, connected: false, browser: 'chrome', mcpPort: getConductorMcpPort() }
  }
  return {
    running: true,
    connected: globalManager.isConnected(),
    browser: globalManager.getBrowser(),
    mcpPort: getConductorMcpPort(),
  }
}

export function isGlobalVisionRunning(): boolean { return globalManager !== null }
export function getGlobalVisionConfig(): GlobalVisionConfig | null { return globalConfig }
export function tryReconnectGlobalVision(): void { if (globalManager) globalManager.tryReconnectNow() }

// === Browser launching (unchanged) ===

function getBrowserPaths(browser: 'chrome' | 'edge'): string[] {
  if (process.platform === 'darwin') {
    if (browser === 'edge') return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  }
  if (browser === 'edge') return [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
}

// Any browser CCC itself spawns is detached + unref'd, so without an explicit
// kill it survives app quit forever (orphan process tree + an open CDP debug port
// with no owner, showing as a blank window). Track the pid of whatever launchBrowser
// spawned — headless or headed, since both are CCC's own child — and tear it down on
// stop/quit (killSpawnedBrowser) and before any relaunch. A browser the USER opened
// themselves never comes through launchBrowser, so it is never tracked or killed.
let spawnedBrowserPid: number | null = null

// ── Heartbeat auto-relaunch ───────────────────────────────────────────────
let lastAutoRelaunchAt = 0
const AUTO_RELAUNCH_COOLDOWN_MS = 120_000

/** The heartbeat found the CDP endpoint dead. While vision is running
 *  (globalConfig set), relaunch OUR browser instead of reconnecting to a corpse
 *  forever — the panel otherwise sticks on "Browser launching…" until the user
 *  manually Stop/Starts. Cooldown-limited so a crash-looping browser can't
 *  spawn-storm. Returns whether a relaunch was attempted. Exported for tests. */
export function maybeAutoRelaunchBrowser(debugPort: number): boolean {
  const cfg = globalConfig
  if (!cfg || cfg.debugPort !== debugPort) return false
  const now = Date.now()
  if (now - lastAutoRelaunchAt < AUTO_RELAUNCH_COOLDOWN_MS) return false
  lastAutoRelaunchAt = now
  logInfo(`[vision] Browser gone on port ${debugPort} — auto-relaunching`)
  try {
    launchBrowser(cfg.browser, cfg.debugPort, cfg.url, cfg.headless !== false)
    return true
  } catch (err) {
    logInfo(`[vision] Auto-relaunch failed (heartbeat will retry): ${(err as Error)?.message ?? err}`)
    return false
  }
}

/** Test seam: clear the auto-relaunch cooldown. */
export function _resetAutoRelaunchForTest(): void { lastAutoRelaunchAt = 0 }

/** Kill ORPHANED debug browsers left over from a PREVIOUS CCC run. The tracked-pid
 *  kill above only covers this process's own spawn — after a crash the pid is lost
 *  and the detached browser survives as a blank zombie window that also holds the
 *  CDP port and the profile singleton lock (making the next launch silently fail).
 *  Match main processes (not --type= children) by the profile-dir signature we bake
 *  into the command line (`chrome-debug-<port>` / `msedge-debug-<port>`) and kill
 *  each tree. Best-effort: never throws, no-op when nothing matches. */
function sweepOrphanDebugBrowsers(debugPort: number): void {
  try {
    if (process.platform === 'win32') {
      const ps =
        `Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe' or Name='msedge.exe'\\" | ` +
        `Where-Object { $_.CommandLine -match 'debug-${debugPort}' -and $_.CommandLine -notmatch '--type=' } | ` +
        `ForEach-Object { taskkill /PID $_.ProcessId /T /F }`
      execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { windowsHide: true, timeout: 10000, stdio: 'ignore' })
    } else {
      execSync(`pkill -f -- "-debug-${debugPort}" || true`, { timeout: 10000, stdio: 'ignore' })
    }
  } catch { /* nothing matched / tool unavailable — best-effort */ }
}

/**
 * Kill the headless browser process tree CCC spawned, if any. Best-effort with a
 * hard fallback: taskkill /T /F (whole tree) on Windows, process.kill(-pid) on
 * POSIX. No-op when CCC didn't spawn one (e.g. user launched a headed browser).
 * Safe to call repeatedly; clears the tracked pid.
 */
export function killSpawnedBrowser(): void {
  const pid = spawnedBrowserPid
  spawnedBrowserPid = null
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      // /T kills the whole Chrome process tree (renderers/gpu), /F forces it.
      execSync(`taskkill /pid ${pid} /T /F`, { windowsHide: true, timeout: 5000 })
    } else {
      // Negative pid targets the detached process group (spawn was detached).
      try { process.kill(-pid, 'SIGTERM') } catch { process.kill(pid, 'SIGTERM') }
    }
    logInfo(`[vision] Killed CCC-spawned headless browser (pid ${pid})`)
  } catch {
    // Already exited / not found — nothing to clean up.
  }
}

/**
 * Build the browser launch args. Pure + exported for unit testing.
 *
 * P2.7: bind the CDP debug port to loopback (`--remote-debugging-address=
 * 127.0.0.1`) so the DevTools endpoint is never reachable from other hosts —
 * defense-in-depth rather than relying on Chrome's default-localhost behaviour.
 */
export function buildBrowserLaunchArgs(
  debugPort: number,
  profileDir: string,
  headless: boolean,
  url?: string,
): string[] {
  const args = [
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    // Automation hygiene: skip Chrome's first-run flow (it creates/repairs the
    // desktop + Start-menu shortcuts — on a OneDrive-synced Desktop that makes the
    // "Google Chrome" icon's sync-overlay flicker), and never prompt to become the
    // default browser. The debug profile is fresh each time, so first-run would
    // otherwise fire on every launch.
    '--no-first-run',
    '--no-default-browser-check',
  ]
  // --window-position offscreen is belt-and-braces: `--headless=new` is meant to
  // be windowless, but on Windows it can still flash/leak a blank window. Parking
  // it at -32000,-32000 means the user never sees it even if that happens.
  if (headless) args.push('--headless=new', '--disable-gpu', '--window-position=-32000,-32000')
  if (url) args.push(url)
  return args
}

export function launchBrowser(browser: 'chrome' | 'edge', debugPort: number, url?: string, headless: boolean = true): { pid: number; command: string } {
  // Relaunch path: kill the previous CCC-spawned browser first so we never
  // stack orphans (the --user-data-dir singleton means a stale one would also
  // reject the new debug port). Then sweep UNTRACKED orphans from a prior
  // crashed run — those hold the same profile lock and would make this spawn
  // silently die.
  killSpawnedBrowser()
  sweepOrphanDebugBrowsers(debugPort)

  const tmpDir = process.env.TEMP || process.env.TMP || os.tmpdir()
  const profileDir = path.join(tmpDir, `${browser}-debug-${debugPort}`)
  const other: 'chrome' | 'edge' = browser === 'edge' ? 'chrome' : 'edge'
  const fallback = process.platform === 'darwin'
    ? (browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome')
    : (browser === 'edge' ? 'msedge' : 'chrome')
  const executable =
    getBrowserPaths(browser).find(p => fs.existsSync(p)) ||
    getBrowserPaths(other).find(p => fs.existsSync(p)) ||
    fallback

  const args = buildBrowserLaunchArgs(debugPort, profileDir, headless, url)

  const command = `"${executable}" ${args.join(' ')}`
  logInfo(`[vision] Launching browser: ${command}`)
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: headless })
  child.on('error', (err) => {
    logInfo(`[vision] Browser launch failed; vision disabled (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
  })
  child.unref()
  // Track EVERY browser WE spawn (headless or headed) for teardown — anything
  // launched via launchBrowser is CCC's own detached child, so it must be killed
  // on stop/quit or it orphans as a blank window that outlives the app. (A browser
  // the USER opened themselves never comes through here, so it's never touched.)
  if (child.pid) spawnedBrowserPid = child.pid
  return { pid: child.pid || 0, command }
}
