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

/** The real user home (parent of the shared ~/.claude). Test-overridable seam. */
function realHomeDir(): string {
  return rootsOverride ? path.dirname(rootsOverride.sharedRoot) : os.homedir()
}

// Home-root entries that stay PRIVATE per account -- never mirrored from the real
// home. The Claude identity (.claude.json) + config dir (.claude) are isolated;
// everything else mirrors the real home so tools behave identically.
const HOME_PRIVATE = new Set(['.claude', '.claude.json'])

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

/** Hard-link a FILE from the real home into the fake home (same data, no admin
 *  on Windows). `link` is ALWAYS inside the fake home; we only replace our own
 *  link/file there, never the target. Cross-volume falls back to a copy. */
function ensureHardLink(target: string, link: string): void {
  try {
    const st = fs.lstatSync(link)
    if (st.isSymbolicLink()) { try { fs.rmdirSync(link) } catch { fs.unlinkSync(link) } }
    else if (st.isDirectory()) return // never clobber a real dir with a file link
    else fs.unlinkSync(link)
  } catch { /* not present */ }
  try {
    fs.linkSync(target, link)
  } catch {
    // Different volume / permission: a one-way copy is a safe best-effort fallback.
    try { fs.copyFileSync(target, link) } catch { /* skip this entry */ }
  }
}

/**
 * Mirror every DOT-entry of the real home into the fake home so git, ssh, npm,
 * gh and friends resolve to the real config: directories via junctions, files
 * via hard links. Skips the private Claude files. SAFETY: only ever writes UNDER
 * `home`; refuses to run if `home` resolves to the real home; best-effort per
 * entry so one bad item never aborts the spawn.
 */
function mirrorRealHome(home: string): void {
  const real = realHomeDir()
  if (path.resolve(home) === path.resolve(real)) return // never mirror onto self
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(real, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (!e.name.startsWith('.')) continue       // only dot-entries hold tool config
    if (HOME_PRIVATE.has(e.name)) continue       // .claude + .claude.json stay private
    const target = path.join(real, e.name)
    const link = path.join(home, e.name)
    try {
      const st = fs.lstatSync(target)
      if (st.isDirectory()) ensureLink(target, link)
      else if (st.isFile()) ensureHardLink(target, link)
      // symlinks / special files at the real root are skipped (don't chain links)
    } catch { /* best-effort: skip entries we can't stat or link */ }
  }
}

/** Remove OLD-layout direct junctions (`<home>/<sharedName>`) left by the prior
 *  CLAUDE_CONFIG_DIR model so they don't linger beside the new `.claude/` ones.
 *  Removes LINKS only -- never their targets. */
function migrateOldLayout(home: string): void {
  for (const name of SHARED_DIR_NAMES) {
    const p = path.join(home, name)
    try {
      if (fs.lstatSync(p).isSymbolicLink()) { try { fs.rmdirSync(p) } catch { fs.unlinkSync(p) } }
    } catch { /* absent */ }
  }
}

/**
 * Inner: build the shared-junction structure + dot-entry mirror inside a given
 * home dir. Extracted so both profile homes and session homes can reuse the same
 * logic without duplicating it. NEVER touches the real home.
 */
function buildHomeLinks(home: string): void {
  migrateOldLayout(home)

  // Private Claude config dir: shared junctions + a one-way settings copy.
  const claudeDir = path.join(home, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  const shared = sharedRoot()
  for (const name of SHARED_DIR_NAMES) {
    const target = path.join(shared, name)
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true })
    ensureLink(target, path.join(claudeDir, name))
  }
  const srcSettings = path.join(shared, 'settings.json')
  if (fs.existsSync(srcSettings)) fs.copyFileSync(srcSettings, path.join(claudeDir, 'settings.json'))

  // Seamless tool state: mirror the real home's dot-entries (git/ssh/npm/...).
  mirrorRealHome(home)
}

/**
 * Build the per-account fake HOME: a private `.claude/` (credentials + a one-way
 * settings copy + junctions to the shared ~/.claude dirs) plus a dot-entry mirror
 * of the real home so every other tool behaves identically. Idempotent -- safe to
 * re-run at every spawn to keep the mirror current. NEVER touches the real home.
 */
export function setupProfileLinks(id: string): void {
  const home = getProfileConfigDir(id)
  fs.mkdirSync(home, { recursive: true })
  buildHomeLinks(home)
}

