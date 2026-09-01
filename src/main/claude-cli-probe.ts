import { execFileSync } from 'child_process'
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

export function probeClaudeCli(): ClaudeCliProbe {
  // stdio pipes stderr so a probe miss does not leak "INFO: Could not find
  // files..." into whatever terminal launched the app.
  const opts: Parameters<typeof execFileSync>[2] = {
    encoding: 'utf-8',
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }

  if (os.platform() === 'win32') {
    for (const bin of ['claude.exe', 'claude.cmd', 'claude']) {
      try {
        const found = firstLine(execFileSync('where', [bin], opts))
        if (found) {
          logInfo(`[setup] Claude CLI found: ${found} (where ${bin})`)
          return { installed: true, path: found, probe: `where ${bin}` }
        }
      } catch { /* try the next candidate */ }
    }
    logInfo('[setup] Claude CLI NOT found (where claude.exe / claude.cmd / claude all missed)')
    return { installed: false, probe: 'where claude' }
  }

  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const found = firstLine(execFileSync(shell, ['-lc', 'command -v claude'], opts))
    if (found) {
      logInfo(`[setup] Claude CLI found: ${found} (${shell} -lc "command -v claude")`)
      return { installed: true, path: found, probe: `${shell} -lc 'command -v claude'` }
    }
  } catch { /* fall through to `which` */ }

  try {
    const found = firstLine(execFileSync('which', ['claude'], opts))
    if (found) {
      logInfo(`[setup] Claude CLI found: ${found} (which claude)`)
      return { installed: true, path: found, probe: 'which claude' }
    }
  } catch { /* not installed */ }

  logInfo('[setup] Claude CLI NOT found (login shell and `which` both missed)')
  return { installed: false, probe: 'command -v claude' }
}
