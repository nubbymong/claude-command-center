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

// Renderer-only debug handle used by scripts/capture-training-screenshots.ts
// to inject a fake high-risk PendingPermission so the toast tray renders
// for the README/tour hero capture without spinning up a real Claude hook.
// No security surface: this is renderer-local Zustand state. The main-side
// channel-permissions IPC layer is still the only thing that gates real
// allow/deny actions on Claude sessions.
;(window as unknown as { __channelStore?: typeof useChannelStore }).__channelStore = useChannelStore

// Wire IPC subscriptions once at app start (called from App.tsx postConfigInit).
export function setupChannelListeners(): () => void {
  const offP = window.electronAPI.channels.onPendingPermissions((list) => useChannelStore.getState().setPending(list as PendingPermission[]))
  const offL = window.electronAPI.channels.onLedgerEvent((r) => useChannelStore.getState().pushLedger(r as LedgerRecord))
  return () => { offP(); offL() }
}
