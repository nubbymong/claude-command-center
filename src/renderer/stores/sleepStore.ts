import { create } from 'zustand'
import type { DiagnosticsSnapshot } from '../../shared/service-health'

/**
 * Sleeping sessions (canvas "Session sleep indicator", 2026-08-27): surface the
 * Watchdog's silent observation as a moon on the session card.
 *
 * The rules, exactly as agreed on the canvas (v4, R2/R3):
 *  - SOURCE is the Watchdog alone. A session sleeps when the Watchdog reports
 *    it `silent` (no PTY output for the silence window — its own, configurable
 *    definition, default 120 s). Sessions the Watchdog does not watch never
 *    sleep visibly, and the renderer runs no clock of its own.
 *  - WAKE is Watchdog-observed activity only. Clicking or selecting a session
 *    changes nothing here — the moon clears when the next health push says the
 *    session is no longer silent. (The Watchdog itself excludes click-redraw
 *    output via its activation grace, RC8, so a click cannot wake a session
 *    through the back door either.)
 *  - MONITOR sessions never sleep (RC8): a session advertising active
 *    monitors in its mode footer is quiet between triggers by design; the
 *    Watchdog flags it (`hasMonitors`) and the moon skips it.
 *  - ATTENTION always outranks the moon (enforced where the moon renders:
 *    `isAsleep` takes needsAttention). A session that stalled WITH a question
 *    shows attention, never sleep.
 *  - AFTER an attention dismiss the moon's clock restarts: the Watchdog's idle
 *    count likely ran past the window while attention was up, so the moon may
 *    appear only once the dismiss is at least ATTENTION_DISMISS_GRACE_MS old.
 *    A dismiss can only DELAY a moon, never wake a session.
 */

/** Minimum age of an attention dismiss before a moon may appear (owner call). */
export const ATTENTION_DISMISS_GRACE_MS = 60_000

interface SleepState {
  /** sessionId -> epoch ms the current silence began (now - idleMs at flip). */
  silentSince: Record<string, number>
  /** sessionId -> epoch ms attention was last dismissed. */
  attentionDismissedAt: Record<string, number>
  /** Bumped when a dismiss grace window elapses, so subscribers re-derive. */
  graceTick: number
  applyWatchdogSessions: (
    sessions: ReadonlyArray<{ sessionId: string; silent: boolean; idleMs: number; hasMonitors?: boolean }>,
    now?: number,
  ) => void
  noteAttentionDismissed: (sessionId: string, now?: number) => void
}

/**
 * Pure eligibility rule, tested directly. `silentSince`/`dismissedAt` are
 * per-session values (undefined = no record).
 */
export function isAsleep(input: {
  silentSince: number | undefined
  dismissedAt: number | undefined
  needsAttention: boolean
  now: number
}): boolean {
  const { silentSince, dismissedAt, needsAttention, now } = input
  if (silentSince == null) return false
  if (needsAttention) return false
  if (dismissedAt != null && now - dismissedAt < ATTENTION_DISMISS_GRACE_MS) return false
  return true
}

export const useSleepStore = create<SleepState>((set, get) => ({
  silentSince: {},
  attentionDismissedAt: {},
  graceTick: 0,

  applyWatchdogSessions: (sessions, now = Date.now()) => {
    const prev = get().silentSince
    const next: Record<string, number> = {}
    for (const s of sessions) {
      // Monitor sessions are quiet between triggers BY DESIGN (RC8): the
      // Watchdog flags them from the "· N monitors ·" mode footer, and the
      // moon skips them even though they are silent by the output clock.
      if (!s.silent || s.hasMonitors === true) continue
      // Keep the original start across pushes; derive it from idleMs on the
      // flip so "asleep 6m" is honest even when the flip push arrived late.
      next[s.sessionId] = prev[s.sessionId] ?? now - Math.max(0, s.idleMs)
    }
    // A session absent from the snapshot has no watcher any more — Watchdog-only
    // source means absent there is absent here (same rule as the sidebar badge).
    const changed =
      Object.keys(next).length !== Object.keys(prev).length ||
      Object.keys(next).some((id) => next[id] !== prev[id])
    if (changed) set({ silentSince: next })
  },

  noteAttentionDismissed: (sessionId, now = Date.now()) => {
    // One timer per session; a re-dismiss before expiry replaces the pending one.
    const pending = graceTimers.get(sessionId)
    if (pending) clearTimeout(pending)
    set((s) => ({ attentionDismissedAt: { ...s.attentionDismissedAt, [sessionId]: now } }))
    // One-shot re-derive when the grace expires: the store only changes on
    // pushes/dismissals, so without this a moon due at dismiss+60s would wait
    // for the next unrelated health push to appear.
    graceTimers.set(
      sessionId,
      setTimeout(() => {
        graceTimers.delete(sessionId)
        set((s) => ({ graceTick: s.graceTick + 1 }))
      }, ATTENTION_DISMISS_GRACE_MS),
    )
  },
}))

const graceTimers = new Map<string, ReturnType<typeof setTimeout>>()

// Module-local unsub so setup is idempotent (StrictMode double-invoke /
// remount) — same shape as setupChannelListeners.
let sleepUnsub: (() => void) | null = null

/** Wire the serviceHealth subscription once at app start (App.tsx postConfigInit). */
export function setupSleepListeners(): () => void {
  if (sleepUnsub) return sleepUnsub
  const apply = (snap: DiagnosticsSnapshot | null | undefined) => {
    useSleepStore.getState().applyWatchdogSessions(snap?.watchdog?.sessions ?? [])
  }
  const off = window.electronAPI.serviceHealth.onUpdate(apply)
  // Seed from the current snapshot: pushes are flip-driven, so a session that
  // went silent before this renderer mounted would otherwise never show.
  void window.electronAPI.serviceHealth.get().then(apply).catch(() => {
    /* main gone mid-teardown */
  })
  sleepUnsub = off
  return sleepUnsub
}
