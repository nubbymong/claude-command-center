// The managed Codex account folders (WP2 slice 3d; plan A5; design 5.4, 5.5,
// 9.3, 12, 13). A Conductor-managed Codex account signs in, runs and keeps its
// history in its own CODEX_HOME, `<resources>/codex-realms/<realmId>`. This
// module resolves the roots those homes derive from, creates a home before
// any sign-in, and removes the home of an abandoned setup -- and nothing else.
//
// Rules, whoever the caller is:
// - Canonical roots. The resources directory is canonicalised
//   (realpathSync.native) before any home is derived from it: on a mapped or
//   SUBST drive realpath answers the UNC or the underlying path, and the CLI
//   and the sign-in lock see that one. The external default home (the
//   CODEX_HOME the app inherited, else ~/.codex) is canonicalised too.
// - No overlap. The external home may not be, contain or sit inside the
//   managed root or any managed home -- judged on the canonical paths AND on
//   file identity (device + inode) along both ancestor chains, because no
//   string comparison sees an 8.3 short name, `\\localhost\C$` or a link.
//   While they overlap every Codex realm is unavailable, managed ones included:
//   one folder may never be two accounts' CODEX_HOME. A CODEX_HOME the app
//   cannot check (relative, ambiguous, unresolvable) counts as overlapping,
//   and prepare looks again once the folders it made exist.
// - Real folders only. The managed root and every home are real directories
//   at their own canonical paths, directly below the canonical resources
//   directory; a link, junction or other reparse point anywhere there is
//   refused (mkdirSecure's walk, then lstat and realpath here). POSIX: both are
//   owner-only (0700), and a folder that cannot be made so is refused.
//   Windows ACL hardening is deliberately NOT applied: the shared ACL
//   primitive has an open, unexplained empty-DACL failure (aicc_planning
//   #103), so these folders inherit the resources directory's ACL like the
//   registry does.
// - Contained removal. Only the home of a setup still `pending` is removed,
//   never an external home. Before anything is deleted the target is proved to
//   be a real directory whose canonical path is `<canonical root>/<realmId>`
//   and whose parent has the managed root's file identity; the whole tree is
//   then walked with lstat and the removal is refused -- nothing deleted -- if
//   it holds a link, a junction, a special file, another volume, an entry not
//   at its own canonical path, or more than a bounded depth or count. Each
//   entry, and its folder, is re-checked just before it goes. A folder still
//   holding a stored sign-in (auth.json) is refused: that is signed out
//   through the CLI, never deleted.
// - Never while in use. Removal takes the realm lock that sign-in and sign-out
//   hold, keyed on the folder's file identity, and only while no status run
//   reads the folder; it then reads the registry again under it (bounded),
//   and again between batches of a long removal: a folder whose setup is no
//   longer pending stops it (the accounts service also marks a setup as being
//   discarded, on disk, before it removes anything, and nothing completes
//   such a setup). A prepare that has to take a folder back after an await
//   does so only under the same lock, and only the folder it made.
// - Never holding the main process. The walks that can be long (a removal, a
//   history copy) go through the asynchronous port, a batch at a time, and
//   let the event loop run between batches.
// - Nothing throws; every odd port answer fails closed with a code.
import path from 'node:path'
import type { AuthRealm, RealmLifecycle } from '../../../shared/providers'
import type { ProviderRealmFolderOperations, RealmFolderResult, RealmFolderFailureCode, RealmRef } from '../core'
import { codexRealmHome, codexExternalHomeCandidate, codexHomesOverlap, isFullyQualifiedPath, CODEX_REALMS_DIRNAME } from './realm-paths'
import type { CodexRealmRoots } from './realm-paths'

/** One directory entry as lstat sees it: the entry itself, never a link's target. */
export interface CodexFsEntry {
  kind: 'file' | 'dir' | 'link' | 'other'
  /** Device and file id as decimal strings (NTFS file ids exceed 2^53). */
  dev: string
  ino: string
  /** Permission bits; only read on POSIX. */
  mode: number
  /** How many names the file has (hard links), where the file system says. */
  nlink?: number
}

/** The same file system without blocking the main process, for the walks
 *  that can be long. Each call rejects as its twin in CodexRealmFsPort
 *  throws. */
export interface CodexRealmFsAsync {
  realpath(p: string): Promise<string>
  lstat(p: string): Promise<CodexFsEntry>
  readdir(dir: string): Promise<string[]>
  mkdir(dir: string, mode: number): Promise<void>
  chmod(p: string, mode: number): Promise<void>
  unlink(p: string): Promise<void>
  rmdir(p: string): Promise<void>
  /** A second name for the file `src` (a hard link); EEXIST when anything is
   *  already at `dest`. */
  link(src: string, dest: string): Promise<void>
  /** Exactly one new file, a byte copy of `src` (a regular file); EEXIST
   *  when anything is already at `dest`. */
  copyFile(src: string, dest: string): Promise<void>
}

/** The filesystem as this module uses it. Each call throws a Node-style
 *  error (with `code`) on failure. */
