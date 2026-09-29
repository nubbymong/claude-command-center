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
import type { SessionState } from './session-state'
import { enrichSessionStateWithResumeTargets, type ResumeEnrichDeps } from './session-resume-enrich'

export interface DurabilityDeps {
  /** Binder-backed enrichment (lazily reads getTranscriptBinder each call). */
  enrichDeps: ResumeEnrichDeps
  /** session-state.saveSessionState — returns false when the latch refuses. */
  save: (state: SessionState) => boolean
  /** session-state.loadSessionState: the `session:load` path. */
  load?: () => SessionState | null
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
   *  state has been saved this run; honest about a latch refusal. Never throws. */
  flushOnExit: (reason: string) => void
  /** Drop the cache after a successful clear so the exit flush cannot resurrect a
   *  set the user intentionally discarded (F1). */
  noteCleared: () => void
  /** Test-only: read the cached state. */
  peek: () => SessionState | null
}

export function createSessionDurability(deps: DurabilityDeps): SessionDurability {
  let last: SessionState | null = null
  const log = deps.log ?? (() => {})

  function saveEnriched(state: SessionState): boolean {
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
    if (!last) return
    try {
      const ok = saveEnriched(last)
      log(ok
        ? `[session-state] durable flush on ${reason}`
        : `[session-state] durable flush on ${reason} REFUSED (read-failure latch); on-disk file kept`)
    } catch (err) {
      log(`[session-state] durable flush on ${reason} failed: ${(err as Error)?.message ?? err}`)
    }
  }

  function noteCleared(): void {
    last = null
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

  return { saveEnriched, flushOnExit, noteCleared, load, peek: () => last }
}
