/**
 * SSH Persistent — pure reconcile helpers for the resume LIVENESS layer.
 *
 * The main-side probe returns a DetachedRemoteLiveness ({outcome, liveSessionIds})
 * for a set of queried detached remotes. The renderer keeps a per-session liveness
 * map and derives from it: what to OFFER on the resume surface (fail-open — hide
 * only a CONFIRMED-dead remote), which entries to PRUNE (verified-dead only), and
 * the AMBER counter (verified-live only). No store, no React — all decisions live
 * here so the fail-open/closed rules are unit-testable in one place.
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
 * The entries to OFFER for reattach on the resume surface: fail-OPEN — everything
 * EXCEPT a confirmed-dead remote. 'checking', 'unverified', 'live', and
 * not-yet-checked are all offered, because a reattach self-heals if it is gone
 * (has-session misses → fresh create + --continue). Only a VERIFIED-dead session
 * is withheld.
 */
export function offerableEntries(entries: DetachedRemote[], map: LivenessMap): DetachedRemote[] {
  return entries.filter((e) => map[e.sessionId] !== 'dead')
}

/** True when at least one OFFERED entry could not be verified — drives the resume
 *  surface's "couldn't verify — offering anyway" note. */
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

// ── Tier 1: host reachability (demote-only) ────────────────────────────────
//
// The SSH `tmux ls` verify above is tier 2 — authenticated, event-driven, and
// the ONLY thing that may promote an entry to 'live'. Tier 1 is a bare host
// ping (main-side `ssh:pingHost`) that may repeat on a slow timer because it
// costs one ICMP echo. It can only ever take state AWAY: a reachable host says
// nothing about the tmux session on it, while a host that has stopped answering
// proves nothing on it is re-attachable right now.

/** Consecutive ping failures before a host's entries are demoted. One failure
 *  is noise (a dropped echo, a laptop mid-roam); two in a row is a signal. */
export const DEMOTE_AFTER_FAILURES = 2

/**
 * What the renderer knows about one HOST. `reachable` starts true-by-absence:
 * a host with no record yet is treated as reachable, since tier 1 may only
 * demote and an unprobed host has demoted nothing.
 */
export interface HostReachability {
  reachable: boolean
  /** Failures since the last success. Reset to 0 by any success. */
  consecutiveFailures: number
  lastCheckedAt: number
}

export type HostReachabilityMap = Record<string, HostReachability>

/** The DISTINCT hosts a set of entries lives on — one ping per host per tick,
 *  never one per entry (three sessions on one box are one ICMP echo). Order is
 *  first-seen, so a tick is deterministic. */
export function distinctHosts(entries: DetachedRemote[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const e of entries) {
    if (!e.host || seen.has(e.host)) continue
    seen.add(e.host)
    out.push(e.host)
  }
  return out
}

/**
 * Fold one ping result into the host map. DEMOTE-ONLY, and both halves of that
 * matter:
 *   - success  → failure counter resets to 0 and the host is reachable again.
 *                It does NOT touch any entry's liveness; promotion is tier 2's
 *                alone.
 *   - failure  → counter increments; the host flips to unreachable only once it
 *                reaches DEMOTE_AFTER_FAILURES. The first failure changes
 *                nothing a user can see.
 */
export function foldPingResult(
  prev: HostReachabilityMap,
  host: string,
  reachable: boolean,
  now: number,
): HostReachabilityMap {
  const before = prev[host]
  if (reachable) {
    return { ...prev, [host]: { reachable: true, consecutiveFailures: 0, lastCheckedAt: now } }
  }
  const consecutiveFailures = (before?.consecutiveFailures ?? 0) + 1
  return {
    ...prev,
    [host]: { reachable: consecutiveFailures < DEMOTE_AFTER_FAILURES, consecutiveFailures, lastCheckedAt: now },
  }
}

/** True when tier 1 has DEMOTED this host (unknown hosts are not demoted). */
export function isHostDemoted(hosts: HostReachabilityMap | undefined, host: string): boolean {
  return hosts?.[host]?.reachable === false
}

/**
 * Hosts that went demoted → reachable between two maps: the "host came back"
 * recovery event. Exactly these get ONE full SSH verify, which is how state
 * heals without a standing SSH poll. A host that was never demoted produces no
 * event, so a merely-flaky single failure never spends a connection.
 */
export function recoveredHosts(prev: HostReachabilityMap, next: HostReachabilityMap): string[] {
  return Object.keys(next).filter((h) => prev[h]?.reachable === false && next[h]?.reachable === true)
}

/**
 * Per-entry state as the UI should SHOW it, once tier 1 is folded in.
 * 'unreachable' is a tier-1 verdict: the host stopped answering, so whatever we
 * last verified about the session is no longer current.
 */
export type EntryDisplayLiveness = EntryLiveness | 'unreachable' | 'unknown'

/**
 * Fold both tiers for one entry. Precedence, strongest evidence first:
 *   1. 'dead'        — tier 2 CONFIRMED the session is gone. An authenticated
 *                      answer outranks an inferred one, always.
 *   2. 'unreachable' — tier 1 demoted the host. Outranks a stale 'live': that
 *                      verify was true when the box was up, and it isn't now.
 *   3. whatever tier 2 last said ('live' / 'checking' / 'unverified').
 *   4. 'unknown'     — never checked this run.
 */
export function displayLiveness(
  entry: DetachedRemote,
  map: LivenessMap,
  hosts?: HostReachabilityMap,
): EntryDisplayLiveness {
  const own = map[entry.sessionId]
  if (own === 'dead') return 'dead'
  if (isHostDemoted(hosts, entry.host)) return 'unreachable'
  return own ?? 'unknown'
}

/**
 * The AMBER counter for a config: how many of its detached entries are
 * VERIFIED-live. Unverified and checking never count — the badge means
 * "confirmed re-attachable", not "maybe".
 *
 * `hosts` is optional and demote-only: pass the tier-1 map and an entry on a
 * host that has stopped answering stops counting, so the badge cannot keep
 * claiming "3 re-attachable" for a box that went away. Omit it and behaviour is
 * exactly as before tier 1 existed.
 */
export function verifiedLiveCount(
  entries: DetachedRemote[],
  map: LivenessMap,
  hosts?: HostReachabilityMap,
): number {
  return entries.reduce((n, e) => (displayLiveness(e, map, hosts) === 'live' ? n + 1 : n), 0)
}
