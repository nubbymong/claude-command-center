/**
 * claude-cli-auth.ts — the CODE-session half of #216, by delegation (not invention).
 *
 * CCC already solves this for the other provider and should not solve it twice:
 * it never implements Codex's OAuth. It shells out to `codex login` in the
 * account's own realm and judges the result by `codex login status` alone
 * (`src/main/providers/codex/auth-operations.ts`); it never opens the
 * credential file the CLI writes. The vendor CLI opens the SYSTEM browser with
 * a loopback redirect.
 *
 * The same seam exists for Claude — `claude auth` and `claude setup-token` — and
 * it is the right one for a managed environment for exactly the reason the
 * embedded window failed: the CLI drives the user's real browser, where the
 * compliance extension lives.
 *
 * WHY THIS PAIRS WITH THE WEB SIGN-IN. Both halves want the same human action.
 * Do the web sign-in first and claude.ai is already authenticated in that
 * browser, so the CLI's OAuth hop is a consent click rather than a second
 * credential entry. One sign-in, both credentials.
 *
 * This module reports STATE and launches the CLI's own flow. It never handles a
 * token itself — the CLI owns that file, and CCC reading it would be a second
 * copy of a credential to protect.
 *
 * No default export (project convention).
 */

import { execFile } from 'node:child_process'
import type { ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logError, logInfo, logWarn } from '../debug-logger'
import { gateManagedLaunch, peekGateVerdict } from '../managed-launch-diagnostics'
import { getProfileConfigDir, getProfilesRoot, withProfileHome, readProfilesStrict, removeProfileIdentityCredentials, MANAGED_LAUNCH_REFUSAL } from '../account-profiles'
import { acquireProfileConsumer, holdProfileForRun, pendingProfileRefresh } from '../profile-consumers'
import { isProfileInUseByLiveSession, sessionsOnProfile } from '../claude-account-identity'
import { DEFAULT_CLI_AUTH_METHOD, PROFILE_ID_RE, isCliAuthMethod, type CliAuthMethod } from '../../shared/account-web-session'

/** promisify(execFile), made when a CLI runs rather than when this module
 *  loads: the composition root imports it at start (WP2 PR 4, the Claude
 *  package's sign-in ports), long before anything here runs. Synchronous up
 *  to the spawn, as before. */
type ExecFileAsync = (file: string, args: readonly string[], options: ExecFileOptions & { encoding: 'utf-8' }) => Promise<{ stdout: string; stderr: string }>
const execFileAsync: ExecFileAsync = (file, args, options) => (promisify(execFile) as unknown as ExecFileAsync)(file, args, options)

export interface ClaudeCliAuthStatus {
  /** True when this account is signed in to the CLI. */
  authenticated: boolean
  /** Subscription tier, when reported. Display only. */
  subscriptionType?: string
  /** Epoch ms the OAuth token expires, when known (credential-file path only). */
  expiresAt?: number
  /** The account the CLI reports for this profile. Only the status path knows it. */
  email?: string
  /** Organisation the CLI reports. Display only. */
  orgName?: string
  /** Which source answered: the CLI's own status command, or the credential file. */
  source?: 'cli-status' | 'credential-file'
  /** Set when nothing could be determined. */
  error?: string
  /** WP2: the CLI was not asked because Claude Code is switched off (or its
   *  on/off could not be read): the reason, in plain words. */
  notChecked?: string
}

/**
 * PURE: interpret `claude auth status` JSON. Exported so it has a test.
 *
 * PREFERRED over reading the credential file. It is the CLI's own supported
 * interface, it survives a change to that file's private layout, and it answers
 * a question the file cannot: WHICH ACCOUNT this profile is signed in as, plus
 * the org and plan. Verified per-account by setting USERPROFILE to the profile
 * home — the same redirection pty-manager already uses to spawn a session under
 * an account.
 */
export function parseAuthStatus(raw: string): ClaudeCliAuthStatus | null {
  try {
    const j = JSON.parse(raw)
    if (typeof j?.loggedIn !== 'boolean') return null
    return {
      authenticated: j.loggedIn,
      email: typeof j.email === 'string' ? j.email : undefined,
      orgName: typeof j.orgName === 'string' ? j.orgName : undefined,
      subscriptionType: typeof j.subscriptionType === 'string' ? j.subscriptionType : undefined,
      source: 'cli-status',
    }
  } catch {
    return null
  }
}

