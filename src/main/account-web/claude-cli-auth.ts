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

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logError, logInfo } from '../debug-logger'
import { getProfileConfigDir, getProfilesRoot } from '../account-profiles'

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
 */
export function readClaudeCliAuth(profileId: string): ClaudeCliAuthStatus {
  // 1. Ask the CLI. Setting USERPROFILE to the profile home is how a session is
  //    already spawned under an account, and `claude auth status` honours it —
  //    verified against two profiles, which reported two different emails.
  try {
    const home = join(getProfilesRoot(), profileId)
    if (existsSync(home)) {
      const out = execFileSync('claude', ['auth', 'status'], {
        encoding: 'utf-8',
        timeout: 10_000,
        windowsHide: true,
        shell: true,          // resolves claude.cmd on Windows, as elsewhere in the app
        env: { ...process.env, USERPROFILE: home, HOME: home },
      })
      const parsed = parseAuthStatus(out)
      if (parsed) return parsed
    }
  } catch {
    // CLI absent, slow, or erroring — fall through to the file.
  }

  // 2. Fall back to the credential file. Less informative (no email/org) but it
  //    needs no subprocess, so a missing or broken CLI still yields a usable
  //    signed-in/out answer rather than an error.
  try {
    const configDir = getProfileConfigDir(profileId)
    if (!configDir) return { authenticated: false }
    const path = join(configDir, '.credentials.json')
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
export function claudeAuthCommand(email?: string): string {
  // --sso forces the SSO flow, which is what a managed org needs; --email
  // pre-populates so the user does not retype it. Both are documented flags of
  // claude auth login, checked against --help rather than assumed.
  const base = 'claude auth login --sso'
  if (!email) return base
  // Only an address-shaped value is interpolated. This string is shown to a
  // human and may be written into a terminal, so it does not get to carry
  // whatever happened to be in the profile record.
  return /^[^\s"'`;&|<>$()]+@[^\s"'`;&|<>$()]+$/.test(email) ? `${base} --email ${email}` : base
}

export function logAuthHandoff(profileId: string): void {
  logInfo(`[account-web] ${profileId}: handing the code-session sign-in to the claude CLI (system browser)`)
}
