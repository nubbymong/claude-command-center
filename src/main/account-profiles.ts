// src/main/account-profiles.ts
// Per-session multi-account via per-process CLAUDE_CONFIG_DIR. Identity files
// are private per profile; projects/memory/etc are junctioned back to the shared
// ~/.claude. SAFETY: this module only ever copies into / links from the shared
// root; it never moves or recursive-deletes through a junction. All path roots
// are injectable so tests never touch the live ~/.claude. Profile metadata is
// persisted as an atomic profiles.json under the profiles root (NOT via
// config-manager) so _setRootsForTest is a total seam.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getResourcesDirectory } from './ipc/setup-handlers'
import { atomicWriteFileSync } from './atomic-write'
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

// `unknown` in, type-guard out: the id can arrive over IPC, where it is not
// necessarily a string. `RE.test(x)` would stringify a non-string first, so a
// crafted `{ toString: () => 'ok' }` used to pass. Length-capped like
// isValidNoteId so a pathological id can't be used to build a huge path.
export function isValidProfileId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && PROFILE_ID_RE.test(id)
}

let rootsOverride: { resourcesDir: string; sharedRoot: string } | null = null
/** Test seam: inject temp roots so we never touch ~/.claude. */
export function _setRootsForTest(roots: { resourcesDir: string; sharedRoot: string } | null): void { rootsOverride = roots }

function resourcesDir(): string { return rootsOverride?.resourcesDir ?? getResourcesDirectory() }
/** The shared real config root (default account). Overridable in tests ONLY. */
export function sharedRoot(): string { return rootsOverride?.sharedRoot ?? path.join(os.homedir(), '.claude') }

export function getProfilesRoot(): string { return path.join(resourcesDir(), 'account-profiles') }

// The single choke point: every profile home in the app is built here, so the
// guard lives here rather than at each of the ~20 call sites. Three resolvers
// (insights, headless/sentinel, cloud agents) previously accepted a
// caller-supplied id and gated only on existsSync, which `path.join` will
// happily walk out of the profiles root with `..` segments — and the resolved
// path is then passed to setupProfileLinks (mkdir + junction creation) and used
// as a spawned process's HOME. Guarding the join itself bans the pattern instead
// of normalising one instance of it.
//
// This throws rather than returning a sentinel because there is no in-band
// "invalid" value for a path. It is unreachable from the app's own paths: every
// caller either passes an id from listProfiles()/createProfile() (always
// `profile-<base36>-<hex>`) or validates first. A future unguarded caller gets a
// loud failure instead of a silent traversal.
export function getProfileConfigDir(id: string): string {
  if (!isValidProfileId(id)) throw new Error('invalid profile id')
  return path.join(getProfilesRoot(), id)
}

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

/**
 * Credential-writer alias for the shared atomic write (#233). The exclusive
 * create and the unguessable staging name that GHSA-pwfw-2ggq-569x turned on now
 * live in `atomic-write.ts`, so every writer in the app gets them rather than
 * only the four credential paths -- and there is one implementation to keep
 * correct instead of two that can drift apart.
 *
 * Kept as a named export because the config/hooks credential writers and
 * `usage/account-usage.ts` import it, and because the name states the intent at
 * a credential call site.
 */
export function atomicWriteSecure(file: string, data: string | Uint8Array, mode?: number): void {
  atomicWriteFileSync(file, data, mode != null ? { mode } : undefined)
}

