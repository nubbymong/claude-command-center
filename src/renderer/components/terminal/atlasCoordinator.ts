/**
 * Cross-terminal glyph-atlas coordinator (#311).
 *
 * `@xterm/addon-webgl` keeps ONE `TextureAtlas` per render config and shares it
 * across every terminal whose font/size/theme match (see `acquireTextureAtlas`
 * in the addon). CCC opens terminals with identical settings, so they all share
 * one atlas. When any one of them rebuilds that atlas — `clearTextureAtlas()`,
 * which the stale-glyph repainter (#273) calls — the shared texture is emptied
 * and only the CALLING terminal is asked to redraw. Every OTHER live terminal
 * keeps rendering against the emptied atlas and loses its glyphs (backgrounds
 * intact) until it happens to repaint. That is the beta.16 corruption.
 *
 * Coordination is PART of a fix, not the whole one: each live WebGL terminal
 * registers a `refresh` callback here; when one rebuilds the shared atlas it
 * calls `notifyCleared`, and every OTHER registered terminal is refreshed on the
 * next animation frame.
 *
 * That is necessary but NOT sufficient, and this module does not repair the
 * corruption on its own. `clearTextureAtlas()` calls `_clearModel(true)` for the
 * CALLER only, so a victim still holds its old cells, `_updateModel` concludes
 * nothing changed, and refresh() draws stale vertices against an emptied
 * texture — i.e. blank. A working repair has to clear the victim's render model
 * WITHOUT re-wiping the shared texture. This module is retained as scaffolding
 * for that, and is inert while `gpuRendering` is off — which is the default,
 * since the setting is opt-in (a literal `true`; see gpuRenderingEnabled).
 *
 * Calls are coalesced per frame: N terminals each clearing in the same frame
 * produce ONE refresh pass over the others, not N. A terminal that cleared this
 * frame already repainted itself (the repainter does clear-then-refresh), so it
 * is skipped.
 *
 * The atlas it guards is process-global, so the app uses a single shared
 * `atlasCoordinator`. `createAtlasCoordinator` is exported (with an injectable
 * `raf`) so the coalescing logic is unit-testable without a real animation frame.
 */

export type TerminalRefresh = () => void

export interface AtlasCoordinator {
  /** Register a live terminal's repaint callback. Returns an unregister fn to
   *  call on teardown. */
  register(refresh: TerminalRefresh): () => void
  /** Report that `source` just rebuilt the shared atlas. Schedules a coalesced
   *  refresh of every OTHER registered terminal on the next animation frame. */
  notifyCleared(source: TerminalRefresh): void
}

export function createAtlasCoordinator(
  raf: (cb: () => void) => number = (cb) => globalThis.requestAnimationFrame(cb),
): AtlasCoordinator {
  const live = new Set<TerminalRefresh>()
  const clearedThisFrame = new Set<TerminalRefresh>()
  let armed = false

  const flush = () => {
    armed = false
    // Snapshot the terminals that cleared this frame, then reset for the next
    // one. Those terminals already repainted themselves via clear-then-refresh,
    // so they are skipped.
    const sources = new Set(clearedThisFrame)
    clearedThisFrame.clear()
    // Snapshot `live` so a refresh() that unregisters mid-pass cannot disturb
    // the iteration.
    for (const refresh of [...live]) {
      if (sources.has(refresh)) continue
      try { refresh() } catch { /* terminal disposed between arming and flush */ }
    }
  }

  return {
    register(refresh) {
      live.add(refresh)
      return () => {
        live.delete(refresh)
        clearedThisFrame.delete(refresh)
      }
    },
    notifyCleared(source) {
      clearedThisFrame.add(source)
      if (!armed) {
        armed = true
        // If scheduling itself fails, DISARM. `armed` is the only thing that
        // stops a second frame being queued, so leaving it true after a throw
        // means this process-wide singleton never schedules another refresh for
        // the life of the app -- the whole coordination silently switched off by
        // one bad frame. Swallowing here is right for the same reason the
        // per-callback catch in flush() is: a terminal repaint is best-effort.
        try {
          raf(flush)
        } catch {
          armed = false
          // Drop the accumulated sources too. No flush will ever run for this
          // frame, so nothing has been repainted on their behalf -- and keeping
          // them would make the NEXT successful flush treat them as having
          // cleared in ITS frame and skip them, which is the very miss this
          // coordinator exists to prevent.
          clearedThisFrame.clear()
        }
      }
    },
  }
}

/** Process-wide coordinator — the atlas it guards is process-global. */
export const atlasCoordinator = createAtlasCoordinator()
