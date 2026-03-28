/**
 * Vision Manager — global CDP browser automation for Claude Code via MCP.
 * Manages a single VisionManager instance (singleton) with CDP connection,
 * heartbeat, and browser launching. The MCP SSE server (vision-mcp-server.ts)
 * wraps this to expose tools to Claude Code sessions.
 */

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'
import { BrowserWindow, nativeImage } from 'electron'
import { getResourcesDirectory } from './ipc/setup-handlers'
import { logInfo, logError } from './debug-logger'
import { startMcpServer, stopMcpServer } from './vision-mcp-server'
import type { GlobalVisionConfig } from '../shared/types'

// chrome-remote-interface types
let CDP: any = null
function getCDP(): any {
  if (!CDP) {
    CDP = require('chrome-remote-interface')
  }
  return CDP
}

export interface VisionCommand {
  command: string
  args: string[]
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

class VisionManager {
  private debugPort: number
  private browser: string
  private client: any = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private connected: boolean = false
  private getWindow: (() => BrowserWindow | null) | null = null

  constructor(debugPort: number, browser: string) {
    this.debugPort = debugPort
    this.browser = browser
  }

  async start(getWindow: () => BrowserWindow | null): Promise<void> {
    this.getWindow = getWindow
    // Try to connect — don't throw if browser isn't running yet.
    // The heartbeat will pick it up when it launches.
    try {
      await this.connectCDP()
    } catch {
      logInfo(`[vision] Browser not reachable yet on port ${this.debugPort} — heartbeat will reconnect when it launches`)
    }
    this.startHeartbeat()
  }

  async stop(): Promise<void> {
    this.stopHeartbeat()
    await this.disconnectCDP()
    this.connected = false
    logInfo(`[vision] Stopped VisionManager for port ${this.debugPort}`)
  }

  isConnected(): boolean {
    return this.connected
  }

  getBrowser(): string {
    return this.browser
  }

  getDebugPort(): number {
    return this.debugPort
  }

  private async connectCDP(): Promise<void> {
    try {
      const cdp = getCDP()
      this.client = await cdp({ port: this.debugPort })
      await this.client.Page.enable()
      await this.client.Runtime.enable()
      // Note: DOM.enable() intentionally omitted — it subscribes to every DOM mutation
      // event which is very expensive on complex pages. We use Runtime.evaluate instead.
      this.connected = true
      logInfo(`[vision] CDP connected to ${this.browser} on port ${this.debugPort}`)
    } catch (err: any) {
      this.connected = false
      throw new Error(`Cannot connect to browser on port ${this.debugPort}`)
    }
  }

  private async disconnectCDP(): Promise<void> {
    if (this.client) {
      try { await this.client.close() } catch { /* ignore */ }
      this.client = null
    }
  }

  private async reconnectCDP(): Promise<void> {
    const wasConnected = this.connected
    await this.disconnectCDP()
    try {
      await this.connectCDP()
      if (!wasConnected) {
        this.notifyStatusChange()
      }
    } catch {
      if (wasConnected) {
        this.connected = false
        this.notifyStatusChange()
      }
    }
  }

  private notifyStatusChange(): void {
    const win = this.getWindow?.()
    if (!win || win.isDestroyed()) return
    win.webContents.send('vision:statusChanged', {
      connected: this.connected,
      browser: this.browser,
      mcpPort: globalConfig?.mcpPort || 0
    })
  }

