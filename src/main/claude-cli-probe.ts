import { execFile } from 'child_process'
import * as os from 'os'
import { logInfo } from './debug-logger'

/**
 * Is the `claude` CLI actually INSTALLED on this machine?
 *
 * Not to be confused with `isCliReady()` in setup-handlers, which asks a
 * different question -- "has Claude been told to trust the install folder?" --
 * and answers it by looking for a folder under `~/.claude/projects/`. That
 * check passes vacuously when the CLI is absent, because a machine with no
 * `claude` binary also has no trusted project for it. First-run setup used to
 * push straight past step 2 on such a machine, spawn a PTY that printed
 * "'claude' is not recognized", and drop the user into an app in which nothing
 * can ever launch (#, phase 7 item B).
 *
 * `resolveClaudeBinary()` cannot answer it either: its Windows branch falls
 * back to the bare string `'claude'` when both `where` probes miss, and its
 * POSIX branch returns `'claude'` unconditionally. A fallback is the right
 * answer for a spawn (let the shell try) and the wrong one for a gate.
 *
 * So probe for real, and probe the way the setup PTY will actually launch it:
 *   - Windows: `where` for claude.exe / claude.cmd / claude, no shell.
 *   - POSIX: the user's LOGIN shell (`$SHELL -lc 'command -v claude'`), because
 *     setup-handlers spawns a login shell precisely so PATH picks up Homebrew,
 *     nvm, asdf and friends. A plain `which` from Electron's own environment
 *     would report "missing" for a CLI the login shell can see perfectly well.
 *     `which` is only the fallback if the login shell probe cannot run.
 *
 * ASYNC, and that is a security property rather than a style choice
 * (adversarial review, 2026-09-01 — DoS). This used to be `execFileSync`: up to
 * THREE sequential 8s probes, each of which BLOCKS the main process outright —
 * no IPC served, no PTY data pumped, no window repainted, for up to 24 seconds.
 * `setup:probeCli` is an ungated renderer channel, so any renderer could freeze
 * the whole app on demand simply by invoking it; and even in normal use a
 * hanging login shell (a slow network mount in an rc file is the classic) stalls
 * the app rather than one dialog. `execFile` answers the same question on the
 * event loop, and overlapping calls coalesce onto ONE probe (see `inFlight`), so
 * a loop of invocations costs one process set instead of three per call.
 */
export interface ClaudeCliProbe {
  /** True only when a probe actually resolved a path. Fail-closed on error. */
  installed: boolean
  /** The resolved path, when one was found. */
  path?: string
  /** Which probe answered (or last failed) -- for the log and the notice. */
  probe: string
}

/** Trim, take the first line, and reject the empty/whitespace answer. */
function firstLine(out: string | Buffer): string | null {
  const line = out.toString().split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0)
  return line || null
}

/**
 * Run one probe candidate and resolve its first output line, or null.
 *
 * Never rejects: a non-zero exit (the `where`/`command -v` miss), a missing
 * binary, a timeout kill and a synchronous spawn throw are all the same answer
 * to this function's question — "no". stderr is captured by execFile rather than
 * inherited, so a probe miss cannot leak "INFO: Could not find files..." into
 * whatever terminal launched the app (the job the old `stdio` option did).
 */
function probeOnce(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        bin,
        args,
        { encoding: 'utf-8', timeout: 8000, windowsHide: true },
        (err, stdout) => resolve(err ? null : firstLine(stdout ?? '')),
      )
    } catch {
      resolve(null)
    }
  })
}

async function runProbe(): Promise<ClaudeCliProbe> {
  if (os.platform() === 'win32') {
    for (const bin of ['claude.exe', 'claude.cmd', 'claude']) {
      const found = await probeOnce('where', [bin])
      if (found) {
        logInfo(`[setup] Claude CLI found: ${found} (where ${bin})`)
        return { installed: true, path: found, probe: `where ${bin}` }
      }
    }
    logInfo('[setup] Claude CLI NOT found (where claude.exe / claude.cmd / claude all missed)')
    return { installed: false, probe: 'where claude' }
  }

  const shell = process.env.SHELL || '/bin/zsh'
  const viaLoginShell = await probeOnce(shell, ['-lc', 'command -v claude'])
  if (viaLoginShell) {
    logInfo(`[setup] Claude CLI found: ${viaLoginShell} (${shell} -lc "command -v claude")`)
    return { installed: true, path: viaLoginShell, probe: `${shell} -lc 'command -v claude'` }
  }

  const viaWhich = await probeOnce('which', ['claude'])
  if (viaWhich) {
    logInfo(`[setup] Claude CLI found: ${viaWhich} (which claude)`)
    return { installed: true, path: viaWhich, probe: 'which claude' }
  }

  logInfo('[setup] Claude CLI NOT found (login shell and `which` both missed)')
  return { installed: false, probe: 'command -v claude' }
}

/**
 * The single probe a set of overlapping callers share.
 *
 * `setup:probeCli` is invoked from a dialog that can be clicked repeatedly (and
 * from an effect that can re-fire), so without this a user — or a renderer loop —
 * multiplies the process count by the call count for an answer that cannot
 * change between two calls a millisecond apart. Cleared on settle, so the NEXT
 * call after an install genuinely re-probes; this coalesces concurrent work, it
 * does not cache a result.
 */
let inFlight: Promise<ClaudeCliProbe> | null = null

export function probeClaudeCli(): Promise<ClaudeCliProbe> {
  if (inFlight) return inFlight
  const run = runProbe().then(
    (result) => { inFlight = null; return result },
    (err) => { inFlight = null; throw err },
  )
  inFlight = run
  return run
}

/** Test seam: drop a probe still in flight so cases cannot bleed into each other. */
export function _resetClaudeCliProbeForTest(): void {
  inFlight = null
}