export interface CodexRealmFsPort {
  readonly platform: NodeJS.Platform
  /** The canonical path (realpathSync.native). */
  realpath(p: string): string
  lstat(p: string): CodexFsEntry
  /** `mkdir -p` that refuses to build through a pre-planted link: the app's
   *  mkdirSecure, injected by the composition root. */
  mkdirSecure(dir: string): void
  /** Exactly one new directory, created with this mode; EEXIST when anything
   *  is already there. */
  mkdir(dir: string, mode: number): void
  chmod(p: string, mode: number): void
  readdir(dir: string): string[]
  unlink(p: string): void
  rmdir(p: string): void
  /** The asynchronous twin. Absent: a removal runs the calls above, one at
   *  a time between yields, and history is not copied. */
  promises?: CodexRealmFsAsync
}

/** The realm locks sign-in, sign-out and folder removal share. */
export interface CodexRealmLocks {
  /** Sign-in and sign-out: one at a time per realm, and never during a
   *  removal. Null when it is held. Call the result to release it. */
  hold(key: string): (() => void) | null
  /** Status: any number at once, beside a sign-in, but never during a
   *  removal (the CLI writes into its home before it parses its arguments). */
  holdReader(key: string): (() => void) | null
  /** Removal: the `hold` lock, and only while no status run is reading. */
  holdRemoval(key: string): (() => void) | null
}

export function createCodexRealmLocks(): CodexRealmLocks {
  const held = new Set<string>()
  const removing = new Set<string>()
  const readers = new Map<string, number>()
  /** Idempotent: a second call releases nothing. */
  const once = (fn: () => void) => { let done = false; return () => { if (!done) { done = true; fn() } } }
  return {
    hold(key) {
      if (held.has(key)) return null
      held.add(key)
      return once(() => { held.delete(key) })
    },
    holdReader(key) {
      if (removing.has(key)) return null
      readers.set(key, (readers.get(key) ?? 0) + 1)
      return once(() => {
        const n = (readers.get(key) ?? 1) - 1
        if (n > 0) readers.set(key, n)
        else readers.delete(key)
      })
    },
    holdRemoval(key) {
      if (held.has(key) || (readers.get(key) ?? 0) > 0) return null
      held.add(key)
      removing.add(key)
      return once(() => { removing.delete(key); held.delete(key) })
    },
  }
}

/** The lock key for a realm home: its file identity where the filesystem
 *  has one (so no two spellings of one folder run at once), else its
 *  canonical path. */
export function codexRealmLockKey(canonical: string, dev: string, ino: string): string {
  const known = typeof ino === 'string' && ino !== '' && ino !== '0' && typeof dev === 'string'
  return known ? `id:${dev}:${ino}` : `path:${canonical.replace(/[\\/]+$/, '').toLowerCase()}`
}

type Env = Readonly<Record<string, string | undefined>>

export type CodexRootsResult = { ok: true; roots: CodexRealmRoots } | { ok: false; message: string }

const errCode = (e: unknown): unknown => (e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined)
const pathApiFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix)
const isPosix = (platform: NodeJS.Platform) => platform !== 'win32'
/** A file id this filesystem actually has (FAT and some network shares report 0). */
const hasIdentity = (e: CodexFsEntry) => typeof e.ino === 'string' && e.ino !== '' && e.ino !== '0' && typeof e.dev === 'string' && e.dev !== ''
const sameIdentity = (a: CodexFsEntry, b: CodexFsEntry) => hasIdentity(a) && hasIdentity(b) && a.dev === b.dev && a.ino === b.ino

function makeSamePath(platform: NodeJS.Platform) {
  const caseless = platform === 'win32' || platform === 'darwin'
  const norm = (p: string) => { const s = p.replace(/[\\/]+$/, ''); return caseless ? s.toLowerCase() : s }
  return (a: string, b: string) => typeof a === 'string' && typeof b === 'string' && norm(a) === norm(b)
}

