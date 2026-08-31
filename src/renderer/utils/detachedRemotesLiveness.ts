/**
 * SSH Persistent — pure reconcile helpers for the resume LIVENESS layer.
 *
 * The main-side probe returns a DetachedRemoteLiveness ({outcome, liveSessionIds})
 * for a set of queried detached remotes. The renderer keeps a per-session liveness
 * map and derives from it: what to OFFER on a manual launch (fail-open — hide only
 * a CONFIRMED-dead remote), which entries to PRUNE (verified-dead only), and the
 * AMBER counter (verified-live only). No store, no React — all decisions live here
 * so the fail-open/closed rules are unit-testable in one place.
 */
import type { DetachedRemote, DetachedRemoteLiveness } from '../../shared/types'

/**
 * Per-session liveness, as the renderer knows it:
 *   - 'checking'   — a probe is in flight (no answer yet)
 *   - 'live'       — verified alive on the host
 *   - 'dead'       — verified NOT alive (host answered, target absent)
 *   - 'unverified' — the host could not be reached / auth failed (fail-open)
 * An id absent from the map has not been checked this run.
 */
export type EntryLiveness = 'checking' | 'live' | 'dead' | 'unverified'
export type LivenessMap = Record<string, EntryLiveness>

/** Mark a set of ids as a probe-in-flight, preserving other entries. */
export function markChecking(prev: LivenessMap, sessionIds: Iterable<string>): LivenessMap {
  const next = { ...prev }
  for (const id of sessionIds) next[id] = 'checking'
  return next
}

/** Fold a probe result into the map: verified → live/dead per membership;
 *  unverified → every queried id becomes 'unverified' (fail-open). */
export function applyLivenessResult(prev: LivenessMap, queriedSessionIds: Iterable<string>, result: DetachedRemoteLiveness): LivenessMap {
  const next = { ...prev }
  if (result.outcome === 'unverified') {
    for (const id of queriedSessionIds) next[id] = 'unverified'
    return next
  }
  const alive = new Set(result.liveSessionIds)
  for (const id of queriedSessionIds) next[id] = alive.has(id) ? 'live' : 'dead'
  return next
}

/**
 * The entries to OFFER for reattach: fail-OPEN — everything EXCEPT a
 * confirmed-dead remote. 'checking', 'unverified', 'live', and not-yet-checked
 * are all offered, because a reattach self-heals if the remote turns out gone
 * (has-session misses → fresh create + --continue). Only a VERIFIED-dead session
 * is withheld.
 */
export function offerableEntries(entries: DetachedRemote[], map: LivenessMap): DetachedRemote[] {
  return entries.filter((e) => map[e.sessionId] !== 'dead')
}

/** True when at least one OFFERED entry could not be verified — drives the
 *  dialog's "couldn't verify — offering anyway" note. */
export function hasUnverifiedOffer(entries: DetachedRemote[], map: LivenessMap): boolean {
  return offerableEntries(entries, map).some((e) => map[e.sessionId] === 'unverified')
}

/**
 * VERIFIED-dead session ids among the queried set — the ones to PRUNE from the
 * persisted registry. Empty when the outcome is 'unverified' (never prune on a
 * failed probe — fail-open).
 */
export function deadSessionIds(queriedSessionIds: string[], result: DetachedRemoteLiveness): string[] {
  if (result.outcome !== 'verified') return []
  const alive = new Set(result.liveSessionIds)
  return queriedSessionIds.filter((id) => !alive.has(id))
}

/**
 * The AMBER counter for a config: how many of its detached entries are
 * VERIFIED-live. Unverified and checking never count — the badge means
 * "confirmed re-attachable", not "maybe".
 */
export function verifiedLiveCount(entries: DetachedRemote[], map: LivenessMap): number {
  return entries.reduce((n, e) => (map[e.sessionId] === 'live' ? n + 1 : n), 0)
}
