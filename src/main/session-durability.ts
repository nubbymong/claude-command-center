/**
 * session-durability.ts — the cross-exit durability core for session-state (#397).
 *
 * Holds the last-known ENRICHED session state and the save / flush / clear logic
 * that index.ts wires to the `session:save` IPC and the process-exit hooks (the
 * instance composed in app-session-durability.ts). Kept
 * out of index.ts so it is unit-testable without the Electron main entry (the
 * adversarial-review lens that found the cache was untestable, and F1 — the exit
 * flush resurrecting an intentionally-cleared set — lived here unseen).
 *
 * Dependency-injected: `save` is session-state.saveSessionState (which honours the
 * read-failure latch and refuses when appropriate), `enrichDeps` reaches the live
 * transcript binder. Pure logic otherwise; one instance per app.
 */
import type { SessionState, SessionStateCleared } from './session-state'
import { enrichSessionStateWithResumeTargets, type ResumeEnrichDeps } from './session-resume-enrich'

export interface DurabilityDeps {
  /** Binder-backed enrichment (lazily reads getTranscriptBinder each call). */
  enrichDeps: ResumeEnrichDeps
  /** session-state.saveSessionState — returns false when the latch refuses. */
  save: (state: SessionState) => boolean
  /** session-state.loadSessionState: the `session:load` path. */
  load?: () => SessionState | null
  /** Fixer 11: session-state.clearSessionState, the `session:clear` path's
   *  removal of the saved file and its .bak, with what it removed. None: the
   *  clear counts as failed. */
  clear?: () => SessionStateCleared
  /** P3.6: main's own records read back from the loaded state (the
   *  conversations whose claim was not certain; pty-manager), before any
   *  restored session respawns. Handed null when nothing was saved. A throw
   *  never fails the load. */
  readBack?: (state: SessionState | null) => void
  log?: (msg: string) => void
}

export interface SessionDurability {
  /** Enrich (from the binder) + cache + persist. The single `session:save` path. */
  saveEnriched: (state: SessionState) => boolean
  /** The single `session:load` path: the saved state, and main's own records
   *  in it read back (P3.6: the uncertain claims). Null when none. */
  load: () => SessionState | null
  /** Re-enrich the cached state and persist it on an exit path. No-op until a
   *  state has been saved this run; honest about a latch refusal. Never throws.
   *  After a clear (and no save since): main's running times only (P3.7). */
  flushOnExit: (reason: string) => void
  /** The single `session:clear` path (fixer 11): remove the saved file and
   *  its .bak (deps.clear), then drop the cache whatever that did, so no exit
   *  flush writes the discarded set back (F1; before fixer 11, a clear that
   *  failed left the cache, and the flush wrote the set back). True when the
   *  saved file is cleared. Never throws. */
  clear: () => boolean
  /** Drop the cache after a clear so the exit flush cannot resurrect a set the
   *  user intentionally discarded (F1). Main's running times are not the set:
   *  they are written back on their own (P3.7, keepRunningTimes).
   *  `bakRemoved` (fixer 10, ADR-009 C2; required since fixer 11): true only
   *  when no copy of the discarded set is left on disk (the file and its .bak
   *  both removed). Otherwise nothing is written until the next save, at the
   *  clear or at any exit flush; anything but true counts as a copy left. */
  noteCleared: (bakRemoved: boolean) => void
  /** Test-only: read the cached state. */
  peek: () => SessionState | null
}