/** The path itself and each ancestor, deepest first. */
function chain(p: string, pathApi: typeof path): string[] {
  const out: string[] = []
  let cur = p
  for (let i = 0; i < 256; i++) {
    out.push(cur)
    const up = pathApi.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return out
}

/** A path's canonical form even when its tail does not exist yet: the
 *  deepest existing ancestor canonicalised, the missing names re-appended.
 *  `absentVolume` when not even the path's root exists (an undocked drive,
 *  an offline share): nothing can be there, so nothing can overlap. Null
 *  when an ancestor fails to resolve for any reason other than absence. */
function canonicalish(p: string, fs: CodexRealmFsPort, pathApi: typeof path): { path: string; exists: boolean } | { absentVolume: true } | null {
  const tail: string[] = []
  let cur = p
  for (let i = 0; i < 256; i++) {
    try {
      const real = fs.realpath(cur)
      if (typeof real !== 'string' || !isFullyQualifiedPath(real, pathApi)) return null
      return { path: tail.length ? pathApi.join(real, ...tail.reverse()) : real, exists: tail.length === 0 }
    } catch (e) {
      const code = errCode(e)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
      const up = pathApi.dirname(cur)
      if (up === cur) return code === 'ENOENT' ? { absentVolume: true } : null
      tail.push(pathApi.basename(cur))
      cur = up
    }
  }
  return null
}

/** The identities along a canonical path's ancestor chain that the
 *  filesystem reports (missing entries skipped). */
function identities(p: string, fs: CodexRealmFsPort, pathApi: typeof path): CodexFsEntry[] {
  const out: CodexFsEntry[] = []
  for (const q of chain(p, pathApi)) {
    try {
      const e = fs.lstat(q)
      if (e && hasIdentity(e)) out.push(e)
    } catch { /* absent or unreadable: nothing to compare */ }
  }
  return out
}

/** The canonical roots every Codex realm home derives from.
 *
 *  `resourcesDir` must resolve to a real directory. The external home is the
 *  CLI's own rule (`codexExternalHomeCandidate`), canonicalised; it is null
 *  when it does not exist or overlaps the managed tree. `externalConflict` is
 *  set -- making every Codex realm unavailable until the user resolves it --
 *  when it overlaps, and also whenever the app cannot show that it does not:
 *  a CODEX_HOME that is relative or ambiguous, or one realpath cannot
 *  resolve for any reason other than a missing tail. */
export function resolveCodexRealmRoots(input: { resourcesDir: string; env: Env; homeDir: string }, fs: CodexRealmFsPort): CodexRootsResult {
  const pathApi = pathApiFor(fs.platform)
  const unavailable = { ok: false as const, message: 'the resources directory is not available' }
  try {
    if (!input || typeof input.resourcesDir !== 'string' || !isFullyQualifiedPath(input.resourcesDir, pathApi)) return unavailable
    const resourcesDir = fs.realpath(input.resourcesDir)
    if (typeof resourcesDir !== 'string' || !isFullyQualifiedPath(resourcesDir, pathApi)) return unavailable
    // Node addresses a folder named `res.` or `res ` verbatim; Win32 path
    // normalisation -- which the CLI's own file calls go through -- drops the
    // trailing dot or space and lands somewhere else. Refused, not guessed.
    if (fs.platform === 'win32' && resourcesDir.split(/[\\/]/).slice(1).some((seg) => /[. ]$/.test(seg))) return unavailable
    if (fs.lstat(resourcesDir)?.kind !== 'dir') return unavailable
    const root = pathApi.join(resourcesDir, CODEX_REALMS_DIRNAME)
    const none: CodexRootsResult = { ok: true, roots: { resourcesDir, externalDefaultHome: null } }
    const conflicted: CodexRootsResult = { ok: true, roots: { resourcesDir, externalDefaultHome: null, externalConflict: true } }

    const c = codexExternalHomeCandidate(input.env ?? {}, input.homeDir, pathApi)
    if (c.kind === 'none') return none
    if (c.kind === 'unusable') return conflicted
    const candidate = c.path
    // The spelling first, whatever canonicalisation later says.
    // (A spelling that overlaps by text but resolves elsewhere -- `..` after a
    // link on POSIX -- is refused: the app cannot tell which one a tool will use.)
    if (codexHomesOverlap(candidate, resourcesDir, pathApi)) return conflicted
    const found = canonicalish(candidate, fs, pathApi)
    if (!found) return conflicted
    // Every later lookup looks again, so a volume that appears is checked then.
    if ('absentVolume' in found) return none
    const ext = found
    let conflict = codexHomesOverlap(ext.path, resourcesDir, pathApi)
    if (!conflict) {
      let rootId: CodexFsEntry | null = null
      try { rootId = fs.lstat(root) } catch { rootId = null }
      const managedIds: CodexFsEntry[] = []
      if (rootId && rootId.kind === 'dir') {
        if (hasIdentity(rootId)) managedIds.push(rootId)
        for (const name of fs.readdir(root)) {
          try {
            const child = fs.lstat(pathApi.join(root, name))
            if (child && hasIdentity(child)) managedIds.push(child)
          } catch { /* gone meanwhile */ }
        }
      }
      // The external home -- or, when it does not exist yet, the deepest
      // folder it would be made in -- at or below the managed root or a
      // managed home (a loopback share, a bind mount) ...
      if (identities(ext.path, fs, pathApi).some((e) => managedIds.some((m) => sameIdentity(e, m)))) conflict = true
      // ... or the managed root at or below the external home.
      if (!conflict && ext.exists) {
        const extId = fs.lstat(ext.path)
        if (identities(root, fs, pathApi).some((e) => sameIdentity(e, extId))) conflict = true
      }
    }
    if (conflict) return conflicted
    return { ok: true, roots: { resourcesDir, externalDefaultHome: ext.exists ? ext.path : null } }
  } catch {
    return unavailable
  }
}

/** The realm as the registry holds it, and the canonical roots. */
export type CodexFolderLookup =
  | { ok: true; realm: Pick<AuthRealm, 'id' | 'providerId' | 'kind' | 'ownership' | 'pathRef'> & { lifecycle?: RealmLifecycle }; roots: CodexRealmRoots }
  | { ok: false }

/** The bounds the walks keep to (a test makes them small). */
export interface CodexRealmFolderLimits {
  /** Entries a removal walks (a replacement that holds carried-over history
   *  may hold `historyEntries` more). */
  removeEntries: number
  /** Entries of conversation history a sign in again carries over. */
  historyEntries: number
  /** Entries handled between two turns of the event loop. */
  batch: number
}

export interface CodexRealmFolderDeps {
  /** Asked for the `folder` use (never a realm an account moved off), and
   *  for the `history` use: an account's earlier realm, whose history
   *  entries are only compared, never changed. */
  lookupRealm(realm: RealmRef, use: 'folder' | 'history'): Promise<CodexFolderLookup>
  fs: CodexRealmFsPort
  locks: CodexRealmLocks
  limits?: Partial<CodexRealmFolderLimits>
}

/** Bounds on a tree the removal will walk: an abandoned setup's home holds a
 *  config file, logs and perhaps a session or two. */
export const CODEX_REMOVE_MAX_DEPTH = 32
export const CODEX_REMOVE_MAX_ENTRIES = 20_000
/** The conversation history a sign in again carries over: generous (Codex
 *  keeps one transcript file per session, in a folder per day). */
export const CODEX_HISTORY_MAX_ENTRIES = 200_000
/** Entries a walk handles before it lets the event loop run. */
export const CODEX_FOLDER_BATCH = 64
/** How long a removal holding the realm lock waits on the registry. */
export const CODEX_UNDER_LOCK_LOOKUP_MS = 10_000
const OWNER_ONLY = 0o700

const MSG: Readonly<Record<RealmFolderFailureCode, string>> = {
  'realm-unavailable': 'The Codex account folder could not be found in the account list.',
  'not-managed': 'This Codex account uses a folder the app does not manage, so the app never creates or removes it.',
  'lifecycle': 'This Codex account folder cannot be changed in its current state.',
  'resources-unavailable': "The app's data folder is not available.",
  'overlaps-external': "Your own Codex folder setting (CODEX_HOME, else ~/.codex) overlaps the app's Codex account folders, or cannot be checked. Set CODEX_HOME to a full path outside the app's data folder, or unset it, then try again.",
  'unsafe-path': 'The Codex account folder is a link or not where the app put it, so the app did not use it.',
  'permissions': 'The Codex account folder could not be made private to you. Move the app data folder to a disk that supports file permissions.',
  'busy': 'A sign-in or sign-out is running for this Codex account.',
  'credentials-present': 'The Codex account folder still holds a sign-in. Sign out of it first.',
  'not-empty': 'The Codex account folder is not empty, so it was kept.',
  'unsafe-contents': 'The Codex account folder holds a link, another disk or more than expected, so the app removed nothing.',
  'changed': 'The Codex account folder changed while it was being used; the app stopped.',
  'too-large': 'This Codex account has more earlier conversation files than the app carries over to a new sign-in, so nothing was changed.',
  'io-failed': 'The Codex account folder could not be created or removed.',
}

type Failure = { ok: false; code: RealmFolderFailureCode; message: string }
const fail = (code: RealmFolderFailureCode): Failure => ({ ok: false, code, message: MSG[code] })
const isFailure = (x: unknown): x is Failure => !!x && typeof x === 'object' && (x as { ok?: unknown }).ok === false
const devKnown = (e: CodexFsEntry) => typeof e.dev === 'string' && e.dev !== ''
/** Two entries the file system places on different volumes. */
const otherVolume = (a: CodexFsEntry, b: CodexFsEntry) => devKnown(a) && devKnown(b) && a.dev !== b.dev
/** The file the CLI keeps a file-stored sign-in in (design 5.5). */
const CODEX_AUTH_FILE = 'auth.json'

/** A limit a caller supplied, when it is a sane one. */
const limitOr = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : dflt)

