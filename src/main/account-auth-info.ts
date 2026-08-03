// account-auth-info.ts — read what each profile's stored credentials say.
//
// Pure file reads: `<home>/.claude/.credentials.json` and `<home>/.claude.json`.
// No network, no `claude` spawn, so this is cheap enough to call whenever a panel
// opens and it serves three consumers:
//
//   * the accounts view -- days until a forced login, per account (#203)
//   * the duplicate/mismatch identity check (#202)
//   * layer 1 of the Insights pre-flight, "are there credentials at all" (#201)

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getProfileConfigDir, listProfiles } from './account-profiles'
import { canonicaliseEmail } from '../shared/account-chip-color'
import type { ProfileAuthInfo } from '../shared/account-auth'
import { logWarn } from './debug-logger'

function readJson(file: string): any | null {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    // A profile mid-write, or a file the CLI wrote in a shape we don't expect.
    // Treated as "nothing readable" rather than throwing: one bad profile must
    // not take out the whole panel.
    return null
  }
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Read one profile's credential state. Never throws. */
export function readProfileAuthInfo(profileId: string, accountEmail?: string): ProfileAuthInfo {
  const home = getProfileConfigDir(profileId)
  const creds = readJson(join(home, '.claude', '.credentials.json'))?.claudeAiOauth
  const oauthEmail: string | undefined = readJson(join(home, '.claude.json'))?.oauthAccount?.emailAddress

  if (!creds) {
    return { profileId, accountEmail, oauthEmail, credentialsMissing: true }
  }
  return {
    profileId,
    accountEmail,
    oauthEmail,
    hasRefreshToken: typeof creds.refreshToken === 'string' && creds.refreshToken.length > 0,
    expiresAt: positiveNumber(creds.expiresAt),
    refreshTokenExpiresAt: positiveNumber(creds.refreshTokenExpiresAt),
    subscriptionType: typeof creds.subscriptionType === 'string' ? creds.subscriptionType : undefined
  }
}

/**
 * Read every profile's credential state and cross-check identities.
 *
 * `identityMismatch` is per-profile divergence (label vs home). `duplicateOfProfileIds`
 * is the cross-profile check, and it is the one that matters: two homes on one
 * account means each refresh rotates the token out from under the other.
 * Duplicates are matched on the HOME's identity, not the label, because the label
 * is the thing that gets silently rewritten.
 */
export function readAllProfileAuthInfo(): ProfileAuthInfo[] {
  const profiles = listProfiles()
  const infos = profiles.map((p) => readProfileAuthInfo(p.id, p.accountEmail))

  for (const info of infos) {
    if (info.oauthEmail && info.accountEmail) {
      info.identityMismatch = canonicaliseEmail(info.oauthEmail) !== canonicaliseEmail(info.accountEmail)
    }
  }

  const byIdentity = new Map<string, string[]>()
  for (const info of infos) {
    // Fall back to the label only when the home says nothing, so a profile with
    // no readable .claude.json isn't paired with everything else that lacks one.
    const identity = info.oauthEmail ?? info.accountEmail
    if (!identity) continue
    const key = canonicaliseEmail(identity)
    const list = byIdentity.get(key)
    if (list) list.push(info.profileId)
    else byIdentity.set(key, [info.profileId])
  }
  for (const [identity, ids] of byIdentity) {
    if (ids.length < 2) continue
    logWarn(
      `[account-auth] ${ids.length} profiles resolve to ${identity} (${ids.join(', ')}) — ` +
      'each refresh will invalidate the others'
    )
    for (const id of ids) {
      const info = infos.find((i) => i.profileId === id)
      if (info) info.duplicateOfProfileIds = ids.filter((other) => other !== id)
    }
  }

  return infos
}
