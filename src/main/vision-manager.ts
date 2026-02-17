import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'
import { BrowserWindow, nativeImage } from 'electron'
import { getResourcesDirectory } from './ipc/setup-handlers'
import { logInfo, logError } from './debug-logger'

// chrome-remote-interface types
let CDP: any = null
function getCDP(): any {
  if (!CDP) {
    CDP = require('chrome-remote-interface')
  }
  return CDP
}

interface VisionCommand {
  command: string
  args: string[]
}

interface VisionResult {
  ok: boolean
  data?: any
  error?: string
  path?: string
}

interface VisionManagerEntry {
  manager: VisionManager
  sessionIds: Set<string>
}

// Registry: one VisionManager per debug port, ref-counted by session IDs
const registry = new Map<number, VisionManagerEntry>()

// Track which session maps to which debug port
const sessionPortMap = new Map<string, number>()

/**
 * Get the local machine's LAN IP address for SSH sessions to reach the proxy.
 */
function getLocalIp(): string {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return '127.0.0.1'
}

class VisionManager {
  private debugPort: number
  private browser: string
  private client: any = null
  private proxyServer: http.Server | null = null
  private proxyPort: number = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private connected: boolean = false
  private commandQueue: Promise<VisionResult> = Promise.resolve({ ok: true })
  private getWindow: (() => BrowserWindow | null) | null = null

  constructor(debugPort: number, browser: string) {
    this.debugPort = debugPort
    this.browser = browser
  }

  async start(getWindow: () => BrowserWindow | null): Promise<number> {
    this.getWindow = getWindow
    await this.startProxy()
    // Try to connect — don't throw if browser isn't running yet.
    // The heartbeat will pick it up when it launches.
    try {
      await this.connectCDP()
    } catch {
      logInfo(`[vision] Browser not reachable yet on port ${this.debugPort} — heartbeat will reconnect when it launches`)
    }
    this.startHeartbeat()
    return this.proxyPort
  }

  async stop(): Promise<void> {
    this.stopHeartbeat()
    if (this.proxyServer) {
      this.proxyServer.close()
      this.proxyServer = null
    }
    await this.disconnectCDP()
    this.connected = false
    logInfo(`[vision] Stopped VisionManager for port ${this.debugPort}`)
  }

  isConnected(): boolean {
    return this.connected
  }

  getProxyPort(): number {
    return this.proxyPort
  }

  getBrowser(): string {
    return this.browser
  }

