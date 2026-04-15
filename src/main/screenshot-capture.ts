import { BrowserWindow, desktopCapturer, nativeImage, ipcMain, screen } from 'electron'
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
const STORYBOARD_JPEG_QUALITY = 78

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

  // Minimize main window
  mainWindow.minimize()
  await new Promise<void>((resolve) => {
    const check = () => {
      if (mainWindow.isMinimized()) resolve()
      else setTimeout(check, 50)
    }
    setTimeout(check, 100)
  })

  // Let minimize animation complete
  await new Promise(r => setTimeout(r, 300))

  return new Promise<string | null>((resolve) => {
    const overlay = new BrowserWindow({
      x: 0,
      y: 0,
      width: screenW,
      height: screenH,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      fullscreen: true,
      webPreferences: {
        preload: join(__dirname, '../preload/screenshot-overlay.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    let resolved = false
    const cleanup = () => {
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
        await new Promise(r => setTimeout(r, 200))

        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: screenW * scaleFactor, height: screenH * scaleFactor }
        })

        if (sources.length === 0) {
          resolve(null)
          return
        }

        const img = sources[0].thumbnail
        const cropped = img.crop({
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

    // Load inline HTML for the overlay
    const html = getOverlayHtml()
    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  })
}

function getOverlayHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100vw;height:100vh;overflow:hidden;background:transparent;cursor:crosshair;user-select:none}
#overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.3)}
#selection{position:fixed;border:2px dashed #00FFFF;background:rgba(0,255,255,0.08);display:none;pointer-events:none;z-index:10}
#hint{position:fixed;bottom:40px;left:50%;transform:translateX(-50%);color:#fff;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;background:rgba(0,0,0,0.7);padding:8px 16px;border-radius:6px;z-index:20}
#dimensions{position:fixed;color:#00FFFF;font-family:'Cascadia Code',monospace;font-size:12px;background:rgba(0,0,0,0.7);padding:2px 6px;border-radius:3px;display:none;pointer-events:none;z-index:20}
</style>
</head>
<body>
<div id="overlay"></div>
<div id="selection"></div>
<div id="hint">Click and drag to select region \\u2022 Escape to cancel</div>
<div id="dimensions"></div>
<script>
const sel=document.getElementById('selection'),hint=document.getElementById('hint'),dims=document.getElementById('dimensions');
let sx=0,sy=0,dragging=false;
document.addEventListener('mousedown',e=>{sx=e.clientX;sy=e.clientY;dragging=true;sel.style.display='block';sel.style.left=sx+'px';sel.style.top=sy+'px';sel.style.width='0px';sel.style.height='0px';hint.style.display='none'});
document.addEventListener('mousemove',e=>{if(!dragging)return;const x=Math.min(e.clientX,sx),y=Math.min(e.clientY,sy),w=Math.abs(e.clientX-sx),h=Math.abs(e.clientY-sy);sel.style.left=x+'px';sel.style.top=y+'px';sel.style.width=w+'px';sel.style.height=h+'px';dims.style.display='block';dims.style.left=(x+w+8)+'px';dims.style.top=(y+h+8)+'px';dims.textContent=w+' \\u00d7 '+h});
document.addEventListener('mouseup',e=>{if(!dragging)return;dragging=false;const x=Math.min(e.clientX,sx),y=Math.min(e.clientY,sy),w=Math.abs(e.clientX-sx),h=Math.abs(e.clientY-sy);if(w<10||h<10){sel.style.display='none';dims.style.display='none';hint.style.display='block';return}window.screenshotAPI.selectRegion({x,y,width:w,height:h})});
document.addEventListener('keydown',e=>{if(e.key==='Escape')window.screenshotAPI.cancel()});
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

// ── Storyboard: repeated region capture ──────────────────────────────────

let storyboardRegion: { x: number; y: number; width: number; height: number } | null = null
let storyboardFrames: string[] = []
let storyboardCounter = 0

/**
 * Show the region-selection overlay (reuses captureRectangle's overlay) and
 * return the selected region without capturing a screenshot.
 * The region is saved internally for subsequent `captureStoryboardFrame()` calls.
 */
export async function startStoryboard(mainWindow: BrowserWindow): Promise<{ x: number; y: number; width: number; height: number } | null> {
  ensureDir()
  storyboardFrames = []
  storyboardCounter = 0

  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenW, height: screenH } = primaryDisplay.size

  // Minimize main window so user can see the screen
  mainWindow.minimize()
  await new Promise<void>((resolve) => {
    const check = () => {
      if (mainWindow.isMinimized()) resolve()
      else setTimeout(check, 50)
    }
    setTimeout(check, 100)
  })
  await new Promise(r => setTimeout(r, 300))

  return new Promise<{ x: number; y: number; width: number; height: number } | null>((resolve) => {
    const overlay = new BrowserWindow({
      x: 0,
      y: 0,
      width: screenW,
      height: screenH,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      fullscreen: true,
      webPreferences: {
        preload: join(__dirname, '../preload/screenshot-overlay.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    let resolved = false
    const cleanup = () => {
      if (!overlay.isDestroyed()) overlay.destroy()
      mainWindow.restore()
      mainWindow.focus()
    }

    const handleRegion = async (_event: unknown, region: { x: number; y: number; width: number; height: number }) => {
      if (resolved) return
      resolved = true
      ipcMain.removeHandler('screenshot:regionSelected')
      ipcMain.removeHandler('screenshot:cancelled')
      cleanup()
      storyboardRegion = region
      resolve(region)
    }

    const handleCancel = () => {
      if (resolved) return
      resolved = true
      ipcMain.removeHandler('screenshot:regionSelected')
      ipcMain.removeHandler('screenshot:cancelled')
      cleanup()
      storyboardRegion = null
      resolve(null)
    }

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

    const html = getOverlayHtml()
    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  })
}

/**
 * Capture a single frame of the saved storyboard region (no overlay).
 * Returns the file path of the saved JPEG, or null on error.
 */
export async function captureStoryboardFrame(): Promise<string | null> {
  if (!storyboardRegion) return null
  ensureDir()

  try {
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenW, height: screenH } = primaryDisplay.size
    const scaleFactor = primaryDisplay.scaleFactor

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: screenW * scaleFactor, height: screenH * scaleFactor }
    })
    if (sources.length === 0) return null

    const img = sources[0].thumbnail
    const cropped = img.crop({
      x: Math.round(storyboardRegion.x * scaleFactor),
      y: Math.round(storyboardRegion.y * scaleFactor),
      width: Math.round(storyboardRegion.width * scaleFactor),
      height: Math.round(storyboardRegion.height * scaleFactor)
    })

    storyboardCounter++
    const padded = String(storyboardCounter).padStart(3, '0')
    const dir = getScreenshotsDir()
    const filePath = join(dir, `storyboard-${padded}.jpg`)
    // Cap longest edge, preserving aspect ratio (storyboard frames also benefit
    // from compression since they're often captured every 1-3 seconds).
    const constrained = constrainToMaxDim(cropped, SCREENSHOT_MAX_DIM)
    writeFileSync(filePath, constrained.toJPEG(STORYBOARD_JPEG_QUALITY))
    storyboardFrames.push(filePath)
    return filePath
  } catch (err) {
    console.error('[screenshot] captureStoryboardFrame error:', err)
    return null
  }
}

/**
 * Stop the storyboard session and return all captured frame paths.
 */
export function stopStoryboard(): string[] {
  const frames = [...storyboardFrames]
  storyboardFrames = []
  storyboardRegion = null
  storyboardCounter = 0
  return frames
}

/**
 * Check whether a storyboard region is currently set (recording could be in progress).
 */
export function isStoryboardActive(): boolean {
  return storyboardRegion !== null
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