/** PURE: interpret a credentials file's contents. Exported so it has a test. */
export function parseCliAuth(raw: string): ClaudeCliAuthStatus {
  try {
    const j = JSON.parse(raw)
    const o = j?.claudeAiOauth
    if (!o || typeof o.accessToken !== 'string' || !o.accessToken) {
      return { authenticated: false }
    }
    return {
      authenticated: true,
      subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : undefined,
      expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : undefined,
    }
  } catch {
    // A malformed file is NOT authenticated. Failing closed here matters: the
    // UI uses this to decide whether to prompt for a sign-in.
    return { authenticated: false, error: 'credential file is not readable JSON' }
  }
}

/**
 * Read one account's CLI auth state.
 *
 * Reads only the SHAPE — whether a token exists and when it expires. The token
 * value is never returned, logged, or copied.
 *
 * ASYNC (#258 follow-up): the CLI probe is a subprocess with a 10s timeout, run
 * once per account and triggered from the Sidebar (every session right-click)
 * and the accounts panel (every row on mount). Running it synchronously blocked
 * the Electron main event loop for up to 10s each time — long enough to trip the
 * usage fetch's own 8s socket timeout. execFileAsync keeps it off the loop.
 *
 * WP2 PR 4: the provider-neutral sign-in check passes a `runner` (the
 * executable discovery proved, run with no shell); the Accounts panel and the
 * Sidebar pass none and run the probe as before. Either waits for a sign-out
 * of the profile under way, and either joins a probe of the profile already
 * running (one CLI per profile at a time).
 */
// Overlapping probes for ONE profile share a single subprocess. The renderer
// fires ACCOUNT_WEB_STATUS on every account-row mount, every auth-method toggle,
// and every Sidebar session right-click, so N accounts on a panel open could boot
// N concurrent `claude` CLI trees at once. The pre-#258 execFileSync path
// serialised them by accident; making the probe async removed that backpressure.
// Keyed by profileId, cleared when the probe settles — same shape as the usage
// refreshInFlight map. Deduping also means one consumer ref per profile, not N.
const authProbesInFlight = new Map<string, Promise<ClaudeCliAuthStatus>>()

/** A sign-out of a profile while it runs (logoutClaudeCli), settled once its
 *  process has ended and the profile is let go. A probe of that profile waits
 *  for it before it starts: `claude auth status` beside a sign-out could
 *  rotate the token the sign-out is removing (WP2 PR 4 review, A2-Q3). */
const signOutsInFlight = new Map<string, Promise<void>>()

/** How the provider-neutral account actions run the Claude CLI (WP2 PR 4):
 *  the executable discovery last proved, started with no shell by the app's
 *  CLI runner, its whole process tree stopped at the time limit. The
 *  composition root builds it (compose.ts claudeCliAuthRunner); the Accounts
 *  panel's own probe does not take one and runs as it always has. */
export interface ClaudeCliAuthRunner {
  /** The folder the CLI runs in: the project gate reads this one. */
  readonly cwd: string
  run(args: readonly string[], env: Record<string, string>, timeoutMs: number): Promise<ClaudeCliAuthRun>
}

/** One run through a ClaudeCliAuthRunner. */
export interface ClaudeCliAuthRun {
  /** Nothing was started, and why (the command line was refused). */
  refused?: string
  /** The process could not be started. */
  spawnError?: string
  exitCode: number | null
  stdout: string
  /** Stopped at the time limit. */
  timedOut: boolean
  /** A stopped run whose kill is still under way: resolves once it has
   *  ended (never rejects). The profile stays held until then. */
  killSettled?: Promise<void>
}

const STATUS_TIMEOUT_MS = 10_000
/** How long past its own time limits a runner-run check or sign-out may hold
 *  the profile: the project gate, and a slow kill of a stopped process tree.
 *  Sized as the reviewer's (CLAUDE_REVIEW_HOLD_GRACE_MS). */
const CLI_HOLD_GRACE_MS = 60_000

/** The environment a CLI auth run gets in a profile's home: withProfileHome's
 *  hardened one, with HOME pointed at the home as well, except on macOS. There
 *  withProfileHome leaves HOME at the real home on purpose (the login keychain
 *  is found through it, #117), so every profile on a Mac runs on the Mac's one
 *  Claude Code sign-in (D2), and a check or a sign-out reads and acts on that
 *  sign-in, as a session on the profile does. */
