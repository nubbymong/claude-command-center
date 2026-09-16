/**
 * Clipboard reads for the terminal paste keybindings + the opt-in input
 * diagnostics stream. Lifted out of `index.ts` (2.1.1) as a pure move; called
 * from inside the once-guarded registerMainWindowIpc() block, never per window.
 */
import { ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { readClipboardImageWithRetry } from '../clipboard-image'
import { readClipboardTextWithRetry } from '../clipboard-text'
import { readClipboardImageFilePath, type PasteableImage } from '../clipboard-file'
import { getResourcesDirectory } from './setup-handlers'
import { logInfo } from '../debug-logger'
import { IPC } from '../../shared/ipc-channels'

// Constrain to longest-edge max while preserving aspect ratio.
// Passing both width and height to nativeImage.resize() distorts non-square images.
const constrainToMaxDim = (img: Electron.NativeImage, maxDim: number) => {
  const size = img.getSize()
  if (size.width <= maxDim && size.height <= maxDim) return img
  if (size.width >= size.height) {
    return img.resize({ width: maxDim, quality: 'good' as const })
  }
  return img.resize({ height: maxDim, quality: 'good' as const })
}

export function registerClipboardHandlers(): void {
  // Clipboard TEXT read for the terminal paste keybinding (#145). Deliberately
  // main-process: navigator.clipboard.readText() requires the document to be
  // focused, which is exactly the condition that fails when an external tool
  // (dictation, snippet expander) takes focus and synthesizes Ctrl+V. Retried
  // for the same Windows delayed-render reason as the image path below.
  ipcMain.handle(IPC.CLIPBOARD_READ_TEXT, async (): Promise<string> => {
    return readClipboardTextWithRetry()
  })

  // Input diagnostics (#145). Opt-in via CCC_INPUT_DEBUG=1 so it costs nothing
  // normally: the renderer asks once and only then attaches listeners. Lines land
  // in the debug log (<dataDir>/debug/app.log) prefixed [input-diag].
  // `on`, not `handle` — this is a fire-and-forget stream; a round trip per
  // keystroke would itself perturb what we are trying to measure.
  ipcMain.handle(IPC.DEBUG_INPUT_ENABLED, () => process.env.CCC_INPUT_DEBUG === '1')
  ipcMain.on(IPC.DEBUG_LOG_INPUT, (_e, line: string) => {
    if (process.env.CCC_INPUT_DEBUG !== '1') return
    logInfo(`[input-diag] ${String(line).slice(0, 400)}`)
  })

  // Save clipboard image to a unique file in the host screenshots dir and return its
  // bare filename so the renderer can use the conductor MCP fetch_host_screenshot tool.
  // Returns { filename, path } so callers have both the bare name (for the MCP tool)
  // and the absolute path (for local-only flows that bypass MCP).
  ipcMain.handle(IPC.CLIPBOARD_SAVE_IMAGE, async (): Promise<PasteableImage> => {
    const screenshotsDir = join(getResourcesDirectory(), 'screenshots')
    // Retry the read so the FIRST Alt+V after copying an image reliably detects
    // it -- Windows' delayed-render clipboard can return empty on the first read
    // after the window gains focus, which was the "no image detected" miss.
    const img = await readClipboardImageWithRetry()
    if (img) {
      // [perf] resize + JPEG encode is the suspected clipboard-paste freeze; time it
      // with the source dimensions, since cost scales with input size.
      const __t0 = Date.now()
      const resized = constrainToMaxDim(img, 1920)
      const jpeg = resized.toJPEG(85)
      const __dt = Date.now() - __t0
      if (__dt > 150) {
        const s = img.getSize()
        logInfo(`[perf] clipboard-image resize+encode took ${__dt}ms (${s.width}x${s.height})`)
      }
      if (!existsSync(screenshotsDir)) mkdirSync(screenshotsDir, { recursive: true })
      const filename = `clipboard-${Date.now()}-${randomBytes(4).toString('hex')}.jpg`
      const filePath = join(screenshotsDir, filename)
      writeFileSync(filePath, jpeg)
      return { path: filePath }
    }
    // No bitmap on the clipboard — fall back to a copied image FILE (BUG-8).
    return readClipboardImageFilePath(screenshotsDir)
  })
}
