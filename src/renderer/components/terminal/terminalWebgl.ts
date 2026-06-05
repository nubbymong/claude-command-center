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
 * Loads a WebGL addon onto `term` and wires a self-reloading context-loss handler.
 *
 * On context loss the addon fires its callback; we:
 *   1. Dispose the stale addon (xterm falls back to canvas renderer automatically).
 *   2. In the next animation frame, try to construct + load a fresh addon (GPU-blip recovery).
 *   3. If the recreate throws (GPU genuinely gone), call `term.refresh(0, rows-1)` so the
 *      canvas renderer repaints the viewport that the dead WebGL canvas left garbled.
 *
 * The happy path (WebGL works, no context loss) is identical to the original single-line version.
 */
export function installWebglWithRecovery(term: Terminal, opts: WebglRecoveryOptions): void {
  const { WebglAddonCtor, raf, isDisposed } = opts

  /**
   * Attempt to create and load a WebGL addon.
   * Throws if construction or loadAddon fails (so callers can distinguish
   * "initial failure — stay on canvas" from "recreate failed — need refresh").
   */
  const createAndLoad = () => {
    const addon = new WebglAddonCtor()          // may throw
    addon.onContextLoss(() => {
      addon.dispose()
      raf(() => {
        if (isDisposed()) return
        try {
          createAndLoad()                        // recreate — may throw
        } catch {
          // Recreate failed: canvas renderer is already active (dispose() did
          // that), but the existing viewport rows are garbled. Force a repaint.
          try { term.refresh(0, term.rows - 1) } catch { /* terminal may have been disposed */ }
        }
      })
    })
    term.loadAddon(addon)                        // may throw
  }

  try {
    createAndLoad()
  } catch {
    // Initial WebGL load failed (unavailable env) — stay on canvas renderer.
  }
}
