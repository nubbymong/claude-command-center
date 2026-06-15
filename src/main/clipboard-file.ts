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