/** chmod a just-written/copied credential FILE to 0o600 on POSIX (no-op on Win). */
export function hardenCredentialFile(file: string): void {
  if (!IS_POSIX) return
  try { fs.chmodSync(file, CRED_FILE_MODE) } catch { /* best-effort */ }
}
// ── The Windows half of the same policy ─────────────────────────────────────
// `chmod` is a no-op on Windows, so `hardenCredentialDir` used to be
// `if (!IS_POSIX) return` -- meaning that on this app's PRIMARY platform every
// directory it "hardened" simply kept whatever its parent's ACL granted. The
// resources directory is user-chosen, and an inherited ACE there reaches every
// tree below it, including ones whose integrity the app depends on rather than
// merely their secrecy (`canvas-plugin/`, whose SKILL.md is handed to every
// local agent session via `--plugin-dir`).
//
// Windows has no mode bits, so the same "owner only" policy the POSIX branch
// has enforced for releases is expressed the only way Windows can express it:
// drop inherited ACEs and grant Full Control to exactly the current user and
// SYSTEM. Measured on Windows 11 (2026-08-15); each measurement is load-bearing:
//
//   * icacls resolves EVERY principal before it applies ANY of them. A name
//     that will not resolve fails the whole invocation (exit 1332) and leaves
//     the DACL untouched -- verified directly: the inherited ACEs were still
//     present afterwards. That is why `/inheritance:r` ships in the SAME
//     invocation as its grants. The strip can never land without them, so there
//     is no window where the app locks itself out of its own data, and no need
//     for a two-step grant-then-strip.
//   * `/inheritance:r` removes INHERITED ACEs ONLY. Explicit ones survive it,
//     and `/grant:r` only replaces the principals it names -- so on a directory
//     whose broad grant is EXPLICIT rather than inherited, the strip-and-grant
//     that shipped left the broad grant exactly where it was. Measured: a dir
//     seeded with an explicit `Authenticated Users:(OI)(CI)F` still had it
//     afterwards, alongside the two ACEs we had just added. That is the whole
//     ACE this change exists to remove, so the DACL is now REPLACED, not added
//     to: every principal currently on it is `/remove`d in the same invocation,
//     ahead of the grants.
//   * Option order inside one invocation is honoured, and it is load-bearing:
//     remove-then-grant leaves exactly the two intended ACEs, while the same
//     options as grant-then-remove leave an EMPTY DACL. Both measured.
//   * A `/remove` naming a principal that is not on the DACL succeeds (it has
//     to: `/inheritance:r` runs first and may already have taken the inherited
//     ACEs the remove list was read from). `/remove` without `:g`/`:d` takes
//     deny ACEs too -- a planted deny would otherwise survive as a denial of
//     service. Both measured.
//   * A DACL can name a principal that icacls cannot resolve BACK, and that
//     fails the whole invocation (1332) rather than the one option:
//     `NT AUTHORITY\LogonSessionId_0_<n>` is in the creator token's default
//     DACL under some logon types and is un-nameable -- measured here, not
//     theorised. That is what the fallback below is for, and why it is a
//     fallback to the strip-and-grant rather than a retry removing principals
//     one at a time: a per-principal retry would leave the un-nameable one
//     behind ANYWAY, so the directory could never reach the shape the skip
//     recognises, and every later call would pay the whole sequence again. One
//     failed batch and a strip-and-grant is the cheaper end of the same
//     outcome. The grants that matter here all resolve -- `Everyone`,
//     `Authenticated Users` and `Users` are well-known SIDs -- so what survives
//     is the case that was never the exposure.
//   * ~25ms per icacls call, read or write (10 calls: 247ms read, 258ms
//     strip-and-grant, 512ms for the read+replace pair). The "~7ms" this
//     comment used to claim was wrong by 3x and mattered, because these calls
//     sit on synchronous paths: a session spawn (~4 calls) and
//     `ensureConfigDir`, which runs on every config write and so on every
//     debounced UI save.
//
// Which is why the DACL is READ first and the write is skipped when it already
// says exactly what we would write. The steady state -- every call after the
// first on a given directory -- is then ONE call, the same cost as the single
// write that shipped, and the pair is paid only when something genuinely needs
// repairing. The skip cannot mask an attacker's grant that a write would have
// removed: to hold a DACL in that shape they need WRITE_DAC, i.e. they own the
// directory, and an owner can re-grant themselves the instant any write of ours
// returns. Hardening is not a defence against the owner of the directory.
//
// Unmemoised is a DECISION, not an oversight. A path-keyed memo would be wrong
// twice over: `ensureCanvasPlugin` deletes and recreates its tree, so a
// recreated directory is back on its parent's ACL while the memo still calls it
// done -- and re-asserting on every call is the whole reason the POSIX branch
// repairs installs made by older builds. The read-first skip gets the same
// saving that a memo was tempting for, without a cache to invalidate: it asks
// the filesystem rather than remembering, so a recreated directory reads as
// unhardened and is repaired.
//   * Children need no pass of their own. Windows resolves inheritance live, so
//     existing and future subdirectories/files reflect the new DACL at once.
const IS_WINDOWS = process.platform === 'win32'
/** Absolute by intent. A step whose whole job is to REMOVE access must not be
 *  resolvable through PATH, where anything earlier on it would run instead. */
