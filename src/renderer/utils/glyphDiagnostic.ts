import { atlasCoordinator } from '../components/terminal/atlasCoordinator'
import { useSettingsStore } from '../stores/settingsStore'
import { gpuRenderingEnabled, DEFAULT_TERMINAL_SETTINGS } from '../stores/settingsStore'
import type { GlyphDiagnosticPayload, GlyphDiagnosticResult } from '../../shared/glyph-diagnostic'

declare const __APP_VERSION__: string

/**
 * The WebGL adapter string (UNMASKED_RENDERER), or null. A throwaway context —
 * the debug-renderer-info extension is the only portable way to name the GPU,
 * and it is exactly what a glyph report needs (a driver/GPU that misbehaves).
 * Never throws; a blocked extension or no-WebGL environment yields null.
 */
export function readGpuAdapter(): string | null {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
    if (!gl || !(gl instanceof WebGLRenderingContext)) return null
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const adapter = ext ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string) : null
    const lose = gl.getExtension('WEBGL_lose_context')
    lose?.loseContext()
    return adapter || null
  } catch {
    return null
  }
}

/** Assemble the diagnostic bundle from the always-on atlas ring + environment. */
export function buildGlyphDiagnostic(activeSessionId: string | null, now: () => number = () => Date.now()): GlyphDiagnosticPayload {
  const ts = useSettingsStore.getState().settings.terminal || DEFAULT_TERMINAL_SETTINGS
  const atlas = atlasCoordinator.snapshot()
  return {
    capturedAt: new Date(now()).toISOString(),
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
    gpuRendering: gpuRenderingEnabled(ts),
    gpuAdapter: readGpuAdapter(),
    activeSessionId,
    terminalCount: atlas.liveCount,
    atlas,
  }
}

/**
 * Capture a glyph-corruption diagnostic: gather the atlas event ring + the
 * environment and hand it to main, which writes it next to a screenshot and
 * reveals both. Returns main's result (or an error shape); never throws, so a
 * keybinding handler can call it bare.
 */
export async function captureGlyphDiagnostic(activeSessionId: string | null): Promise<GlyphDiagnosticResult> {
  try {
    const payload = buildGlyphDiagnostic(activeSessionId)
    const api = window.electronAPI?.diagnostics
    if (!api?.captureGlyph) return { ok: false, error: 'diagnostics API unavailable' }
    const result = await api.captureGlyph(payload)
    if (result?.ok) {
      // eslint-disable-next-line no-console
      console.info(`[glyph-capture] saved: ${result.jsonPath}${result.imagePath ? ` (+ ${result.imagePath})` : ''}`)
    } else {
      console.warn(`[glyph-capture] failed: ${result?.error ?? 'unknown'}`)
    }
    return result ?? { ok: false, error: 'no result' }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.warn(`[glyph-capture] error: ${error}`)
    return { ok: false, error }
  }
}
