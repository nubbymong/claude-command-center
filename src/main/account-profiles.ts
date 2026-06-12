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
import { canonicaliseEmail } from '../shared/account-chip-color'
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

// ── Credential file permissions (POSIX hardening) ──────────────────────────
// `.credentials.json` holds live OAuth access/refresh tokens. Claude Code's own
// copy is 0o600; CCC re-writes/copies it into the canonical identity dir, each
// per-account home, and back to global. With the default umask (0o022) on macOS/
// Linux those copies would land 0o644 (world-readable), letting any other local
// user read the tokens. We chmod them to 0o600 (and credential dirs to 0o700).
// On Windows fs mode bits are ignored, so these are cheap no-ops there.
const IS_POSIX = process.platform !== 'win32'
const CRED_FILE_MODE = 0o600
const CRED_DIR_MODE = 0o700

/** chmod a just-written/copied credential FILE to 0o600 on POSIX (no-op on Win). */
function hardenCredentialFile(file: string): void {
  if (!IS_POSIX) return
  try { fs.chmodSync(file, CRED_FILE_MODE) } catch { /* best-effort */ }
}
/** chmod a credential-containing dir (a `.claude/`) to 0o700 on POSIX. */
function hardenCredentialDir(dir: string): void {
  if (!IS_POSIX) return
  try { fs.chmodSync(dir, CRED_DIR_MODE) } catch { /* best-effort */ }
}
/** Atomic write of a credential file with a restrictive 0o600 mode (POSIX),
 *  creating parent dirs (subsumes the old plain atomicWriteFile). */
function writeCredentialFile(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, data, IS_POSIX ? { mode: CRED_FILE_MODE } : undefined)
  fs.renameSync(tmp, file)
  hardenCredentialFile(file)   // rename preserves the tmp's mode; re-assert to be safe
}
/** copyFileSync + chmod 0o600 (copy clones the source mode only loosely). */
function copyCredentialFile(src: string, dest: string): void {
  fs.copyFileSync(src, dest)
  hardenCredentialFile(dest)
}

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

/** The captured-global "primary" account, or null if none is marked yet. */
export function getPrimaryProfileId(): string | null {
  return listProfiles().find((p) => p.isPrimary)?.id ?? null
}

