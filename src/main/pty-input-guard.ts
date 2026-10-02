/**
 * A PTY's input and output must never take the app down (P3.15 rounds 3 to
 * 5).
 *
 * Input. On Windows node-pty (1.2.0-beta.15, lib/windowsPtyAgent.js) writes a
 * PTY's input to a net.Socket over the console's input pipe, and gives that
 * socket no 'error' listener: a write that fails there is an uncaught
 * exception, and the app's handler (debug-logger) ends the app on every one
 * but EPIPE and EIO. The VM run at 98455d52 saw it under node-pty's bundled
 * ConPTY: "write EAGAIN" around a Ctrl+C that ended the CLI, the app gone in
 * 4 of 5 fast-typing tries (0 of 5 under the system ConPTY). The cause,
 * CONFIRMED by the VM run at f2b1cf65: keys typed after the program had
 * ended. The console host lets go of the pipe as the program ends (node-pty
 * releases the bundled pseudo console when it starts the program, so
 * OpenConsole.exe ends with it, where the system host keeps the pipe until
 * the PTY is killed), so a key typed in that moment lands on a pipe being
 * closed. In all 38 tries whose write failed (Codex, under the bundled
 * ConPTY), Codex's exit text had reached the tab 9 to 70 ms before the failure
 * was logged; fast typing into a live Codex with no Ctrl+C failed in none of
 * 39 tries. There is nothing to retry: a failed write destroys the socket.
 *
 * Output. node-pty's own handler on a PTY's output socket (windowsTerminal.js
 * on Windows, unixTerminal.js elsewhere) ignores EIO, the program's end as
 * node-pty reads it, and throws any other error unless the PTY has an 'error'
 * listener of its own: the same way to quit the app. guardPtyOutput gives it
 * one (Terminal.prototype.on puts it on the output socket). The unix handler
 * also returns on EAGAIN before anything else, so off Windows an EAGAIN is
 * ignored, as node-pty's unix handler ignores it (round 5); on Windows
 * node-pty closes the PTY on one, and there it stays a failure.
 *
 * Every error is caught on both sides; the first failure on each side is
 * reported once (the caller ends a session that does not end by itself).
 * node-pty on macOS and Linux handles its own write errors and has no input
 * socket to guard.
 */
import type { EventEmitter } from 'events'

/** The socket a Windows PTY's input is written to (node-pty's
 *  WindowsTerminal._agent.inSocket), or null when there is none. */
export function ptyInputSocket(proc: unknown): EventEmitter | null {
  const agent = (proc as { _agent?: unknown } | null | undefined)?._agent as { inSocket?: unknown } | undefined
  const socket = agent?.inSocket as EventEmitter | undefined
  return socket && typeof socket.on === 'function' ? socket : null
}

/** Catch every error on the PTY's input socket; `onFirstError` hears the
 *  first. Whether there was a socket to guard. */
export function guardPtyInput(proc: unknown, onFirstError: (err: NodeJS.ErrnoException) => void): boolean {
  const socket = ptyInputSocket(proc)
  if (!socket) return false
  let reported = false
  socket.on('error', (err: NodeJS.ErrnoException) => {
    if (reported) return
    reported = true
    try { onFirstError(err) } catch { /* a report must never let the error out */ }
  })
  return true
}

/** EIO (or "errno 5"): node-pty reads the program's end this way and ignores
 *  it; not a failure to report. */
const isPtyEnd = (err: NodeJS.ErrnoException | undefined): boolean =>
  typeof err?.code === 'string' && (err.code.includes('EIO') || err.code.includes('errno 5'))

/** EAGAIN: node-pty's unix handler (unixTerminal.js, macOS and Linux) returns
 *  on it before anything else, ignoring it; on Windows node-pty closes the PTY
 *  on one. */
const isEagain = (err: NodeJS.ErrnoException | undefined): boolean =>
  typeof err?.code === 'string' && err.code.includes('EAGAIN')

/** Give the PTY's output socket an 'error' listener of the app's own, so
 *  node-pty's handler never throws; `onFirstError` hears the first error that
 *  is a failure: not the program's end, nor off Windows an EAGAIN (ignored,
 *  as node-pty's unix handler ignores it). Whether the PTY could take one. */
export function guardPtyOutput(proc: unknown, onFirstError: (err: NodeJS.ErrnoException) => void): boolean {
  const on = (proc as { on?: unknown } | null | undefined)?.on
  if (typeof on !== 'function') return false
  // node-pty builds a unix PTY everywhere but win32 (lib/index.js).
  const eagainIgnored = process.platform !== 'win32'
  let reported = false
  try {
    (on as (event: string, listener: (err: NodeJS.ErrnoException) => void) => void).call(proc, 'error', (err: NodeJS.ErrnoException) => {
      if (reported || isPtyEnd(err)) return
      if (eagainIgnored && isEagain(err)) return
      reported = true
      try { onFirstError(err) } catch { /* a report must never let the error out */ }
    })
  } catch { return false }
  return true
}

export type PtyIoSide = 'input' | 'output'

/** Both sides: `onFirstError` hears the first failure of each. */
export function guardPtyIo(proc: unknown, onFirstError: (side: PtyIoSide, err: NodeJS.ErrnoException) => void): { input: boolean; output: boolean } {
  return {
    input: guardPtyInput(proc, (err) => onFirstError('input', err)),
    output: guardPtyOutput(proc, (err) => onFirstError('output', err)),
  }
}
