/**
 * The animated boot splash. Lifted out of `index.ts` (2.1.1) as a pure move;
 * the rationale comments came with it.
 */
import { BrowserWindow, app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { splashBuildQuery } from './splash-info'
import { logInfo } from './debug-logger'

let splashWindow: BrowserWindow | null = null
// Unconditional backstop so the splash can never orphan. It is normally
// closed by the main window's ready-to-show; if that never fires (renderer
// crash, GPU wedge) or createWindow() throws, this timer force-closes it so
// the user is never left with a frameless, alwaysOnTop, taskbar-less window
// that also blocks app quit. Generous — well past the ~5s normal close.
let splashBackstopTimer: ReturnType<typeof setTimeout> | null = null
const SPLASH_MAX_MS = 15000

// Minimum on-screen time before the splash may close: enough for the animation
// (a 7 s authored timeline played at 2.0x in resources/splash/splash.js) to
// reach the finished brand lockup (~3.3 s) so it is never cut off mid-form.
export const SPLASH_MIN_MS = 3600
// After the main window is ready AND the lockup has formed, hold the finished
// lockup this long before fading — so the brand mark is clearly seen on every
// launch, even when the main window loads instantly.
export const SPLASH_POST_READY_MS = 1000
// When the splash became visible (its ready-to-show), which is when its
// animation clock actually starts — page load + module init put that a few
// hundred ms after window creation. Initialised to "now" so the skip paths
// (e2e, page missing) behave as if the splash showed instantly. A live `let`
// binding: index.ts reads it at reveal time and must never snapshot it.
export let splashShownAt = Date.now()

// Build-time defines (electron.vite.config.ts). Guarded with typeof so a
// context without the defines (unit tests, a bare tsx run) degrades to
// app.getVersion() + "dev" rather than a ReferenceError at boot.
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
  // Playwright-driven runs (e2e + the training-screenshot capture) assume the
  // first window is the main window; keep the splash out of them. The probe
  // that visually verifies the splash sets CCC_FORCE_SPLASH=1 to override.
  if (process.env.CCC_E2E_DATA_DIR && process.env.CCC_FORCE_SPLASH !== '1') {
    logInfo('[splash] Skipped for e2e run')
    return
  }

  // The animated splash is self-contained under resources/splash/ (packaged
  // inside the asar via the `files` glob). Resolve it relative to __dirname
  // (out/main/ in every launch mode): app.getAppPath() is the js file's
  // directory when Electron is handed out/main/index.js directly, which made
  // an appPath-based lookup miss. All assets are local — three.js and the
  // Montserrat subset are vendored — so it renders with no network. The page
  // carries its own <meta> CSP (script-src 'self', no 'unsafe-inline'): the
  // app-wide onHeadersReceived CSP does not reach a file:// document, so the
  // splash must police itself, which is why its script lives in a separate
  // module file rather than inline.
  const splashHtml = join(__dirname, '..', '..', 'resources', 'splash', 'index.html')
  if (!existsSync(splashHtml)) {
    logInfo('[splash] Animated splash page not found, skipping')
    return
  }

  splashWindow = new BrowserWindow({
    width: 720,
    height: 430,
    frame: false,
    // Opaque + frameless so Windows 11 gives the window its native rounded
    // corners (transparent windows lose them). The page paints #0b0e15.
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

  // If the splash page itself fails to load or its renderer dies, close it
  // rather than show a blank always-on-top window.
  splashWindow.webContents.on('did-fail-load', () => closeSplashWindow())
  splashWindow.webContents.on('render-process-gone', () => closeSplashWindow())

  // #384: the build identity ("v2.1.0-beta.17 · beta · build 3a1b2e2 ·
  // 2026-08-22") rides the URL query — the page is static with a strict CSP
  // (no inline script, no preload), so a query string read back by
  // splash-info.js is the one channel that needs no new capability. Only
  // main builds this URL; the page sets textContent, never markup.
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
  // Fade the whole window out (revealing the main window behind it), then
  // destroy. setOpacity on the window itself gives a clean cross-fade: the
  // splash is opaque (#0b0e15, for Win11 rounded corners), so fading the page
  // body would only reveal that dark rectangle, not the app.
  const win = splashWindow
  splashWindow = null // re-entrancy guard — a second close() is a no-op
  let op = 1
  const fade = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(fade); return }
    op -= 0.09
    if (op <= 0) {
      clearInterval(fade)
      if (!win.isDestroyed()) win.destroy()
      return
    }
    try { win.setOpacity(op) } catch { /* setOpacity unsupported → destroy next tick */ }
  }, 28)
}
