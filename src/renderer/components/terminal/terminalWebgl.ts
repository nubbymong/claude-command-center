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
  /**
   * How many consecutive context losses to recover from before staying on the
   * DOM renderer for good. A flapping GPU context (a driver reset / Windows TDR)
   * fires context loss every frame; without a cap the addon recreates on every
   * one — the storm that shows as garbled glyphs, a white flash, then a renderer
   * crash, on repeat (#311). After the cap we stay on the DOM renderer and
   * repaint the garbled viewport. Defaults to DEFAULT_MAX_RECREATES.
   */
  maxRecreates?: number
  /**
   * How long the context must survive for the NEXT loss to count as a fresh
   * incident rather than a continuation of the current storm. See
   * DEFAULT_STABLE_PERIOD_MS. Defaults to DEFAULT_STABLE_PERIOD_MS.
   */
  stablePeriodMs?: number
  /** Clock, injectable for tests. Defaults to Date.now. */
  now?: () => number
}

/** Consecutive context losses recovered from before we stay on the DOM renderer.
 *  Enough to ride out a genuine one-off GPU blip, low enough to kill a storm. */
export const DEFAULT_MAX_RECREATES = 3

/**
 * How long the WebGL context must survive before the next loss is treated as a
 * NEW incident and the recreate counter resets.
 *
 * Without this the cap is a LIFETIME cap, not a consecutive one: a terminal left
 * open for days would burn its three recoveries on three unrelated blips — a
 * driver update, a sleep/wake, a monitor replugged — each of which recovered
 * perfectly, and then permanently drop to the DOM renderer on the fourth. That
 * is precisely the case the cap is supposed to tolerate.
 *
 * A storm is defined by losses arriving back to back (a TDR loop re-fires within
 * seconds, a flapping context every frame), so it reaches the cap long before
 * this window elapses and the reset never rescues it. A context that has
 * rendered for a full 30 seconds has demonstrably recovered, and the loss that
 * follows is a new event, not the same one.
 */
export const DEFAULT_STABLE_PERIOD_MS = 30_000

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
   *
   * EXPENSIVE: every glyph on screen must be re-rasterized afterwards. Calling
   * it on a schedule during continuous output makes the terminal flash and
   * renders frames against a half-rebuilt atlas (beta.13 regression, #292).
   * Reserve it for the cases that actually corrupt the atlas; use `isActive()`
   * plus a plain `term.refresh()` for a merely-stale viewport.
   */
  clearTextureAtlas(): boolean
  /**
   * True when the WebGL renderer is currently live. Lets a caller do the cheap
   * half of a repaint (mark the viewport dirty, re-render from the EXISTING
   * atlas) without paying for an atlas rebuild, while still skipping the work
   * entirely on a DOM-renderer session that never had the artifact (#273
   * adversarial review).
   */
  isActive(): boolean
}

/**
 * Build the callback a terminal registers with the shared atlas coordinator.
 *
 * The coordinator repaints every OTHER terminal when one rebuilds the shared
 * glyph atlas — but only a terminal actually rendering through WebGL has
 * anything to repaint. Two ways a terminal ends up registered without WebGL:
 * `installWebglWithRecovery` swallows an initial load failure (WebGL
 * unavailable in the environment), and a context-loss storm can drop a terminal
 * to the DOM renderer permanently once the recreate cap is reached. Either way
 * the viewport is correct already, so the refresh is pure waste.
 *
 * Gating here rather than at the registration site covers BOTH cases with one
 * check — registration happens once at mount, when the second case has not
 * happened yet.
 *
 * Note for callers: register THIS function with the coordinator and pass the
 * SAME reference to `notifyCleared`. The coordinator skips the terminal that
 * cleared by callback identity, so passing a different function for the two
 * would repaint the source twice — once from the repainter's own
 * clear-then-refresh, once from the coordinator.
 */
export function createAtlasRefresh(
  getHandle: () => WebglHandle | null,
  refresh: () => void,
): () => void {
  return () => { if (getHandle()?.isActive()) refresh() }
}

/**
 * Loads a WebGL addon onto `term` and wires a self-reloading context-loss handler.
 *
 * On context loss the addon fires its callback; we:
 *   1. Dispose the stale addon (xterm falls back to DOM renderer automatically).
 *   2. In the next animation frame, try to construct + load a fresh addon (GPU-blip recovery).
 *   3. If the recreate throws (GPU genuinely gone), call `term.refresh(0, rows-1)` so the
 *      DOM renderer repaints the viewport that the dead WebGL canvas left garbled.
 *   4. After `maxRecreates` consecutive losses, stop recreating and stay on the DOM
 *      renderer — a context that keeps dying would otherwise recreate every frame and
 *      storm the renderer into a crash (#311).
 *
 * Returns a WebglHandle so the caller can force a full repaint (#273) against
 * whichever addon is currently live. The happy path (WebGL works, no context
 * loss) is otherwise identical to the original single-line version.
 */
export function installWebglWithRecovery(term: Terminal, opts: WebglRecoveryOptions): WebglHandle {
  const { WebglAddonCtor, raf, isDisposed } = opts
  const maxRecreates = opts.maxRecreates ?? DEFAULT_MAX_RECREATES
  const stablePeriodMs = opts.stablePeriodMs ?? DEFAULT_STABLE_PERIOD_MS
  const now = opts.now ?? Date.now
  // Consecutive context losses recovered from within the CURRENT storm. Shared
  // across every recreated addon (each re-arms its own onContextLoss), so a
  // flapping context that keeps recreating is counted across the whole storm,
  // not per addon — and reset once the context has held for stablePeriodMs, so
  // the cap bounds one storm rather than the terminal's whole lifetime.
  let recreateCount = 0
  let lastLossAt = Number.NEGATIVE_INFINITY

  const forceDomRepaint = () => {
    // The DOM renderer is already active (dispose() switched to it); repaint the
    // viewport the dead WebGL canvas left garbled.
    try { term.refresh(0, term.rows - 1) } catch { /* terminal may have been disposed */ }
  }

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
      // A loss that arrives after the context has held for stablePeriodMs is a
      // new incident, not the continuation of a storm — start its count afresh.
      // Must run BEFORE the cap check, or a terminal that recovered cleanly
      // hours ago would still be measured against that old count.
      const lossAt = now()
      if (lossAt - lastLossAt > stablePeriodMs) recreateCount = 0
      lastLossAt = lossAt
      if (recreateCount >= maxRecreates) {
        // Cap reached: the context keeps dying (a flapping GPU / Windows TDR).
        // Stop recreating and stay on the DOM renderer — recreating again just
        // feeds the crash loop (#311). Repaint the garbled viewport and give up.
        forceDomRepaint()
        return
      }
      recreateCount++
      raf(() => {
        if (isDisposed()) return
        try {
          createAndLoad()                        // recreate — may throw
        } catch {
          // Recreate failed: DOM renderer is already active (dispose() did
          // that), but the existing viewport rows are garbled. Force a repaint.
          forceDomRepaint()
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
    isActive() {
      return currentAddon !== null
    },
  }
}
