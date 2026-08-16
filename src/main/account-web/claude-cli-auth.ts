/**
 * claude-cli-auth.ts — the CODE-session half of #216, by delegation (not invention).
 *
 * CCC already solves this for the other provider and should not solve it twice:
 * it never implements Codex's OAuth. It shells out to `codex login` and then
 * READS `~/.codex/auth.json` for the result (`src/main/providers/codex/auth.ts`).
 * The vendor CLI opens the SYSTEM browser with a loopback redirect; CCC only
 * reads the credential file the CLI writes.
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
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logError, logInfo } from '../debug-logger'
import { getProfileConfigDir, getProfilesRoot } from '../account-profiles'
import { acquireProfileConsumer } from '../profile-consumers'
import { DEFAULT_CLI_AUTH_METHOD, PROFILE_ID_RE, isCliAuthMethod, type CliAuthMethod } from '../../shared/account-web-session'

const execFileAsync = promisify(execFile)

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
 */
export async function readClaudeCliAuth(profileId: string): Promise<ClaudeCliAuthStatus> {
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
  const release = acquireProfileConsumer(profileId)
  try {
    const home = join(getProfilesRoot(), profileId)
    if (existsSync(home)) {
      const { stdout } = await execFileAsync('claude', ['auth', 'status'], {
        encoding: 'utf-8',
        timeout: 10_000,
        windowsHide: true,
        shell: true,          // resolves claude.cmd on Windows, as elsewhere in the app
        env: { ...process.env, USERPROFILE: home, HOME: home },
      })
      const parsed = parseAuthStatus(stdout)
      if (parsed) return parsed
    }
  } catch {
    // CLI absent, slow, or erroring — fall through to the file.
  } finally {
    release()
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
