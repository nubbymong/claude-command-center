/**
 * Cross-terminal glyph-atlas coordinator (#311, completed 2026-08-21).
 *
 * `@xterm/addon-webgl` keeps ONE `TextureAtlas` per render config and shares it
 * across every terminal whose font/size/theme match (see `acquireTextureAtlas`
 * in the addon). CCC opens terminals with identical settings, so they all share
 * one atlas — the atlas is effectively per PROCESS, not per terminal. When any
 * one of them rebuilds it via `clearTextureAtlas()`, the shared texture is
 * emptied and `_clearModel(true)` runs for the CALLING terminal only. Every
 * OTHER live terminal keeps its old render model, so `_updateModel` concludes
 * nothing changed and `refresh()` draws stale vertices against an emptied
 * texture: backgrounds intact, glyphs gone. That is the corruption.
 *
 * ── Why the previous version did not fix it ──────────────────────────────────
 *
 * It refreshed the other terminals, which is necessary and not sufficient, and
 * was in fact WORSE than doing nothing: before it, an idle background terminal
 * kept its last good frame until something redrew it. Refreshing a victim whose
 * model still says "nothing changed" is precisely what paints it blank.
 *
 * ── The repair ───────────────────────────────────────────────────────────────
 *
 * A victim has to drop its OWN render model WITHOUT re-wiping the shared
 * texture — re-wiping would just move the corruption to the next terminal, and
 * N terminals each clearing in response to each other is an infinite mutual
 * repaint. The only public API that clears one terminal's model alone is a
 * same-value theme reassignment (`term.options.theme = { ...term.options.theme }`
 * → xterm's `_handleColorChange` → `_clearModel(true)`), which the caller
 * supplies here as the `resync` callback. This module owns the SEQUENCING; the
 * callback owns the mechanism.
 *
 * ── The generation counter ───────────────────────────────────────────────────
 *
 * A frame-scheduled pass only reaches terminals that are registered and alive
 * at that moment. A terminal that registers a frame later, or whose resync
 * throws because it was mid-teardown, would stay behind forever with no way to
 * discover it. So every clear bumps a module-level generation, each terminal
 * records the generation it last resynced against, and `resyncIfBehind` lets a
 * terminal catch up at any later point — on becoming visible, on focus, after a
 * resize. Cheap to ask, and it is the difference between "usually repaired" and
 * "repaired".
 *
 * Calls are coalesced per frame: N terminals each clearing in the same frame
 * produce ONE pass over the others, not N. A terminal that cleared this frame
 * already has a fresh model (clearTextureAtlas cleared it), so it is skipped
 * and its generation is marked current.
 *
 * The atlas it guards is process-global, so the app uses a single shared
 * `atlasCoordinator`. `createAtlasCoordinator` is exported (with an injectable
 * `raf`) so the sequencing is unit-testable without a real animation frame.
 */

/** Drop this terminal's own render model, then repaint it. Must NOT clear the
 *  shared texture atlas — see the header. */
export type TerminalResync = () => void

/**
 * One entry in the atlas event ring (#374). The ring is always on and cheap so
 * that when a user hits the glyph-capture shortcut the moment they see
 * corruption, the SEQUENCE that produced it is already recorded — which
 * terminal cleared the shared atlas, when, which others fell behind, and
 * whether each was repaired or missed. `kind`:
 *  - `clear`   a terminal rebuilt the shared atlas (the trigger for corruption)
 *  - `resync`  the coalesced frame pass repaired a victim
 *  - `catchup` `resyncIfBehind` repaired a terminal late (activation/focus/resize)
 *  - `miss`    a resync threw — the terminal is still behind and drawing stale
 *  - `register` / `unregister` a terminal joined or left the coordinator
 */
export interface AtlasEvent {
  t: number
  kind: 'clear' | 'resync' | 'catchup' | 'miss' | 'register' | 'unregister'
  /** The terminal's label (its session id), or 'unknown' when unlabelled. */
  label: string
  /** Generation after the event. */
  generation: number
}

/** A point-in-time view of the coordinator for a diagnostic bundle. */
export interface AtlasDiagnosticSnapshot {
  generation: number
  liveCount: number
  /** Every live terminal and how many generations behind the shared atlas it is
   *  (0 = up to date; >0 = drawing against a rebuilt atlas until it resyncs). */
  live: Array<{ label: string; generation: number; behind: number }>
  /** The event ring, oldest first. */
  events: AtlasEvent[]
}

export interface AtlasCoordinator {
  /** Register a live terminal's resync callback, optionally labelled (its
   *  session id) so the event ring is readable. Returns an unregister fn to
   *  call on teardown. */
  register(resync: TerminalResync, label?: string): () => void
  /** Report that `source` just rebuilt the shared atlas. Bumps the generation
   *  and schedules a coalesced resync of every OTHER registered terminal on the
   *  next animation frame. */
  notifyCleared(source: TerminalResync): void
  /** The current atlas generation. Bumped once per clear. */
  generation(): number
  /**
   * Resync `resync` if it has not caught up with the current generation, and
   * return whether it ran. Safe and cheap to call on every activation: a
   * terminal that is already current does nothing.
   *
   * This is the backstop for every terminal the frame pass could not reach —
   * registered late, threw mid-teardown, or was created after the clear.
   */
  resyncIfBehind(resync: TerminalResync): boolean
  /** A snapshot of the current state + the event ring, for the glyph-capture
   *  diagnostic (#374). Never throws. */
  snapshot(): AtlasDiagnosticSnapshot
}

