import { create } from 'zustand'
import { useSessionStore } from './sessionStore'

/**
 * Active sessions (the inverse of the sleep moon — owner call, 2026-08-27):
 * a Claude session whose PTY output is MOVING right now gets a subtle green
 * sweep on its context bar. Sourced in the RENDERER from the same `pty:data`
 * bytes the Watchdog observes (`pty-manager` sends them unconditionally per
 * session), so — unlike sleep, which rides the Watchdog and needs it enabled —
 * this works for every Claude session out of the box, and the main process is
 * left untouched.
 *
 * The rules:
 *  - SOURCE is raw PTY output. Each chunk stamps `lastOutputAt`; a session is
 *    "active" while its last chunk is within ACTIVE_WINDOW_MS. The store only
 *    re-renders on a TICK when the active SET changes, never per chunk.
 *  - MUTUALLY EXCLUSIVE with sleep by construction: sleep is 120 s of silence,
 *    active is output within ~2.5 s — the two windows can never both hold.
 *  - ATTENTION outranks it, and it is Claude-only: both enforced where the bar
 *    renders (SessionRow), not here — this store only answers "is output moving".
 */

/** Output seen within this window counts as "actively moving". */
export const ACTIVE_WINDOW_MS = 2500
/** How often the active set is re-derived (the CSS animation is smooth regardless). */
const TICK_MS = 1000
/** Activation grace (RC8): after a session click/switch or a terminal resize,
 *  the TUI repaints (focus-report response, ConPTY redraw) — output that is a
 *  REDRAW, not work. Chunks within this window of such a trigger are ignored,
 *  so the pill does not flash on a click. Mirrors the main-process grace the
 *  Watchdog applies to the sleep moon. A genuinely working session keeps
 *  streaming past the window, and its ≤1s stamp gap never outlasts the 2.5s
 *  active window — so a live pill cannot flicker off from the grace itself. */
export const ACTIVITY_GRACE_MS = 1000

interface ActiveState {
  /** Session ids whose PTY output moved within the last ACTIVE_WINDOW_MS. */
  activeIds: Set<string>
}

export const useActiveStore = create<ActiveState>(() => ({ activeIds: new Set<string>() }))

// Module-local, per session: epoch ms of the last pty:data chunk. Written on the
// hot path (every chunk) so it is a plain Map, never store state.
const lastOutputAt = new Map<string, number>()
// Per-session unsubscribe handles for the pty:data subscriptions we own.
const dataSubs = new Map<string, () => void>()
// Per-session grace deadline (epoch ms): chunks before it are click/resize
// redraws and are not stamped. See ACTIVITY_GRACE_MS.
const graceUntil = new Map<string, number>()

/** Arm the activation grace for a session: the next ACTIVITY_GRACE_MS of its
 *  output is treated as a redraw, not activity. TerminalView calls this on the
 *  SAME triggers the main process graces the sleep moon on — a focus-report
 *  write (\x1b[I / \x1b[O, sent by xterm when a pane gains or loses focus, so
 *  both sides of a session switch are covered) and a PTY resize (ConPTY
 *  repaints on resize). */
export function noteActivityGrace(sessionId: string): void {
  graceUntil.set(sessionId, Date.now() + ACTIVITY_GRACE_MS)
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

// One reconcile of the pty:data subscriptions against the live session list:
// subscribe ids we don't yet watch, drop ids that are gone (and their stamp).
function reconcile(ids: readonly string[]): void {
  const api = window.electronAPI?.pty
  if (!api) return
  const live = new Set(ids)
  for (const id of live) {
    if (!dataSubs.has(id)) {
      const off = api.onData(id, () => {
        const now = Date.now()
        // Inside the activation grace this chunk is a click/resize redraw —
        // never stamp it as activity (RC8).
        if (now < (graceUntil.get(id) ?? 0)) return
        lastOutputAt.set(id, now)
      })
      dataSubs.set(id, off)
    }
  }
  for (const [id, off] of dataSubs) {
    if (!live.has(id)) {
      try { off() } catch { /* listener already gone */ }
      dataSubs.delete(id)
      lastOutputAt.delete(id)
      graceUntil.delete(id)
    }
  }
}

// Module-local so setup is idempotent (StrictMode double-invoke / remount) —
// same shape as setupSleepListeners.
let started = false
let tickTimer: ReturnType<typeof setInterval> | null = null
let sessionUnsub: (() => void) | null = null
let lastIdsKey = ''

/** Wire the PTY-activity tracking once at app start (App.tsx postConfigInit). */
export function setupActiveListeners(): () => void {
  if (started) return teardownActiveListeners
  started = true

  const applyIds = (ids: readonly string[]) => {
    // Cheap identity guard: the session store changes on every keystroke/status
    // tick, but the id LIST rarely does — only reconcile when it actually moved.
    // Newline separator: a session id (randomId, hex) never contains one, so no
    // two distinct lists can collide onto the same key.
    const key = [...ids].sort().join('\n')
    if (key === lastIdsKey) return
    lastIdsKey = key
    reconcile(ids)
  }

  applyIds(useSessionStore.getState().sessions.map((s) => s.id))
  sessionUnsub = useSessionStore.subscribe((state) => applyIds(state.sessions.map((s) => s.id)))

  tickTimer = setInterval(() => {
    const now = Date.now()
    const next = new Set<string>()
    for (const [id, at] of lastOutputAt) {
      if (now - at < ACTIVE_WINDOW_MS) next.add(id)
    }
    const cur = useActiveStore.getState().activeIds
    if (!setsEqual(cur, next)) useActiveStore.setState({ activeIds: next })
  }, TICK_MS)

  return teardownActiveListeners
}

/** Tear everything down (tests / teardown). Leaves the store empty. */
export function teardownActiveListeners(): void {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
  if (sessionUnsub) { try { sessionUnsub() } catch { /* ignore */ } sessionUnsub = null }
  for (const [, off] of dataSubs) { try { off() } catch { /* ignore */ } }
  dataSubs.clear()
  lastOutputAt.clear()
  graceUntil.clear()
  lastIdsKey = ''
  started = false
  useActiveStore.setState({ activeIds: new Set<string>() })
}
