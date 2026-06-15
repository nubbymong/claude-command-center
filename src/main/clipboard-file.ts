import { clipboard } from 'electron'
import { statSync, copyFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

// Reading copied FILE references off the clipboard (Unit 5 W1 / BUG-8).
// `clipboard.readImage()` is bitmap-only, so an image FILE copied in Explorer
// (Windows CF_HDROP) or Finder (macOS public.file-url) is invisible to it.
// These helpers recover the file path(s). The format strings go through
// Electron's experimental readBuffer/read/availableFormats APIs (stable in
// practice on Electron 42); every read is guarded against empty/short buffers.

/**
 * Decode a `file://` URL (macOS `public.file-url`) to an absolute path.
 * Strips the scheme + an optional `localhost` host, then percent-decodes.
 * Returns null for empty or non-file input.
 */
export function parseFileUrl(url: string): string | null {
  if (!url || !url.startsWith('file://')) return null
  let p = url.slice('file://'.length)
  if (p.startsWith('localhost')) p = p.slice('localhost'.length)
  try { p = decodeURIComponent(p) } catch { /* keep raw on malformed escapes */ }
  return p || null
}

/**
 * Decode a Windows DROPFILES (CF_HDROP) buffer into file paths.
 * Layout: UInt32LE(0) = offset to the path list, byte 13 = fWide (1 = UTF-16LE),
 * then a null-separated, double-null-terminated list. Returns [] on a malformed
 * or too-short buffer.
 */
export function parseHdropBuffer(buf: Buffer): string[] {
  if (!buf || buf.length < 20) return []
  const start = buf.readUInt32LE(0)
  if (start <= 0 || start >= buf.length) return []
  const wide = buf.readUInt8(13) !== 0
  const list = buf.subarray(start).toString(wide ? 'ucs2' : 'latin1')
  return list.split('\0').map((s) => s.trim()).filter(Boolean)
}

const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10 MB — a format-preserving copy skips the bitmap path's clamp

function extOf(p: string): string {
  const i = p.lastIndexOf('.')
  return i < 0 ? '' : p.slice(i).toLowerCase()
}

export type PasteableImage = { path: string } | { error: 'no-image' | 'too-large' }

/**
 * Pick the first clipboard file that's a pasteable raster image, enforcing the
 * 10 MB cap. Pure (size injected) so it's unit-testable. (Unit 5 W1)
 */
export function pickPasteableImage(paths: string[], sizeOf: (p: string) => number): PasteableImage {
  const images = paths.filter((p) => ALLOWED_IMAGE_EXTS.has(extOf(p)))
  if (images.length === 0) return { error: 'no-image' }
  const first = images[0]
  if (sizeOf(first) > MAX_IMAGE_BYTES) return { error: 'too-large' }
  return { path: first }
}

/** Read image-file paths off the clipboard, per platform (best-effort, guarded). */
export function readClipboardFilePaths(): string[] {
  try {
    const formats = clipboard.availableFormats()
    if (process.platform === 'win32') {
      if (formats.includes('CF_HDROP')) {
        const paths = parseHdropBuffer(clipboard.readBuffer('CF_HDROP'))
        if (paths.length) return paths
      }
      if (formats.includes('FileNameW')) {
        const p = clipboard.readBuffer('FileNameW').toString('ucs2').replace(/\0/g, '').trim()
        return p ? [p] : []
      }
      return []
    }
    if (process.platform === 'darwin' && formats.includes('public.file-url')) {
      const p = parseFileUrl(clipboard.read('public.file-url'))
      return p ? [p] : []
    }
  } catch { /* experimental clipboard formats — never throw into the paste path */ }
  return []
}

/**
 * BUG-8 fallback: when clipboard.readImage() is empty, recover a copied image
 * FILE, copy it (format-preserving) into the screenshots dir, and return its
 * path. Returns {error} for no usable image / oversize. (Unit 5 W1)
 */
export function readClipboardImageFilePath(screenshotsDir: string): PasteableImage {
  const picked = pickPasteableImage(readClipboardFilePaths(), (p) => {
    try { return statSync(p).size } catch { return Number.POSITIVE_INFINITY }
  })
  if (!('path' in picked)) return picked
  try {
    if (!statSync(picked.path).isFile()) return { error: 'no-image' }
    mkdirSync(screenshotsDir, { recursive: true })
    const dest = join(screenshotsDir, `clipboard-${Date.now()}-${randomBytes(4).toString('hex')}${extOf(picked.path)}`)
    copyFileSync(picked.path, dest)
    return { path: dest }
  } catch {
    return { error: 'no-image' }
  }
}
