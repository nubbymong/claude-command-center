/**
 * GUI-subsystem executables — the contract both processes share (#379).
 *
 * THE PROBLEM (measured by the owner, 2026-08-21, Bambu Studio as the worked
 * example). A Windows program is marked in its PE header as either a CONSOLE
 * subsystem program (`Subsystem = 3`) or a GUI one (`Subsystem = 2`). The
 * Slic3r/wxWidgets family — and Inkscape, several Qt tools, parts of Git — are
 * GUI programs that still want to print when you run them from a prompt, so on
 * startup they do:
 *
 *     AttachConsole(ATTACH_PARENT_PROCESS);  freopen("CONOUT$", "w", stdout);
 *
 * Both halves of that are hostile to us:
 *
 *  1. `AttachConsole(ATTACH_PARENT_PROCESS)` attaches to the PARENT's console.
 *     No creation flag on the CHILD can prevent it, because the decision is the
 *     child's and the console is ours.
 *  2. `freopen("CONOUT$")` REPLACES the inherited stdout/stderr handles. Every
 *     redirect we applied — a pipe, a file, `>`, `2>`, `Start-Process
 *     -RedirectStandardOutput` — is discarded at that instant, and the text is
 *     written straight into the console SCREEN BUFFER. That is the same buffer
 *     the TUI in that terminal (Claude Code, say) is drawing into, so the log
 *     lands ON TOP of its frame, and the file we redirected to holds 0 bytes.
 *
 * The owner's measured matrix, spawning the tool with stdout+stderr piped:
 *
 *     launch                          bytes captured   bleeds?
 *     plain spawn, handles inherited        0            yes
 *     DETACHED_PROCESS                      0            yes
 *     CREATE_NO_WINDOW                      0            no, log lost
 *     CREATE_NEW_CONSOLE                    0            no, log lost
 *     conhost --headless                    0            no, needs a pty client
 *     PARENT HAS NO CONSOLE              5621            NO, AND CAPTURED
 *
 * So exactly one launch both suppresses the bleed and keeps the log: **the
 * parent must have no console at all**. Electron's main process has no console,
 * so a `child_process.spawn` from main with piped stdio IS that parent —
 * `AttachConsole(ATTACH_PARENT_PROCESS)` fails, the `freopen` fails with it, and
 * the inherited pipes survive. That is fix A, and it is why fix C
 * (`windowsHide`) is only for when the log is not wanted, and why `detached:
 * true` is never a fix: DETACHED_PROCESS gives the child no console of its own,
 * which is exactly the state in which it goes looking for its parent's.
 *
 * WHERE CCC IS EXPOSED. A command button does not spawn anything: it TYPES a
 * line into a live ConPTY (see CommandBar.sendCommand). The parent of whatever
 * that line runs is the shell inside that pty, and that shell HAS a console —
 * the pty's. So a GUI-subsystem tool launched from a command button attaches to
 * the pty console and paints over the pane. That is the reported bug, and it is
 * why the fix cannot be a spawn flag: it has to be a different PARENT.
 *
 * This module is pure and dependency-free so main (which sniffs and spawns) and
 * the renderer (which decides and renders) cannot drift on the vocabulary.
 */

/** What the PE header says the image is. `not-pe` covers scripts (.cmd, .ps1),
 *  non-Windows binaries and anything whose header does not parse. */
export type ExeSubsystem = 'gui' | 'console' | 'other' | 'not-pe'

/** A probe outcome. Adds the two answers that are not about the file itself:
 *  we could not find an executable for the first token, or we are not on
 *  Windows (where none of this applies). */
export type ExeProbeStatus = ExeSubsystem | 'unresolved' | 'not-windows'

export interface ExeProbeResult {
  status: ExeProbeStatus
  /** The first token of the command line, as parsed. Null when the line is empty. */
  token: string | null
  /** The absolute path the token resolved to, or null when it did not resolve. */
  exePath: string | null
}

/**
 * What a command button should do when its target is a GUI-subsystem exe.
 *
 * `ask` (the default, and what an absent value means) shows the dialog on each
 * press. `capture` runs it from main with pipes and shows the log. `terminal`
 * types it into the pty as before, accepting the bleed — an honest choice for a
 * tool whose GUI the user actually wants, or one they want to watch live.
 */
export type GuiExePolicy = 'ask' | 'capture' | 'terminal'

/** A chunk of a captured run, pushed main -> renderer. */
export interface CapturedRunChunk {
  runId: string
  stream: 'stdout' | 'stderr'
  chunk: string
}

/** The end of a captured run, pushed main -> renderer. */
export interface CapturedRunExit {
  runId: string
  /** Process exit code, or null when it was killed by a signal or never started. */
  code: number | null
  signal: string | null
  /** True when output hit the byte cap and later output was dropped. */
  truncated: boolean
  durationMs: number
  /** Set when the run could not start, or died before exiting. */
  error?: string
}

/** What `exe:run:start` answers with. `runId` is null when the run was refused. */
export interface CapturedRunStart {
  runId: string | null
  exePath: string | null
  error?: string
}

/**
 * Per-stream byte cap for a captured run. The worked example's banner is 5.6 KB;
 * 512 KiB is room for a chatty build tool without letting a runaway process fill
 * the main process's heap. Past the cap the process keeps running (killing it
 * would be a surprise) and further output is dropped, with `truncated` set.
 */
export const CAPTURED_RUN_MAX_BYTES = 512 * 1024

/**
 * After this long we STOP CAPTURING a run. We do not stop the program.
 *
 * Everything reachable through this path is a GUI application by construction --
 * the gate refuses anything else -- and a GUI application still alive after ten
 * minutes is being USED, not hung. Killing it to reclaim a capture slot would
 * take the user's unsaved work with it, so the timer only releases the slot and
 * reports that the program is still running. (Review MAJOR-2; the first version
 * force-killed here.)
 */
export const CAPTURED_RUN_TIMEOUT_MS = 10 * 60 * 1000

/** How many captured runs may be in flight at once, across all sessions. */
export const CAPTURED_RUN_MAX_CONCURRENT = 4

/** Longest command line we will parse a first token out of. Matches the
 *  `terminalOptions.command` bound at the pty IPC boundary. */
export const EXE_PROBE_MAX_COMMAND_LEN = 4096

/**
 * Shell operators that a captured run will NOT honour.
 *
 * The console-less path spawns with an argv array and no shell, which is what
 * makes it safe -- and also means `tool --x > log.txt` passes `>` and `log.txt`
 * as two literal ARGUMENTS rather than redirecting. That is not an injection
 * risk; it is a MEANING change, and the user has to be told before they choose
 * it (review MAJOR-5).
 *
 * Order matters: the two-character operators come first so `&&` is reported as
 * `&&` rather than as two `&`s.
 */
const SHELL_OPERATORS = ['&&', '||', '>>', '2>', '|', '>', '<', ';', '&', '$env:', '$(', '`'] as const

/**
 * Which shell operators appear in a command line -- in the order above, without
 * duplicates. Empty when the line means the same thing either way.
 *
 * Deliberately a plain scan, not a parser: an operator inside quotes is still
 * reported. Over-warning costs the user one sentence; under-warning costs them a
 * command that silently did something else.
 */
export function shellOperatorsIn(command: string): string[] {
  if (typeof command !== 'string' || !command) return []
  const found: string[] = []
  let rest = command
  for (const op of SHELL_OPERATORS) {
    if (rest.includes(op)) {
      found.push(op)
      // Blank out what matched so `&&` does not also report `&`.
      rest = rest.split(op).join(' ')
    }
  }
  return found
}