const ICACLS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe')
/** SYSTEM by SID: the account NAME is localized, the SID never is. */
const SYSTEM_SID = '*S-1-5-18'
/** Best-effort has to mean bounded -- the resources dir may be a network share. */
const ICACLS_TIMEOUT_MS = 5000
/** Characters that would change what icacls PARSES rather than merely fail to
 *  resolve: `:` and `()` are grant syntax, `,`/`;` separate entries, `/` starts
 *  an option, `*` marks a literal SID, `\` splits domain from account, and
 *  quotes/control bytes have no business in an account name. `execFileSync`
 *  passes argv with no shell, so this is not about command injection -- it is
 *  about one argument being read as a DIFFERENT grant than the intended one. */
const ACL_PRINCIPAL_BAD_RE = /[:()\\/*",;]|[\u0000-\u001F\u007F]/
function isAclPrincipalPart(s: string): boolean {
  return s.length > 0 && s.length <= 256 && !ACL_PRINCIPAL_BAD_RE.test(s)
}

/** As above, for a principal read back OUT of a DACL, where `\` and spaces are
 *  ordinary (`NT AUTHORITY\SYSTEM`) and only the control bytes are not. Written
 *  by char code so this file contains no control characters of its own. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

function currentUserName(): string {
  try { return os.userInfo().username } catch { return '' /* no identity available */ }
}

/**
 * How to spell the current user for icacls, best spelling first: `DOMAIN\user`
 * (unambiguous on a domain-joined machine), then the bare account name for when
 * the domain half will not resolve (offline domain member, renamed machine).
 *
 * EMPTY when the identity cannot be established or will not survive icacls'
 * own parsing -- and empty means NOTHING is applied, deliberately: an
 * `/inheritance:r` whose companion grant we cannot name would lock the app out
 * of its own data.
 *
 * `user`/`domain` are parameters rather than reads baked into the body so this
 * guard is exercised on every leg of the CI matrix instead of only the Windows
 * one -- the same reason `isTransientRenameError` takes `platform`.
 */
export function windowsAclPrincipals(user: string = currentUserName(), domain: string = process.env.USERDOMAIN ?? ''): string[] {
  if (!isAclPrincipalPart(user)) return []
  return isAclPrincipalPart(domain) ? [`${domain}\\${user}`, user] : [user]
}

/** The DACL entries icacls reports for `target`, one `principal:(flags)` per
 *  entry. Empty when the DACL cannot be read at all, which is a fallback
 *  signal and not an "it is empty" claim -- see `hardenDirAclWindows`.
 *
 *  icacls echoes the path on the first line, immediately followed by that
 *  line's ACE; later ACEs are indented. `:(` appears in every ACE and in
 *  neither the echoed path nor the trailing "Successfully processed" summary. */
