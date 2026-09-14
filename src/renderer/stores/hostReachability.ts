import { create } from 'zustand'
import { useConfigStore } from './configStore'
import { useDetachedRemotesStore } from './detachedRemotesStore'
import { refreshDetachedLiveness } from './livenessStore'
import { matchDetachedRemotes } from '../utils/detachedRemotes'
import {
  distinctHosts,
  foldPingResult,
  recoveredHosts,
  type HostReachabilityMap,
} from '../utils/detachedRemotesLiveness'

/**
 * SSH Persistent — TIER 1 host reachability, and the ONLY thing in the resume
 * layer allowed to run on a clock.
 *
 * THE MODEL, in one paragraph. The expensive check — an authenticated ssh that
 * runs `tmux ls` — is tier 2 (livenessStore), and it fires on EVENTS ONLY: app
 * start, the resume section opening, window focus, a card click, and a host
 * coming back. Never on a timer. What repeats here instead is a bare host ping:
 * one ICMP echo per DISTINCT host (not per entry) every ~90s, and only while
 * pings are ARMED. It is demote-only — a reachable host says nothing about the
 * tmux session on it, so it can never promote an entry to 'live'; two
 * consecutive failures demote that host's entries to 'unreachable'. When a
 * demoted host starts answering again, that transition fires EXACTLY ONE tier-2
 * verify for the affected configs, which is how the state heals without a
 * standing SSH poll.
 *
 * All the decisions (fold, demote threshold, transition detection, dedupe) live
 * in utils/detachedRemotesLiveness.ts; this module is the scheduling shell.
 * No default export (project convention).
 */

/** Ping cadence while armed. Slow by design — this is a liveness hint, not a
 *  heartbeat, and every tick is real network traffic on someone's LAN. */
export const HOST_PING_INTERVAL_MS = 90_000

interface HostReachabilityState {
  byHost: HostReachabilityMap
  reset: () => void
}

export const useHostReachabilityStore = create<HostReachabilityState>((set) => ({
  byHost: {},
  reset: () => set({ byHost: {} }),
}))

// Module-level scheduling state (not render state).
let timer: ReturnType<typeof setInterval> | null = null
let tickInFlight = false

/**
 * Run ONE reachability pass: ping every distinct host in the detached registry,
 * fold the answers, and fire the recovery verify for any host that came back.
 *
 * Safe to call directly — this is the "one initial pass" the app start uses, and
 * the body of each armed tick. Concurrent calls collapse (a slow pass never
 * overlaps the next tick). Never throws.
 */
export async function pingAllDetachedHosts(): Promise<void> {
  if (tickInFlight) return
  const ping = window.electronAPI?.ssh?.pingHost
  // No IPC surface (tests, a preload that predates tier 1): do NOTHING rather
  // than record failures. Absence of evidence must not demote a live host.
  if (typeof ping !== 'function') return
  const hosts = distinctHosts(useDetachedRemotesStore.getState().entries)
  if (hosts.length === 0) return

  tickInFlight = true
  try {
    const results = await Promise.all(
      hosts.map(async (host) => {
        try {
          const r = await ping({ host })
          return { host, reachable: !!r?.reachable }
        } catch {
          // An IPC rejection is a failed probe, not a crash — it counts toward
          // the demote threshold exactly like a timed-out ping.
          return { host, reachable: false }
        }
      }),
    )

    const prev = useHostReachabilityStore.getState().byHost
    const now = Date.now()
    let next = prev
    for (const { host, reachable } of results) next = foldPingResult(next, host, reachable, now)
    useHostReachabilityStore.setState({ byHost: next })

    // The recovery event, derived from the TRANSITION (demoted → reachable), so
    // it cannot fire from the timer itself, cannot fire per-entry, and cannot
    // re-fire on the next tick while the host stays up.
    for (const host of recoveredHosts(prev, next)) verifyHostEntries(host)
  } finally {
    tickInFlight = false
  }
}

/**
 * Fire the tier-2 SSH verify for the entries on one host — ONE per affected
 * config, never one per entry. Configs are matched with the same
 * matchDetachedRemotes rule the rest of the feature uses (configId first,
 * host+user+path fallback), and livenessStore's own in-flight guard collapses a
 * duplicate that arrives while a probe is still running.
 */
function verifyHostEntries(host: string): void {
  const entries = useDetachedRemotesStore.getState().entries.filter((e) => e.host === host)
  if (entries.length === 0) return
  for (const config of useConfigStore.getState().configs) {
    if (matchDetachedRemotes(entries, config).length === 0) continue
    void refreshDetachedLiveness(config)
  }
}

/**
 * ARM the ping timer: run a pass now, then every HOST_PING_INTERVAL_MS. Phase 3
 * calls this when the Running tab becomes visible. Idempotent — arming an armed
 * scheduler does not stack a second timer or a second pass.
 */
export function armHostPings(): void {
  if (timer) return
  timer = setInterval(() => { void pingAllDetachedHosts() }, HOST_PING_INTERVAL_MS)
  void pingAllDetachedHosts()
}

/** DISARM: stop the timer. Phase 3 calls this when the Running tab is hidden.
 *  The recorded reachability survives — only the clock stops. */
export function disarmHostPings(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

/** Is the ping timer running? (Phase 3 / tests.) */
export function isHostPingArmed(): boolean {
  return timer !== null
}

/** Full teardown for tests: disarm and forget every recorded host. */
export function resetHostReachability(): void {
  disarmHostPings()
  tickInFlight = false
  useHostReachabilityStore.setState({ byHost: {} })
}