function profileCliEnv(home: string, context: { launchId: string; cwd: string; probe: true; projectGate: Awaited<ReturnType<typeof gateManagedLaunch>> }): Record<string, string> {
  const env = withProfileHome({ ...process.env } as Record<string, string>, home, context)
  // MUTATED rather than spread into a literal: the realm patch builds the env
  // with a null prototype (see src/shared/providers/realm-env.ts).
  return process.platform === 'darwin' ? env : Object.assign(env, { HOME: home })
}

export function readClaudeCliAuth(profileId: string, runner?: ClaudeCliAuthRunner): Promise<ClaudeCliAuthStatus> {
  const existing = authProbesInFlight.get(profileId)
  if (existing) return existing
  const probe = (async () => {
    try {
      const signingOut = signOutsInFlight.get(profileId)
      if (signingOut) await signingOut
      return await readClaudeCliAuthUncached(profileId, runner)
    } finally {
      authProbesInFlight.delete(profileId)
    }
  })()
  authProbesInFlight.set(profileId, probe)
  return probe
}

async function readClaudeCliAuthUncached(profileId: string, runner?: ClaudeCliAuthRunner): Promise<ClaudeCliAuthStatus> {
  // VALIDATE HERE, not only at the IPC boundary. `join` does not sandbox: with
  // `../../..` segments it walks straight out of the profiles root, and the id
  // below becomes both a filesystem path and the HOME of a spawned process. The
  // one caller today validates first, which makes this function safe by
  // coincidence rather than by construction — and that is precisely the pattern
  // `getProfileConfigDir` exists to stop repeating.
  if (!PROFILE_ID_RE.test(profileId)) {
    return { authenticated: false, error: 'could not determine CLI auth state' }
  }

  // 1. Ask the CLI. Setting USERPROFILE to the profile home is how a session is
  //    already spawned under an account, and `claude auth status` honours it —
  //    verified against two profiles, which reported two different emails.
  //
  //    Register as a transient credential consumer for the probe's lifetime:
  //    `claude auth status` reads this profile's credentials under its home and
  //    can make the CLI rotate the (single-use) refresh token. Without this, the
  //    usage page's auto token-refresh — which gates on isProfileInUseByLiveSession
  //    and knows only about PTY sessions — could rotate the same token
  //    concurrently and strand the account (log it out). See profile-consumers.ts.
  //
  //    And the other ordering (#49): if that refresh is ALREADY in flight when the
  //    probe starts, registering now is too late to stop the POST -- the CLI would
  //    read the pre-rotation credential file and could later redeem the same
  //    single-use refresh token. So acquire FIRST (from here on no new rotation
  //    can start), then wait for the in-flight one to land, then spawn. The
  //    other order left a microtask between the wait settling and the acquire
  //    in which a fresh rotation could begin (adversarial pass on #598).
  //    Awaited ONLY when a rotation is actually in flight, or when the project
  //    gate has no recent verdict for this process's directory (the first
  //    probe, and once per reuse window after): the common path stays
  //    synchronous up to the spawn, which is what lets overlapping probes for
  //    one profile share a single subprocess.
  //
  //    Through a runner (the provider-neutral check, WP2 PR 4) the profile is
  //    held for the runner's own time limit plus a grace, and let go only once
  //    a stopped process tree has ended.
  const release = runner
    ? acquireProfileConsumer(profileId, { maxAgeMs: STATUS_TIMEOUT_MS + CLI_HOLD_GRACE_MS })
    : acquireProfileConsumer(profileId)
  let kill: Promise<void> | undefined
  try {
    const rotation = pendingProfileRefresh(profileId)
    if (rotation) await rotation
    // The project gate for the directory the CLI runs in (the one this probe
    // inherits, or the runner's). A recent verdict is read synchronously so
    // the common path stays synchronous up to the spawn (see above); only a
    // miss awaits the gate.
    const probeCwd = runner ? runner.cwd : process.cwd()
    const projectGate = peekGateVerdict(probeCwd) ?? await gateManagedLaunch(probeCwd)
    const home = join(getProfilesRoot(), profileId)
    if (existsSync(home)) {
      // `claude auth status` is an AUTH path, so it is a managed launch and
      // gets the same hardening as a session: ambient authority variables
      // removed, the host control applied last. It used to hand-build
      // `{ ...process.env, USERPROFILE, HOME }`, which is the shape
      // withProfileHome exists to own -- and being the one launch path that
      // built its own env is exactly how it would have kept inheriting an
      // ambient ANTHROPIC_API_KEY and reported the wrong account as signed
      // in. HOME: see profileCliEnv.
      const env = profileCliEnv(home, { launchId: 'auth-status', cwd: probeCwd, probe: true, projectGate })
      if (runner) {
        const r = await runner.run(['auth', 'status'], env, STATUS_TIMEOUT_MS)
        if (r.killSettled instanceof Promise) kill = r.killSettled
        // `claude auth status` exits 1 when signed out, its answer on stdout.
        const parsed = r.refused !== undefined || r.spawnError !== undefined || r.timedOut ? null : parseAuthStatus(r.stdout)
        if (parsed) return parsed
      } else {
        const { stdout } = await execFileAsync('claude', ['auth', 'status'], {
          encoding: 'utf-8',
          timeout: STATUS_TIMEOUT_MS,
          windowsHide: true,
          shell: true,          // resolves claude.cmd on Windows, as elsewhere in the app
          env,
        })
        const parsed = parseAuthStatus(stdout)
        if (parsed) return parsed
      }
    }
  } catch (e) {
    // CLI absent, slow, or erroring — fall through to the file.
    //
    // But a managed-launch REFUSAL is not that. `withProfileHome` throws when
    // the host control could not be applied, and this bare catch swallowed it
    // with no log line at all; the probe then fell back to reading the
    // credential file and answered as if nothing had happened. This call site
    // records no preflight either, so a regressed control here left ZERO trace
    // anywhere (adversarial review, MAJOR 7). The fallback is still correct --
    // it reads a file rather than launching the CLI, so it cannot act as the
    // wrong account -- but the silence was not.
    const message = (e as Error)?.message ?? String(e)
    if (message.includes(MANAGED_LAUNCH_REFUSAL)) {
      logWarn(`[account-web] profile ${profileId}: the CLI auth probe was refused -- ${message}. Falling back to the credential file; this is an isolation fault, not a missing CLI.`)
    }
  } finally {
    const letGo = (): void => { release() }
    if (kill) void kill.then(letGo, letGo)
    else letGo()
  }

  // 2. Fall back to the credential file at <profileHome>/.claude/.credentials.json
  //    — the location EVERY writer and reader in the app uses (account-usage.ts,
  //    account-auth-info.ts, account-profiles.ts). The previous path omitted the
  //    `.claude` segment, so the file could never be found: whenever the CLI probe
  //    above failed (absent/slow/non-zero, all swallowed) a fully signed-in
  //    account rendered "not signed in", telling the user to /login. Less
  //    informative than the CLI (no email/org) but needs no subprocess, so a
  //    missing or broken CLI still yields a usable signed-in/out answer.
  try {
    const configDir = getProfileConfigDir(profileId)
    if (!configDir) return { authenticated: false }
    const path = join(configDir, '.claude', '.credentials.json')
    if (!existsSync(path)) return { authenticated: false }
    return { ...parseCliAuth(readFileSync(path, 'utf-8')), source: 'credential-file' }
  } catch (err) {
    logError(`[account-web] could not read CLI auth for ${profileId}: ${(err as Error)?.message}`)
    return { authenticated: false, error: 'could not determine CLI auth state' }
  }
}

