import { BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import { IPC } from '../../shared/ipc-channels'
import { getResourcesDirectory } from './setup-handlers'
import { logInfo, logWarn } from '../debug-logger'
import {
  GLYPH_DIAGNOSTIC_MAX_BYTES,
  isGlyphDiagnosticPayload,
  sanitizeGlyphDiagnosticPayload,
  type GlyphDiagnosticResult,
} from '../../shared/glyph-diagnostic'

/** `glyph-YYYYMMDD-HHMMSS-mmm` — sortable, filesystem-safe, no separators to
 *  escape. Milliseconds keep two captures in the same second from colliding. */
function stamp(): string {
  return new Date()
    .toISOString()
    .replace(/T/, '-')
    .replace(/:/g, '')
    .replace(/\.(\d{3})Z$/, '-$1')
}

/** Minimum gap between accepted captures. Bounds a compromised renderer that
 *  loops the IPC (files written + Explorer windows opened); a person pressing
 *  the shortcut never hits it. */
const MIN_CAPTURE_INTERVAL_MS = 1500
let lastCaptureAt = 0

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
      // Throttle: a person pressing Ctrl+Alt+G never hits this, but a
      // compromised renderer looping the IPC would otherwise spam files + open an
      // Explorer window per call. Reject-fast, before any work.
      const nowMs = Date.now()
      if (nowMs - lastCaptureAt < MIN_CAPTURE_INTERVAL_MS) {
        return { ok: false, error: 'rate limited' }
      }

      if (!isGlyphDiagnosticPayload(payload)) {
        return { ok: false, error: 'payload shape invalid' }
      }
      // Write ONLY the known fields — never the raw object. This drops any extra
      // fields a compromised renderer attached, which both keeps unvetted content
      // off disk AND removes the amplification carrier behind the size check: the
      // bytes we bound are the exact bytes we write (indented), so a deeply nested
      // extra field can no longer pass a compact-serialized cap and then balloon
      // on the pretty-printed write (ADR-009 pass on #399).
      const clean = sanitizeGlyphDiagnosticPayload(payload)
      const out = JSON.stringify(clean, null, 2)
      if (Buffer.byteLength(out, 'utf8') > GLYPH_DIAGNOSTIC_MAX_BYTES) {
        return { ok: false, error: 'payload too large' }
      }
      // Only now commit to this capture — a rejected payload must not start the
      // throttle window.
      lastCaptureAt = nowMs

      const dir = join(getResourcesDirectory(), 'glyph-diagnostics')
      mkdirSync(dir, { recursive: true })
      const base = `glyph-${stamp()}`
      const jsonPath = join(dir, `${base}.json`)
      writeFileSync(jsonPath, out, 'utf8')

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
