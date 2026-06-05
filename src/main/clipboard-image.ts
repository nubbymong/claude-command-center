import { clipboard, type NativeImage } from 'electron'
import { logInfo } from './debug-logger'

/**
 * Read an image off the clipboard, retrying briefly when the first read comes
 * back empty.
 *
 * Why the retry: on Windows the clipboard advertises an externally-copied
 * image (Snipping Tool, browser, Excalidraw, ...) via a delayed-render / DIB
 * format. The FIRST `clipboard.readImage()` after the Electron window gains
 * focus can return an empty NativeImage because Chromium hasn't yet
 * materialised the bitmap for this focus session -- so a one-shot read reports
 * "no image" even though one is present. That is the Alt+V first-attempt miss:
 * pressing a key (which forces a focus/clipboard-sync cycle) made the SECOND
 * attempt succeed. Re-reading a couple of times with a short async yield lets
 * the bitmap sync land before we conclude the clipboard is empty.
 *
 * Deterministic and cheap: returns as soon as a non-empty image appears, and
 * gives up after `attempts` tries (default 6, ~80ms spacing => up to ~400ms)
 * so a genuinely empty clipboard still resolves null promptly. The default
 * window is sized to outlast Windows delayed-render sync (50-200ms after
 * focus); 3x20ms was too short, which is why the FIRST Alt+V often missed and
 * only the second press worked. On success it short-circuits, so the common
 * case (image already present) still returns on the first read with no delay.
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
    const img = clipboard.readImage()
    if (!img.isEmpty()) {
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
