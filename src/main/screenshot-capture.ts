import { BrowserWindow, desktopCapturer, nativeImage } from 'electron'
import { join } from 'path'
import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import Screenshots from 'electron-screenshots'

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
 *
 * Backed by `electron-screenshots` — a maintained library that handles
 * the platform-specific stuff (multi-monitor, taskbar coverage, focus
 * routing, CSP-friendly preload) that our custom overlay kept tripping
 * on. We just hand it `startCapture()` and listen for the `ok` /
 * `cancel` / `save` events, then resize + JPG-encode the buffer it
 * gives us using the same constraints the rest of the app applies.
 *
 * The mainWindow arg is kept for API compatibility with the IPC
 * handler — the library ignores it and creates its own overlay.
 */
let captureInProgress = false
let screenshotsInstance: Screenshots | null = null

function getScreenshotsInstance(): Screenshots {
  if (!screenshotsInstance) {
    screenshotsInstance = new Screenshots({
      // singleWindow=false (default) gives a separate overlay per
      // display, so a 3-monitor setup doesn't end up with the live
      // taskbars of monitors 2/3 showing under the overlay on
      // monitor 1.
      // English labels — the library is authored in Chinese and
      // defaults to 坐标 (Coordinates), 确定 (OK), etc., which leak
      // into the magnifier + toolbar. These are the user-visible
      // strings; the library's internal logs stay Chinese (fine).
      lang: {
        magnifier_position_label: 'Position',
        operation_ok_title: 'OK',
        operation_cancel_title: 'Cancel',
        operation_save_title: 'Save',
        operation_redo_title: 'Redo',
        operation_undo_title: 'Undo',
        operation_mosaic_title: 'Mosaic',
        operation_text_title: 'Text',
        operation_brush_title: 'Brush',
        operation_arrow_title: 'Arrow',
        operation_ellipse_title: 'Ellipse',
        operation_rectangle_title: 'Rectangle',
      },
    })
  }
  return screenshotsInstance
}

export async function captureRectangle(_mainWindow: BrowserWindow): Promise<string | null> {
  if (captureInProgress) return null
  captureInProgress = true

  return new Promise<string | null>((resolve) => {
    const screenshots = getScreenshotsInstance()
    let settled = false

    const finish = (result: string | null) => {
      if (settled) return
      settled = true
      screenshots.removeAllListeners('ok')
      screenshots.removeAllListeners('cancel')
      screenshots.removeAllListeners('save')
      captureInProgress = false
      resolve(result)
    }

    const handleBuffer = (buffer: Buffer) => {
      try {
        ensureDir()
        const filename = generateFilename()
        const filePath = uniquePath(filename)
        const img = nativeImage.createFromBuffer(buffer)
        if (img.isEmpty()) {
          console.error('[screenshot] empty image from electron-screenshots')
          finish(null)
          return
        }
        // Same downscale + JPG encode the rest of the app uses, so
        // captures land under Claude's image-size budget every time.
        const constrained = constrainToMaxDim(img, SCREENSHOT_MAX_DIM)
        writeFileSync(filePath, constrained.toJPEG(SCREENSHOT_JPEG_QUALITY))
        finish(filePath)
      } catch (err) {
        console.error('[screenshot] save failed:', err)
        finish(null)
      }
    }

    // 'ok' fires when the user clicks the library's confirm button on
    // the overlay; 'save' fires when they pick "save" instead — same
    // buffer either way, so we treat both the same and drop our copy
    // into the screenshots dir.
    screenshots.on('ok', (_e, buffer, _data) => handleBuffer(buffer))
    screenshots.on('save', (_e, buffer, _data) => handleBuffer(buffer))
    screenshots.on('cancel', () => finish(null))

    screenshots.startCapture().catch((err: Error) => {
      console.error('[screenshot] startCapture failed:', err)
      finish(null)
    })
  })
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