  private async connectCDP(): Promise<void> {
    try {
      const cdp = getCDP()
      this.client = await cdp({ port: this.debugPort })
      await this.client.Page.enable()
      await this.client.Runtime.enable()
      await this.client.DOM.enable()
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
    const entry = registry.get(this.debugPort)
    if (!entry) return
    for (const sessionId of entry.sessionIds) {
      win.webContents.send('vision:statusChanged', {
        sessionId,
        connected: this.connected,
        browser: this.browser,
        proxyPort: this.proxyPort
      })
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
    }, 10000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private async startProxy(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proxyServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/command') {
          let body = ''
          req.on('data', (c) => { body += c })
          req.on('end', () => {
            try {
              const cmd: VisionCommand = JSON.parse(body)
              this.enqueueCommand(cmd).then((result) => {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify(result))
              })
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }))
            }
          })
        } else if (req.method === 'GET' && req.url === '/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, data: { connected: this.connected, browser: this.browser, port: this.debugPort } }))
        } else {
          res.writeHead(404)
          res.end()
        }
      })

      // Listen on 0.0.0.0 so SSH sessions on remote machines can reach the proxy
      this.proxyServer.listen(0, '0.0.0.0', () => {
        const addr = this.proxyServer!.address() as { port: number }
        this.proxyPort = addr.port
        logInfo(`[vision] HTTP proxy listening on 0.0.0.0:${this.proxyPort} (debug port ${this.debugPort})`)
        resolve()
      })

      this.proxyServer.on('error', (err) => {
        logError('[vision] Proxy server error:', err)
        reject(err)
      })
    })
  }

  private enqueueCommand(cmd: VisionCommand): Promise<VisionResult> {
    this.commandQueue = this.commandQueue.then(
      () => this.executeCommand(cmd),
      () => this.executeCommand(cmd)
    )
    return this.commandQueue
  }

  private async executeCommand(cmd: VisionCommand): Promise<VisionResult> {
    if (!this.connected || !this.client) {
      return { ok: false, error: 'Not connected to browser. Launch it first or check that it is running with --remote-debugging-port.' }
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
          await this.client.DOM.enable()
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

// === Vision CLAUDE.md Instructions ===

const VISION_MARKER_START = '<!-- VISION-INSTRUCTIONS-START -->'
const VISION_MARKER_END = '<!-- VISION-INSTRUCTIONS-END -->'

/**
 * Inject vision instructions into ~/.claude/CLAUDE.md so Claude
 * automatically knows about the vision CLI tools.
 * Uses section markers to add/update without clobbering user content.
 */
function injectVisionInstructions(): void {
  try {
    const promptFile = path.join(getResourcesDirectory(), 'scripts', 'vision-prompt.txt')
    if (!fs.existsSync(promptFile)) return

    const instructions = fs.readFileSync(promptFile, 'utf-8').trim()
    const section = `${VISION_MARKER_START}\n${instructions}\n${VISION_MARKER_END}`

    const claudeDir = path.join(os.homedir(), '.claude')
    const claudeMdPath = path.join(claudeDir, 'CLAUDE.md')

    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true })

    let existing = ''
    if (fs.existsSync(claudeMdPath)) {
      existing = fs.readFileSync(claudeMdPath, 'utf-8')
    }

    // Replace existing vision section or append
    const markerRegex = new RegExp(
      `${VISION_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${VISION_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      'g'
    )

    if (markerRegex.test(existing)) {
      const updated = existing.replace(markerRegex, section)
      fs.writeFileSync(claudeMdPath, updated)
    } else {
      const separator = existing.length > 0 ? '\n\n' : ''
      fs.writeFileSync(claudeMdPath, existing + separator + section + '\n')
    }
    logInfo('[vision] Injected vision instructions into ~/.claude/CLAUDE.md')
  } catch (err: any) {
    logError('[vision] Failed to inject CLAUDE.md instructions:', err?.message)
  }
}

/**
 * Remove vision instructions from ~/.claude/CLAUDE.md when no vision sessions remain.
 */
function removeVisionInstructions(): void {
  try {
    const claudeMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md')
    if (!fs.existsSync(claudeMdPath)) return

    const content = fs.readFileSync(claudeMdPath, 'utf-8')
    const markerRegex = new RegExp(
      `\\n?\\n?${VISION_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${VISION_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
      'g'
    )

    if (markerRegex.test(content)) {
      const cleaned = content.replace(markerRegex, '').trim()
      if (cleaned.length === 0) {
        fs.unlinkSync(claudeMdPath)
      } else {
        fs.writeFileSync(claudeMdPath, cleaned + '\n')
      }
      logInfo('[vision] Removed vision instructions from ~/.claude/CLAUDE.md')
    }
  } catch (err: any) {
    logError('[vision] Failed to clean CLAUDE.md instructions:', err?.message)
  }
}

/**
 * Generate shell commands to inject vision instructions into CLAUDE.md on a remote machine.
 */
export function getRemoteVisionInstructionsSetup(): string {
  try {
    const promptFile = path.join(getResourcesDirectory(), 'scripts', 'vision-prompt.txt')
    if (!fs.existsSync(promptFile)) return ''
    const instructions = fs.readFileSync(promptFile, 'utf-8').trim()
    // Escape single quotes for shell injection
    const escaped = instructions.replace(/'/g, "'\\''")
    return `mkdir -p ~/.claude 2>/dev/null; if ! grep -q 'VISION-INSTRUCTIONS-START' ~/.claude/CLAUDE.md 2>/dev/null; then echo '\\n${VISION_MARKER_START}\\n${escaped}\\n${VISION_MARKER_END}' >> ~/.claude/CLAUDE.md; fi`
  } catch {
    return ''
  }
}

// === Public API ===

export async function startVisionForSession(
  sessionId: string,
  debugPort: number,
  browser: string,
  getWindow: () => BrowserWindow | null
): Promise<number> {
  const existing = registry.get(debugPort)
  if (existing) {
    existing.sessionIds.add(sessionId)
    sessionPortMap.set(sessionId, debugPort)
    logInfo(`[vision] Session ${sessionId} joined existing VisionManager on port ${debugPort} (${existing.sessionIds.size} sessions)`)
    return existing.manager.getProxyPort()
  }

  const manager = new VisionManager(debugPort, browser)
  const proxyPort = await manager.start(getWindow)
  registry.set(debugPort, { manager, sessionIds: new Set([sessionId]) })
  sessionPortMap.set(sessionId, debugPort)

  // Inject vision instructions into CLAUDE.md on first vision session
  injectVisionInstructions()

  logInfo(`[vision] Started new VisionManager for session ${sessionId} on debug port ${debugPort}, proxy port ${proxyPort}`)
  return proxyPort
}

export function stopVisionForSession(sessionId: string): void {
  const debugPort = sessionPortMap.get(sessionId)
  if (!debugPort) return

  const entry = registry.get(debugPort)
  if (!entry) return

  entry.sessionIds.delete(sessionId)
  sessionPortMap.delete(sessionId)

  if (entry.sessionIds.size === 0) {
    entry.manager.stop()
    registry.delete(debugPort)
    // If no vision managers remain, clean up CLAUDE.md instructions
    if (registry.size === 0) {
      removeVisionInstructions()
    }
    logInfo(`[vision] Stopped VisionManager for port ${debugPort} (no more sessions)`)
  } else {
    logInfo(`[vision] Session ${sessionId} left VisionManager on port ${debugPort} (${entry.sessionIds.size} remaining)`)
  }
}

export function getVisionEnv(sessionId: string, forSSH: boolean = false): Record<string, string> {
  const debugPort = sessionPortMap.get(sessionId)
  if (!debugPort) return {}

  const entry = registry.get(debugPort)
  if (!entry) return {}

  const scriptsDir = path.join(getResourcesDirectory(), 'scripts')
  const cliPath = path.join(scriptsDir, 'vision-cli.js')

  const env: Record<string, string> = {
    VISION_PORT: String(entry.manager.getProxyPort()),
    VISION_CLI: cliPath
  }

  // For SSH sessions, set VISION_HOST to the LAN IP so remote can reach the proxy.
  // For local sessions, default 127.0.0.1 (the CLI defaults to this).
  if (forSSH) {
    env.VISION_HOST = getLocalIp()
  }

  return env
}

export function getVisionStatus(sessionId: string): { connected: boolean; browser: string; proxyPort: number } | null {
  const debugPort = sessionPortMap.get(sessionId)
  if (!debugPort) return null

  const entry = registry.get(debugPort)
  if (!entry) return null

  return {
    connected: entry.manager.isConnected(),
    browser: entry.manager.getBrowser(),
    proxyPort: entry.manager.getProxyPort()
  }
}

export function stopAllVisionManagers(): void {
  for (const [port, entry] of registry) {
    entry.manager.stop()
    logInfo(`[vision] Stopped VisionManager on port ${port} (app quit)`)
  }
  registry.clear()
  sessionPortMap.clear()
  removeVisionInstructions()
}

/**
 * Launch the browser with remote debugging enabled.
 * Returns the child process PID (for logging), or throws on failure.
 */
export function launchBrowser(browser: 'chrome' | 'edge', debugPort: number, url?: string): { pid: number; command: string } {
  const tmpDir = process.env.TEMP || process.env.TMP || os.tmpdir()
  const profileDir = path.join(tmpDir, `${browser}-debug-${debugPort}`)

  let executable: string
  if (browser === 'edge') {
    // Try common Edge paths
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

  // Navigate to URL if provided, otherwise open about:blank
  if (url) {
    args.push(url)
  }

  const command = `"${executable}" ${args.join(' ')}`
  logInfo(`[vision] Launching browser: ${command}`)

  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  })
  child.unref()

  return { pid: child.pid || 0, command }
}
