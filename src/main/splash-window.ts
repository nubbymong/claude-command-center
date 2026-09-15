import { BrowserWindow, app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { splashBuildQuery } from './splash-info'
import { logInfo } from './debug-logger'

let splashWindow: BrowserWindow | null = null
let splashBackstopTimer: ReturnType<typeof setTimeout> | null = null
const SPLASH_MAX_MS = 15000

export const SPLASH_MIN_MS = 3600
export const SPLASH_POST_READY_MS = 1000
export let splashShownAt = Date.now()

declare const __APP_VERSION__: string
declare const __BUILD_SHA__: string
declare const __BUILD_TIME__: string
function getBuildIdentityInput(): { version: string; sha?: string; buildTime?: string } {
  let version = ''
  try { if (typeof __APP_VERSION__ === 'string' && __APP_VERSION__) version = __APP_VERSION__ } catch { /* undefined */ }
  if (!version) version = app.getVersion()
  let sha: string | undefined
  try { if (typeof __BUILD_SHA__ === 'string') sha = __BUILD_SHA__ } catch { /* undefined */ }
  let buildTime: string | undefined
  try { if (typeof __BUILD_TIME__ === 'string') buildTime = __BUILD_TIME__ } catch { /* undefined */ }
  return { version, sha, buildTime }
}

export function createSplashWindow(): void {
  if (process.env.CCC_E2E_DATA_DIR && process.env.CCC_FORCE_SPLASH !== '1') {
    logInfo('[splash] Skipped for e2e run')
    return
  }

  const splashHtml = join(__dirname, '..', '..', 'resources', 'splash', 'index.html')
  if (!existsSync(splashHtml)) {
    logInfo('[splash] Animated splash page not found, skipping')
    return
  }

  splashWindow = new BrowserWindow({
    width: 720,
    height: 430,
    frame: false,
    transparent: false,
    backgroundColor: '#0b0e15',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    center: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  splashWindow.webContents.on('did-fail-load', () => closeSplashWindow())
  splashWindow.webContents.on('render-process-gone', () => closeSplashWindow())

  splashWindow.loadFile(splashHtml, { query: splashBuildQuery(getBuildIdentityInput()) })
  splashWindow.once('ready-to-show', () => {
    splashShownAt = Date.now()
    splashWindow?.show()
  })

  splashBackstopTimer = setTimeout(() => closeSplashWindow(), SPLASH_MAX_MS)
}

export function closeSplashWindow(): void {
  if (splashBackstopTimer) { clearTimeout(splashBackstopTimer); splashBackstopTimer = null }
  if (!splashWindow || splashWindow.isDestroyed()) return
  const win = splashWindow
  splashWindow = null
  let op = 1
  const fade = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(fade); return }
    op -= 0.09
    if (op <= 0) {
      clearInterval(fade)
      if (!win.isDestroyed()) win.destroy()
      return
    }
    try { win.setOpacity(op) } catch { /* setOpacity unsupported -> destroy next tick */ }
  }, 28)
}
