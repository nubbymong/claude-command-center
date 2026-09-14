import { create } from 'zustand'
import { useConfigStore, type TerminalConfig } from './configStore'
import type { DetachedRemoteLiveness } from '../../shared/types'
import { useDetachedRemotesStore } from './detachedRemotesStore'
import { persistSessionState } from '../session-persistence'
import { matchDetachedRemotes } from '../utils/detachedRemotes'
import {
  applyLivenessResult,
  markChecking as markCheckingIds,
  deadSessionIds,
  type LivenessMap,
} from '../utils/detachedRemotesLiveness'

/**
 * SSH Persistent — ephemeral per-session liveness the renderer learns from the
 * main-side probe. Feeds the resume surface (hide confirmed-dead, show
 * checking/couldn't-verify) and the amber re-attachable counter. NOT persisted —
 * re-derived on demand. No default export (project convention).
 */
interface LivenessState {
  bySession: LivenessMap
  setChecking: (sessionIds: string[]) => void
  applyResult: (queriedSessionIds: string[], result: DetachedRemoteLiveness) => void
  reset: () => void
}

export const useDetachedLivenessStore = create<LivenessState>((set) => ({
  bySession: {},
  setChecking: (ids) => set((s) => ({ bySession: markCheckingIds(s.bySession, ids) })),
  applyResult: (ids, result) => set((s) => ({ bySession: applyLivenessResult(s.bySession, ids, result) })),
  reset: () => set({ bySession: {} }),
}))

// In-flight configIds — a module-level dedupe guard (not render state), so a
// re-mounted row or a double trigger doesn't fire the same probe twice.
const inFlight = new Set<string>()

type LaunchableConfig = Pick<TerminalConfig, 'id' | 'sessionType' | 'sshConfig'>
const UNVERIFIED: DetachedRemoteLiveness = { outcome: 'unverified', liveSessionIds: [] }

/**
 * Probe the host for this config's detached remotes and reconcile: update the
 * liveness map, and PRUNE any verified-dead entry from the persisted registry
 * (never on an 'unverified' outcome — fail-open). No-op when the config has no
 * matching detached entries.
 */
export async function refreshDetachedLiveness(config: LaunchableConfig): Promise<void> {
  const matched = matchDetachedRemotes(useDetachedRemotesStore.getState().entries, config)
  const sessionIds = matched.map((e) => e.sessionId)
  if (sessionIds.length === 0) return
  const key = config.id || sessionIds.join(',')
  if (inFlight.has(key)) return
  inFlight.add(key)
  useDetachedLivenessStore.getState().setChecking(sessionIds)
  try {
    const result = (await window.electronAPI?.ssh?.checkDetachedLive?.({ configId: config.id, sessionIds })) ?? UNVERIFIED
    useDetachedLivenessStore.getState().applyResult(sessionIds, result)
    const dead = deadSessionIds(sessionIds, result)
    if (dead.length > 0) {
      const reg = useDetachedRemotesStore.getState()
      for (const id of dead) reg.remove(id)
      void persistSessionState()
    }
  } catch {
    useDetachedLivenessStore.getState().applyResult(sessionIds, UNVERIFIED)
  } finally {
    inFlight.delete(key)
  }
}

/**
 * One-pass refresh for the config list (on mount / on demand — never a poll):
 * probe every config that has matching detached entries.
 */
export async function refreshAllDetachedLiveness(configs: LaunchableConfig[]): Promise<void> {
  const entries = useDetachedRemotesStore.getState().entries
  if (entries.length === 0) return
  await Promise.all(
    configs.filter((c) => matchDetachedRemotes(entries, c).length > 0).map((c) => refreshDetachedLiveness(c)),
  )
}

// ── The event hooks: every place a full SSH verify is allowed to happen ──
//
// The SSH `tmux ls` probe authenticates and spends a connection, so it runs on
// EVENTS and never on a clock. That list is closed, and it is exactly these
// four plus the app-start pass (App.tsx) and the tier-1 recovery transition
// (hostReachability.ts). The repeating cheap check is the host ping, which can
// only ever demote.
//
// They are thin, deliberately: named seams Phase 3's Remote Resumable section
// calls, so the "when may we ssh?" policy reads as a list in one file instead of
// being scattered across component effects. refreshDetachedLiveness's in-flight
// guard collapses whatever arrives while a probe is already running, so a burst
// of focus events costs one probe.

/** The resume section became visible — verify everything it is about to show. */
export async function verifyOnResumeSectionOpen(): Promise<void> {
  await refreshAllDetachedLiveness(useConfigStore.getState().configs)
}

/** The window regained focus — the user was away, so re-verify. */
export async function verifyOnWindowFocus(): Promise<void> {
  await refreshAllDetachedLiveness(useConfigStore.getState().configs)
}

/** A resumable card was clicked — verify just that config before acting on it. */
export async function verifyOnCardClick(config: LaunchableConfig): Promise<void> {
  await refreshDetachedLiveness(config)
}

/**
 * Full teardown for tests: forget every recorded liveness AND clear the
 * in-flight guard. Both halves matter — `inFlight` is module state, so a probe
 * a test left pending would silently swallow the NEXT test's probe (the guard
 * doing exactly its job, against a caller that no longer exists). Sibling of
 * hostReachability's resetHostReachability.
 */
export function resetDetachedLiveness(): void {
  inFlight.clear()
  useDetachedLivenessStore.setState({ bySession: {} })
}

/**
 * App-restart path: probe the restored persistent-SSH sessions' OWN tmux targets
 * and return the ids whose remote is CONFIRMED gone (verified, not alive). Grouped
 * by configId (only sessions with a configId can be probed — the target is built
 * from the saved config). Unverified hosts contribute nothing (fail-open: no
 * notice for a host that is merely asleep). Never throws.
 */
export async function probeGoneSessions(sessions: Array<{ id: string; configId?: string }>): Promise<string[]> {
  const byConfig = new Map<string, string[]>()
  for (const s of sessions) {
    if (!s.configId) continue
    const list = byConfig.get(s.configId) ?? []
    list.push(s.id)
    byConfig.set(s.configId, list)
  }
  const gone: string[] = []
  await Promise.all(
    [...byConfig.entries()].map(async ([configId, sessionIds]) => {
      try {
        const result = (await window.electronAPI?.ssh?.checkDetachedLive?.({ configId, sessionIds })) ?? UNVERIFIED
        for (const id of deadSessionIds(sessionIds, result)) gone.push(id)
      } catch {
        /* fail-open: no notice on a probe failure */
      }
    }),
  )
  return gone
}
