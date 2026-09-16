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

const constrainToMaxDim = (img: Electron.NativeImage, maxDim: number) => {
  const size = img.getSize()
  if (size.width <= maxDim && size.height <= maxDim) return img
  if (size.width >= size.height) {
    return img.resize({ width: maxDim, quality: 'good' as const })
  }
  return img.resize({ height: maxDim, quality: 'good' as const })
}

export function registerClipboardHandlers(): void {
  ipcMain.handle(IPC.CLIPBOARD_READ_TEXT, async (): Promise<string> => {
    return readClipboardTextWithRetry()
  })

  ipcMain.handle(IPC.DEBUG_INPUT_ENABLED, () => process.env.CCC_INPUT_DEBUG === '1')
  ipcMain.on(IPC.DEBUG_LOG_INPUT, (_e, line: string) => {
    if (process.env.CCC_INPUT_DEBUG !== '1') return
    logInfo(`[input-diag] ${String(line).slice(0, 400)}`)
  })

  ipcMain.handle(IPC.CLIPBOARD_SAVE_IMAGE, async (): Promise<PasteableImage> => {
    const screenshotsDir = join(getResourcesDirectory(), 'screenshots')
    const img = await readClipboardImageWithRetry()
    if (img) {
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
    return readClipboardImageFilePath(screenshotsDir)
  })
}
