import type { Terminal } from '@xterm/xterm'
import type { WebglAddon } from '@xterm/addon-webgl'

/**
 * Options that let callers (or tests) inject dependencies.
 *
 * @param WebglAddonCtor - Constructor for WebglAddon (injectable for tests).
 * @param raf            - requestAnimationFrame (injectable for tests to run synchronously).
 * @param isDisposed     - Returns true when the owning terminal has been torn down.
 */
export interface WebglRecoveryOptions {
  WebglAddonCtor: new () => WebglAddon
  raf: (cb: () => void) => number
  isDisposed: () => boolean
}

/**
 * A handle onto the LIVE WebGL addon, valid across context-loss recreations.
 *
 * The addon instance is replaced on every recovery, so callers must not cache
 * their own reference — they go through this handle, which always targets the
 * current addon (or is a no-op when WebGL isn't active).
 */
export interface WebglHandle {
  /**
   * Rebuild the WebGL glyph atlas and re-raster the viewport — the programmatic
   * equivalent of the full repaint a window resize forces (see #273). Returns
   * true if it ran, false when WebGL isn't active (initial load failed, or a
   * context loss dropped us to the DOM renderer) — in which case the caller's
   * `term.refresh()` is the repaint that matters.
   */
  clearTextureAtlas(): boolean
}

/**
 * Loads a WebGL addon onto `term` and wires a self-reloading context-loss handler.
 *
 * On context loss the addon fires its callback; we:
 *   1. Dispose the stale addon (xterm falls back to DOM renderer automatically).
 *   2. In the next animation frame, try to construct + load a fresh addon (GPU-blip recovery).
 *   3. If the recreate throws (GPU genuinely gone), call `term.refresh(0, rows-1)` so the
 *      DOM renderer repaints the viewport that the dead WebGL canvas left garbled.
 *
 * Returns a WebglHandle so the caller can force a full repaint (#273) against
 * whichever addon is currently live. The happy path (WebGL works, no context
 * loss) is otherwise identical to the original single-line version.
 */
export function installWebglWithRecovery(term: Terminal, opts: WebglRecoveryOptions): WebglHandle {
  const { WebglAddonCtor, raf, isDisposed } = opts

  // The addon currently loaded on the terminal, or null when WebGL isn't active
  // (never loaded, or dropped to the DOM renderer after a context loss). Kept in
  // sync so the returned handle always targets the live addon.
  let currentAddon: WebglAddon | null = null

  /**
   * Attempt to create and load a WebGL addon.
   * Throws if construction or loadAddon fails (so callers can distinguish
   * "initial failure — stay on the DOM renderer" from "recreate failed — need
   * refresh"). xterm's default non-WebGL renderer is the DOM renderer; this app
   * loads no canvas addon, so that is always the fallback.
   */
  const createAndLoad = () => {
    const addon = new WebglAddonCtor()          // may throw
    addon.onContextLoss(() => {
      // The atlas is gone the moment the context is lost — drop the reference
      // before disposing so a repaint racing the recovery no-ops instead of
      // touching a dead addon.
      currentAddon = null
      addon.dispose()
      raf(() => {
        if (isDisposed()) return
        try {
          createAndLoad()                        // recreate — may throw
        } catch {
          // Recreate failed: DOM renderer is already active (dispose() did
          // that), but the existing viewport rows are garbled. Force a repaint.
          try { term.refresh(0, term.rows - 1) } catch { /* terminal may have been disposed */ }
        }
      })
    })
    term.loadAddon(addon)                        // may throw
    // Only after loadAddon succeeds — a throw above leaves currentAddon null.
    currentAddon = addon
  }

  try {
    createAndLoad()
  } catch {
    // Initial WebGL load failed (unavailable env) — stay on DOM renderer.
  }

  return {
    clearTextureAtlas() {
      if (!currentAddon) return false
      try {
        currentAddon.clearTextureAtlas()
        return true
      } catch {
        // Addon disposed mid-call, or an internal WebGL error — treat as "not
        // active" so the caller falls back to a plain refresh.
        return false
      }
    },
  }
}
