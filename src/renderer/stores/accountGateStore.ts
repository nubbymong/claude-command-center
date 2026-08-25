import { create } from 'zustand'

// Transient (never persisted) store backing the pre-spawn account launch gate.
// Before a session spawns for the first time this app-run, TerminalView asks
// the user which account to launch under via `requestChoice`, which resolves
// when <AccountLaunchGate> calls `resolveChoice`. Restart / switch mark the
// session `predetermined` so the gate is skipped (they already chose).

/** Sentinel resolution meaning "the user cancelled the launch" — the awaiting
 *  spawn must NOT proceed (TerminalView closes the pending tab instead). */
export const GATE_CANCELLED = '__account-gate-cancelled__' as const
export type GateChoice = string | undefined | typeof GATE_CANCELLED

export interface PendingAccountGate {
  sessionId: string
  /** Friendly label shown in the modal ("Choose the account for X"). */
  sessionLabel: string
  /** Pre-selected profile id. Always a real profile id in the multi-account UI. */
  currentProfileId: string | undefined
  /** Resolves the awaiting spawn with the chosen profile id (undefined = Default). */
  resolve: (profileId: GateChoice) => void
}

interface AccountGateState {
  /** FIFO of sessions awaiting an account choice. The modal renders queue[0]. */
  queue: PendingAccountGate[]
  /** Sessions whose next spawn already has an explicit account (restart/switch). */
  predetermined: string[]
  /** Sessions RESTORED this app-run (#446). A property of the session, not of
   *  the resume-account setting, so it is marked in BOTH modes. It is what
   *  makes a cancelled resume-gate keep the session (continue under its saved
   *  account) instead of discarding it the way a cancelled NEW-tab gate does —
   *  session.profileId cannot tell the two apart (legacy config.profileId, and
   *  single-account sessions that carry no pin). Never persisted. */
  restored: string[]

  /** Enqueue a choice request; resolves when the modal is answered. */
  requestChoice: (
    sessionId: string,
    sessionLabel: string,
    currentProfileId: string | undefined,
  ) => Promise<GateChoice>
  /** Answer the head request with the chosen profile id (undefined = Default). */
  resolveChoice: (profileId: string | undefined) => void
  /** Cancel the head request: the awaiting spawn aborts and the tab closes. */
  cancelChoice: () => void
  /** Re-entry guard: is a gate already queued for this session? */
  isPending: (sessionId: string) => boolean
  /** Mark the session's next spawn as predetermined (skip the gate once). */
  markPredetermined: (sessionId: string) => void
  /** Read + clear the predetermined flag for a session. */
  consumePredetermined: (sessionId: string) => boolean
  /** Mark sessions as restored-this-run (#446). Idempotent. */
  markRestored: (sessionIds: string[]) => void
  /** Was this session restored this app-run? (Not consumed — a lasting fact.) */
  wasRestored: (sessionId: string) => boolean
}

export const useAccountGateStore = create<AccountGateState>((set, get) => ({
  queue: [],
  predetermined: [],
  restored: [],

  requestChoice: (sessionId, sessionLabel, currentProfileId) =>
    new Promise<GateChoice>((resolve) => {
      set((s) => ({
        queue: [...s.queue, { sessionId, sessionLabel, currentProfileId, resolve }],
      }))
    }),

  resolveChoice: (profileId) => {
    const head = get().queue[0]
    set((s) => ({ queue: s.queue.slice(1) }))
    // Resolve AFTER the state update so the awaiting spawn sees a settled queue.
    head?.resolve(profileId)
  },

  cancelChoice: () => {
    const head = get().queue[0]
    set((s) => ({ queue: s.queue.slice(1) }))
    head?.resolve(GATE_CANCELLED)
  },

  isPending: (sessionId) => get().queue.some((p) => p.sessionId === sessionId),

  markPredetermined: (sessionId) =>
    set((s) =>
      s.predetermined.includes(sessionId)
        ? s
        : { predetermined: [...s.predetermined, sessionId] },
    ),

  consumePredetermined: (sessionId) => {
    const had = get().predetermined.includes(sessionId)
    if (had) set((s) => ({ predetermined: s.predetermined.filter((id) => id !== sessionId) }))
    return had
  },

  markRestored: (sessionIds) =>
    set((s) => {
      const add = sessionIds.filter((id) => !s.restored.includes(id))
      return add.length ? { restored: [...s.restored, ...add] } : s
    }),

  wasRestored: (sessionId) => get().restored.includes(sessionId),
}))
