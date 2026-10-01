/**
 * A PTY's input must never take the app down (P3.15 round 3, K1).
 *
 * On Windows node-pty (1.2.0-beta.15, lib/windowsPtyAgent.js) writes a PTY's
 * input to a net.Socket over the console's input pipe, and gives that socket
 * no 'error' listener: a write that fails there is an uncaught exception, and
 * the app's handler (debug-logger) ends the app on every one but EPIPE and EIO.
 *
 * A write fails there once the console host has let go of its end of the pipe.
 * Under node-pty's bundled ConPTY that host (OpenConsole.exe) ends as soon as
 * the program in it has ended, because node-pty releases the pseudo console
 * when it starts the program; a key typed in the moment between the program
 * ending and node-pty reporting the end lands on a pipe that is being closed,
 * and the write fails (the VM run at 98455d52: "write EAGAIN" right after
 * the CLI in the PTY ended on Ctrl+C, the app gone in 4 of 5 fast-typing
 * tries; 0 of 5 under the system ConPTY, whose host keeps the pipe until the
 * PTY is killed).
 * It is not a full pipe to retry later: node-pty's writes on this pipe block
 * until there is room, and a failed write also destroys the socket, so that
 * PTY takes no more input whatever is done.
 *
 * guardPtyInput gives that socket its listener: every error on it is caught,
 * and the first is reported once (the caller ends a session that does not end
 * by itself). node-pty on macOS and Linux handles its own write errors
 * (lib/unixTerminal.js) and has no such socket, so there is nothing to guard.
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