export function windowsAclEntries(target: string): string[] {
  let out: string
  try {
    // stdout captured, stderr discarded: an unreadable directory is a normal
    // outcome here (it falls back), not something to print on every config write.
    out = execFileSync(ICACLS, [target], {
      encoding: 'utf8', windowsHide: true, timeout: ICACLS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch { return [] }
  return out
    .split(/\r?\n/)
    .map((line) => (line.startsWith(target) ? line.slice(target.length) : line).trim())
    .filter((line) => line.includes(':('))
}

/** An ACE's principal is everything ahead of its first `:(`. */
function aclEntryPrincipal(entry: string): string {
  return entry.slice(0, entry.indexOf(':('))
}

/** How many principals one invocation will name back. A DACL longer than this
 *  is not a directory this app made; bound the argv rather than grow it, and
 *  bound it by REFUSING the batch rather than truncating it -- a truncated
 *  remove list would leave whichever principals fell off the end in place while
 *  the grants below made the result look deliberate. */
const ACL_MAX_REMOVALS = 32

/**
 * `/remove <principal>` arguments for every principal on `entries`, spelled the
 * way icacls printed them -- which is the spelling it accepts back.
 *
 * Exported (with `windowsAclPrincipals`) so the parsing runs on every leg of the
 * CI matrix, not only the Windows one.
 *
 * An entry that cannot be named back SAFELY is skipped rather than failing the
 * batch: removing the other principals is still an improvement, and the caller
 * treats a partial result as a partial result. The rejects are the ones that
 * would be READ AS SOMETHING ELSE rather than merely fail to resolve -- a
 * leading `/` is an icacls option, `*` marks a literal SID, and `"` and control
 * bytes have no business in an account name. `\` and spaces are NOT rejected:
 * `NT AUTHORITY\SYSTEM` and `BUILTIN\Administrators` are the two most common
 * entries there are. A bare SID (an ACE whose account no longer resolves, which
 * icacls prints unadorned) is handed back with the `*` prefix that makes icacls
 * read it as a SID instead of a name.
 */
export function windowsAclRemovalArgs(entries: string[], ignorable?: ReadonlySet<string>): string[] {
  if (entries.length > ACL_MAX_REMOVALS) return []
  const args: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const raw = aclEntryPrincipal(entry)
    if (raw.length === 0 || raw.length > 256) continue
    if (/^[/*]/.test(raw) || raw.includes(String.fromCharCode(34)) || hasControlChar(raw)) continue
    const principal = /^S-1-[\d-]+$/.test(raw) ? `*${raw}` : raw
    if (seen.has(principal) || ignorable?.has(principal)) continue
    seen.add(principal)
    args.push('/remove', principal)
  }
  return args
}

/**
 * Whether `entries` is ALREADY the DACL this module writes: exactly two ACEs,
 * neither inherited, both Full Control with the container/object inherit flags,
 * one of them the current user. The other is SYSTEM, whose display name is
 * localized and so is matched structurally rather than by name (it is granted
 * by SID for the same reason).
 *
 * `ignorable` names principals a previous call PROVED cannot be removed on this
 * machine; entries for those do not count against the answer, which is what
 * lets a directory carrying one still settle into a state this recognises
 * instead of paying the full sequence on every call forever.
 *
 * `user` is a parameter rather than a read baked into the body so this runs on
 * every leg of the CI matrix.
 */
export function windowsAclIsOwnerOnly(entries: string[], user: string, ignorable?: ReadonlySet<string>): boolean {
  if (ignorable?.size) entries = entries.filter((e) => !ignorable.has(aclEntryPrincipal(e)))
  if (entries.length !== 2 || user.length === 0) return false
  if (!entries.every((e) => !e.includes('(I)') && e.endsWith(':(OI)(CI)(F)'))) return false
  // The printed spelling may be `DOMAIN\user` whatever spelling was granted, so
  // compare the account half.
  const account = (p: string): string => p.slice(p.lastIndexOf('\\') + 1).toLowerCase()
  return entries.map((e) => account(aclEntryPrincipal(e))).includes(user.toLowerCase())
}

function icacls(args: string[]): boolean {
  try {
    execFileSync(ICACLS, args, { stdio: 'ignore', windowsHide: true, timeout: ICACLS_TIMEOUT_MS })
    return true
  } catch { return false /* a principal did not resolve, or icacls is unavailable */ }
}

/**
 * REPLACE `dir`'s Windows DACL with the current user + SYSTEM: drop every
 * inherited ACE, remove every explicit one, grant those two. Returns whether it
 * was applied.
 *
 * Never throws. Every caller sits on a session-spawn or config-write path where
 * a permissions failure must not be fatal -- including the case where a mocked
 * or absent `child_process` makes `execFileSync` unusable.
 */
/**
 * Principals this machine's DACLs NAME but icacls cannot resolve back, learned
 * by trying. Per-process and never invalidated, which is safe because it is a
 * property of the machine and the logon session rather than of any directory:
 * a name that will not resolve now will not resolve later in the same session,
 * and a wrong entry here can only cost one un-removed principal that a removal
 * had already failed on.
 *
 * Only a SINGLE-principal removal failure adds to it. A failed BATCH proves
 * nothing about which of its principals was at fault, and memoising on that
 * would teach the app to stop removing a grant it could have removed.
 */
const unremovableAclPrincipals = new Set<string>()
const UNREMOVABLE_MEMO_MAX = 64

export function hardenDirAclWindows(dir: string): boolean {
  if (!IS_WINDOWS) return false
  const spellings = windowsAclPrincipals()
  if (spellings.length === 0) return false

  const entries = windowsAclEntries(dir)
  if (windowsAclIsOwnerOnly(entries, currentUserName(), unremovableAclPrincipals)) return true

  const removals = windowsAclRemovalArgs(entries, unremovableAclPrincipals)
  for (const principal of spellings) {
    const grants = ['/inheritance:r', '/grant:r', `${principal}:(OI)(CI)F`, `${SYSTEM_SID}:(OI)(CI)F`]

    // The replace, in one invocation: nothing is stripped unless every name in
    // it resolved, so there is no window in which the app has no access.
    if (removals.length > 0 && icacls([dir, ...removals, ...grants])) return true

    // It did not. Either this spelling of the user does not resolve -- the next
    // one is tried below -- or one of the removals does not, and the exit code
    // does not say which. Establish the app's own access FIRST, with the
    // strip-and-grant that shipped: if this fails it is the spelling, nothing
    // has been removed, and the next spelling gets its turn.
    if (!icacls([dir, ...grants])) continue
    if (removals.length === 0) return true

    // Access is granted and the grants are now PROVEN to resolve. Remove the
    // rest one at a time -- each is independent, and a failure names the
    // principal that caused it. Doing this rather than giving up on the
    // removals is the difference between an explicit `Authenticated Users`
    // being removed on such a machine and surviving.
    for (let i = 1; i < removals.length; i += 2) {
      const target = removals[i]
      if (icacls([dir, '/remove', target])) continue
      if (unremovableAclPrincipals.size < UNREMOVABLE_MEMO_MAX) unremovableAclPrincipals.add(target)
    }
    // The pass above removes the app's own entries too, so re-grant. The same
    // argv succeeded moments ago, which is why it is safe to have removed them:
    // the only window where this directory has no DACL of ours is between those
    // two calls, and it closes with a command already known to work.
    icacls([dir, ...grants])
    return true
  }
  return false
}

/** Restrict a credential-containing dir (a `.claude/`) to its owner: 0700 on
 *  POSIX, an explicit user+SYSTEM DACL on Windows. Returns whether it took, so
 *  a caller that can report the failure may; the rest ignore it exactly as
 *  before and stay best-effort. */
export function hardenCredentialDir(dir: string): boolean {
  if (!IS_POSIX) return hardenDirAclWindows(dir)
  try { fs.chmodSync(dir, CRED_DIR_MODE) } catch { /* best-effort */ return false }
  return true
}

/** The app-managed roots below which every credential/identity/backup directory
 *  is created. Segments AT or BELOW one of these must be real directories the
 *  app itself made; the user's chosen path ABOVE them (a resources dir that may
 *  legitimately sit under a symlink, the home dir) is trusted and not inspected.
 *  Returns the DEEPEST matching root so the walk in `mkdirSecure` stops as tight
 *  as possible. */
function managedTrustRoot(target: string): string {
  const rp = path.resolve(target)
  let best: string | null = null
  // The user's chosen credential roots. The resources dir may legitimately live
  // on a symlink/junction (docs invite a network drive for portability) and
  // ~/.claude is commonly a dotfile symlink -- so these anchors are trusted and
  // NOT inspected; only the app-created tree BELOW them is. realHomeDir()/
  // sharedRoot() honour the _setRootsForTest seam. Each getter is guarded: at
  // early boot the resources dir may not be configured yet, and a throw there
  // must not sink a credential write.
  for (const get of [resourcesDir, sharedRoot, realHomeDir]) {
    let root: string
    try { root = get() } catch { continue }
    const r = path.resolve(root)
    if ((rp === r || rp.startsWith(r + path.sep)) && (best === null || r.length > best.length)) best = r
  }
  return best ?? path.dirname(rp)
}

/**
 * `mkdir -p` for a directory a credential or identity file is about to be
 * written into, refusing to build it THROUGH a pre-planted reparse point.
 *
 * `atomicWriteSecure` stops a link planted at the staging FILE, but it cannot
 * see a symlink/junction planted on a DIRECTORY above it: the leaf file is still
 * created fresh with O_EXCL -- just inside the attacker's directory, where on
 * Windows it inherits the attacker dir's ACL (the 0o600 hardening is a POSIX
 * no-op). An unprivileged Windows directory *junction* is enough, and it is not
 * a race: `mkdir -p` silently accepts a pre-existing junction. So after creating
 * the tree, walk every app-managed segment from `dir` up to its trust root and
 * reject any that is a reparse point. lstat reports a junction as a symbolic
 * link on Windows (verified on this platform), so one check covers POSIX
 * symlinks and Windows junctions alike. Throwing fails closed -- the credential
 * write never happens rather than happening in attacker space.
 */
export function mkdirSecure(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const stop = managedTrustRoot(dir)
  let cur = path.resolve(dir)
  for (;;) {
    // Stop AT the trusted anchor without inspecting it: the anchor is the user's
    // own directory and may legitimately be a symlink; inspecting it would turn a
    // supported layout (resources on a network junction, symlinked ~/.claude) into
    // a permanent silent failure. Everything strictly below it is app-created and
    // must be real.
    if (cur === stop) break
    let st
    try { st = fs.lstatSync(cur) } catch { break }
    if (st.isSymbolicLink()) {
      throw new Error(`refusing to write credentials: ${cur} is a reparse point, not a real directory`)
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
}
/** Atomic write of a credential file with a restrictive 0o600 mode (POSIX),
 *  creating parent dirs (subsumes the old plain atomicWriteFile). */
function writeCredentialFile(file: string, data: string): void {
  mkdirSecure(path.dirname(file))
  atomicWriteSecure(file, data, IS_POSIX ? CRED_FILE_MODE : undefined)
  hardenCredentialFile(file)   // rename preserves the tmp's mode; re-assert to be safe
}
/** Copy a credential file to `dest` SAFELY. Plain copyFileSync opens the
 *  destination THROUGH a link planted there and writes the token into it
 *  (COPYFILE_EXCL is not set), and the follow-up chmod then hardens the
 *  attacker's file -- the exact write-through this module exists to stop, one
 *  copy away from writeCredentialFile. Route the bytes through the same
 *  exclusive-create staging instead, then re-assert 0o600. Exported for tests. */
export function copyCredentialFile(src: string, dest: string): void {
  mkdirSecure(path.dirname(dest))
  atomicWriteSecure(dest, fs.readFileSync(src), IS_POSIX ? CRED_FILE_MODE : undefined)
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
  atomicWriteSecure(file, JSON.stringify({ profiles } satisfies AccountProfilesConfig, null, 2))
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

/**
 * Resolve the home dir for a HEADLESS claude spawn (Sentinel analysis, insights):
 * preferred profile (when its dir exists) → captured primary → first signed-in
 * profile (else first profile whose dir exists) → null (bare global, single-
 * account installs only). Under capture-all the bare global login is frozen at
 * capture time and never refreshes, so headless runs against it hang at auth /
 * hit stale rate-limit state — hence "never bare-global when profiles exist",
 * the same rule PTY spawns follow. Picking a per-account home when no primary is
 * set is what keeps Sentinel from hanging on a fresh multi-account install where
 * the user never marked a primary. Refreshes the profile's shared links before
 * returning, like the PTY/cloud-agent paths.
 */
export function resolveHeadlessProfileHome(preferredProfileId?: string | null): {
  home: string | null
  profileId: string | null
} {
  // Validate before the join: an invalid id reports "no home", so a crafted
  // preferredProfileId takes the existing fall-back-to-primary branch instead of
  // reaching getProfileConfigDir's throw.
  const homeExists = (pid: string): boolean => isValidProfileId(pid) && fs.existsSync(getProfileConfigDir(pid))
  let id: string | null = null
  if (preferredProfileId && homeExists(preferredProfileId)) {
    id = preferredProfileId
  } else {
    const primary = getPrimaryProfileId()
    if (primary && homeExists(primary)) {
      id = primary
    } else {
      // No chosen/primary account: never fall through to the frozen bare global
      // login when profiles exist. Prefer a signed-in profile (has accountEmail,
      // so it can actually authenticate headlessly), else the first profile that
      // still has a home on disk.
      const existing = listProfiles().filter((p) => homeExists(p.id))
      id = (existing.find((p) => p.accountEmail) ?? existing[0])?.id ?? null
    }
  }
  if (!id) return { home: null, profileId: null }
  try { setupProfileLinks(id) } catch { /* stale links are non-fatal; spawn proceeds */ }
  return { home: getProfileConfigDir(id), profileId: id }
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
    // No auto-name: an account is identified by its email once /login resolves
    // it; the friendly name stays blank until the user sets one (user request
    // 2026-07-03 — don't default to "New account").
    name: trimmed ? trimmed.slice(0, 120) : '',
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

/**
 * Union-move the contents of an orphaned REAL dir (inside a fake home) into the
 * app-shared target so nothing is orphaned; the caller then replaces the drained
 * dir with a junction. Reads only from `src` (a fake home) and writes only into
 * `dest` (the shared ~/.claude store) -- NEVER the real home. On a filename
 * collision keeps the LARGER file: a session transcript only grows, so the larger
 * copy is the more complete one and conversation history is never lost.
 */
function mergeTreeInto(src: string, dest: string): void {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(src, { withFileTypes: true }) } catch { return }
  fs.mkdirSync(dest, { recursive: true })
  for (const e of entries) {
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    let st: fs.Stats
    try { st = fs.lstatSync(s) } catch { continue }
    if (st.isSymbolicLink()) continue          // never chase a link out of the fake home
    if (st.isDirectory()) { mergeTreeInto(s, d); continue }
    try {
      let dstat: fs.Stats | null = null
      try { dstat = fs.statSync(d) } catch { /* absent */ }
      if (!dstat) {
        try { fs.renameSync(s, d) }             // fast move (same volume)
        catch { fs.copyFileSync(s, d); fs.rmSync(s, { force: true }) } // cross-volume
      } else if (st.size > dstat.size) {
        fs.rmSync(d, { force: true })
        try { fs.renameSync(s, d) } catch { fs.copyFileSync(s, d); fs.rmSync(s, { force: true }) }
      } else {
        fs.rmSync(s, { force: true })           // dest is >= complete; drop the dominated dup
      }
    } catch { /* leave un-drained; removeTreeIfDrained preserves it and skips junctioning */ }
  }
}

/**
 * Remove `dir` (a drained fake-home dir) bottom-up. Returns true only if the whole
 * tree was empty/removed; if any file survived the merge (e.g. a cross-volume copy
 * failed), it is LEFT in place and false is returned so the caller does NOT junction
 * over it -- preserving data beats establishing the junction (retried next spawn).
 */
function removeTreeIfDrained(dir: string): boolean {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return true }
  let drained = true
  for (const e of entries) {
    const full = path.join(dir, e.name)
    let st: fs.Stats
    try { st = fs.lstatSync(full) } catch { drained = false; continue }
    if (st.isDirectory() && !st.isSymbolicLink()) {
      if (!removeTreeIfDrained(full)) drained = false
    } else {
      drained = false                           // a leftover file/link -> preserve, not drained
    }
  }
  if (drained) { try { fs.rmdirSync(dir) } catch { drained = false } }
  return drained
}

/**
 * Point `link` at `target` as a junction/symlink. `link` is ALWAYS inside a fake
 * home; we only replace our own link there, never the target.
 *
 * `mergeOrphans` (used for the shared `projects` store): if `link` is a pre-existing
 * REAL directory -- e.g. Claude wrote transcripts there before the junction was ever
 * established, orphaning them from every other account (#131) -- union-merge its
 * contents into the shared `target` first, then junction. A non-empty real dir would
 * otherwise block symlinkSync (EEXIST) forever, and those sessions would never be
 * discoverable cross-account. If the dir can't be fully drained, we skip junctioning
 * this pass rather than lose data.
 */
function ensureLink(target: string, link: string, mergeOrphans = false): void {
  // Replace any existing entry at `link` (safely: never recurse a junction).
  try {
    const st = fs.lstatSync(link)
    if (st.isSymbolicLink()) { try { fs.rmdirSync(link) } catch { fs.unlinkSync(link) } }
    else if (st.isDirectory()) {
      if (mergeOrphans) {
        mergeTreeInto(link, target)
        if (!removeTreeIfDrained(link)) return  // couldn't drain -> preserve data, don't junction
      } else {
        fs.rmdirSync(link) // only if empty; a real dir we created
      }
    }
    else fs.unlinkSync(link)
  // NOTE (non-merge path): a pre-existing REAL non-empty dir at `link` throws ENOTEMPTY
  // here (swallowed) then EEXIST at symlinkSync. That is safe (rmdirSync never deletes
  // non-empty dirs). The `projects` junction passes mergeOrphans=true to recover instead.
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
  // 0700 (POSIX): it holds .credentials.json + the settings copy; the umask
  // default (0755) left the credential filenames enumerable by other local users.
  hardenCredentialDir(claudeDir)
  const shared = sharedRoot()
  for (const name of SHARED_DIR_NAMES) {
    const target = path.join(shared, name)
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true })
    // `projects` (session transcripts, uuid filenames -> union-safe) recovers an
    // orphaned real dir into the shared store before junctioning (#131). Other
    // shared dirs keep the plain replace-if-empty behavior: `memory` has a curated
    // MEMORY.md index that is NOT union-safe, and the rest are synced config.
    ensureLink(target, path.join(claudeDir, name), name === 'projects')
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
  // The per-account fake HOME holds the token-bearing .claude.json; keep it
  // owner-only (POSIX) rather than the 0755 umask default.
  hardenCredentialDir(home)
  buildHomeLinks(home)
}

/**
 * Startup repair (#131): recover sessions orphaned in a profile's REAL
 * `.claude/projects` dir (a junction that never established) by merging them into
 * the shared store and junctioning, for EVERY profile -- so orphans are visible
 * cross-account at launch, not only when that account is next spawned. Idempotent
 * and best-effort: an already-junctioned profile is skipped; a per-profile failure
 * never aborts the sweep. Only ever touches a profile's own `.claude/projects` and
 * the shared store.
 */
export function repairSharedProjectJunctions(): void {
  const shared = path.join(sharedRoot(), 'projects')
  for (const p of listProfiles()) {
    if (!isValidProfileId(p.id)) continue
    const link = path.join(getProfileConfigDir(p.id), '.claude', 'projects')
    let st: fs.Stats
    try { st = fs.lstatSync(link) } catch { continue }   // absent -> nothing to repair
    if (st.isSymbolicLink() || !st.isDirectory()) continue // already a junction (or a file)
    try {
      fs.mkdirSync(shared, { recursive: true })
      ensureLink(shared, link, true)                     // merge orphaned transcripts -> junction
    } catch { /* best-effort; retried next launch/spawn */ }
  }
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
    // Per-item: a reparse-point plant (or any fs error) on ONE profile's dir must
    // not abort salvaging the others, nor the shared-dir repair pass further down.
    try { writeCanonicalIdentity(profileId, { claudeJson: cand.claudeJson, credentials: cand.credentials }) } catch { /* best-effort */ }
    const home = getProfileConfigDir(profileId)
    // Token-bearing .claude.json — owner-only atomic write, not a bare 0644 one.
    try { atomicWriteSecure(path.join(home, '.claude.json'), cand.claudeJson, IS_POSIX ? CRED_FILE_MODE : undefined) } catch { /* best-effort */ }
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
  // mkdirSecure, not a bare mkdir: this directory holds .credentials.json, and a
  // symlink/junction pre-planted on it (or an ancestor) would redirect that
  // write into attacker space before the leaf-file O_EXCL guard ever applied.
  mkdirSecure(dir)
  // It was also being created at the umask default (0755 observed), leaving the
  // credential filenames enumerable by any other local user even though their
  // contents are 0600.
  hardenCredentialDir(dir)
  if (files.claudeJson != null) {
    const f = path.join(dir, '.claude.json')
    // .claude.json carries the account's OAuth token; write it owner-only, not at
    // the umask default (0644 observed) which left the token world-readable even
    // though the containing dir is 0700.
    atomicWriteSecure(f, files.claudeJson, IS_POSIX ? CRED_FILE_MODE : undefined)
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
    // Per-item: one profile throwing must not halt migration of the rest.
    if (claudeJson || credentials) {
      try { writeCanonicalIdentity(p.id, { claudeJson, credentials }) } catch { /* best-effort */ }
    }
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
  // Read side: if the identity dir is a reparse point, readFileSync below would
  // follow it and restore an ATTACKER-chosen token into the live home (account
  // fixation). The dir is always app-created (writeCanonicalIdentity), so a link
  // here is a plant, not a legitimate layout — refuse.
  try {
    if (fs.lstatSync(idDir).isSymbolicLink()) throw new Error(`refusing restore: ${idDir} is a reparse point`)
  } catch (e) {
    if (e instanceof Error && e.message.includes('reparse point')) throw e
    return false // idDir absent -> nothing to restore
  }
  const srcJson = path.join(idDir, '.claude.json')
  if (!fs.existsSync(srcJson)) return false
  const home = getProfileConfigDir(id)
  // .claude.json can carry OAuth tokens, so restore it through the same
  // link-safe path as the credential file rather than a plain copyFileSync.
  mkdirSecure(home)
  atomicWriteSecure(path.join(home, '.claude.json'), fs.readFileSync(srcJson))
  const srcCred = path.join(idDir, '.credentials.json')
  if (fs.existsSync(srcCred)) {
    const claudeDir = path.join(home, '.claude')
    mkdirSecure(claudeDir)
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