/** How many atlas events the always-on ring keeps. Enough to hold the run-up to
 *  a corruption a user is about to capture, small enough to be free. */
const ATLAS_EVENT_CAP = 300

export function createAtlasCoordinator(
  raf: (cb: () => void) => number = (cb) => globalThis.requestAnimationFrame(cb),
  now: () => number = () => Date.now(),
): AtlasCoordinator {
  /** Live terminals → the generation each last resynced against. */
  const live = new Map<TerminalResync, number>()
  /** Live terminals → their label (session id), for the event ring. */
  const labels = new Map<TerminalResync, string>()
  /** Always-on event ring; oldest entries drop first. */
  const events: AtlasEvent[] = []
  const labelOf = (r: TerminalResync) => labels.get(r) ?? 'unknown'
  const record = (kind: AtlasEvent['kind'], label: string) => {
    events.push({ t: now(), kind, label, generation })
    if (events.length > ATLAS_EVENT_CAP) events.shift()
  }
  const clearedThisFrame = new Set<TerminalResync>()
  let generation = 0
  let armed = false

  /** Run a resync and record that it reached the current generation. A throw
   *  still counts as an ATTEMPT but not as caught up, so `resyncIfBehind` will
   *  retry it later rather than assuming it landed. */
  const run = (resync: TerminalResync): boolean => {
    try {
      resync()
      if (live.has(resync)) live.set(resync, generation)
      return true
    } catch {
      // Terminal disposed between arming and flush, or a renderer that is
      // already gone. Leave its generation behind so a later activation retries.
      return false
    }
  }

  const flush = () => {
    armed = false
    // Snapshot the terminals that cleared this frame, then reset for the next
    // one. clearTextureAtlas() already cleared THEIR model, so they are current
    // by definition — mark them so, or resyncIfBehind would redundantly repaint
    // the one terminal that was never broken.
    const sources = new Set(clearedThisFrame)
    clearedThisFrame.clear()
    // Snapshot the keys so a resync that unregisters mid-pass cannot disturb
    // the iteration.
    for (const resync of [...live.keys()]) {
      if (sources.has(resync)) {
        live.set(resync, generation)
        continue
      }
      record(run(resync) ? 'resync' : 'miss', labelOf(resync))
    }
  }

  return {
    register(resync, label) {
      // A terminal joining now has a model built against the CURRENT atlas, so
      // it starts current rather than owing a resync it does not need.
      live.set(resync, generation)
      if (label) labels.set(resync, label)
      record('register', labelOf(resync))
      return () => {
        record('unregister', labelOf(resync))
        live.delete(resync)
        labels.delete(resync)
        clearedThisFrame.delete(resync)
      }
    },
    notifyCleared(source) {
      // Bump FIRST: everything registered is now one generation behind, whether
      // or not the frame below ever runs. That is what makes resyncIfBehind a
      // real backstop instead of a second copy of the same optimism.
      generation++
      // The source's own model was rebuilt by the clearTextureAtlas() that
      // triggered this, so it is current as of the new generation — record that
      // now, not only when the frame flush reaches it, so a snapshot taken
      // between the clear and the frame does not misreport the one terminal that
      // was never broken as behind.
      if (live.has(source)) live.set(source, generation)
      clearedThisFrame.add(source)
      record('clear', labelOf(source))
      if (!armed) {
        armed = true
        // If scheduling itself fails, DISARM. `armed` is the only thing that
        // stops a second frame being queued, so leaving it true after a throw
        // means this process-wide singleton never schedules another pass for
        // the life of the app — the whole coordination silently switched off by
        // one bad frame. The generation bump above is deliberately NOT rolled
        // back: the atlas really was cleared, so every terminal really is
        // behind, and resyncIfBehind must still say so.
        try {
          raf(flush)
        } catch {
          armed = false
          // Drop the accumulated sources. No flush will run for this frame, so
          // keeping them would make the NEXT successful flush treat them as
          // having cleared in ITS frame and skip them — the very miss this
          // coordinator exists to prevent.
          clearedThisFrame.clear()
        }
      }
    },
    generation() {
      return generation
    },
    resyncIfBehind(resync) {
      const at = live.get(resync)
      // Unregistered callers are not tracked and get nothing: they have no
      // model here to reason about, and resyncing one would be a repaint with
      // no owner.
      if (at === undefined || at >= generation) return false
      const ok = run(resync)
      record(ok ? 'catchup' : 'miss', labelOf(resync))
      return ok
    },
    snapshot() {
      return {
        generation,
        liveCount: live.size,
        live: [...live.entries()].map(([resync, at]) => ({
          label: labelOf(resync),
          generation: at,
          behind: Math.max(0, generation - at),
        })),
        events: [...events],
      }
    },
  }
}

/** Process-wide coordinator — the atlas it guards is process-global. */
export const atlasCoordinator = createAtlasCoordinator()