/** What a sign-out did. `ran`: `claude auth logout` was started, so the
 *  profile may have changed whatever followed. `after`: the CLI's own answer
 *  for the profile, read afresh once the sign-out ended; null when it could
 *  not be read, and not read at all after a sign-out stopped at its time
 *  limit (its result is unconfirmed). `refused`: nothing was started, and
 *  why. */
export interface ClaudeCliLogoutResult {
  ran: boolean
  after: ClaudeCliAuthStatus | null
  refused?: 'invalid-profile' | 'in-use' | 'no-home' | 'host-control' | 'cli-unavailable' | 'computer-sign-in'
  timedOut?: boolean
}

/** How a sign-out runs. */
export interface ClaudeCliLogoutOptions {
  /** The CLI run: the executable discovery proved, no shell. Absent or null:
   *  discovery has proved no file, and nothing runs ('cli-unavailable'). */
  runner?: ClaudeCliAuthRunner | null
  /** The user's acknowledgement that this sign-out reaches this computer's
   *  own Claude Code sign-in (see profileSharesComputerSignIn). */
  acknowledgeComputerSignIn?: boolean
}

const LOGOUT_TIMEOUT_MS = 30_000

/** Whether signing this profile out reaches this computer's own Claude Code
 *  sign-in, the one the user's Claude Code uses outside the app:
 *  - macOS: every profile. withProfileHome leaves HOME at the real home there,
 *    so the login keychain, and with it the Mac's one Claude Code sign-in, is
 *    what every profile's session runs on (D2, #117);
 *  - elsewhere: the primary profile, whose credentials the app keeps on the
 *    same token as the user's own login (syncPrimaryCredentialsWithGlobal).
 *  A profile list that cannot be read counts as shared: the acknowledgement
 *  is then asked for rather than skipped. */
