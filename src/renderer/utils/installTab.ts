// The visible terminal tab that runs an install or update line main built
// (a recipe's runLine), opened from a setup page, Settings, Accounts or the
// footer's CLI help. Every such line ends its own shell when its command ends
// (recipe-run-line.ts), so the tab's session then reads as exited: that is
// the moment the surface that opened it checks again (ADR-024).
import { openCommandTerminal } from './commandTerminal'
import { goToSession } from '../lib/goToSession'
import { useSessionStore } from '../stores/sessionStore'

export interface InstallTab { id: string; label: string }

type SessionLike = { id: string; ptyExited?: boolean }

/** The tab is open and its shell has not exited. */
export function installTabRunning(tab: InstallTab | null | undefined, sessions: readonly SessionLike[]): boolean {
  if (!tab) return false
  const s = sessions.find((x) => x.id === tab.id)
  return !!s && s.ptyExited !== true
}

/** installTabRunning, live from the session store. */
export function useInstallTabRunning(tab: InstallTab | null | undefined): boolean {
  return useSessionStore((s) => installTabRunning(tab, s.sessions))
}

/**
 * Open the tab that types main's `runLine` (openCommandTerminal: shell only,
 * transient, never elevated, no command secrets). `show` brings the sessions
 * view forward on it, for a surface that is not the sessions view. `onEnded`
 * is called once, when the tab's shell exits or the tab is closed, whatever
 * is showing then (the surface that opened it may be gone by then).
 */
export function openInstallTab(opts: { label: string; runLine: string; show?: boolean; onEnded?: (tab: InstallTab) => void }): InstallTab {
  const id = openCommandTerminal({ label: opts.label, command: opts.runLine })
  const tab: InstallTab = { id, label: opts.label }
  const onEnded = opts.onEnded
  if (onEnded) {
    let stop: (() => void) | null = null
    stop = useSessionStore.subscribe((state) => {
      if (!stop || installTabRunning(tab, state.sessions)) return
      stop()
      stop = null
      onEnded(tab)
    })
  }
  if (opts.show) goToSession(id)
  return tab
}
