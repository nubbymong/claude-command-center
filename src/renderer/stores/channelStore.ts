import { create } from 'zustand'
import type { PendingPermission, LedgerRecord } from '../../shared/channel-types'

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
  return () => { offP(); offL() }
}
