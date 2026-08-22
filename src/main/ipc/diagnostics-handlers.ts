import { BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import { IPC } from '../../shared/ipc-channels'
import { getResourcesDirectory } from './setup-handlers'
import { logInfo, logWarn } from '../debug-logger'
import {
  GLYPH_DIAGNOSTIC_MAX_BYTES,
  isGlyphDiagnosticPayload,
  type GlyphDiagnosticResult,
} from '../../shared/glyph-diagnostic'

/** `glyph-YYYYMMDD-HHMMSS` — sortable, filesystem-safe, no separators to escape. */
function stamp(): string {
  return new Date()
    .toISOString()
    .replace(/T/, '-')
    .replace(/:/g, '')
    .replace(/\..*$/, '')
}

/**
 * The glyph-corruption capture (#374). The renderer hands over the atlas event
 * ring + environment; main writes it as JSON next to a full-window screenshot
 * and reveals both in the file manager so the user can send them on.
 *
 * The renderer is untrusted: the payload is size-capped and shape-checked, and
 * the output path is built ENTIRELY here (a fixed subdirectory + a timestamped
 * name) — nothing from the renderer reaches the filesystem path. On any failure
 * the handler returns `{ ok: false, error }` rather than throwing, so a capture
 * attempt can never take the window down.
 */
export function registerDiagnosticsHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.DIAGNOSTICS_CAPTURE_GLYPH, async (_event, payload: unknown): Promise<GlyphDiagnosticResult> => {
    try {
      // Reject an oversized blob before parsing anything else.
      let serialized: string
      try {
        serialized = JSON.stringify(payload)
      } catch {
        return { ok: false, error: 'payload not serializable' }
      }
      if (Buffer.byteLength(serialized, 'utf8') > GLYPH_DIAGNOSTIC_MAX_BYTES) {
        return { ok: false, error: 'payload too large' }
      }
      if (!isGlyphDiagnosticPayload(payload)) {
        return { ok: false, error: 'payload shape invalid' }
      }

      const dir = join(getResourcesDirectory(), 'glyph-diagnostics')
      mkdirSync(dir, { recursive: true })
      const base = `glyph-${stamp()}`
      const jsonPath = join(dir, `${base}.json`)
      writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8')

      // A full-window capture, saved beside the JSON. Best-effort: a diagnostic
      // is still useful without the image (headless, capture unsupported), so a
      // capture failure downgrades to json-only rather than failing the call.
      let imagePath: string | undefined
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        try {
          const image = await win.webContents.capturePage()
          imagePath = join(dir, `${base}.png`)
          writeFileSync(imagePath, image.toPNG())
        } catch (err) {
          logWarn('[diagnostics] glyph screenshot failed:', err instanceof Error ? err.message : String(err))
          imagePath = undefined
        }
      }

      // Reveal the newest artifact so the user lands on it, ready to share.
      try { shell.showItemInFolder(imagePath ?? jsonPath) } catch { /* headless / no shell */ }
      logInfo(`[diagnostics] glyph capture written: ${jsonPath}${imagePath ? ` (+ ${imagePath})` : ' (no screenshot)'}`)
      return { ok: true, jsonPath, imagePath }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logWarn('[diagnostics] glyph capture failed:', error)
      return { ok: false, error }
    }
  })
}
