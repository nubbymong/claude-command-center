import { BrowserWindow, desktopCapturer, nativeImage, ipcMain, screen, globalShortcut } from 'electron'
import { join } from 'path'
import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'

import { getResourcesDirectory } from './ipc/setup-handlers'

function getScreenshotsDir(): string { return join(getResourcesDirectory(), 'screenshots') }

function ensureDir(): void {
  const dir = getScreenshotsDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function generateFilename(): string {
  const now = new Date()
  const ts = now.toISOString()
    .replace(/T/, '-')
    .replace(/:/g, '')
    .replace(/\.\d+Z/, '')
  return `screenshot-${ts}.jpg`
}

function uniquePath(filename: string): string {
  const dir = getScreenshotsDir()
  const fullPath = join(dir, filename)
  if (!existsSync(fullPath)) return fullPath
  const base = filename.replace('.jpg', '')
  return join(dir, `${base}-${randomBytes(3).toString('hex')}.jpg`)
}

/**
 * Resize a nativeImage so the longest edge is at most maxDim, preserving aspect ratio.
 * Returns the original image if it already fits.
 *
 * Important: passing both width and height to nativeImage.resize() will distort
 * non-square images. We compute one dimension from the ratio and pass only that.
 */
function constrainToMaxDim(img: ReturnType<typeof nativeImage.createFromBuffer>, maxDim: number) {
  const size = img.getSize()
  if (size.width <= maxDim && size.height <= maxDim) return img
  if (size.width >= size.height) {
    return img.resize({ width: maxDim, quality: 'good' as const })
  } else {
    return img.resize({ height: maxDim, quality: 'good' as const })
  }
}

const SCREENSHOT_MAX_DIM = 1920
const SCREENSHOT_JPEG_QUALITY = 85

/**
 * Capture a rectangle region of the screen.
 * Minimizes the main window, shows a fullscreen overlay for selection,
 * captures the screen, crops to selection, saves to SCREENSHOTS_DIR.
 */
let captureInProgress = false

export async function captureRectangle(mainWindow: BrowserWindow): Promise<string | null> {
  if (captureInProgress) return null // Prevent conflicting rapid calls
  captureInProgress = true
  try {
    return await _captureRectangleImpl(mainWindow)
  } finally {
    captureInProgress = false
  }
}

async function _captureRectangleImpl(mainWindow: BrowserWindow): Promise<string | null> {
  ensureDir()

  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenW, height: screenH } = primaryDisplay.size
  const scaleFactor = primaryDisplay.scaleFactor

  // Minimize main window. Bound the wait — on some Windows configs
  // (multi-monitor + alwaysOnTop apps stealing focus) `isMinimized()`
  // can stay false even after `minimize()` resolves the OS-level call.
  // Without a timeout we'd block here forever and the user would be
  // stuck with no way to dismiss Snap.
  mainWindow.minimize()
  await new Promise<void>((resolve) => {
    const start = Date.now()
    const check = () => {
      if (mainWindow.isMinimized() || Date.now() - start > 1500) resolve()
      else setTimeout(check, 50)
    }
    setTimeout(check, 100)
  })

  // Let minimize animation complete
  await new Promise(r => setTimeout(r, 300))

  // Capture the desktop NOW — before the overlay exists. Two reasons:
  //   1. The previous design used `transparent: true` on the overlay so
  //      the user could see through to the live desktop. On Windows the
  //      transparent compositor silently drops sub-pixel paint for the
  //      selection rectangle — the user sees the dimming overlay but
  //      not the rectangle they're dragging. Snipping Tool / ShareX
  //      avoid this by freezing the desktop into an opaque image and
  //      letting the user draw on top of THAT. Same trick here.
  //   2. We previously captured AGAIN after the user clicked-up, which
  //      meant a second IPC round-trip and a tiny window where another
  //      app could move/animate between freeze and selection. One
  //      capture, used for both preview and crop, is correct.
  let desktopImage: ReturnType<typeof nativeImage.createFromBuffer> | null = null
  let desktopDataUrl = ''
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: screenW * scaleFactor, height: screenH * scaleFactor },
    })
    if (sources.length > 0 && !sources[0].thumbnail.isEmpty()) {
      desktopImage = sources[0].thumbnail
      // Encode as JPG (much smaller than PNG for photographic content)
      // for embedding in the overlay HTML. q90 keeps the preview crisp
      // without blowing the data-URL up — at 1920×1080 this lands around
      // 300-500 KB; at 4K around 1-2 MB. Both load instantly on a local
      // data: URL.
      const previewBytes = desktopImage.toJPEG(90)
      desktopDataUrl = `data:image/jpeg;base64,${previewBytes.toString('base64')}`
    }
  } catch (err) {
    console.warn('[screenshot] pre-capture failed, falling back to live capture:', err)
  }
  if (!desktopImage || !desktopDataUrl) {
    // Pre-capture is required for the visible-rectangle pattern. If it
    // failed (no permission, no display source), bail rather than
    // showing a broken overlay.
    mainWindow.restore()
    mainWindow.focus()
    return null
  }

  return new Promise<string | null>((resolve) => {
    const overlay = new BrowserWindow({
      x: 0,
      y: 0,
      width: screenW,
      height: screenH,
      frame: false,
      // NOT transparent — we paint the captured desktop as the bg.
      // Opaque windows route input + paint reliably on Windows.
      transparent: false,
      backgroundColor: '#000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false,
      focusable: true,
      webPreferences: {
        preload: join(__dirname, '../preload/screenshot-overlay.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    let resolved = false
    // Safety net: if for any reason the overlay still fails to capture
    // input (OS compositor edge case, focus-stealer race), auto-cancel.
    // 120s was way too long — a user who hits a focus-trap is locked out
    // of the app for two minutes. 15s is enough for a deliberate drag
    // and short enough that "I'm stuck" is a brief annoyance, not a
    // crash.
    const safetyTimer = setTimeout(() => {
      if (resolved) return
      console.warn('[screenshot] overlay safety timeout — auto-cancelling')
      handleCancel()
    }, 15_000)

    // Belt-and-suspenders escape: register Esc as a global shortcut for
    // the lifetime of this overlay. Even if the overlay loses focus to
    // an alwaysOnTop app or the OS compositor doesn't route input, the
    // user can still hit Esc to kill the capture. Always unregister on
    // cleanup — leaving it bound would swallow Esc app-wide.
    let escRegistered = false
    try {
      escRegistered = globalShortcut.register('Escape', () => {
        if (!resolved) handleCancel()
      })
    } catch {
      // ignore — globalShortcut.register can fail when an unrelated
      // accelerator already owns Escape; the in-overlay Esc handler
      // is still our primary path.
    }

    const cleanup = () => {
      clearTimeout(safetyTimer)
      if (escRegistered) {
        try { globalShortcut.unregister('Escape') } catch { /* noop */ }
      }
      // Defensive: ipcMain.handle re-registration throws if a prior
      // run leaked handlers. Always remove on cleanup so the next
      // capture call lands on a clean slate even if we got here via
      // an unexpected path.
      try { ipcMain.removeHandler('screenshot:regionSelected') } catch { /* noop */ }
      try { ipcMain.removeHandler('screenshot:cancelled') } catch { /* noop */ }
      if (!overlay.isDestroyed()) overlay.destroy()
      mainWindow.restore()
      mainWindow.focus()
    }

    const handleRegion = async (_event: unknown, region: { x: number; y: number; width: number; height: number }) => {
      if (resolved) return
      resolved = true
      ipcMain.removeHandler('screenshot:regionSelected')
      ipcMain.removeHandler('screenshot:cancelled')

      try {
        cleanup()

        // Crop the desktop image we already captured before showing
        // the overlay. No second IPC round-trip, no race with on-screen
        // animations, and it's guaranteed to match exactly what the
        // user saw and dragged over.
        if (!desktopImage) {
          resolve(null)
          return
        }
        const cropped = desktopImage.crop({
          x: Math.round(region.x * scaleFactor),
          y: Math.round(region.y * scaleFactor),
          width: Math.round(region.width * scaleFactor),
          height: Math.round(region.height * scaleFactor)
        })

        const filename = generateFilename()
        const filePath = uniquePath(filename)
        // Cap longest edge to SCREENSHOT_MAX_DIM, preserving aspect ratio
        const constrained = constrainToMaxDim(cropped, SCREENSHOT_MAX_DIM)
        writeFileSync(filePath, constrained.toJPEG(SCREENSHOT_JPEG_QUALITY))
        resolve(filePath)
      } catch (err) {
        console.error('[screenshot] captureRectangle error:', err)
        resolve(null)
      }
    }

    const handleCancel = () => {
      if (resolved) return
      resolved = true
      ipcMain.removeHandler('screenshot:regionSelected')
      ipcMain.removeHandler('screenshot:cancelled')
      cleanup()
      resolve(null)
    }

    // Defensive registration: if a prior capture run leaked handlers
    // (renderer crash mid-overlay, hot-reload, etc.) ipcMain.handle
    // would throw "second handler registered". Drop any stale handler
    // first so registration always succeeds.
    try { ipcMain.removeHandler('screenshot:regionSelected') } catch { /* noop */ }
    try { ipcMain.removeHandler('screenshot:cancelled') } catch { /* noop */ }
    ipcMain.handle('screenshot:regionSelected', handleRegion)
    ipcMain.handle('screenshot:cancelled', handleCancel)

    overlay.on('closed', () => {
      if (!resolved) {
        resolved = true
        ipcMain.removeHandler('screenshot:regionSelected')
        ipcMain.removeHandler('screenshot:cancelled')
        mainWindow.restore()
        mainWindow.focus()
        resolve(null)
      }
    })

    // Show + focus only after the page is ready. Showing before load can
    // leave the window in the Windows "created but unfocused" state where
    // input events never reach the renderer; waiting for did-finish-load
    // gives Chromium time to register input handlers before we ask the
    // OS to focus it. Also force-elevate to 'screen-saver' so the overlay
    // sits above taskbar popups and always-on-top apps on Windows.
    overlay.once('ready-to-show', () => {
      if (overlay.isDestroyed()) return
      overlay.setAlwaysOnTop(true, 'screen-saver')
      overlay.show()
      overlay.focus()
      overlay.moveTop()
    })

    const html = getOverlayHtml(desktopDataUrl)
    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  })
}

function getOverlayHtml(desktopDataUrl: string): string {
  // Opaque overlay: the captured desktop is the bg, a 35%-black wash
  // sits over it for the dimming effect, the selection rectangle
  // shows the underlying desktop crisply (border + transparent fill).
  // Because the window is no longer `transparent: true`, every paint
  // lands reliably on Windows.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100vw;height:100vh;overflow:hidden;background:#000;cursor:crosshair;user-select:none}
#desktop{position:fixed;top:0;left:0;width:100%;height:100%;background-image:url('${desktopDataUrl}');background-size:100% 100%;background-repeat:no-repeat;z-index:0}
#dim{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.45);z-index:1;pointer-events:none}
/* Selection: 3px solid cyan + 1px black outline so it reads on any
 * wallpaper, with the dim wash NOT applied inside (we punch a "clear"
 * hole via inverse-alpha shadow). */
#selection{position:fixed;border:3px solid #00FFFF;outline:1px solid rgba(0,0,0,0.7);box-shadow:0 0 0 9999px rgba(0,0,0,0.45);display:none;pointer-events:none;z-index:5;box-sizing:border-box}
#hint{position:fixed;bottom:40px;left:50%;transform:translateX(-50%);color:#fff;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;background:rgba(0,0,0,0.75);padding:8px 16px;border-radius:6px;z-index:20}
#dimensions{position:fixed;color:#00FFFF;font-family:'Cascadia Code',monospace;font-size:13px;font-weight:600;background:rgba(0,0,0,0.9);padding:3px 8px;border-radius:3px;display:none;pointer-events:none;z-index:20}
#cancel-btn{position:fixed;top:20px;right:20px;background:rgba(0,0,0,0.85);color:#fff;border:1px solid #666;font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;padding:8px 18px;border-radius:6px;cursor:pointer;z-index:30}
#cancel-btn:hover{background:rgba(255,80,80,0.9);border-color:#ff5050}
</style>
</head>
<body>
<div id="desktop"></div>
<div id="dim"></div>
<div id="selection"></div>
<div id="hint">Click and drag to select region &bull; Esc or click Cancel to exit</div>
<div id="dimensions"></div>
<button id="cancel-btn" type="button">Cancel</button>
<script>
const sel=document.getElementById('selection'),dim=document.getElementById('dim'),hint=document.getElementById('hint'),dims=document.getElementById('dimensions'),cancelBtn=document.getElementById('cancel-btn');
let sx=0,sy=0,dragging=false;
function showSelection(){sel.style.display='block';dim.style.display='none'}
function hideSelection(){sel.style.display='none';dim.style.display='block';dims.style.display='none';hint.style.display='block'}
document.addEventListener('mousedown',e=>{if(e.target===cancelBtn)return;sx=e.clientX;sy=e.clientY;dragging=true;sel.style.left=sx+'px';sel.style.top=sy+'px';sel.style.width='0px';sel.style.height='0px';showSelection();hint.style.display='none'});
document.addEventListener('mousemove',e=>{if(!dragging)return;const x=Math.min(e.clientX,sx),y=Math.min(e.clientY,sy),w=Math.abs(e.clientX-sx),h=Math.abs(e.clientY-sy);sel.style.left=x+'px';sel.style.top=y+'px';sel.style.width=w+'px';sel.style.height=h+'px';dims.style.display='block';dims.style.left=(x+w+8)+'px';dims.style.top=(y+h+8)+'px';dims.textContent=w+' × '+h});
document.addEventListener('mouseup',e=>{if(!dragging)return;dragging=false;const x=Math.min(e.clientX,sx),y=Math.min(e.clientY,sy),w=Math.abs(e.clientX-sx),h=Math.abs(e.clientY-sy);if(w<10||h<10){hideSelection();return}window.screenshotAPI.selectRegion({x,y,width:w,height:h})});
document.addEventListener('keydown',e=>{if(e.key==='Escape')window.screenshotAPI.cancel()});
cancelBtn.addEventListener('click',()=>window.screenshotAPI.cancel());
document.body.tabIndex=0;document.body.focus();
window.addEventListener('blur',()=>{setTimeout(()=>{try{document.body.focus()}catch(e){}},100)});
</script>
</body>
</html>`
}

/**
 * Capture a specific window by its desktopCapturer source ID.
 */
export async function captureWindow(sourceId: string): Promise<string | null> {
  ensureDir()
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 3840, height: 2160 }
    })

    const source = sources.find(s => s.id === sourceId)
    if (!source || source.thumbnail.isEmpty()) return null

    const filename = generateFilename()
    const filePath = uniquePath(filename)
    // Cap longest edge, preserving aspect ratio
    const constrained = constrainToMaxDim(source.thumbnail, SCREENSHOT_MAX_DIM)
    writeFileSync(filePath, constrained.toJPEG(SCREENSHOT_JPEG_QUALITY))
    return filePath
  } catch (err) {
    console.error('[screenshot] captureWindow error:', err)
    return null
  }
}

/**
 * List available windows for capture.
 */
export async function listWindows(): Promise<Array<{ id: string; name: string; thumbnail: string }>> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 200, height: 150 }
    })

    return sources
      .filter(s => !s.thumbnail.isEmpty() && !s.name.includes('Claude Command Center'))
      .map(s => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toPNG().toString('base64')
      }))
  } catch (err) {
    console.error('[screenshot] listWindows error:', err)
    return []
  }
}

/**
 * List recent screenshots with thumbnails.
 */
export async function listRecentScreenshots(): Promise<Array<{
  filename: string
  path: string
  timestamp: number
  thumbnail: string
}>> {
  ensureDir()
  try {
    const dir = getScreenshotsDir()
    const files = readdirSync(dir)
      .filter(f => f.startsWith('screenshot-') && (f.endsWith('.jpg') || f.endsWith('.png')))

    const entries = files.map(f => {
      const fullPath = join(dir, f)
      const stat = statSync(fullPath)
      return { filename: f, path: fullPath, timestamp: stat.mtimeMs }
    })

    entries.sort((a, b) => b.timestamp - a.timestamp)

    return entries.slice(0, 20).map(entry => {
      try {
        const img = nativeImage.createFromPath(entry.path)
        const resized = img.resize({ width: 120, height: 90 })
        return {
          ...entry,
          thumbnail: resized.toPNG().toString('base64')
        }
      } catch {
        return { ...entry, thumbnail: '' }
      }
    })
  } catch (err) {
    console.error('[screenshot] listRecentScreenshots error:', err)
    return []
  }
}

/**
 * Delete screenshots older than maxAgeDays.
 */
export async function cleanupOldScreenshots(maxAgeDays: number): Promise<number> {
  ensureDir()
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  let deleted = 0

  try {
    const dir = getScreenshotsDir()
    const files = readdirSync(dir)
      .filter(f => f.startsWith('screenshot-') && (f.endsWith('.jpg') || f.endsWith('.png')))

    for (const f of files) {
      const fullPath = join(dir, f)
      try {
        const stat = statSync(fullPath)
        if (stat.mtimeMs < cutoff) {
          unlinkSync(fullPath)
          deleted++
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    console.error('[screenshot] cleanup error:', err)
  }

  return deleted
}
