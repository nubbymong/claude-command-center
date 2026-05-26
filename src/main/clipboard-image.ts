import { clipboard, type NativeImage } from 'electron'

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
 * gives up after `attempts` tries (default 3, ~20ms spacing) so a genuinely
 * empty clipboard still resolves null promptly.
 *
 * @param attempts total number of reads to try (>= 1)
 * @param delayMs  delay between reads in milliseconds
 * @param sleep    injectable timer (tests pass a no-op resolver)
 * @returns the first non-empty NativeImage, or null if all attempts were empty
 */
export async function readClipboardImageWithRetry(
  attempts = 3,
  delayMs = 20,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<NativeImage | null> {
  const tries = Math.max(1, attempts)
  for (let i = 0; i < tries; i++) {
    const img = clipboard.readImage()
    if (!img.isEmpty()) return img
    if (i < tries - 1) await sleep(delayMs)
  }
  return null
}
