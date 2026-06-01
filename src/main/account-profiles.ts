// src/main/account-profiles.ts
// Per-session multi-account via per-process CLAUDE_CONFIG_DIR. Identity files
// are private per profile; projects/memory/etc are junctioned back to the shared
// ~/.claude. SAFETY: this module only ever copies into / links from the shared
// root; it never moves or recursive-deletes through a junction. All path roots
// are injectable so tests never touch the live ~/.claude. Profile metadata is
// persisted as an atomic profiles.json under the profiles root (NOT via
// config-manager) so _setRootsForTest is a total seam.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getResourcesDirectory } from './ipc/setup-handlers'
import type { AccountProfile, AccountProfilesConfig } from '../shared/account-types'

// Shared-directory names junctioned from a profile back to the shared root.
// Identity files (.credentials.json, .claude.json, statsig, telemetry, caches)
// are deliberately NOT here -- they stay private per profile.
export const SHARED_DIR_NAMES = ['projects', 'memory', 'agents', 'skills', 'commands', 'plugins'] as const

// Profile ids are CCC-generated, lowercase-alphanumeric + hyphen. Validating
// here is the primary defense against a malicious/buggy renderer-supplied id
// (e.g. "..\\..\\.claude") escaping the profiles root in teardown.
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]*$/

export function isValidProfileId(id: string): boolean { return PROFILE_ID_RE.test(id) }

let rootsOverride: { resourcesDir: string; sharedRoot: string } | null = null
/** Test seam: inject temp roots so we never touch ~/.claude. */
export function _setRootsForTest(roots: { resourcesDir: string; sharedRoot: string } | null): void { rootsOverride = roots }

function resourcesDir(): string { return rootsOverride?.resourcesDir ?? getResourcesDirectory() }
/** The shared real config root (default account). Overridable in tests ONLY. */
export function sharedRoot(): string { return rootsOverride?.sharedRoot ?? path.join(os.homedir(), '.claude') }

export function getProfilesRoot(): string { return path.join(resourcesDir(), 'account-profiles') }
export function getProfileConfigDir(id: string): string { return path.join(getProfilesRoot(), id) }

function profilesMetaFile(): string { return path.join(getProfilesRoot(), 'profiles.json') }

export function listProfiles(): AccountProfile[] {
  try {
    const raw = fs.readFileSync(profilesMetaFile(), 'utf8')
    return (JSON.parse(raw) as AccountProfilesConfig)?.profiles ?? []
  } catch { return [] }
}

function saveProfiles(profiles: AccountProfile[]): void {
  const file = profilesMetaFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ profiles } satisfies AccountProfilesConfig, null, 2))
  fs.renameSync(tmp, file) // atomic; Node renameSync overwrites existing on win + posix
}
export function upsertProfile(p: AccountProfile): void {
  const all = listProfiles().filter((x) => x.id !== p.id)
  all.push(p)
  saveProfiles(all)
}
export function deleteProfileMeta(id: string): void {
  saveProfiles(listProfiles().filter((x) => x.id !== id))
}

/** Create a fresh, EMPTY profile dir + shared junctions + metadata. The account
 *  email is filled in later by readProfileAccountEmail once the user runs /login
 *  under this profile's CLAUDE_CONFIG_DIR. Never copies credentials; never
 *  touches the default ~/.claude. */
export function createProfile(name?: string): AccountProfile {
  const id = `profile-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  setupProfileLinks(id)
  const trimmed = name?.trim()
  const profile: AccountProfile = {
    id,
    name: trimmed ? trimmed.slice(0, 120) : 'New account',
    accountEmail: '',
    createdAt: Date.now(),
  }
  upsertProfile(profile)
  return profile
}

const isWin = process.platform === 'win32'

function ensureLink(target: string, link: string): void {
  // Replace any existing entry at `link` (safely: never recurse a junction).
  try {
    const st = fs.lstatSync(link)
    if (st.isSymbolicLink()) { try { fs.rmdirSync(link) } catch { fs.unlinkSync(link) } }
    else if (st.isDirectory()) fs.rmdirSync(link) // only if empty; a real dir we created
    else fs.unlinkSync(link)
  // NOTE: a pre-existing REAL non-empty dir at `link` throws ENOTEMPTY here (swallowed) then EEXIST at symlinkSync. That is safe (rmdirSync never deletes non-empty dirs) but surfaces a confusing error; in this feature's flows `link` is always our own junction or absent.
  } catch { /* not present */ }
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link, isWin ? 'junction' : 'dir')
}

/**
 * Junction the shared dirs from `sharedRoot()` into the profile, and copy
 * settings.json one-way (junctions are dir-only; a file symlink needs elevation
 * on Windows, and a shared settings.json must never be mutated by a profile).
 * Idempotent: re-running replaces existing junctions and re-copies settings.json.
 */
export function setupProfileLinks(id: string): void {
  const dir = getProfileConfigDir(id)
  fs.mkdirSync(dir, { recursive: true })
  const shared = sharedRoot()
  for (const name of SHARED_DIR_NAMES) {
    const target = path.join(shared, name)
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true })
    ensureLink(target, path.join(dir, name))
  }
  const srcSettings = path.join(shared, 'settings.json')
  if (fs.existsSync(srcSettings)) fs.copyFileSync(srcSettings, path.join(dir, 'settings.json'))
}

/** Re-copy settings.json from shared -> profile (call after the user edits shared settings). */
export function resyncProfileSettings(id: string): void {
  const src = path.join(sharedRoot(), 'settings.json')
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(getProfileConfigDir(id), 'settings.json'))
}

/** Recursive teardown that removes junction LINKS only, never their targets. */
function safeTeardown(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    const st = fs.lstatSync(full)
    if (st.isSymbolicLink()) {
      // junction/symlink: remove the reparse point ONLY, never its target.
      try { fs.rmdirSync(full) } catch { fs.unlinkSync(full) }
    } else if (st.isDirectory()) {
      safeTeardown(full)
    } else {
      fs.unlinkSync(full)
    }
  }
  fs.rmdirSync(dir)
}

export function safeTeardownProfile(id: string): void {
  if (!isValidProfileId(id)) throw new Error(`refusing teardown: invalid profile id ${JSON.stringify(id)}`)
  const dir = getProfileConfigDir(id)
  // Defense-in-depth: the dir MUST be exactly <profilesRoot>/<id>. A validated
  // id can't contain separators or "..", but assert containment anyway.
  if (path.resolve(dir) !== path.resolve(getProfilesRoot(), id)) {
    throw new Error('refusing teardown: path escapes the profiles root')
  }
  if (fs.existsSync(dir)) {
    // Never recurse a reparse point AS THE ROOT (would walk into a junction target).
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('refusing teardown: profile dir is a reparse point')
    safeTeardown(dir)
  }
  deleteProfileMeta(id)
}

/** Reliable per-session identity: each profile has its OWN .claude.json.
 *  (The v1.5.9 alias attempt failed because it read the GLOBAL last-login.) */
export function readProfileAccountEmail(id: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(getProfileConfigDir(id), '.claude.json'), 'utf8')
    const email = (JSON.parse(raw) as { oauthAccount?: { emailAddress?: unknown } })?.oauthAccount?.emailAddress
    return typeof email === 'string' && email ? email : null
  } catch { return null }
}