  /** Immediately attempt CDP reconnection (called after browser launch) */
  async tryReconnectNow(): Promise<void> {
    // Give Chrome a moment to start its debug server
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(r => setTimeout(r, 1500))
      try {
        await this.connectCDP()
        this.notifyStatusChange()
        return
      } catch {
        // Keep trying
      }
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: this.debugPort,
        path: '/json/version',
        method: 'GET',
        timeout: 5000
      }, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          if (!this.connected) {
            logInfo(`[vision] Browser heartbeat restored on port ${this.debugPort}, reconnecting...`)
            this.reconnectCDP()
          }
        })
      })
      req.on('error', () => {
        if (this.connected) {
          logInfo(`[vision] Browser heartbeat lost on port ${this.debugPort}`)
          this.connected = false
          this.notifyStatusChange()
        }
      })
      req.on('timeout', () => {
        req.destroy()
        if (this.connected) {
          this.connected = false
          this.notifyStatusChange()
        }
      })
      req.end()
    }, 30000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** Execute a vision command against the connected browser. */
  async executeCommand(cmd: VisionCommand): Promise<VisionResult> {
    if (!this.connected || !this.client) {
      return { ok: false, error: 'Not connected to browser. Launch it from the Vision page or check that it is running with --remote-debugging-port.' }
    }

    try {
      switch (cmd.command) {
        case 'status':
          return { ok: true, data: { connected: true, browser: this.browser, debugPort: this.debugPort } }

        case 'tabs': {
          const cdp = getCDP()
          const targets = await cdp.List({ port: this.debugPort })
          const tabs = targets
            .filter((t: any) => t.type === 'page')
            .map((t: any, i: number) => ({ index: i, title: t.title, url: t.url }))
          return { ok: true, data: tabs }
        }

        case 'tab': {
          const idx = parseInt(cmd.args[0], 10)
          if (isNaN(idx)) return { ok: false, error: 'tab requires a numeric index' }
          const cdp = getCDP()
          const targets = await cdp.List({ port: this.debugPort })
          const pages = targets.filter((t: any) => t.type === 'page')
          if (idx < 0 || idx >= pages.length) return { ok: false, error: `Tab index ${idx} out of range (0-${pages.length - 1})` }
          await this.disconnectCDP()
          this.client = await cdp({ port: this.debugPort, target: pages[idx] })
          await this.client.Page.enable()
          await this.client.Runtime.enable()
          this.connected = true
          return { ok: true, data: { index: idx, title: pages[idx].title, url: pages[idx].url } }
        }

        case 'screenshot': {
          const { data } = await this.client.Page.captureScreenshot({ format: 'jpeg', quality: 75 })
          const screenshotsDir = path.join(getResourcesDirectory(), 'screenshots')
          if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true })
          const filename = `vision-${Date.now()}.jpg`
          const filePath = path.join(screenshotsDir, filename)

          // Downscale high-res captures to cap token usage (max 1280px wide)
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
          await this.client.Page.navigate({ url })
          await this.client.Page.loadEventFired()
          return { ok: true, data: { url } }
        }

        case 'click': {
          const target = cmd.args[0]
          if (!target) return { ok: false, error: 'click requires a CSS selector or x,y coordinates' }
          const coordMatch = target.match(/^(\d+),(\d+)$/)
          if (coordMatch) {
            const x = parseInt(coordMatch[1], 10)
            const y = parseInt(coordMatch[2], 10)
            await this.client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
            await this.client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
            return { ok: true, data: { x, y } }
          }
          const { result } = await this.client.Runtime.evaluate({
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
          await this.client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
          await this.client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
          return { ok: true, data: { selector: target, x, y } }
        }

        case 'type': {
          const selector = cmd.args[0]
          const text = cmd.args.slice(1).join(' ')
          if (!selector || !text) return { ok: false, error: 'type requires <selector> <text>' }
          await this.client.Runtime.evaluate({
            expression: `document.querySelector(${JSON.stringify(selector)})?.focus()`
          })
          for (const char of text) {
            await this.client.Input.dispatchKeyEvent({ type: 'keyDown', text: char })
            await this.client.Input.dispatchKeyEvent({ type: 'keyUp', text: char })
          }
          return { ok: true, data: { selector, text } }
        }

        case 'eval': {
          const expression = cmd.args.join(' ')
          if (!expression) return { ok: false, error: 'eval requires an expression' }
          const { result, exceptionDetails } = await this.client.Runtime.evaluate({
            expression,
            returnByValue: true,
            awaitPromise: true
          })
          if (exceptionDetails) {
            return { ok: false, error: exceptionDetails.text || 'Evaluation error' }
          }
          return { ok: true, data: result.value }
        }

        case 'wait': {
          const selector = cmd.args[0]
          const timeoutMs = parseInt(cmd.args[1], 10) || 5000
          if (!selector) return { ok: false, error: 'wait requires a CSS selector' }
          const startTime = Date.now()
          while (Date.now() - startTime < timeoutMs) {
            const { result } = await this.client.Runtime.evaluate({
              expression: `!!document.querySelector(${JSON.stringify(selector)})`,
              returnByValue: true
            })
            if (result.value) return { ok: true, data: { selector, elapsed: Date.now() - startTime } }
            await new Promise(r => setTimeout(r, 200))
          }
          return { ok: false, error: `Timeout waiting for ${selector} (${timeoutMs}ms)` }
        }

        case 'html': {
          const selector = cmd.args[0] || 'body'
          const { result } = await this.client.Runtime.evaluate({
            expression: `document.querySelector(${JSON.stringify(selector)})?.innerHTML`,
            returnByValue: true
          })
          if (result.value === undefined) return { ok: false, error: `Element not found: ${selector}` }
          return { ok: true, data: result.value }
        }

        case 'text': {
          const selector = cmd.args[0] || 'body'
          const { result } = await this.client.Runtime.evaluate({
            expression: `document.querySelector(${JSON.stringify(selector)})?.textContent`,
            returnByValue: true
          })
          if (result.value === undefined) return { ok: false, error: `Element not found: ${selector}` }
          return { ok: true, data: result.value }
        }

        case 'title': {
          const { result } = await this.client.Runtime.evaluate({
            expression: 'document.title',
            returnByValue: true
          })
          return { ok: true, data: result.value }
        }

        case 'url': {
          const { result } = await this.client.Runtime.evaluate({
            expression: 'window.location.href',
            returnByValue: true
          })
          return { ok: true, data: result.value }
        }

        case 'back':
          await this.client.Runtime.evaluate({ expression: 'window.history.back()' })
          await new Promise(r => setTimeout(r, 500))
          return { ok: true, data: 'navigated back' }

        case 'forward':
          await this.client.Runtime.evaluate({ expression: 'window.history.forward()' })
          await new Promise(r => setTimeout(r, 500))
          return { ok: true, data: 'navigated forward' }

        case 'reload':
          await this.client.Page.reload()
          await this.client.Page.loadEventFired()
          return { ok: true, data: 'reloaded' }

        case 'scroll': {
          const direction = cmd.args[0] || 'down'
          const px = parseInt(cmd.args[1], 10) || 400
          const scrollMap: Record<string, string> = {
            down: `window.scrollBy(0, ${px})`,
            up: `window.scrollBy(0, -${px})`,
            left: `window.scrollBy(-${px}, 0)`,
            right: `window.scrollBy(${px}, 0)`
          }
          const expr = scrollMap[direction]
          if (!expr) return { ok: false, error: `Invalid scroll direction: ${direction}. Use up/down/left/right.` }
          await this.client.Runtime.evaluate({ expression: expr })
          return { ok: true, data: { direction, px } }
        }

        default:
          return { ok: false, error: `Unknown command: ${cmd.command}. Available: status, tabs, tab, screenshot, navigate, click, type, eval, wait, html, text, title, url, back, forward, reload, scroll` }
      }
    } catch (err: any) {
      logError(`[vision] Command '${cmd.command}' failed:`, err?.message || err)
      if (err?.message?.includes('not attached') || err?.message?.includes('ECONNREFUSED') || err?.message?.includes('WebSocket')) {
        this.connected = false
        this.notifyStatusChange()
      }
      return { ok: false, error: err?.message || 'Command failed' }
    }
  }
}

