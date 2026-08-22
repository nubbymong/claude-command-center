/**
 * session-durability.ts — the cross-exit durability core for session-state (#397).
 *
 * Holds the last-known ENRICHED session state and the save / flush / clear logic
 * that index.ts wires to the `session:save` IPC and the process-exit hooks. Kept
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
  log?: (msg: string) => void
}

export interface SessionDurability {
  /** Enrich (from the binder) + cache + persist. The single `session:save` path. */
  saveEnriched: (state: SessionState) => boolean
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

  return { saveEnriched, flushOnExit, noteCleared, peek: () => last }
}
