// claude-headless.ts — Reusable headless `claude` process spawner.
// Used by insights-runner and the Sentinel AI analysis runner.
import { spawn, execSync } from 'child_process'
import { logInfo, logError } from './debug-logger'
import { withProfileHome } from './pty-manager'
import { acquireProfileConsumer, pendingProfileRefresh } from './profile-consumers'
import { profileIdFromHome } from './profile-id'

/** Grace added to a run's kill timeout for its consumer ref's leak bound: the
 *  spawner kills at `timeoutMs` and settles right after, so a ref that outlives
 *  this could only be one whose release never ran. */
export const HEADLESS_CONSUMER_GRACE_MS = 60_000

// shell:true means the spawn is `cmd.exe -> claude` on Windows, so proc.kill()
// kills only the shell and orphans the real claude process (it keeps running and
// a retry / next launch spawns yet another). taskkill /T /F tears down the whole
// tree by pid -- same pattern as vision-manager / cloud-agent teardown. POSIX
// keeps proc.kill() (no shell-orphan problem for our spawns).
function killHeadlessTree(proc: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === 'win32' && proc.pid) {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { windowsHide: true, timeout: 5000 })
    } else {
      proc.kill()
    }
  } catch {
    // process may have already exited
  }
}

// SECURITY CONTROL. `shell: true` means the argv below is CONCATENATED INTO A
// SHELL COMMAND LINE without quoting (this is Node's DEP0190 warning). Verified
// empirically on both platforms with an echo shim:
//
//   ['-p','--settings','x&echo PWNED']  -> cmd.exe runs `echo PWNED` as a second
//                                          command; `sh -c` does the same with `;`
//   ['-p','--tools','']                -> the empty arg VANISHES and `--tools`
//                                          swallows the next flag
//   ['-p','--settings','%VAR%']        -> cmd.exe splices the env value into the
//                                          command line, then re-parses ITS metachars
//
// Every current call site passes a literal array and is safe, and the callers'
// comments say so — but a comment 500 lines from the sink is not a control, and
// those same comments name the next two arguments someone will want to add
// (`--tools ""`, `--settings '{...}'`), one of which silently breaks the argv.
// So the invariant is enforced HERE, where the shell actually is.
//
// The character class is the UNION of both platforms' metacharacters on purpose:
// `$`/backtick/glob are inert on Windows and live on POSIX, `%` is the reverse, so
// a set tested on one platform would pass CI and be a no-op on the other.
// `#` is in the class because it starts a COMMENT under `sh -c`, which silently
// swallows every argument after it — the same drop-and-shift failure as the empty
// string, just via a different mechanism. Verified: `sh -c 'echo a #b; echo X'`
// prints only `a`.
// `[` and `]` are in the class for the #144 reason: they open a POSIX glob
// CHARACTER CLASS, so a model id like `opus[1m]` or `claude-opus-4-6[1m]` is
// glob-expanded by the shell and, under zsh, aborts the whole command with
// "no matches found". Every other path that puts a model on a command line
// quotes it (modelFlag/quoteArgForShell); this one cannot quote, because the
// argv goes through `shell: true` unquoted — so it fails loudly instead (#385).
const UNSAFE_ARGV = /[\s&|^<>%$`;()*?~'"\\#[\]]/

/** Throws on an argv element the shell would re-parse or silently drop. */
export function assertSafeArgv(args: string[]): void {
  for (const arg of args) {
    if (arg.length === 0) {
      throw new Error('[claude-headless] empty argv element: shell:true would drop it and shift every later flag')
    }
    if (UNSAFE_ARGV.test(arg)) {
      throw new Error(
        `[claude-headless] unsafe argv element ${JSON.stringify(arg)}: shell:true would let the shell re-parse it. ` +
        'Pass the value on stdin, or drop shell:true and resolve the claude path explicitly.'
      )
    }
  }
}

/**
 * Spawn `claude` as a headless child process (shell:true so both claude.exe and
 * claude.cmd are found on PATH).  Returns stdout/stderr and the exit code.
 *
 * Throws synchronously on an unsafe argv (see assertSafeArgv) — that is a
 * programming error, not a runtime condition, so it fails loudly in dev and in
 * tests rather than resolving with a code the caller might shrug off.
 *
 * @param args        CLI arguments passed to `claude`
 * @param timeoutMs   Kill and resolve with code 1 after this many ms (default 10 min)
 * @param stdinData   Optional data to pipe into stdin
 * @param home        Per-account fake HOME injected via withProfileHome; null = default
 */
export function spawnClaudeHeadless(
  args: string[],
  timeoutMs = 600000,
  stdinData?: string,
  home: string | null = null,
  signal?: AbortSignal
): Promise<{ code: number; stdout: string; stderr: string }> {
  assertSafeArgv(args)
  // #48/#49: a headless run under a profile home is a credential consumer like
  // any session, and this is the ONE place every such run passes through
  // (insights KPI extraction, the cross-account synthesis, Sentinel analysis).
  // Two things follow. If the usage page is mid-rotation for THIS profile, the
  // run waits for the new lineage to land before it spawns -- a CLI that read
  // the old file would redeem the same single-use refresh token later and log
  // the account out. And for the run's whole life the profile reads as in-use,
  // so the usage refresh and the account delete defer to it. The ref is bounded
  // by the run's own kill timeout plus a grace: the only way it outlives that is
  // a release that never ran, which is a leak, and leaks are swept.
  //
  // The spawn stays SYNCHRONOUS when nothing is pending (the common case, and
  // what the timeout tests drive); it defers only behind a real in-flight
  // refresh for this profile.
  //
  // The hold is taken BEFORE the wait (adversarial pass on #598): it is what
  // stops a new rotation from starting, and acquiring only after the in-flight
  // one settled left a microtask in which a fresh refresh could begin and
  // rotate the token this run is about to read. The wait itself is bounded by
  // the refresh's own socket timeout, well inside the ref's grace.
  const profileId = profileIdFromHome(home)
  const release = profileId ? acquireProfileConsumer(profileId, { maxAgeMs: timeoutMs + HEADLESS_CONSUMER_GRACE_MS }) : null
  const pending = profileId ? pendingProfileRefresh(profileId) : null
  const p = pending
    ? pending.then(() => spawnNow(args, timeoutMs, stdinData, home, signal))
    : spawnNow(args, timeoutMs, stdinData, home, signal)
  if (release) p.then(release, release)
  return p
}

function spawnNow(
  args: string[],
  timeoutMs: number,
  stdinData: string | undefined,
  home: string | null,
  signal: AbortSignal | undefined
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    logInfo(`[claude-headless] Spawning: claude ${args.join(' ')}${stdinData ? ' (with stdin)' : ''}${home ? ' (account home)' : ''}`)

    const proc = spawn('claude', args, {
      shell: true,
      windowsHide: true,
      env: withProfileHome({ ...process.env } as Record<string, string>, home)
    })

    // Pipe prompt via stdin if provided
    if (stdinData && proc.stdin) {
      proc.stdin.write(stdinData)
      proc.stdin.end()
    }

    let stdout = ''
    let stderr = ''
    let resolved = false

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        logError(`[claude-headless] Timed out after ${timeoutMs / 1000}s`)
        killHeadlessTree(proc)
        resolve({ code: 1, stdout, stderr: stderr + '\nTimed out after ' + (timeoutMs / 1000) + 's' })
      }
    }, timeoutMs)

    // External cancel (Sentinel disable / re-run / account change): kill the
    // whole tree like the timeout path. shell:true makes proc the cmd.exe pid, so
    // a plain proc.kill() would orphan the real claude; killHeadlessTree taskkills
    // the tree by pid.
    const onAbort = () => {
      if (resolved) return
      resolved = true
      clearTimeout(timeout)
      logInfo('[claude-headless] Aborted; killing process tree')
      killHeadlessTree(proc)
      resolve({ code: 1, stdout, stderr: stderr + '\nAborted' })
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })

    proc.stdout?.on('data', (data) => { stdout += data.toString() })
    proc.stderr?.on('data', (data) => { stderr += data.toString() })

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        logError('[claude-headless] Spawn error:', err.message)
        resolve({ code: 1, stdout, stderr: stderr + '\n' + err.message })
      }
    })

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        logInfo(`[claude-headless] Process exited with code ${code}`)
        resolve({ code: code ?? 1, stdout, stderr })
      }
    })
  })
}
