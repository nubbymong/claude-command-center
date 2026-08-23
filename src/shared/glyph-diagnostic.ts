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

/** How many atlas events / live-terminal rows the sanitized bundle keeps. The
 *  ring is capped at 300 in the coordinator; these bound what a compromised
 *  renderer can send regardless. */
const SANITIZE_EVENT_CAP = 500
const SANITIZE_LIVE_CAP = 200

/**
 * Rebuild a payload from ONLY the known fields, with each nested value coerced
 * to a primitive. Main writes THIS, never the raw object: extra fields a
 * compromised renderer attached never reach disk, and — because every value is
 * a scalar and the arrays are capped — a deeply nested field cannot pass a
 * size check and then balloon when the file is pretty-printed. Call only after
 * `isGlyphDiagnosticPayload` has passed.
 */
export function sanitizeGlyphDiagnosticPayload(p: GlyphDiagnosticPayload): GlyphDiagnosticPayload {
  const str = (v: unknown, max = 512): string => (typeof v === 'string' ? v.slice(0, max) : String(v ?? '').slice(0, max))
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    capturedAt: str(p.capturedAt, 64),
    appVersion: str(p.appVersion, 64),
    gpuRendering: p.gpuRendering === true,
    gpuAdapter: p.gpuAdapter === null ? null : str(p.gpuAdapter),
    activeSessionId: p.activeSessionId === null ? null : str(p.activeSessionId, 128),
    terminalCount: num(p.terminalCount),
    atlas: {
      generation: num(p.atlas?.generation),
      liveCount: num(p.atlas?.liveCount),
      live: (Array.isArray(p.atlas?.live) ? p.atlas.live : []).slice(0, SANITIZE_LIVE_CAP).map((l) => ({
        label: str(l?.label, 128), generation: num(l?.generation), behind: num(l?.behind),
      })),
      events: (Array.isArray(p.atlas?.events) ? p.atlas.events : []).slice(0, SANITIZE_EVENT_CAP).map((e) => ({
        t: num(e?.t), kind: str(e?.kind, 32), label: str(e?.label, 128), generation: num(e?.generation),
      })),
    },
    ...(p.note !== undefined ? { note: str(p.note, 2048) } : {}),
  }
}

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
