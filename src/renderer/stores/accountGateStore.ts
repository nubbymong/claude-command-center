import { create } from 'zustand'

// Transient (never persisted) store backing the pre-spawn account launch gate.
// Before a session spawns for the first time this app-run, TerminalView asks
// the user which account to launch under via `requestChoice`, which resolves
// when <AccountLaunchGate> calls `resolveChoice`. Restart / switch mark the
// session `predetermined` so the gate is skipped (they already chose).

export interface PendingAccountGate {
  sessionId: string
  /** Friendly label shown in the modal ("Choose the account for X"). */
  sessionLabel: string
  /** Pre-selected profile id. Always a real profile id in the multi-account UI. */
  currentProfileId: string | undefined
  /** Resolves the awaiting spawn with the chosen profile id (undefined = Default). */
  resolve: (profileId: string | undefined) => void
}

interface AccountGateState {
  /** FIFO of sessions awaiting an account choice. The modal renders queue[0]. */
  queue: PendingAccountGate[]
  /** Sessions whose next spawn already has an explicit account (restart/switch). */
  predetermined: string[]

  /** Enqueue a choice request; resolves when the modal is answered. */
  requestChoice: (
    sessionId: string,
    sessionLabel: string,
    currentProfileId: string | undefined,
  ) => Promise<string | undefined>
  /** Answer the head request with the chosen profile id (undefined = Default). */
  resolveChoice: (profileId: string | undefined) => void
  /** Re-entry guard: is a gate already queued for this session? */
  isPending: (sessionId: string) => boolean
  /** Mark the session's next spawn as predetermined (skip the gate once). */
  markPredetermined: (sessionId: string) => void
  /** Read + clear the predetermined flag for a session. */
  consumePredetermined: (sessionId: string) => boolean
}

export const useAccountGateStore = create<AccountGateState>((set, get) => ({
  queue: [],
  predetermined: [],

  requestChoice: (sessionId, sessionLabel, currentProfileId) =>
    new Promise<string | undefined>((resolve) => {
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
}))
