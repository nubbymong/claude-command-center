// Persistence for last-known-good account usage.
//
// `account-usage.ts` has always kept the last successful fetch per profile so a
// later fetch that cannot complete (lapsed token, 429 burst, network blip) shows
// stale-but-real figures rather than blanking the card. That map was memory-only
// and its comment said so: "Cleared naturally on app restart."
//
// Which meant the case it was most wanted in was the one case it could not
// serve. Reopen the app, pick an account before any session has run, and there
// was nothing to show -- the card had to wait for a live fetch even though the
// app knew perfectly well what that account looked like an hour ago.
//
// This module is only the disk half. Nothing about the DECISION changes:
// `resolveUsageOutcome` already models "stale figures with an age" and the UI
// already renders `stale` + `fetchedAt`. A snapshot is a convenience, never a
// source of truth, which is why every parse failure here drops the entry rather
// than trying to repair it -- falling back to a live fetch costs nothing, while
// trusting a half-parsed record paints wrong numbers over a real account.
//
// Nothing is shown on a fresh install until one fetch has succeeded and been
// persisted, so a new user sees this from their second run onward. That is
// inherent: there is no honest figure to show before there is a figure.
import { createReadFailureLatch, loadConfigLatched, saveConfigLatched } from '../persist-latch'
import type { UsageBucket, CreditsInfo } from '../../shared/usage-types'

export interface UsageSnapshot {
  buckets: UsageBucket[]
  credits?: CreditsInfo
  /** epoch ms of the fetch these figures came from -- what "as of 2h ago" reads. */
  fetchedAt: number
}

/** One bucket, defensively: a hand-edited or truncated file must not be able to
 *  put NaN into a meter or a non-string into a label. */
function isBucket(v: unknown): v is UsageBucket {
  if (!v || typeof v !== 'object') return false
  const b = v as Record<string, unknown>
  return typeof b.key === 'string'
    && typeof b.label === 'string'
    && typeof b.group === 'string'
    && typeof b.percent === 'number' && Number.isFinite(b.percent)
    && typeof b.resetsAt === 'string'
}

/**
 * Validate a raw parsed JSON blob into snapshots. Pure, so the whole
 * accept/reject matrix is testable without touching disk or the fetch path.
 * Anything that does not fully typecheck is DROPPED, entry by entry -- one bad
 * record must not cost the user every other account's snapshot.
 */
export function parseSnapshots(raw: unknown): Map<string, UsageSnapshot> {
  const out = new Map<string, UsageSnapshot>()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [profileId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!profileId) continue
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    if (!Array.isArray(v.buckets) || !v.buckets.every(isBucket)) continue
    if (typeof v.fetchedAt !== 'number' || !Number.isFinite(v.fetchedAt)) continue
    // A fetchedAt in the future would render as a negative age ("as of -3h
    // ago"), which is worse than no snapshot at all.
    if (v.fetchedAt > Date.now()) continue
    const credits = v.credits && typeof v.credits === 'object' ? (v.credits as CreditsInfo) : undefined
    out.set(profileId, { buckets: v.buckets as UsageBucket[], credits, fetchedAt: v.fetchedAt })
  }
  return out
}

/** #371: the old comment here said "an unreadable file is simply no snapshots",
 *  which is true for an ABSENT file and false for an unreadable one. Every
 *  caller rebuilds the whole map and saves it back, so one EBUSY read at the
 *  wrong moment dropped every other profile's snapshot. */
const snapshotsLatch = createReadFailureLatch('usage-snapshots')

/** Read the persisted snapshots. Never throws: an ABSENT file is no snapshots,
 *  which is the state every install starts in. A file that could not be READ is
 *  also no snapshots to show, but it latches saving off until a load succeeds —
 *  a blank card costs a fetch, an overwritten file costs the history. */
export function loadSnapshots(): Map<string, UsageSnapshot> {
  try {
    return parseSnapshots(loadConfigLatched<unknown>('usageSnapshots', snapshotsLatch))
  } catch {
    return new Map()
  }
}

/** Write the snapshots through. Best-effort: a snapshot that fails to persist is
 *  not worth failing a usage fetch over, so this never throws. */
export function saveSnapshots(snapshots: Map<string, UsageSnapshot>): boolean {
  try {
    return saveConfigLatched('usageSnapshots', Object.fromEntries(snapshots), snapshotsLatch)
  } catch {
    return false
  }
}

/** Test seam — the latch is module state and outlives a test file otherwise. */
export function _resetSnapshotsLatchForTest(): void {
  snapshotsLatch.reset()
}
