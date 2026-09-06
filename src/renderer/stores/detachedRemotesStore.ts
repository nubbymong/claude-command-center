import { create } from 'zustand'
import type { DetachedRemote } from '../../shared/types'

/**
 * SSH Persistent — "Resume a Running Session" (Phase 1): the in-memory registry
 * of remote tmux sessions the user LEFT RUNNING.
 *
 * Hydrated from session-state.json on restore (App.tsx) and folded back into it
 * by buildSessionState (session-persistence.ts), so an entry survives an app
 * restart. Lifecycle: `add` on Leave running; `remove` on reattach (Phase 3) or
 * End remote. No default export (project convention).
 */
/**
 * Upper bound on a hydrated registry.
 *
 * Every entry costs a card, a liveness slot, and a share of the ping fan-out —
 * `distinctHosts` turns the array into one probe per host per 90s tick, so an
 * oversized file is an amplifier pointed at whatever hosts it names. A user with
 * two hundred remotes left running does not exist; a file that says so is
 * corrupt or hostile, and either way the tail is not worth honouring.
 */
export const DETACHED_REMOTES_MAX = 200

/**
 * Is this a DetachedRemote we can actually work with?
 *
 * `hydrate` reads session-state.json, which round-trips this array untouched by
 * design (the main-side loader migrates only `sessions`) — so what lands here is
 * whatever is on disk: a file edited by hand, written by an older build, or
 * truncated by a crash mid-write. The old check was `Array.isArray` alone, so a
 * `[null]` or a `{}` went straight into the store, and the first thing that
 * touched it threw: `distinctHosts` reads `e.host` on every tick of the
 * reachability timer, and an unhandled rejection every 90 seconds is not a
 * degraded feature, it is a broken app.
 *
 * FAIL-OPEN PER ENTRY, the same posture as `sanitizeRestoredSpawnOptions`: a
 * malformed row is DROPPED and the rest of the registry survives. Losing one
 * card is recoverable (the remote is still on its host, and reattaching or
 * ending it is a config-driven action); losing the whole registry, or crashing
 * on it, is not. Only the fields something reads are required — `configId` and
 * `accountEmail` are optional in the type and stay optional here.
 */
function isUsableDetachedRemote(value: unknown): value is DetachedRemote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const e = value as Record<string, unknown>
  return (
    typeof e.sessionId === 'string' && e.sessionId.length > 0 &&
    typeof e.host === 'string' && e.host.length > 0 &&
    typeof e.username === 'string' && e.username.length > 0 &&
    typeof e.remotePath === 'string' &&
    (e.mux === 'tmux' || e.mux === 'psmux') &&
    typeof e.label === 'string' &&
    typeof e.detachedAt === 'number' && Number.isFinite(e.detachedAt) &&
    (e.configId === undefined || typeof e.configId === 'string') &&
    (e.accountEmail === undefined || typeof e.accountEmail === 'string') &&
    // #54 destination fields: optional (absent on pre-#54 files), but when
    // present they drive the orphan decision, so a malformed one is a bad row.
    (e.port === undefined || (typeof e.port === 'number' && Number.isFinite(e.port))) &&
    (e.runtime === undefined || isUsableRuntime(e.runtime))
  )
}

/** A recorded runtime we can compare: an object whose `type` this build knows. */
function isUsableRuntime(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const t = (value as { type?: unknown }).type
  return t === 'host' || t === 'container'
}

/** Drop what cannot be used, then bound what is left. Exported so the boundary
 *  rule is tested against the real predicate rather than a copy of it. */
export function sanitizeRestoredDetachedRemotes(value: unknown): DetachedRemote[] {
  if (!Array.isArray(value)) return []
  return value.filter(isUsableDetachedRemote).slice(0, DETACHED_REMOTES_MAX)
}

interface DetachedRemotesState {
  entries: DetachedRemote[]
  /** Add (or replace, by sessionId) a left-running remote. */
  add: (entry: DetachedRemote) => void
  /** Drop the entry for a session id (reattached / ended / stale). */
  remove: (sessionId: string) => void
  /** Replace the whole registry from persisted state on restore. */
  hydrate: (entries: DetachedRemote[] | undefined) => void
}

export const useDetachedRemotesStore = create<DetachedRemotesState>((set) => ({
  entries: [],
  add: (entry) =>
    set((s) => ({
      // Dedupe by sessionId: a re-detach of the same id supersedes the old
      // record rather than stacking a second, stale one.
      entries: [...s.entries.filter((e) => e.sessionId !== entry.sessionId), entry],
    })),
  remove: (sessionId) =>
    set((s) => {
      const entries = s.entries.filter((e) => e.sessionId !== sessionId)
      // Preserve array identity when nothing changed (no-op remove of an id that
      // was never registered — the common End-remote case), so subscribers don't
      // re-render on a teardown that touched no entry.
      return entries.length === s.entries.length ? s : { entries }
    }),
  hydrate: (entries) => set({ entries: sanitizeRestoredDetachedRemotes(entries) }),
}))
