import { create } from 'zustand'

// WP2 commit 6: the per-launch acknowledgement an unverified sign-in needs
// (design 5.5). Transient by construction -- module state and a Zustand
// queue, never persisted, never written to a config or a session record.
//
// Two ways a launch is acknowledged:
//  - the New session dialog's checkbox, which covers exactly the launch the
//    dialog starts: a one-shot GRANT for that session id and account id,
//    consumed by the session's first spawn;
//  - a small confirm asked right before any other spawn of such a session
//    (a restart, a reopen after an app restart, a multi-spawn copy). This is
//    the same queue-and-promise pattern as the Claude account launch gate
//    (accountGateStore), kept separate from it.
// A declined confirm spawns nothing.

/** Session id -> the account id its one launch was acknowledged for. */
const grants = new Map<string, string>()

/** The dialog's ticked checkbox: acknowledge the one launch of `sessionId`
 *  on `accountId`. */
export function grantLaunchAcknowledgement(sessionId: string, accountId: string): void {
  grants.set(sessionId, accountId)
}

/** Use up a session's grant. True only for the account it was given for;
 *  either way the grant is gone, so it never covers a second launch. */
export function consumeLaunchAcknowledgement(sessionId: string, accountId: string): boolean {
  const granted = grants.get(sessionId)
  grants.delete(sessionId)
  return granted !== undefined && granted === accountId
}

export interface PendingLaunchAck {
  /** This question, and no other: an answer names it, so a click meant for
   *  one launch can never land on the next one in the queue. */
  requestId: number
  sessionId: string
  /** The session's name, for the confirm's subtitle. */
  sessionLabel: string
  /** The account's name, as the Accounts surface shows it. */
  accountName: string
  /** The account's email, when known. */
  email?: string
  /** The provider's own home on this computer, rather than an account whose
   *  sign-in is merely unverified: the confirm words each differently. */
  external: boolean
  /** The account list could not be read, so the app cannot tell what this
   *  sign-in is: it asks anyway, and main still validates the account. */
  unknown: boolean
  resolve: (yes: boolean) => void
}

interface LaunchAckState {
  /** FIFO of launches waiting for a yes or no. The confirm renders queue[0]. */
  queue: PendingLaunchAck[]
  request: (req: Omit<PendingLaunchAck, 'resolve' | 'requestId'>) => Promise<boolean>
  /** Answer ONE question, by its id. An id no longer queued (withdrawn, or
   *  already answered) is ignored. */
  answer: (requestId: number, yes: boolean) => void
  /** Re-entry guard: a confirm is already queued for this session. */
  isPending: (sessionId: string) => boolean
  /** The view that asked is gone (a closed tab, a restart that remounts it):
   *  drop its question, answered "no", so nothing spawns from it and a
   *  remounted view can ask afresh. */
  withdraw: (sessionId: string) => void
}

let nextRequestId = 1

export const useLaunchAckStore = create<LaunchAckState>((set, get) => ({
  queue: [],
  request: (req) => new Promise<boolean>((resolve) => {
    const requestId = nextRequestId++
    set((s) => ({ queue: [...s.queue, { ...req, requestId, resolve }] }))
  }),
  answer: (requestId, yes) => {
    const entry = get().queue.find((p) => p.requestId === requestId)
    if (!entry) return
    set((s) => ({ queue: s.queue.filter((p) => p.requestId !== requestId) }))
    // After the state update, so the awaiting launch sees a settled queue.
    entry.resolve(yes)
  },
  isPending: (sessionId) => get().queue.some((p) => p.sessionId === sessionId),
  withdraw: (sessionId) => {
    const gone = get().queue.filter((p) => p.sessionId === sessionId)
    if (gone.length === 0) return
    set((s) => ({ queue: s.queue.filter((p) => p.sessionId !== sessionId) }))
    for (const p of gone) p.resolve(false)
  },
}))
