import { clipboard } from 'electron'

/**
 * Read TEXT off the clipboard from the MAIN process, retrying briefly when the
 * first read comes back empty. The text sibling of readClipboardImageWithRetry.
 *
 * Why this exists at all, rather than the renderer calling
 * `navigator.clipboard.readText()` (#145):
 *
 *  1. The async clipboard API requires the DOCUMENT TO BE FOCUSED and rejects
 *     with "Document is not focused" otherwise. Electron's main-process
 *     clipboard has no such requirement. That matters because the whole point
 *     of the terminal paste handler is to work when focus is unsettled — an
 *     external tool (dictation, snippet expander) takes focus, writes the
 *     clipboard, hands focus back, then synthesizes Ctrl+V. Depending on
 *     document focus there reintroduces the very failure being fixed.
 *  2. Same Windows delayed-render behaviour already documented for images: the
 *     FIRST read after the window gains focus can come back empty because the
 *     source app renders the format lazily, so a one-shot read concludes "empty
 *     clipboard" when text is in fact present. This was the Alt+V
 *     first-attempt miss for images; text is no different.
 *
 * Deterministic and cheap: returns as soon as non-empty text appears and gives
 * up after `attempts` tries, so a genuinely empty clipboard still resolves ''
 * promptly. Defaults match readClipboardImageWithRetry (6 x 80ms => up to
 * ~400ms) because they are outlasting the same 50-200ms Windows sync window.
 * On success it short-circuits, so the common case costs one read and no delay.
 *
 * @param attempts total number of reads to try (>= 1)
 * @param delayMs  delay between reads in milliseconds
 * @param sleep    injectable timer (tests pass a no-op resolver)
 * @returns the first non-empty clipboard text, or '' if every attempt was empty
 */
export async function readClipboardTextWithRetry(
  attempts = 6,
  delayMs = 80,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string> {
  const tries = Math.max(1, attempts)
  for (let i = 0; i < tries; i++) {
    // Never let a platform clipboard error propagate: a failed read must degrade
    // to "nothing to paste", never break the paste keybinding.
    let text = ''
    try {
      text = clipboard.readText() || ''
    } catch {
      text = ''
    }
    if (text) return text
    if (i < tries - 1) await sleep(delayMs)
  }
  return ''
}
