// src/main/ipc/watchdog-handlers.ts
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { getWatchdogManager } from '../watchdog/watchdog-manager'
import type { WatchdogPublicState } from '../watchdog/session-watchdog'

/**
 * Session Watchdog (#235) read surface. The state PUSH (IPC.WATCHDOG_STATE)
 * is sent directly from watchdog-manager's onStateChange adapter callback
 * (mirrors the statusline fan-out) — this handler only covers the renderer's
 * pull-on-mount hydration, so a tab opened after a watchdog already started
 * still shows its current state instead of nothing until the next change.
 */
export function registerWatchdogHandlers(): void {
  ipcMain.handle(IPC.WATCHDOG_GET_STATES, (): WatchdogPublicState[] => {
    return getWatchdogManager()?.getStates() ?? []
  })
}
