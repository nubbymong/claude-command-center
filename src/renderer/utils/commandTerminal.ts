import { generateId } from './id'
import { useSessionStore } from '../stores/sessionStore'
import type { TerminalOptions } from '../../shared/types'

/** A transient tab's options once its command has run: the command gone, the
 *  rest kept. Its one confirmation covered one run, not every later spawn. */
export function spentCommand(opts: TerminalOptions | undefined): TerminalOptions | undefined {
  if (!opts || opts.command === undefined) return opts
  const { command: _spent, ...rest } = opts
  return rest
}

/**
 * Open a terminal tab that runs one command, in plain sight.
 *
 * A shell-only session, like the add-account login shell: the command rides
 * in `terminalOptions.command`, which the PTY manager types into the shell
 * once it opens (the terminal-only first-run command), so the user watches
 * it run and can stop it. Never elevated: the app does not ask for
 * administrator rights on its own. The new tab becomes the active session.
 *
 * `transient`: the tab is never saved with the session set, so the next
 * launch cannot resume it, and TerminalView consumes the command at its first
 * spawn, so a Restart opens a plain shell. The user confirmed ONE run.
 *
 * Returns the new session id.
 */
export function openCommandTerminal(opts: { label: string; command: string }): string {
  const id = generateId()
  useSessionStore.getState().addSession({
    id,
    label: opts.label,
    workingDirectory: '',
    model: '',
    // The standard default colour for sessions created by the app itself,
    // which have no config to take one from (as useAddAccount).
    color: '#89B4FA',
    status: 'idle',
    createdAt: Date.now(),
    sessionType: 'local',
    shellOnly: true,
    transient: true,
    // The stored shape of a terminal-only session (see SessionDialog).
    provider: 'claude',
    terminalOptions: { command: opts.command, elevated: false },
  })
  return id
}
