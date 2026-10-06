import { clipboard } from 'electron'
import { statSync, copyFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { fileURLToPath } from 'url'

// Reading copied FILE references off the clipboard (Unit 5 W1 / BUG-8).
// A bitmap read sees only bitmaps, so an image FILE copied in Explorer or
// Finder is invisible to it. These helpers recover the file path(s).
//
// Electron 44 reads the clipboard through `clipboard.read()` (ClipboardItem[],
// W3C shaped). Copied files arrive as `text/uri-list`, which Electron maps to
// the platform's own copied-files format (CF_HDROP on Windows, the file
// pasteboard type on macOS): an RFC 2483 list of file:// URIs. Windows also
// keeps the raw `FileNameW` format (one UTF-16LE path), reached through
// Electron's `osclipboard` custom format. Every read is guarded: a failure is
// "no file", never an error into the paste path.

/** The MIME type Electron 44 gives copied files (an RFC 2483 file:// URI list). */
export const URI_LIST_TYPE = 'text/uri-list'
/** Windows' raw FileNameW format (one NUL-terminated UTF-16LE path). */
export const FILENAMEW_TYPE = 'electron application/osclipboard;format="FileNameW"'

/**
 * A path the paste may stat and copy from: absolute, with no NUL, and not in a
 * Windows device namespace (a path starting with two separators and then `.`
 * or `?`, either slash), where a stat could open a pipe or a raw device
 * instead of reading a file's attributes. A drive path and a UNC share path
 * (two separators, server, share) pass on Windows, as a file copied from a
 * share in Explorer always did; elsewhere only an absolute `/` path.
 */
export function isClipboardFilePath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) return false
  if (platform === 'win32') {
    const w = p.replace(/\//g, '\\')
    if (/^\\\\[.?]\\/.test(w)) return false
    return /^[A-Za-z]:\\/.test(w) || /^\\\\[^\\]+\\[^\\]+/.test(w)
  }
  return p.startsWith('/')
}

/**
 * Turn an RFC 2483 URI list (`text/uri-list`) into the absolute paths it names.
 * Lines end in CRLF (a bare LF is tolerated); a line starting with `#` is a
 * comment; only `file:` URIs count. Each is converted with `url.fileURLToPath`
 * for this platform, which percent-decodes, refuses an encoded slash or
 * backslash, and on Windows turns a host into a UNC path (elsewhere a host other
 * than localhost is refused). A URI that does not convert, or converts to a path
 * isClipboardFilePath refuses, is dropped.
 */
export function uriListToPaths(list: string): string[] {
  if (typeof list !== 'string' || list.length === 0) return []
  const paths: string[] = []
  for (const raw of list.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (!/^file:/i.test(line)) continue
    let p: string
    try { p = fileURLToPath(line) } catch { continue }
    if (isClipboardFilePath(p)) paths.push(p)
  }
  return paths
}

/** The text of a ClipboardItem payload (a Blob), or '' for anything else. */
async function payloadText(payload: unknown): Promise<string> {
  if (!payload || typeof (payload as Blob).text !== 'function') return ''
  const t: unknown = await (payload as Blob).text()
  return typeof t === 'string' ? t : ''
}

/** The bytes of a ClipboardItem payload (a Blob), or an empty buffer for anything else. */
async function payloadBytes(payload: unknown): Promise<Buffer> {
  if (!payload || typeof (payload as Blob).arrayBuffer !== 'function') return Buffer.alloc(0)
  return Buffer.from(await (payload as Blob).arrayBuffer())
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

/**
 * Read copied file paths off the clipboard, on Windows and macOS (as before;
 * Linux has no copied-file paste). `text/uri-list` first; on Windows the raw
 * FileNameW format when the list gives nothing. Best-effort: never throws.
 */
export async function readClipboardFilePaths(): Promise<string[]> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return []
  try {
    const items = await clipboard.read()
    const withType = (t: string) => items.find((it) => Array.isArray(it?.types) && it.types.includes(t))
    const uriItem = withType(URI_LIST_TYPE)
    if (uriItem) {
      const paths = uriListToPaths(await payloadText(await uriItem.getType(URI_LIST_TYPE)))
      if (paths.length) return paths
    }
    if (process.platform === 'win32') {
      const nameItem = withType(FILENAMEW_TYPE)
      if (nameItem) {
        // One path, ending at its NUL: what follows it in the block is not a path.
        const p = (await payloadBytes(await nameItem.getType(FILENAMEW_TYPE))).toString('ucs2').split('\0')[0].trim()
        return isClipboardFilePath(p) ? [p] : []
      }
    }
  } catch { /* clipboard formats: never throw into the paste path */ }
  return []
}

/**
 * BUG-8 fallback: when the clipboard holds no bitmap, recover a copied image
 * FILE, copy it (format-preserving) into the screenshots dir, and return its
 * path. Returns {error} for no usable image / oversize. (Unit 5 W1)
 */
export async function readClipboardImageFilePath(screenshotsDir: string): Promise<PasteableImage> {
  const picked = pickPasteableImage(await readClipboardFilePaths(), (p) => {
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

/** MIME type for an image filename by extension (covers ALLOWED_IMAGE_EXTS). */
export function mimeForImage(filename: string): string {
  switch (extOf(filename)) {
    case '.png': return 'image/png'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    case '.bmp': return 'image/bmp'
    default: return 'image/jpeg' // .jpg / .jpeg / unknown
  }
}

/** True for screenshot-/clipboard- image files the screenshots reaper should sweep. */
export function isReapableImageFile(name: string): boolean {
  return (name.startsWith('screenshot-') || name.startsWith('clipboard-')) && ALLOWED_IMAGE_EXTS.has(extOf(name))
}
