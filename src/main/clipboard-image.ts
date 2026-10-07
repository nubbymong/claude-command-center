import { clipboard, nativeImage, type NativeImage } from 'electron'
import { logInfo } from './debug-logger'

/** The image types taken off the clipboard, in order of preference: the two
 *  that `nativeImage.createFromBuffer` decodes. A bitmap copied from another
 *  app (Snipping Tool, Paint, a browser) is offered as `image/png`. */
const IMAGE_TYPES = ['image/png', 'image/jpeg'] as const

/**
 * One read of the clipboard's image through Electron 44's clipboard API
 * (`clipboard.read()`, then `ClipboardItem.getType()`), decoded into a
 * NativeImage. Null when the clipboard holds no PNG or JPEG, when the bytes
 * decode to an empty image, or when any step fails: a failed read is "no image
 * yet", so the caller retries and then falls back to a copied image FILE.
 */
async function readClipboardImageOnce(): Promise<NativeImage | null> {
  try {
    const items = await clipboard.read()
    for (const type of IMAGE_TYPES) {
      const item = items.find((it) => Array.isArray(it?.types) && it.types.includes(type))
      if (!item) continue
      const payload: unknown = await item.getType(type)
      if (!payload || typeof (payload as Blob).arrayBuffer !== 'function') continue
      const img = nativeImage.createFromBuffer(Buffer.from(await (payload as Blob).arrayBuffer()))
      if (!img.isEmpty()) return img
    }
  } catch {
    /* a platform clipboard error is "no image", never an error into the paste path */
  }
  return null
}

/**
 * Read an image off the clipboard, retrying briefly when the first read comes
 * back empty.
 *
 * Why the retry: on Windows the clipboard advertises an externally-copied
 * image (Snipping Tool, browser, Excalidraw, ...) via a delayed-render / DIB
 * format. The FIRST read after the Electron window gains focus can come back
 * empty because Chromium hasn't yet materialised the bitmap for this focus
 * session -- so a one-shot read reports "no image" even though one is present.
 * That is the Alt+V first-attempt miss: pressing a key (which forces a
 * focus/clipboard-sync cycle) made the SECOND attempt succeed. Re-reading a
 * couple of times with a short async yield lets the bitmap sync land before we
 * conclude the clipboard is empty.
 *
 * Deterministic and cheap: returns as soon as a non-empty image appears, and
 * gives up after `attempts` tries (default 6, ~80ms spacing => up to ~400ms)
 * so a genuinely empty clipboard still resolves null promptly. The default
 * window is sized to outlast Windows delayed-render sync (50-200ms after
 * focus); 3x20ms was too short, which is why the FIRST Alt+V often missed and
 * only the second press worked. On success it short-circuits, so the common
 * case (image already present) still returns on the first read with no delay.
 *
 * Electron 44 removed `clipboard.readImage()`; each attempt is one
 * readClipboardImageOnce() above, and a failed attempt counts as empty.
 *
 * @param attempts total number of reads to try (>= 1)
 * @param delayMs  delay between reads in milliseconds
 * @param sleep    injectable timer (tests pass a no-op resolver)
 * @returns the first non-empty NativeImage, or null if all attempts were empty
 */
export async function readClipboardImageWithRetry(
  attempts = 6,
  delayMs = 80,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<NativeImage | null> {
  const __t0 = Date.now()
  const tries = Math.max(1, attempts)
  for (let i = 0; i < tries; i++) {
    const img = await readClipboardImageOnce()
    if (img) {
      const __dt = Date.now() - __t0
      if (__dt > 150) logInfo(`[perf] clipboard-image processing took ${__dt}ms`)
      return img
    }
    if (i < tries - 1) await sleep(delayMs)
  }
  const __dt = Date.now() - __t0
  if (__dt > 150) logInfo(`[perf] clipboard-image processing took ${__dt}ms`)
  return null
}