/** Mark exactly one profile as primary (clears the flag on all others). */
export function setPrimaryProfile(id: string): void {
  const all = listProfiles().map((p) => ({ ...p, isPrimary: p.id === id }))
  saveProfiles(all)
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

/** Read the OAuth expiry (ms) from a credentials JSON; 0 when absent/unparseable.
 *  Used to pick the freshest live token when migrating off the per-session homes. */
function credentialExpiry(raw: string | undefined): number {
  if (!raw) return 0
  try {
    const c = JSON.parse(raw) as { claudeAiOauth?: { expiresAt?: unknown }; expiresAt?: unknown }
    const e = c.claudeAiOauth?.expiresAt ?? c.expiresAt
    return typeof e === 'number' ? e : 0
  } catch { return 0 }
}

/**
 * One-time migration OFF the per-session-home model (Bug 2). Each account's sessions
 * used to get a private COPY of its credentials under account-homes/<sessionId>/.
 * Rotating OAuth refresh tokens can't survive being copied across N homes (the first
 * session to refresh invalidates every other copy), which forced a re-auth on resume.
 * Every session of an account now shares the account's profile home instead.
 *
 * We SALVAGE the freshest live token for each account (the profile home + canonical
 * seed are typically the stale, dead seed) into the profile home + canonical, so the
 * user does not re-auth even once after upgrading. Then -- crucially -- we do NOT
 * delete the retired session homes: a long-running or later-resumed session may still
 * name an `account-homes\<sessionId>` path in its durable transcript. We strip the
 * private credential copies and re-point each home's shared dirs (projects/memory/...)
 * at the canonical store so those paths keep resolving to the same shared memory (see
 * UPGRADE GUARD below). Only ever writes under account-homes / profile dirs; never the
 * real home.
 */
export function cleanupSessionHomes(): void {
  const root = getSessionHomesRoot()
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return } // absent -> nothing to do

  const profiles = listProfiles()
  type Cand = { claudeJson: string; credentials: string | undefined; exp: number; fromSession: boolean }
  const best = new Map<string, Cand>() // profileId -> freshest candidate

  const consider = (profileId: string, dir: string, fromSession: boolean): void => {
    let claudeJson: string
    try { claudeJson = fs.readFileSync(path.join(dir, '.claude.json'), 'utf8') } catch { return }
    let credentials: string | undefined
    try { credentials = fs.readFileSync(path.join(dir, '.claude', '.credentials.json'), 'utf8') } catch { credentials = undefined }
    const exp = credentialExpiry(credentials)
    const cur = best.get(profileId)
    if (!cur || exp > cur.exp) best.set(profileId, { claudeJson, credentials, exp, fromSession })
  }

  // Seed candidates with each profile's CURRENT home so we never downgrade it.
  for (const p of profiles) consider(p.id, getProfileConfigDir(p.id), false)
  // Add the retiring session homes, matched to a profile by account email.
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const email = readEmailFromFile(path.join(root, e.name, '.claude.json'))
    if (!email) continue
    const prof = profiles.find((p) => p.accountEmail && normEmail(p.accountEmail) === normEmail(email))
    if (prof) consider(prof.id, path.join(root, e.name), true)
  }
  // Apply only when a session home was fresher than the profile home.
  for (const [profileId, cand] of best) {
    if (!cand.fromSession) continue
    writeCanonicalIdentity(profileId, { claudeJson: cand.claudeJson, credentials: cand.credentials })
    const home = getProfileConfigDir(profileId)
    try { fs.writeFileSync(path.join(home, '.claude.json'), cand.claudeJson) } catch { /* best-effort */ }
    if (cand.credentials != null) {
      try { const cd = path.join(home, '.claude'); fs.mkdirSync(cd, { recursive: true }); hardenCredentialDir(cd); writeCredentialFile(path.join(cd, '.credentials.json'), cand.credentials) } catch { /* best-effort */ }
    }
  }

  // UPGRADE GUARD -- do NOT delete the retired session homes. A session created
  // under the old per-session-home build baked the literal path
  // `account-homes\<sessionId>\.claude\projects\...\memory` into its DURABLE
  // conversation transcript. A prior build DELETED this tree on upgrade, so
  // resuming such a session afterwards pointed it at a now-missing path -- the
  // memory-divergence incident (no data was lost because the dirs were junctions
  // to the shared store, but the path looked dead). Instead we KEEP each home and
  // re-point its shared dirs (projects/memory/...) at the canonical store, after
  // stripping the now-superseded PRIVATE credential copies (salvaged above) so the
  // Bug-2 stale-token problem cannot recur. Net: any lingering account-homes path
  // resolves to the SAME shared memory a current per-account session sees, so
  // resuming or switching an account across an upgrade never disrupts memory.
  const shared = sharedRoot()
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const home = path.join(root, e.name)
    try {
      // Drop the private per-session identity copies (freshest token already
      // salvaged into the profile + canonical above).
      try { fs.unlinkSync(path.join(home, '.claude.json')) } catch { /* absent */ }
      const claudeDir = path.join(home, '.claude')
      try { fs.unlinkSync(path.join(claudeDir, '.credentials.json')) } catch { /* absent */ }
      // Re-point the shared dirs to canonical (self-heals a missing/old junction).
      fs.mkdirSync(claudeDir, { recursive: true })
      for (const name of SHARED_DIR_NAMES) {
        const target = path.join(shared, name)
        if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true })
        ensureLink(target, path.join(claudeDir, name))
      }
    } catch { /* best-effort: a redirect we couldn't rebuild just leaves that one old session on a stale path */ }
  }
  // NOTE: intentionally NOT removing the account-homes root -- see UPGRADE GUARD above.
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
    writeCredentialFile(path.join(dir, '.credentials.json'), files.credentials)
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
    // Also seed the per-account-home layout the spawn reads (USERPROFILE=<profileDir>):
    const home = getProfileConfigDir(profile.id)
    fs.writeFileSync(path.join(home, '.claude.json'), claudeJson)
    if (credentials != null) {
      const claudeDir = path.join(home, '.claude')
      fs.mkdirSync(claudeDir, { recursive: true })
      hardenCredentialDir(claudeDir)
      writeCredentialFile(path.join(claudeDir, '.credentials.json'), credentials)
    }
    const updated: AccountProfile = { ...profile, accountEmail: email, name: name?.trim() || '' }
    upsertProfile(updated)
    return updated
  } catch {
    // capture failed mid-write: don't leave a dangling empty profile
    try { safeTeardownProfile(profile.id) } catch { /* best-effort */ }
    return null
  }
}

