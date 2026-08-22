/**
 * The glyph-corruption diagnostic bundle (#374), shared by the renderer (which
 * assembles it) and main (which validates and writes it). A user who sees the
 * WebGL glyph fault presses Ctrl+Alt+G; the renderer gathers the always-on
 * atlas event ring plus the environment, main writes it next to a screenshot of
 * the window, and reveals both so they can be shared.
 *
 * Kept small, plain, and dependency-free: main treats the renderer's copy as
 * untrusted and re-checks its shape (`isGlyphDiagnosticPayload`) before writing.
 */

export interface GlyphDiagnosticPayload {
  /** ISO timestamp the renderer stamped when the user fired the capture. */
  capturedAt: string
  /** __APP_VERSION__ of the running build. */
  appVersion: string
  /** Whether GPU/WebGL rendering is enabled in settings at capture time. */
  gpuRendering: boolean
  /** The WebGL adapter string (UNMASKED_RENDERER), or null when unavailable. */
  gpuAdapter: string | null
  /** The active session id, for cross-referencing the screenshot. */
  activeSessionId: string | null
  /** How many terminals were mounted (visible + hidden). */
  terminalCount: number
  /** The atlas coordinator's snapshot: generation, per-terminal behind-ness,
   *  and the event ring. Typed loosely here so the shared file need not import
   *  renderer types; the renderer passes `atlasCoordinator.snapshot()`. */
  atlas: {
    generation: number
    liveCount: number
    live: Array<{ label: string; generation: number; behind: number }>
    events: Array<{ t: number; kind: string; label: string; generation: number }>
  }
  /** Free-text note the user or caller attached (optional). */
  note?: string
}

/** Result main returns after writing the bundle. */
export interface GlyphDiagnosticResult {
  ok: boolean
  /** Absolute path to the written JSON, when ok. */
  jsonPath?: string
  /** Absolute path to the screenshot PNG, when the capture succeeded. */
  imagePath?: string
  error?: string
}

/** Upper bound on the serialized payload main will accept (256 KB): the ring is
 *  capped at 300 small events, so a well-formed payload is far under this; the
 *  cap is a guard against a compromised renderer sending an unbounded blob. */
export const GLYPH_DIAGNOSTIC_MAX_BYTES = 256 * 1024

/** Main-side shape check — the renderer is untrusted. Validates the fields the
 *  writer relies on; extra fields are ignored, missing/mistyped ones reject. */
export function isGlyphDiagnosticPayload(v: unknown): v is GlyphDiagnosticPayload {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  if (typeof p.capturedAt !== 'string' || typeof p.appVersion !== 'string') return false
  if (typeof p.gpuRendering !== 'boolean') return false
  if (!(p.gpuAdapter === null || typeof p.gpuAdapter === 'string')) return false
  if (!(p.activeSessionId === null || typeof p.activeSessionId === 'string')) return false
  if (typeof p.terminalCount !== 'number') return false
  const a = p.atlas as Record<string, unknown> | undefined
  if (!a || typeof a !== 'object') return false
  if (typeof a.generation !== 'number' || typeof a.liveCount !== 'number') return false
  if (!Array.isArray(a.live) || !Array.isArray(a.events)) return false
  return true
}
