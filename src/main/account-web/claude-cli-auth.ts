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

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logError, logInfo } from '../debug-logger'
import { getProfileConfigDir } from '../account-profiles'

export interface ClaudeCliAuthStatus {
  /** True when a credential file exists with a claude.ai OAuth block. */
  authenticated: boolean
  /** Subscription tier the CLI recorded, when present. Display only. */
  subscriptionType?: string
  /** Epoch ms the OAuth token expires, when recorded. */
  expiresAt?: number
  /** Set when the file could not be read or parsed. */
  error?: string
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
  try {
    // getProfileConfigDir is the per-account CLAUDE_CONFIG_DIR — the same dir
    // the CLI writes its credentials into when a session runs as this account.
    const configDir = getProfileConfigDir(profileId)
    if (!configDir) return { authenticated: false }
    const path = join(configDir, '.credentials.json')
    if (!existsSync(path)) return { authenticated: false }
    return parseCliAuth(readFileSync(path, 'utf-8'))
  } catch (err) {
    logError(`[account-web] could not read CLI auth for ${profileId}: ${(err as Error)?.message}`)
    return { authenticated: false, error: 'could not read the credential file' }
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
export function claudeAuthCommand(): string {
  return 'claude auth'
}

export function logAuthHandoff(profileId: string): void {
  logInfo(`[account-web] ${profileId}: handing the code-session sign-in to the claude CLI (system browser)`)
}