/** One-time: move each profile's live-home identity into its canonical identity/.
 *  Idempotent (skips profiles already having identity/.claude.json). Profile dir
 *  files only; never touches the real home. */
export function migrateProfilesToCanonicalLayout(): void {
  for (const p of listProfiles()) {
    if (!isValidProfileId(p.id)) continue
    const idDir = getAccountIdentityDir(p.id)
    if (fs.existsSync(path.join(idDir, '.claude.json'))) continue // already migrated
    const home = getProfileConfigDir(p.id)
    let claudeJson: string | undefined
    try { claudeJson = fs.readFileSync(path.join(home, '.claude.json'), 'utf8') } catch { /* none */ }
    let credentials: string | undefined
    try { credentials = fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8') } catch { /* none */ }
    if (claudeJson || credentials) writeCanonicalIdentity(p.id, { claudeJson, credentials })
  }
}

/** A captured/completed profile left with the placeholder name "New account"
 *  should display its email instead. Clears that placeholder on profiles that
 *  have a real account email (an in-progress add-account with no email keeps it). */
export function healPlaceholderNames(): void {
  for (const p of listProfiles()) {
    if (p.accountEmail && p.name === 'New account') upsertProfile({ ...p, name: '' })
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

function normEmail(email: string): string { return email.toLowerCase().trim() }

/** Reliable per-session identity: each profile has its OWN .claude.json.
 *  (The v1.5.9 alias attempt failed because it read the GLOBAL last-login.) */
export function readProfileAccountEmail(id: string): string | null {
  return readEmailFromFile(path.join(getProfileConfigDir(id), '.claude.json'))
}

/** Restore a profile's per-account-home identity from its canonical backup.
 *  Returns false if there is no canonical backup to restore from. */
export function restoreProfileHomeFromCanonical(id: string): boolean {
  const idDir = getAccountIdentityDir(id)
  const srcJson = path.join(idDir, '.claude.json')
  if (!fs.existsSync(srcJson)) return false
  const home = getProfileConfigDir(id)
  fs.copyFileSync(srcJson, path.join(home, '.claude.json'))
  const srcCred = path.join(idDir, '.credentials.json')
  if (fs.existsSync(srcCred)) {
    const claudeDir = path.join(home, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    hardenCredentialDir(claudeDir)
    copyCredentialFile(srcCred, path.join(claudeDir, '.credentials.json'))
  }
  return true
}

/** Snapshot a profile's CURRENT per-account-home identity into its canonical
 *  backup, so it can be restored later. Best-effort; no-op if the home has no
 *  identity yet. Only reads/writes under the profile dir.
 *
 *  EMAIL-GUARDED: canonical is the recovery source of truth, so a /login that
 *  switched this shared home to a DIFFERENT account must never overwrite it. We
 *  back up only when the home identity still matches the profile's known account
 *  (a token refresh keeps the email; only an account switch changes it). A profile
 *  with no accountEmail yet is a first capture -- nothing to protect, so allow it. */
export function backupProfileHomeToCanonical(id: string): void {
  if (!isValidProfileId(id)) return
  const home = getProfileConfigDir(id)
  let claudeJson: string
  try { claudeJson = fs.readFileSync(path.join(home, '.claude.json'), 'utf8') } catch { return }
  // A null homeEmail (a .claude.json with no parseable oauthAccount -- a corrupt /
  // in-progress login) counts as "does not match", so an identity-less home can
  // never overwrite a profile that already has a known account.
  const homeEmail = readEmailFromFile(path.join(home, '.claude.json'))
  const prof = listProfiles().find((p) => p.id === id)
  if (prof?.accountEmail && canonicaliseEmail(prof.accountEmail) !== canonicaliseEmail(homeEmail ?? '')) return
  let credentials: string | undefined
  try { credentials = fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8') } catch { credentials = undefined }
  writeCanonicalIdentity(id, { claudeJson, credentials })
}

export type PrimaryCredentialSyncResult = 'none' | 'profile->global' | 'global->profile'

function readFileMaybe(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8') } catch { return undefined }
}

/**
 * Keep the user's REAL global Claude login (`~/.claude/.credentials.json`) in
 * lockstep with the PRIMARY account's profile home, so an OAuth token rotation
 * inside a CCC session never leaves an external `claude -p` on a stale, dead
 * refresh token -- and a `/login` OUTSIDE CCC is picked up by the next session.
 * (Root cause: capture COPIES the global creds into the primary profile home;
 * sessions then rotate the token there, silently invalidating the global copy.)
 *
 * Deliberately minimal + safe:
 *  - Syncs ONLY the small `.credentials.json` token file. NEVER writes the large
 *    `~/.claude.json` identity/state file (it only READS the email from it).
 *  - FRESHEST-WINS on the OAuth expiry: whichever side holds the newer token
 *    wins; we never downgrade a live token to an older one.
 *  - EMAIL-GUARDED on BOTH sides: the primary profile home AND the real global
 *    must CURRENTLY be the primary account. A `/login` to a DIFFERENT account on
 *    either side aborts the sync, so a wrong account's token can never be written
 *    across. Primary-only; no-op without a captured primary profile + email.
 *  - Atomic write; best-effort; never throws. The one-time backupRealClaudeOnce
 *    snapshot of the real `~/.claude` is the recovery net.
 *
 * Returns what it did (for logging/tests).
 */
export function syncPrimaryCredentialsWithGlobal(): PrimaryCredentialSyncResult {
  try {
    const primaryId = getPrimaryProfileId()
    if (!primaryId || !isValidProfileId(primaryId)) return 'none'
    const prof = listProfiles().find((p) => p.id === primaryId)
    if (!prof?.accountEmail) return 'none' // no known account -> cannot guard
    const want = canonicaliseEmail(prof.accountEmail)

    const home = getProfileConfigDir(primaryId)
    // Guard A: the primary profile home must STILL be the primary account. A
    // mid-session /login may have switched it -> let detection handle that, not us.
    if (canonicaliseEmail(readEmailFromFile(path.join(home, '.claude.json')) ?? '') !== want) return 'none'
    // Guard B: the real global must ALSO be the primary account. The user may have
    // logged a DIFFERENT account globally -> never cross-contaminate either store.
    if (canonicaliseEmail(readEmailFromFile(path.join(realHomeDir(), '.claude.json')) ?? '') !== want) return 'none'

    const profCredPath = path.join(home, '.claude', '.credentials.json')
    const globalCredPath = path.join(sharedRoot(), '.credentials.json')
    const profCred = readFileMaybe(profCredPath)
    const globalCred = readFileMaybe(globalCredPath)
    const profExp = credentialExpiry(profCred)
    const globalExp = credentialExpiry(globalCred)

    if (profCred != null && profExp > globalExp) {
      writeCredentialFile(globalCredPath, profCred)
      return 'profile->global'
    }
    if (globalCred != null && globalExp > profExp) {
      writeCredentialFile(profCredPath, globalCred)
      // Keep canonical in lockstep with the externally-refreshed token.
      try { writeCanonicalIdentity(primaryId, { credentials: globalCred }) } catch { /* best-effort */ }
      return 'global->profile'
    }
    return 'none'
  } catch { return 'none' }
}

/** A /login switched a session to a new account, written into the account's SHARED
 *  profile home. Capture it as a NEW named profile from that home. The caller is
 *  responsible for restoring the source profile home from canonical afterwards so
 *  the source account's other sessions recover. Returns the new profile, or null if
 *  there is nothing to capture / the profile id is invalid. */
export function captureDetectedAccount(profileId: string, name?: string): AccountProfile | null {
  if (!isValidProfileId(profileId)) return null
  const home = getProfileConfigDir(profileId)
  let claudeJson: string
  try { claudeJson = fs.readFileSync(path.join(home, '.claude.json'), 'utf8') } catch { return null }
  const email = readEmailFromFile(path.join(home, '.claude.json'))
  if (!email) return null
  let credentials: string | undefined
  try { credentials = fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8') } catch { credentials = undefined }
  const np = createProfile(name)
  try {
    writeCanonicalIdentity(np.id, { claudeJson, credentials })
    const npHome = getProfileConfigDir(np.id)
    fs.writeFileSync(path.join(npHome, '.claude.json'), claudeJson)
    if (credentials != null) {
      const cd = path.join(npHome, '.claude'); fs.mkdirSync(cd, { recursive: true })
      hardenCredentialDir(cd)
      writeCredentialFile(path.join(cd, '.credentials.json'), credentials)
    }
    const updated: AccountProfile = { ...np, accountEmail: email }
    upsertProfile(updated)
    return updated
  } catch {
    try { safeTeardownProfile(np.id) } catch { /* best-effort */ }
    return null
  }
}