/** Re-copy settings.json from shared -> profile's `.claude/` (after shared edits). */
export function resyncProfileSettings(id: string): void {
  const src = path.join(sharedRoot(), 'settings.json')
  if (fs.existsSync(src)) {
    const claudeDir = path.join(getProfileConfigDir(id), '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.copyFileSync(src, path.join(claudeDir, 'settings.json'))
  }
}

/**
 * One-time migration to the USERPROFILE fake-home layout. A profile is on the OLD
 * layout when it has no `<home>/.claude/` dir. For each such profile we drop the
 * now-ambiguous identity + credentials (the old model polluted them with the
 * global account), rebuild the new layout, and reset accountEmail so the user
 * re-runs /login once. Only ever touches files UNDER the profile dir.
 */
export function migrateProfilesToHomeLayout(): void {
  for (const p of listProfiles()) {
    if (!isValidProfileId(p.id)) continue
    const home = getProfileConfigDir(p.id)
    if (!fs.existsSync(home)) continue
    if (fs.existsSync(path.join(home, '.claude'))) continue // already new layout
    // Drop the polluted identity + creds so re-login is clean (profile dir only).
    for (const f of ['.claude.json', '.credentials.json']) {
      try { fs.unlinkSync(path.join(home, f)) } catch { /* absent */ }
    }
    try { setupProfileLinks(p.id) } catch { /* best-effort; leaves it setup-incomplete */ }
    upsertProfile({ ...p, accountEmail: '' })
  }
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

// ---------------------------------------------------------------------------
// Per-session working home
// ---------------------------------------------------------------------------

export function getSessionHomesRoot(): string { return path.join(resourcesDir(), 'account-homes') }
export function getSessionHomeDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(getSessionHomesRoot(), safe)
}

/** Build a per-session working home seeded from the account's canonical identity.
 *  Reuses the same junction/mirror logic as profile homes. Returns the home path. */
export function setupSessionHome(sessionId: string, profileId: string): string {
  const home = getSessionHomeDir(sessionId)
  fs.mkdirSync(home, { recursive: true })
  buildHomeLinks(home)
  const idDir = getAccountIdentityDir(profileId)
  const claudeDir = path.join(home, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  try { fs.copyFileSync(path.join(idDir, '.claude.json'), path.join(home, '.claude.json')) } catch { /* no identity yet */ }
  try { fs.copyFileSync(path.join(idDir, '.credentials.json'), path.join(claudeDir, '.credentials.json')) } catch { /* none */ }
  return home
}

export function teardownSessionHome(sessionId: string): void {
  const home = getSessionHomeDir(sessionId)
  if (!fs.existsSync(home)) return
  if (fs.lstatSync(home).isSymbolicLink()) return // never recurse a reparse-point root
  safeTeardown(home)
}

/** The authoritative, protected credential copy for an account. This dir is the source of truth; it is never used directly as a process HOME/CLAUDE_CONFIG_DIR. */
export function getAccountIdentityDir(id: string): string {
  return path.join(getProfileConfigDir(id), 'identity')
}

/** Write the canonical identity files (atomic-ish: write then rename). */
export function writeCanonicalIdentity(
  id: string,
  files: { claudeJson?: string; credentials?: string },
): void {
  const dir = getAccountIdentityDir(id)
  fs.mkdirSync(dir, { recursive: true })
  if (files.claudeJson != null) {
    const f = path.join(dir, '.claude.json')
    fs.writeFileSync(f + '.tmp', files.claudeJson)
    fs.renameSync(f + '.tmp', f)
  }
  if (files.credentials != null) {
    const f = path.join(dir, '.credentials.json')
    fs.writeFileSync(f + '.tmp', files.credentials)
    fs.renameSync(f + '.tmp', f)
  }
}

/** Capture the CURRENT global login (~/.claude.json + ~/.claude/.credentials.json)
 *  into a fresh canonical profile. Read-only on the real home. Returns the new
 *  profile, or null if there is no global login to capture. */
export function captureGlobalLogin(name?: string): AccountProfile | null {
  const homeRoot = path.dirname(sharedRoot())
  let claudeJson: string
  try { claudeJson = fs.readFileSync(path.join(homeRoot, '.claude.json'), 'utf8') } catch { return null }
  const email = (() => {
    try { return (JSON.parse(claudeJson) as { oauthAccount?: { emailAddress?: unknown } })?.oauthAccount?.emailAddress }
    catch { return undefined }
  })()
  if (typeof email !== 'string' || !email) return null
  let credentials: string | undefined
  try { credentials = fs.readFileSync(path.join(sharedRoot(), '.credentials.json'), 'utf8') } catch { credentials = undefined }

  const profile = createProfile(name)
  try {
    writeCanonicalIdentity(profile.id, { claudeJson, credentials })
    const updated: AccountProfile = { ...profile, accountEmail: email }
    upsertProfile(updated)
    return updated
  } catch {
    // capture failed mid-write: don't leave a dangling empty profile
    try { safeTeardownProfile(profile.id) } catch { /* best-effort */ }
    return null
  }
}

/** Read oauthAccount.emailAddress from a Claude identity JSON file. Never throws. */
function readEmailFromFile(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const email = (JSON.parse(raw) as { oauthAccount?: { emailAddress?: unknown } })?.oauthAccount?.emailAddress
    return typeof email === 'string' && email ? email : null
  } catch { return null }
}

/** Read the account email from the canonical .claude.json (source of truth). */
export function readCanonicalIdentityEmail(id: string): string | null {
  return readEmailFromFile(path.join(getAccountIdentityDir(id), '.claude.json'))
}

/** Reliable per-session identity: each profile has its OWN .claude.json.
 *  (The v1.5.9 alias attempt failed because it read the GLOBAL last-login.) */
export function readProfileAccountEmail(id: string): string | null {
  return readEmailFromFile(path.join(getProfileConfigDir(id), '.claude.json'))
}
