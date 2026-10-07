// account-auth-info.ts — read what each profile's stored credentials say.
//
// Pure file reads: `<home>/.claude/.credentials.json` and `<home>/.claude.json`.
// No network, no `claude` spawn, so this is cheap enough to call whenever a panel
// opens and it serves three consumers:
//
//   * the accounts view -- days until a forced login, per account (#203)
//   * the duplicate/mismatch identity check (#202)
//   * layer 1 of the Insights pre-flight, "are there credentials at all" (#201)

import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { getProfileConfigDir, listProfiles, profileIdentityFile, profileCredentialLocation, readMacCredential, type ProfileCredentialLocation } from './account-profiles'
import type { ClaudeKeychainCreds } from './claude-credential-store-darwin'
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

/** <home>/.claude.json, or on macOS the file the experimental realm keeps
 *  inside its config directory (profileIdentityFile). Off macOS the account
 *  module is not asked at all, so nothing changes there. */
function identityFileFor(home: string): string {
  return process.platform === 'darwin' ? profileIdentityFile(home) : join(home, '.claude.json')
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Read one profile's credential state. Never throws. */
export function readProfileAuthInfo(profileId: string, accountEmail?: string): ProfileAuthInfo {
  const home = getProfileConfigDir(profileId)
  const credentialsFile = join(home, '.claude', '.credentials.json')
  const creds = readJson(credentialsFile)?.claudeAiOauth
  const oauthEmail: string | undefined = readJson(identityFileFor(home))?.oauthAccount?.emailAddress

  if (!creds) {
    return { profileId, accountEmail, oauthEmail, credentialsMissing: true }
  }
  // mtime, not a value inside the file: this is how "the user has signed in since
  // that failure" is established, and a fresh login rewrites the whole file.
  let credentialsUpdatedAt: number | undefined
  try {
    credentialsUpdatedAt = statSync(credentialsFile).mtimeMs
  } catch {
    credentialsUpdatedAt = undefined
  }
  return {
    profileId,
    accountEmail,
    oauthEmail,
    hasRefreshToken: typeof creds.refreshToken === 'string' && creds.refreshToken.length > 0,
    expiresAt: positiveNumber(creds.expiresAt),
    refreshTokenExpiresAt: positiveNumber(creds.refreshTokenExpiresAt),
    subscriptionType: typeof creds.subscriptionType === 'string' ? creds.subscriptionType : undefined,
    credentialsUpdatedAt
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
  return crossCheckAuthInfo(profiles.map((p) => readProfileAuthInfo(p.id, p.accountEmail)))
}

/** The ProfileAuthInfo of a parsed credential, wherever it was read from. */
function infoFromCreds(base: Pick<ProfileAuthInfo, 'profileId' | 'accountEmail' | 'oauthEmail'>, creds: ClaudeKeychainCreds, credentialsUpdatedAt: number | undefined): ProfileAuthInfo {
  return {
    ...base,
    hasRefreshToken: !!creds.refreshToken,
    expiresAt: positiveNumber(creds.expiresAt),
    refreshTokenExpiresAt: creds.refreshTokenExpiresAt,
    subscriptionType: creds.subscriptionType,
    credentialsUpdatedAt,
  }
}

/**
 * readProfileAuthInfo through the platform seam (profileCredentialLocation).
 * win32/linux and macOS with the setting off: the file read above, unchanged.
 * macOS with the setting on: the profile's Keychain item (or the file Claude
 * Code falls back to). An item that cannot be read is `credentialsUnknown`,
 * never `credentialsMissing`: "Not signed in" would be a guess. The Keychain
 * has no cheap modification time, so `credentialsUpdatedAt` is left unset
 * there, which keeps a past auth failure showing (authFailureStillApplies
 * fails toward the warning) until a login moves the refresh-token expiry.
 */
export async function readProfileAuthInfoAsync(profileId: string, accountEmail?: string): Promise<ProfileAuthInfo> {
  let loc: ProfileCredentialLocation
  try { loc = profileCredentialLocation(profileId) } catch { return readProfileAuthInfo(profileId, accountEmail) }
  if (loc.kind === 'file') return readProfileAuthInfo(profileId, accountEmail)
  const oauthEmail: string | undefined = readJson(identityFileFor(getProfileConfigDir(profileId)))?.oauthAccount?.emailAddress
  const base = { profileId, accountEmail, oauthEmail }
  const r = await readMacCredential(loc)
  if (r.status === 'not-found') return { ...base, credentialsMissing: true }
  if (r.status === 'unknown') return { ...base, credentialsUnknown: true }
  let updatedAt: number | undefined
  if (r.source === 'file') { try { updatedAt = statSync(r.file).mtimeMs } catch { updatedAt = undefined } }
  return infoFromCreds(base, r.creds, updatedAt)
}

/** readAllProfileAuthInfo through the platform seam. Identical to the sync
 *  read wherever no profile is on the Keychain. */
export async function readAllProfileAuthInfoAsync(): Promise<ProfileAuthInfo[]> {
  const profiles = listProfiles()
  const infos: ProfileAuthInfo[] = []
  // One at a time: each Keychain read is a `security` process.
  for (const p of profiles) infos.push(await readProfileAuthInfoAsync(p.id, p.accountEmail))
  return crossCheckAuthInfo(infos)
}

function crossCheckAuthInfo(infos: ProfileAuthInfo[]): ProfileAuthInfo[] {
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