function profileSharesComputerSignIn(profileId: string): boolean {
  if (process.platform === 'darwin') return true
  let all: ReturnType<typeof readProfilesStrict>
  try { all = readProfilesStrict() } catch { return true }
  if (all === null) return true
  return all.some((p) => !!p && typeof p === 'object' && p.isPrimary === true && p.id === profileId)
}

const refusedLogout = (refused: NonNullable<ClaudeCliLogoutResult['refused']>): ClaudeCliLogoutResult => ({ ran: false, after: null, refused })

/**
 * Sign one account's CLI out: `claude auth logout` in that profile's own home,
 * by delegation, as the status probe above reads it. WP2 PR 4: the Claude
 * package's `auth.logout` (owner answers 2026-10-04).
 *
 * It runs the Claude executable discovery found, through the runner (no
 * shell, the whole process tree stopped at the time limit), with the probe's
 * hardened profile-home environment and the project gate for the folder the
 * CLI runs in. The credential file is never opened here; the CLI owns it.
 * The CLI also revokes the sign-in's token with the service, so a sign-out
 * that reaches this computer's own sign-in (profileSharesComputerSignIn) signs
 * out every Claude Code using it: that one runs only with the user's
 * acknowledgement.
 *
 * Refused, before anything starts, while the profile is in use (a live
 * session, or another check or run holding it): signing out removes the
 * credentials that consumer reads -- the rule a profile removal follows. The
 * profile is then held for the whole run (holdProfileForRun, with the run's
 * full bound), a probe of it waits for the sign-out, and the sessions on it
 * are asked again just before the start. The verdict is the profile's state
 * read afterwards, not the exit code. Once a sign-out has run, the profile's
 * identity copy of its credentials is removed (unless the profile still reads
 * as signed in).
 */
export async function logoutClaudeCli(profileId: string, opts: ClaudeCliLogoutOptions = {}): Promise<ClaudeCliLogoutResult> {
  if (!PROFILE_ID_RE.test(profileId)) return refusedLogout('invalid-profile')
  if (opts.acknowledgeComputerSignIn !== true && profileSharesComputerSignIn(profileId)) return refusedLogout('computer-sign-in')
  const runner = opts.runner
  if (!runner) return refusedLogout('cli-unavailable')
  if (signOutsInFlight.has(profileId) || isProfileInUseByLiveSession(profileId)) return refusedLogout('in-use')
  // Published before anything awaits, so a probe asked for from here on waits.
  const run = runLogout(profileId, runner)
  const settled = run.then(() => undefined, () => undefined)
  signOutsInFlight.set(profileId, settled)
  try {
    return await run
  } finally {
    if (signOutsInFlight.get(profileId) === settled) signOutsInFlight.delete(profileId)
  }
}