// === Settings.json MCP config management ===

function injectMcpSettings(mcpPort: number): void {
  const entry = { url: `http://localhost:${mcpPort}/sse` }

  // Write to ~/.claude/settings.json
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
    let settings: any = {}
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) } catch { /* file may not exist */ }
    if (!settings.mcpServers) settings.mcpServers = {}
    settings.mcpServers['conductor-vision'] = entry
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  } catch (err: any) {
    logError('[vision] Failed to inject settings.json MCP:', err?.message)
  }

  // Also write to ~/.claude.json (Claude Code reads MCP servers from here too)
  try {
    const claudeJsonPath = path.join(os.homedir(), '.claude.json')
    let cj: any = {}
    try { cj = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) } catch { /* file may not exist */ }
    if (!cj.mcpServers) cj.mcpServers = {}
    cj.mcpServers['conductor-vision'] = entry
    fs.writeFileSync(claudeJsonPath, JSON.stringify(cj, null, 2))
  } catch (err: any) {
    logError('[vision] Failed to inject .claude.json MCP:', err?.message)
  }

  logInfo(`[vision] Injected MCP server config (port ${mcpPort})`)
}

function removeMcpSettings(): void {
  // Remove from ~/.claude/settings.json
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      if (settings.mcpServers?.['conductor-vision']) {
        delete settings.mcpServers['conductor-vision']
        if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
      }
    }
  } catch (err: any) {
    logError('[vision] Failed to remove settings.json MCP:', err?.message)
  }

  // Remove from ~/.claude.json
  try {
    const claudeJsonPath = path.join(os.homedir(), '.claude.json')
    if (fs.existsSync(claudeJsonPath)) {
      const cj = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'))
      if (cj.mcpServers?.['conductor-vision']) {
        delete cj.mcpServers['conductor-vision']
        if (Object.keys(cj.mcpServers).length === 0) delete cj.mcpServers
        fs.writeFileSync(claudeJsonPath, JSON.stringify(cj, null, 2))
      }
    }
  } catch (err: any) {
    logError('[vision] Failed to remove .claude.json MCP:', err?.message)
  }

  logInfo('[vision] Removed MCP server config')
}

