import { create } from 'zustand'
import type { PendingPermission, LedgerRecord } from '../../shared/channel-types'
import { useSessionStore } from './sessionStore'

interface ChannelState {
  pending: PendingPermission[]
  ledger: LedgerRecord[]
  setPending: (list: PendingPermission[]) => void
  pushLedger: (r: LedgerRecord) => void
}
export const useChannelStore = create<ChannelState>((set) => ({
  pending: [],
  ledger: [],
  setPending: (list) => set({ pending: list }),
  pushLedger: (r) => set((s) => ({ ledger: [r, ...s.ledger].slice(0, 100) })),
}))

// Wire IPC subscriptions once at app start (called from App.tsx postConfigInit).
export function setupChannelListeners(): () => void {
  const offP = window.electronAPI.channels.onPendingPermissions((list) => useChannelStore.getState().setPending(list as PendingPermission[]))
  const offL = window.electronAPI.channels.onLedgerEvent((r) => useChannelStore.getState().pushLedger(r as LedgerRecord))
  const offA = window.electronAPI.channels.onAttention(({ sessionId, needsAttention }) => {
    const ss = useSessionStore.getState()
    // Don't raise on the session you're already looking at; clears always apply.
    if (needsAttention && ss.activeSessionId === sessionId) return
    ss.updateSession(sessionId, { needsAttention })
  })
  // Tell main the listeners are mounted -> safe to make CCC the universal gate.
  void window.electronAPI.channels.rendererReady()
  return () => { offP(); offL(); offA() }
}