/** The synchronous port behind the asynchronous shape: each call alone, so
 *  the walk still yields between batches. No link, no copy. */
function viaSync(fs: CodexRealmFsPort): CodexRealmFsAsync {
  const none = async (): Promise<void> => { throw Object.assign(new Error('ENOSYS'), { code: 'ENOSYS' }) }
  return {
    realpath: async (p) => fs.realpath(p),
    lstat: async (p) => fs.lstat(p),
    readdir: async (dir) => fs.readdir(dir),
    mkdir: async (dir, mode) => fs.mkdir(dir, mode),
    chmod: async (p, mode) => fs.chmod(p, mode),
    unlink: async (p) => fs.unlink(p),
    rmdir: async (p) => fs.rmdir(p),
    link: none,
    copyFile: none,
  }
}

/** One turn of the event loop: timers, I/O and IPC run before the walk goes on. */
const nextTurn = () => new Promise<void>((resolve) => { setImmediate(resolve) })

export function createCodexRealmFolders(deps: CodexRealmFolderDeps): ProviderRealmFolderOperations {
  const fs = deps.fs
  const platform = fs.platform
  const pathApi = pathApiFor(platform)
  const samePath = makeSamePath(platform)
  const limits: CodexRealmFolderLimits = {
    removeEntries: limitOr(deps.limits?.removeEntries, CODEX_REMOVE_MAX_ENTRIES),
    historyEntries: limitOr(deps.limits?.historyEntries, CODEX_HISTORY_MAX_ENTRIES),
    batch: limitOr(deps.limits?.batch, CODEX_FOLDER_BATCH),
  }
  const afs: CodexRealmFsAsync = fs.promises ?? viaSync(fs)
  /** Counts entries handled and lets the event loop run once a batch is done. */
  const pacer = () => { let n = 0; return async () => { if (++n % limits.batch === 0) { await nextTurn(); return true } return false } }

  interface Located { home: string; root: string; resourcesDir: string }

  /** The record behind the reference, checked; the home it derives. */
  async function locate(ref: RealmRef, allowed: readonly RealmLifecycle[], use: 'folder' | 'history' = 'folder'): Promise<Located | Failure> {
    let found: CodexFolderLookup
    try {
      const id = ref && typeof ref === 'object' ? (ref as { authRealmId?: unknown }).authRealmId : undefined
      if (typeof id !== 'string' || !id) return fail('realm-unavailable')
      found = await deps.lookupRealm({ authRealmId: id }, use)
      if (!found || found.ok !== true || !found.realm || found.realm.id !== id || !found.roots) return fail('realm-unavailable')
    } catch {
      return fail('realm-unavailable')
    }
    const { realm, roots } = found
    if (realm.providerId !== 'codex' || realm.kind !== 'codex-home') return fail('realm-unavailable')
    // The overlap first: it makes every Codex realm unusable, and says why.
    if (roots.externalConflict === true) return fail('overlaps-external')
    if (realm.ownership !== 'conductor-managed') return fail('not-managed')
    if (!realm.lifecycle || !allowed.includes(realm.lifecycle)) return fail('lifecycle')
    const where = codexRealmHome(realm, roots, pathApi)
    if (!where.ok) return fail('realm-unavailable')
    const root = pathApi.dirname(where.home)
    // The roots were canonical when resolved; they must still be.
    try {
      if (!samePath(fs.realpath(roots.resourcesDir), roots.resourcesDir)) return fail('unsafe-path')
    } catch {
      return fail('resources-unavailable')
    }
    return { home: where.home, root, resourcesDir: roots.resourcesDir }
  }

  /** A real directory at its own canonical path. */
  function checkDir(dir: string): CodexFsEntry | Failure {
    let e: CodexFsEntry
    try { e = fs.lstat(dir) } catch { return fail('io-failed') }
    if (!e || e.kind !== 'dir') return fail('unsafe-path')
    let real: string
    try { real = fs.realpath(dir) } catch { return fail('io-failed') }
    if (!samePath(real, dir)) return fail('unsafe-path')
    return e
  }

  /** POSIX: owner-only, verified. Windows: nothing (ACL hardening deferred, #103). */
  function makePrivate(dir: string): Failure | null {
    if (!isPosix(platform)) return null
    try { fs.chmod(dir, OWNER_ONLY) } catch { return fail('permissions') }
    let e: CodexFsEntry
    try { e = fs.lstat(dir) } catch { return fail('io-failed') }
    return e && e.kind === 'dir' && typeof e.mode === 'number' && (e.mode & 0o077) === 0 ? null : fail('permissions')
  }

  /** Absent is not a failure; anything else odd is. */
  function isAbsent(p: string): boolean | Failure {
    try { fs.lstat(p); return false } catch (e) { return errCode(e) === 'ENOENT' ? true : fail('io-failed') }
  }

  /** The managed root, real and private. Created when absent. */
  function ensureRoot(root: string): { entry: CodexFsEntry; created: boolean } | Failure {
    const absent = isAbsent(root)
    if (isFailure(absent)) return absent
    try { fs.mkdirSecure(root) } catch {
      try { if (fs.lstat(root).kind === 'link') return fail('unsafe-path') } catch { /* absent */ }
      return fail('io-failed')
    }
    const undoRoot = (f: Failure): Failure => { if (absent) { try { fs.rmdir(root) } catch { /* not empty: left */ } } return f }
    const e = checkDir(root)
    if (isFailure(e)) return undoRoot(e)
    const priv = makePrivate(root)
    return priv ? undoRoot(priv) : { entry: e, created: absent }
  }

  /** The home exactly one level below the root, by path, by identity and on
   *  the root's volume. */
  function checkHome(home: string, rootId: CodexFsEntry): CodexFsEntry | Failure {
    const e = checkDir(home)
    if (isFailure(e)) return e
    let parent: CodexFsEntry
    try { parent = fs.lstat(pathApi.dirname(home)) } catch { return fail('io-failed') }
    if (hasIdentity(rootId) && !sameIdentity(parent, rootId)) return fail('unsafe-path')
    // Another volume mounted AT the home (POSIX; on Windows a mount point is
    // a reparse point, which the canonical-path check already refuses).
    if (otherVolume(e, parent)) return fail('unsafe-path')
    return e
  }

  function prepare(ref: RealmRef): Promise<RealmFolderResult> {
    return guard(async () => {
      const at = await locate(ref, ['pending'])
      if (isFailure(at)) return at
      const root = ensureRoot(at.root)
      if (isFailure(root)) return root
      const absent = isAbsent(at.home)
      if (isFailure(absent)) return absent
      let created = false
      const undo = (f: Failure): Failure => {
        // Only folders this call just made, and only while they are empty
        // (rmdir removes nothing else).
        if (created) { try { fs.rmdir(at.home) } catch { /* left for the next attempt */ } }
        if (root.created) { try { fs.rmdir(at.root) } catch { /* another realm's folder is in it */ } }
        return f
      }
      if (absent) {
        try { fs.mkdir(at.home, OWNER_ONLY) } catch { return undo(fail('io-failed')) }
        created = true
      }
      // mkdirSecure's walk re-checks every segment below the anchor.
      try { fs.mkdirSecure(at.home) } catch { return undo(fail('unsafe-path')) }
      const homeId = checkHome(at.home, root.entry)
      if (isFailure(homeId)) return undo(homeId)
      const priv = makePrivate(at.home)
      if (priv) return undo(priv)
      // The external home once more, now the folders exist: an alias of a
      // folder that did not exist a moment ago shows only by identity once it
      // does.
      const again = await locate(ref, ['pending'])
      if (isFailure(again) || !samePath(again.home, at.home)) {
        // After an await, a sign-in may have started in the folder this call
        // made, or the folder may have been removed and made again by
        // another call: take it back only when it is still the one made
        // here and nothing holds it. Otherwise it stays, empty, for the next
        // attempt.
        const failure = isFailure(again) ? again : fail('changed')
        let release: (() => void) | null = null
        try {
          if (created && unchanged(at.home, homeId)) release = deps.locks.holdRemoval(codexRealmLockKey(fs.realpath(at.home), homeId.dev, homeId.ino))
        } catch { release = null }
        if (!release) return failure
        try { return undo(failure) } finally { release() }
      }
      return { ok: true, created }
    })
  }

  /** An entry, and the folder it was found in as it was then. */
  interface Planned { p: string; e: CodexFsEntry; parent: CodexFsEntry }

  /** How far a walk may go: at most `max` entries (else `over`), letting
   *  the event loop run every batch. */
  interface WalkBound { max: number; over: Failure; pace: () => Promise<boolean> }

  /** Every entry below `dir`, children before their directory; a failure
   *  when the tree is not plainly files and folders on one volume, each at
   *  its own canonical path, or is deeper or larger than the bound. */
  async function walk(dir: string, dirEntry: CodexFsEntry, depth: number, out: Planned[], bound: WalkBound): Promise<Failure | null> {
    if (depth > CODEX_REMOVE_MAX_DEPTH) return fail('unsafe-contents')
    let names: string[]
    try { names = await afs.readdir(dir) } catch { return fail('io-failed') }
    if (!Array.isArray(names)) return fail('io-failed')
    for (const name of names) {
      if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\0]/.test(name)) return fail('unsafe-contents')
      const p = pathApi.join(dir, name)
      let e: CodexFsEntry
      try { e = await afs.lstat(p) } catch { return fail('io-failed') }
      if (!e || (e.kind !== 'file' && e.kind !== 'dir')) return fail('unsafe-contents')
      if (otherVolume(e, dirEntry)) return fail('unsafe-contents')
      // A reparse point lstat does not report as a link (a junction to a
      // volume-GUID path) resolves somewhere else.
      if (!(await canonicalNow(p))) return fail('unsafe-contents')
      if (out.length >= bound.max) return bound.over
      if (e.kind === 'dir') {
        const below = await walk(p, e, depth + 1, out, bound)
        if (below) return below
      }
      out.push({ p, e, parent: dirEntry })
      await bound.pace()
    }
    return null
  }

  /** The path is (still) its own canonical path: no link or junction on the way. */
  async function canonicalNow(p: string): Promise<boolean> {
    try { return samePath(await afs.realpath(p), p) } catch { return false }
  }

  /** The entry is still the one seen (its kind and file id); as it is now. */
  async function unchangedNow(p: string, was: CodexFsEntry): Promise<CodexFsEntry | null> {
    let now: CodexFsEntry
    try { now = await afs.lstat(p) } catch { return null }
    if (!now || now.kind !== was.kind) return null
    return !hasIdentity(was) || sameIdentity(now, was) ? now : null
  }

  /** The entry, and the folder it is in, as planned: still at its own
   *  canonical path (no folder on the way was swapped for a link since
   *  planning, file ids or not) and still the one planned. */
  async function asPlanned({ p, e, parent }: Planned): Promise<CodexFsEntry | null> {
    const dir = pathApi.dirname(p)
    if (!(await canonicalNow(dir)) || !(await unchangedNow(dir, parent))) return null
    return unchangedNow(p, e)
  }

  async function removeFileNow(p: string): Promise<boolean> {
    try { await afs.unlink(p); return true } catch (e) {
      // Windows refuses to delete a read-only file.
      if (platform !== 'win32' || (errCode(e) !== 'EPERM' && errCode(e) !== 'EACCES')) return false
      try { await afs.chmod(p, 0o666); await afs.unlink(p); return true } catch { return false }
    }
  }

  function unchanged(p: string, was: CodexFsEntry): boolean {
    let now: CodexFsEntry
    try { now = fs.lstat(p) } catch { return false }
    if (!now || now.kind !== was.kind) return false
    return !hasIdentity(was) || sameIdentity(now, was)
  }

  /** A sign-in the CLI stored in the folder (anything there, or no answer). */
  function credentialsPresent(home: string): boolean {
    const absent = isAbsent(pathApi.join(home, CODEX_AUTH_FILE))
    return absent !== true
  }

  /** The home as it stands: absent, or real, contained and its identity. */
  function inspect(at: Located): 'absent' | { home: CodexFsEntry; canonical: string } | Failure {
    let homeEntry: CodexFsEntry
    try { homeEntry = fs.lstat(at.home) } catch (e) {
      return errCode(e) === 'ENOENT' ? 'absent' : fail('io-failed')
    }
    if (!homeEntry || homeEntry.kind !== 'dir') return fail('unsafe-path')
    const rootId = checkDir(at.root)
    if (isFailure(rootId)) return rootId
    const homeId = checkHome(at.home, rootId)
    if (isFailure(homeId)) return homeId
    let canonical: string
    try { canonical = fs.realpath(at.home) } catch { return fail('io-failed') }
    return { home: homeId, canonical }
  }

  function remove(ref: RealmRef, opts?: { contents?: 'empty-only' | 'all'; holdsHistory?: boolean }): Promise<RealmFolderResult> {
    return guard(async () => {
      const contents = opts && typeof opts === 'object' ? opts.contents : undefined
      if (contents !== 'empty-only' && contents !== 'all') return fail('io-failed')
      // A sign in again's replacement may hold the history carried over into
      // it: the removal's own bound is not what stops its Discard.
      const max = limits.removeEntries + (opts?.holdsHistory === true ? limits.historyEntries : 0)
      const at = await locate(ref, ['pending'])
      if (isFailure(at)) return at
      const first = inspect(at)
      if (first === 'absent') return { ok: true, removed: false }
      if (isFailure(first)) return first
      const release = deps.locks.holdRemoval(codexRealmLockKey(first.canonical, first.home.dev, first.home.ino))
      if (!release) return fail('busy')
      try {
        // Under the lock, the registry again: a sign-in that finished while
        // the first lookup was in flight may have been committed since.
        // Bounded: a registry answer that never comes must not hold the realm.
        const still = () => bounded(locate(ref, ['pending']), CODEX_UNDER_LOCK_LOOKUP_MS, fail('io-failed'))
        const now = await still()
        if (isFailure(now)) return now
        if (!samePath(now.home, at.home)) return fail('changed')
        const second = inspect(now)
        if (second === 'absent') return { ok: true, removed: false }
        if (isFailure(second)) return second
        const homeId = second.home
        if (hasIdentity(first.home) && !sameIdentity(first.home, homeId)) return fail('changed')
        // A sign-in is removed by signing out through the CLI, never by deleting its file.
        if (credentialsPresent(now.home)) return fail('credentials-present')
        if (contents === 'all') {
          const planned: Planned[] = []
          const refused = await walk(now.home, homeId, 1, planned, { max, over: fail('unsafe-contents'), pace: pacer() })
          if (refused) return refused
          // The walk awaited: the registry once more before anything goes,
          // and after each batch. A folder whose setup is no longer pending
          // (or no longer this folder) stops the removal there.
          const settled = await still()
          if (isFailure(settled)) return settled
          if (!samePath(settled.home, now.home)) return fail('changed')
          const pace = pacer()
          for (const entry of planned) {
            if (!(await asPlanned(entry))) return fail('changed')
            let gone: boolean
            if (entry.e.kind === 'dir') {
              try { await afs.rmdir(entry.p); gone = true } catch { gone = false }
            } else {
              gone = await removeFileNow(entry.p)
            }
            if (!gone) return fail('io-failed')
            if (await pace()) {
              const again = await still()
              if (isFailure(again)) return again
              if (!samePath(again.home, now.home)) return fail('changed')
            }
          }
        } else {
          let names: string[]
          try { names = fs.readdir(now.home) } catch { return fail('io-failed') }
          if (!Array.isArray(names) || names.length) return fail('not-empty')
        }
        if (!unchanged(now.home, homeId)) return fail('changed')
        try { fs.rmdir(now.home) } catch (e) {
          return errCode(e) === 'ENOTEMPTY' || errCode(e) === 'EEXIST' ? fail('not-empty') : fail('io-failed')
        }
        return { ok: true, removed: true }
      } finally {
        release()
      }
    })
  }

  /** The conversation history a Codex home keeps: its session transcripts
   *  and its prompt history. Nothing else is copied (never a sign-in). */
  const HISTORY_DIR = 'sessions'
  const HISTORY_FILE = 'history.jsonl'

  /** An account's earlier realms, for the `history` use. */
  const EARLIER: readonly RealmLifecycle[] = ['retiring', 'retired', 'recovery']

  /** The refusal when the history is larger than the bound, saying the bound. */
  const tooLarge = (): Failure => ({
    ok: false,
    code: 'too-large',
    message: `This Codex account has more than ${limits.historyEntries.toLocaleString('en-US')} earlier conversation files and folders, more than the app carries over to a new sign-in, so nothing was changed.`,
  })

  /** Whether every name the file has is one the app gave it: the file
   *  itself, and the same place in the account's earlier realms (an
   *  earlier sign in again linked it there). A file with any other name --
   *  a hard link planted to a sign-in or to anything else -- is not given
   *  one more, nor copied. Unknown counts or file ids prove nothing. */
  async function onlyOurNames(rel: string, cur: CodexFsEntry, earlier: readonly string[]): Promise<boolean> {
    const n = cur.nlink
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) return false
    if (n === 1) return true
    if (!hasIdentity(cur)) return false
    let ours = 0
    for (const home of earlier) {
      const q = pathApi.join(home, rel)
      let e: CodexFsEntry | null
      try { e = await afs.lstat(q) } catch { e = null }
      if (e && e.kind === 'file' && sameIdentity(e, cur) && (await canonicalNow(q))) ours++
    }
    return 1 + ours === n
  }

  /** A staged sign in again's history, carried into the replacement before
   *  the switch (P3.3 review rounds 2 and 3): the source is the account's
   *  realm in use, the destination the replacement being set up. Both are
   *  held with their sign-in locks for the whole copy, which runs through
   *  the asynchronous port and lets the event loop run between batches. The
   *  source tree is walked first, as a removal walks it (plain files and
   *  folders on one volume, each at its own canonical path), bounded by its
   *  own, generous bound (too-large: nothing is changed). Each entry is
   *  re-checked just before it is carried over. A file becomes a second
   *  name of the same file (a hard link: the folders share a volume, and
   *  nothing runs in the old realm again, so the file is only ever used
   *  through its new name), else a byte copy; never over
   *  anything already there, and only when every name it already has is one
   *  the app gave it (`earlier`: the account's earlier realms, compared
   *  only); any other is skipped and counted. Folders are made owner-only in
   *  the destination. */
  function copyHistory(from: RealmRef, to: RealmRef, opts?: { earlier?: readonly RealmRef[] }): Promise<RealmFolderResult & { copied?: number; linked?: number; skipped?: number }> {
    return guard(async () => {
      if (!fs.promises) return fail('io-failed')
      const src = await locate(from, ['active'])
      if (isFailure(src)) return src
      const dst = await locate(to, ['pending'])
      if (isFailure(dst)) return dst
      const earlier: string[] = []
      for (const ref of opts && Array.isArray(opts.earlier) ? opts.earlier : []) {
        const at = await locate(ref, EARLIER, 'history')
        if (isFailure(at) || samePath(at.home, src.home) || samePath(at.home, dst.home)) continue
        const was = inspect(at)
        if (was !== 'absent' && !isFailure(was)) earlier.push(at.home)
      }
      const s = inspect(src)
      const d = inspect(dst)
      if (s === 'absent' || d === 'absent') return fail('realm-unavailable')
      if (isFailure(s)) return s
      if (isFailure(d)) return d
      const releaseSrc = deps.locks.hold(codexRealmLockKey(s.canonical, s.home.dev, s.home.ino))
      if (!releaseSrc) return fail('busy')
      const releaseDst = deps.locks.hold(codexRealmLockKey(d.canonical, d.home.dev, d.home.ino))
      if (!releaseDst) { releaseSrc(); return fail('busy') }
      try {
        const planned: Planned[] = []
        // The transcripts folder, when there is one.
        const sessions = pathApi.join(src.home, HISTORY_DIR)
        let sessionsEntry: CodexFsEntry | null = null
        try { sessionsEntry = await afs.lstat(sessions) } catch (e) { if (errCode(e) !== 'ENOENT') return fail('io-failed') }
        if (sessionsEntry) {
          if (sessionsEntry.kind !== 'dir' || otherVolume(sessionsEntry, s.home) || !(await canonicalNow(sessions))) return fail('unsafe-contents')
          const refused = await walk(sessions, sessionsEntry, 2, planned, { max: limits.historyEntries, over: tooLarge(), pace: pacer() })
          if (refused) return refused
          planned.push({ p: sessions, e: sessionsEntry, parent: s.home })
        }
        // The prompt history, when there is one.
        const history = pathApi.join(src.home, HISTORY_FILE)
        let historyEntry: CodexFsEntry | null = null
        try { historyEntry = await afs.lstat(history) } catch (e) { if (errCode(e) !== 'ENOENT') return fail('io-failed') }
        if (historyEntry) {
          if (historyEntry.kind !== 'file' || otherVolume(historyEntry, s.home) || !(await canonicalNow(history))) return fail('unsafe-contents')
          planned.push({ p: history, e: historyEntry, parent: s.home })
        }
        // Parents before children: the walk lists every entry after
        // everything below it, so the reverse lists it before.
        planned.reverse()
        const pace = pacer()
        let linked = 0
        let byteCopies = 0
        let skipped = 0
        for (const entry of planned) {
          const cur = await asPlanned(entry)
          if (!cur) return fail('changed')
          const rel = pathApi.relative(src.home, entry.p)
          if (!rel || rel.startsWith('..') || pathApi.isAbsolute(rel)) return fail('unsafe-contents')
          const target = pathApi.join(dst.home, rel)
          if (!(await canonicalNow(pathApi.dirname(target)))) return fail('changed')
          if (cur.kind === 'dir') {
            try { await afs.mkdir(target, OWNER_ONLY) } catch (err) {
              if (errCode(err) !== 'EEXIST') return fail('io-failed')
              const there = checkDir(target)
              if (isFailure(there)) return there
            }
            const priv = makePrivate(target)
            if (priv) return priv
          } else if (!(await onlyOurNames(rel, cur, earlier))) {
            skipped++
          } else {
            let how: 'link' | 'copy' = 'link'
            try { await afs.link(entry.p, target) } catch (err) {
              if (errCode(err) === 'EEXIST') return fail('not-empty')
              // Linking refused (a file system without hard links, a file
              // the user may not link): a byte copy instead.
              how = 'copy'
              try { await afs.copyFile(entry.p, target) } catch (err2) { return fail(errCode(err2) === 'EEXIST' ? 'not-empty' : 'io-failed') }
            }
            // What was made is the file that was checked: a link has its file
            // id, and a copy's source did not change meanwhile. Otherwise it
            // goes again, and the copy stops.
            let made: CodexFsEntry | null
            try { made = await afs.lstat(target) } catch { made = null }
            const same = !!made && made.kind === 'file' && (how === 'link' ? !hasIdentity(cur) || sameIdentity(made, cur) : !!(await unchangedNow(entry.p, cur)))
            if (!same) {
              try { await afs.unlink(target) } catch { /* the replacement is removed with its setup */ }
              return fail('changed')
            }
            if (how === 'link') linked++
            else byteCopies++
          }
          await pace()
        }
        return { ok: true, copied: linked + byteCopies, linked, skipped }
      } finally {
        releaseDst()
        releaseSrc()
      }
    })
  }

  return { prepare, remove, copyHistory }
}

/** The promise's answer, or `late` once `ms` have passed. */
function bounded<T>(p: Promise<T>, ms: number, late: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>((res) => { timer = setTimeout(() => res(late), ms); timer.unref?.() })
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer))
}

/** Nothing escapes as a rejection. */
async function guard(body: () => Promise<RealmFolderResult>): Promise<RealmFolderResult> {
  try { return await body() } catch { return fail('io-failed') }
}