async function runLogout(profileId: string, runner: ClaudeCliAuthRunner): Promise<ClaudeCliLogoutResult> {
  // Held before the wait for a rotation in flight, then again with the run's
  // full bound: the sign-out, the status read after it and a slow kill.
  const release = await holdProfileForRun(profileId, LOGOUT_TIMEOUT_MS + STATUS_TIMEOUT_MS + CLI_HOLD_GRACE_MS)
  if (!release) return refusedLogout('in-use')
  const kills: Promise<void>[] = []
  const ended = async (r: ClaudeCliAuthRun): Promise<void> => {
    if (r.killSettled instanceof Promise) {
      kills.push(r.killSettled)
      await r.killSettled
    }
  }
  try {
    const projectGate = peekGateVerdict(runner.cwd) ?? await gateManagedLaunch(runner.cwd)
    const home = join(getProfilesRoot(), profileId)
    if (!existsSync(home)) return refusedLogout('no-home')
    let env: Record<string, string>
    try {
      env = profileCliEnv(home, { launchId: 'auth-logout', cwd: runner.cwd, probe: true, projectGate })
    } catch (e) {
      logWarn(`[account-web] profile ${profileId}: the CLI sign-out was refused -- ${(e as Error)?.message ?? String(e)}. Nothing was run.`)
      return refusedLogout('host-control')
    }
    // Asked again after every wait, immediately before the start: a session
    // opened on the profile meanwhile refuses the sign-out. The sessions are
    // what is asked; the hold above is this run's own.
    if (sessionsOnProfile(profileId).length > 0) return refusedLogout('in-use')
    const out = await runner.run(['auth', 'logout'], env, LOGOUT_TIMEOUT_MS)
    await ended(out)
    if (out.refused !== undefined || out.spawnError !== undefined) {
      logWarn(`[account-web] profile ${profileId}: the Claude executable could not be started for the sign-out (${out.refused ?? out.spawnError}). Nothing was run.`)
      return refusedLogout('cli-unavailable')
    }
    if (out.timedOut) {
      // Its process tree has ended (awaited above). Whether it signed out is
      // not known, and no status is read in its place.
      removeProfileIdentityCredentials(profileId)
      logInfo(`[account-web] ${profileId}: the claude CLI sign-out was stopped at its time limit; signed out is unconfirmed`)
      return { ran: true, after: null, timedOut: true }
    }
    const after = await readStatusAfterLogout(runner, env, ended)
    const signedOut = !!after && after.error === undefined && after.authenticated === false
    const stillSignedIn = !!after && after.error === undefined && after.authenticated === true
    if (!stillSignedIn) removeProfileIdentityCredentials(profileId)
    logInfo(`[account-web] ${profileId}: the claude CLI sign-out ran; ${signedOut ? 'signed out (confirmed by its status)' : stillSignedIn ? 'the profile still reads as signed in' : 'signed out is unconfirmed'}`)
    return { ran: true, after }
  } finally {
    // Let go once every process the run started has ended.
    const letGo = (): void => { try { release() } catch { /* a release never replaces the result */ } }
    if (kills.length) void Promise.all(kills).then(letGo, letGo)
    else letGo()
  }
}

/** The profile's state straight from the CLI, never a probe already in
 *  flight (that one started before the sign-out). `claude auth status`
 *  exits 1 when signed out, with its answer still on stdout. */
async function readStatusAfterLogout(runner: ClaudeCliAuthRunner, env: Record<string, string>, ended: (r: ClaudeCliAuthRun) => Promise<void>): Promise<ClaudeCliAuthStatus | null> {
  try {
    const r = await runner.run(['auth', 'status'], env, STATUS_TIMEOUT_MS)
    await ended(r)
    if (r.refused !== undefined || r.spawnError !== undefined || r.timedOut) return null
    return parseAuthStatus(r.stdout)
  } catch {
    return null
  }
}

/**
 * The command a user runs to authenticate the CODE session for this account.
 *
 * Returned rather than executed: `claude auth` is interactive and belongs in a
 * terminal the user can see, and CCC already owns a PTY per session. Handing
 * back the command lets the caller run it in the session's own terminal, where
 * its browser hand-off and any prompts are visible — instead of a hidden child
 * process the user cannot answer.
 */
export function claudeAuthCommand(method: CliAuthMethod = DEFAULT_CLI_AUTH_METHOD, email?: string): string {
  // The flag comes from the account's own setting, not a guess. `--claudeai` is
  // the CLI's default and is emitted explicitly so the command is
  // self-describing when a user copies it. All three are documented flags of
  // `claude auth login`, read off its --help.
  const flag = isCliAuthMethod(method) ? method : DEFAULT_CLI_AUTH_METHOD
  const base = `claude auth login --${flag}`
  if (!email) return base
  // Only an address-shaped value is interpolated. This string is shown to a
  // human and may be written into a terminal, so it does not get to carry
  // whatever happened to be in the profile record.
  return /^[^\s"'`;&|<>$()]+@[^\s"'`;&|<>$()]+$/.test(email) ? `${base} --email ${email}` : base
}

export function logAuthHandoff(profileId: string): void {
  logInfo(`[account-web] ${profileId}: handing the code-session sign-in to the claude CLI (system browser)`)
}