/** One-time cleanup: remove old CLAUDE.md vision markers from the legacy per-session system. */
export function cleanupLegacyVisionMarkers(): void {
  try {
    const claudeMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md')
    if (!fs.existsSync(claudeMdPath)) return

    const content = fs.readFileSync(claudeMdPath, 'utf-8')
    const markerRegex = /\n?\n?<!-- VISION-INSTRUCTIONS-START -->[\s\S]*?<!-- VISION-INSTRUCTIONS-END -->\n?/g

    if (markerRegex.test(content)) {
      const cleaned = content.replace(markerRegex, '').trim()
      if (cleaned.length === 0) {
        fs.unlinkSync(claudeMdPath)
      } else {
        fs.writeFileSync(claudeMdPath, cleaned + '\n')
      }
      logInfo('[vision] Cleaned up legacy vision markers from ~/.claude/CLAUDE.md')
    }
  } catch (err: any) {
    logError('[vision] Failed to clean legacy CLAUDE.md markers:', err?.message)
  }
}

// === Public API (global singleton) ===

export async function startGlobalVision(
  config: GlobalVisionConfig,
  getWindow: () => BrowserWindow | null
): Promise<void> {
  // Stop existing if running
  if (globalManager) {
    await stopGlobalVision()
  }

  globalConfig = config
  const manager = new VisionManager(config.debugPort, config.browser)
  await manager.start(getWindow)
  globalManager = manager

  // Start MCP SSE server
  await startMcpServer(config.mcpPort, manager)

  // Inject MCP settings into Claude Code
  injectMcpSettings(config.mcpPort)

  // Clean up any legacy CLAUDE.md markers
  cleanupLegacyVisionMarkers()

  logInfo(`[vision] Global vision started: CDP port ${config.debugPort}, MCP port ${config.mcpPort}`)
}

export async function stopGlobalVision(): Promise<void> {
  if (globalManager) {
    // Sync cleanup first (safe to run without await — critical for before-quit handler)
    stopMcpServer()
    removeMcpSettings()
    // Async cleanup (CDP disconnect)
    await globalManager.stop()
    globalManager = null
    logInfo('[vision] Global vision stopped')
  }
  globalConfig = null
}

export function getGlobalVisionStatus(): { running: boolean; connected: boolean; browser: string; mcpPort: number } {
  if (!globalManager || !globalConfig) {
    return { running: false, connected: false, browser: 'chrome', mcpPort: 0 }
  }
  return {
    running: true,
    connected: globalManager.isConnected(),
    browser: globalManager.getBrowser(),
    mcpPort: globalConfig.mcpPort
  }
}

export function isGlobalVisionRunning(): boolean {
  return globalManager !== null
}

export function getGlobalVisionConfig(): GlobalVisionConfig | null {
  return globalConfig
}

export function tryReconnectGlobalVision(): void {
  if (globalManager) {
    globalManager.tryReconnectNow()
  }
}

// === Browser launching (unchanged) ===

export function launchBrowser(browser: 'chrome' | 'edge', debugPort: number, url?: string, headless: boolean = true): { pid: number; command: string } {
  const tmpDir = process.env.TEMP || process.env.TMP || os.tmpdir()
  const profileDir = path.join(tmpDir, `${browser}-debug-${debugPort}`)

  let executable: string
  if (browser === 'edge') {
    const edgePaths = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    executable = edgePaths.find(p => fs.existsSync(p)) || 'msedge'
  } else {
    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]
    executable = chromePaths.find(p => fs.existsSync(p)) || 'chrome'
  }

  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
  ]

  if (headless) {
    args.push('--headless=new', '--disable-gpu')
  }

  if (url) {
    args.push(url)
  }

  const command = `"${executable}" ${args.join(' ')}`
  logInfo(`[vision] Launching browser: ${command}`)

  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: headless
  })
  child.unref()

  return { pid: child.pid || 0, command }
}