export function createSessionDurability(deps: DurabilityDeps): SessionDurability {
  let last: SessionState | null = null
  /** P3.7: a clear this run, and no save since. */
  let cleared = false
  /** Fixer 10 (ADR-009 C2): that clear left a copy of the discarded set on
   *  disk (its .bak; fixer 11: or the file itself). */
  let bakLeft = false
  const log = deps.log ?? (() => {})

  function saveEnriched(state: SessionState): boolean {
    cleared = false
    const enriched = enrichSessionStateWithResumeTargets(state, deps.enrichDeps)
    last = enriched
    return deps.save(enriched)
  }

  // Re-enriches from the (still-live) binder and persists on EVERY exit path. It is
  // NOT deduped across hooks: an exit-flush dedup latch (removed in round-3) had to
  // be reset per-exit, but powerMonitor 'suspend' is not an exit and poisoned it, so
  // a later real exit skipped re-enrichment and dropped a now-available resume
  // target to the picker. The cost of not deduping is a few bounded head reads if
  // two exit hooks fire in one teardown (SIGTERM→before-quit) — negligible, and
  // saveSessionState's atomic write is idempotent — so correctness wins over it.
  function flushOnExit(reason: string): void {
    if (!last) {
      if (cleared && !bakLeft) keepRunningTimes(`exit flush on ${reason}`)
      return
    }
    try {
      const ok = saveEnriched(last)
      log(ok
        ? `[session-state] durable flush on ${reason}`
        : `[session-state] durable flush on ${reason} REFUSED (read-failure latch); on-disk file kept`)
    } catch (err) {
      log(`[session-state] durable flush on ${reason} failed: ${(err as Error)?.message ?? err}`)
    }
  }

  /**
   * P3.7 (row 36; fixer 9 A1, the VM gate 6 FAIL): a clear discards the
   * session set, never main's own record kept with it, each conversation's
   * running time (conversation-running-time.ts). Claude Code keeps its
   * Duration in the conversation's own transcript (a cost-state entry its CLI
   * restores when it resumes), which no choice about the app's tabs removes;
   * where the CLI records none (P3.1), main keeps it, saved only in this
   * file. So after a clear ("Close sessions", "Don't open", the window closed
   * with no tabs), and at each exit flush until the next save (a run settles
   * as its process ends, after the clear), it is written back on its own: a
   * state with no sessions (no Resume prompt, nothing of the discarded set)
   * and main's list, never the renderer's. None kept: nothing is written, the
   * file stays cleared, as before. Not while the clear left a copy of the set
   * on disk (fixers 10 and 11, noteCleared). Never throws.
   */
  function keepRunningTimes(why: string): void {
    try {
      const state = enrichSessionStateWithResumeTargets({ sessions: [], activeSessionId: null, savedAt: Date.now() }, deps.enrichDeps)
      if (!Array.isArray(state.conversationRunningTimes) || state.conversationRunningTimes.length === 0) return
      const ok = deps.save(state)
      log(ok
        ? `[session-state] the conversations' running times kept on their own (${why})`
        : `[session-state] the conversations' running times REFUSED (read-failure latch) on ${why}; on-disk file kept`)
    } catch (err) {
      log(`[session-state] keeping the conversations' running times on ${why} failed: ${(err as Error)?.message ?? err}`)
    }
  }

  /**
   * Fixer 10 (ADR-009 C2, with #397 N1): a clear that left a copy of the
   * discarded set on disk keeps no running times until the next save: its
   * .bak that could not be removed (held by a scanner or a sync tool) or,
   * since fixer 11, the file itself when the clear failed or was refused. A
   * file written now would sit in front of a .bak left, and a load that finds
   * the file damaged recovers the .bak: the discarded set would come back.
   * With no file the .bak is never read; the next save copies its own state
   * over it or, when that copy fails, removes it (saveSessionState, fixer 11),
   * and only a .bak that can be neither written nor removed then is left,
   * logged. If no save comes before the app stops, the running times are
   * lost, as every clear lost them before fixer 9 (A1); said once, here.
   */
  function noteCleared(bakRemoved: boolean): void {
    last = null
    cleared = true
    bakLeft = bakRemoved !== true
    if (bakLeft) {
      log("[session-state] a copy of the cleared sessions is still on disk (its .bak, or the file when the clear failed), so the conversations' running times are not kept until the next save (a file written in front of it could bring the cleared set back)")
      return
    }
    keepRunningTimes('clear')
  }

  function clear(): boolean {
    let done: SessionStateCleared = { ok: false, bakRemoved: false }
    try {
      if (deps.clear) done = deps.clear()
    } catch (err) {
      log(`[session-state] the clear of the saved sessions failed: ${(err as Error)?.message ?? err}`)
    }
    // Fixer 11 (ADR-009 lens D round 2, finding 4): whatever the clear did,
    // the user discarded the set, so the cache goes; a copy left on disk (the
    // file, or its .bak) means nothing is written until the next save.
    noteCleared(done.ok === true && done.bakRemoved === true)
    return done.ok === true
  }

  function load(): SessionState | null {
    const state = deps.load ? deps.load() : null
    try {
      deps.readBack?.(state)
    } catch (err) {
      log(`[session-state] main's records in the saved state could not be read back: ${(err as Error)?.message ?? err}`)
    }
    return state
  }

  return { saveEnriched, flushOnExit, clear, noteCleared, load, peek: () => last }
}
