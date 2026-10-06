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
//   reads the folder; it then reads the registry again under it (bounded)
//   and nothing awaits after that. A prepare that has to take a folder back
//   after an await does so only under the same lock, and only the folder it
//   made.
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

export interface CodexRealmFolderDeps {
  lookupRealm(realm: RealmRef): Promise<CodexFolderLookup>
  fs: CodexRealmFsPort
  locks: CodexRealmLocks
}

/** Bounds on a tree the removal will walk: an abandoned setup's home holds a
 *  config file, logs and perhaps a session or two. */
export const CODEX_REMOVE_MAX_DEPTH = 32
export const CODEX_REMOVE_MAX_ENTRIES = 20_000
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

export function createCodexRealmFolders(deps: CodexRealmFolderDeps): ProviderRealmFolderOperations {
  const fs = deps.fs
  const platform = fs.platform
  const pathApi = pathApiFor(platform)
  const samePath = makeSamePath(platform)

  interface Located { home: string; root: string; resourcesDir: string }

  /** The record behind the reference, checked; the home it derives. */
  async function locate(ref: RealmRef, allowed: readonly RealmLifecycle[]): Promise<Located | Failure> {
    let found: CodexFolderLookup
    try {
      const id = ref && typeof ref === 'object' ? (ref as { authRealmId?: unknown }).authRealmId : undefined
      if (typeof id !== 'string' || !id) return fail('realm-unavailable')
      found = await deps.lookupRealm({ authRealmId: id })
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

  function stillCanonical(p: string): boolean {
    try { return samePath(fs.realpath(p), p) } catch { return false }
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

  /** Every entry below `dir`, children before their directory; a failure
   *  when the tree is not plainly files and folders on one volume, each at
   *  its own canonical path. */
  function plan(dir: string, dirEntry: CodexFsEntry, depth: number, out: Planned[]): Failure | null {
    if (depth > CODEX_REMOVE_MAX_DEPTH) return fail('unsafe-contents')
    let names: string[]
    try { names = fs.readdir(dir) } catch { return fail('io-failed') }
    if (!Array.isArray(names)) return fail('io-failed')
    for (const name of names) {
      if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\0]/.test(name)) return fail('unsafe-contents')
      const p = pathApi.join(dir, name)
      let e: CodexFsEntry
      try { e = fs.lstat(p) } catch { return fail('io-failed') }
      if (!e || (e.kind !== 'file' && e.kind !== 'dir')) return fail('unsafe-contents')
      if (otherVolume(e, dirEntry)) return fail('unsafe-contents')
      // A reparse point lstat does not report as a link (a junction to a
      // volume-GUID path) resolves somewhere else.
      if (!stillCanonical(p)) return fail('unsafe-contents')
      if (out.length >= CODEX_REMOVE_MAX_ENTRIES) return fail('unsafe-contents')
      if (e.kind === 'dir') {
        const below = plan(p, e, depth + 1, out)
        if (below) return below
      }
      out.push({ p, e, parent: dirEntry })
    }
    return null
  }

  function unchanged(p: string, was: CodexFsEntry): boolean {
    let now: CodexFsEntry
    try { now = fs.lstat(p) } catch { return false }
    if (!now || now.kind !== was.kind) return false
    return !hasIdentity(was) || sameIdentity(now, was)
  }

  function removeFile(p: string): boolean {
    try { fs.unlink(p); return true } catch (e) {
      // Windows refuses to delete a read-only file.
      if (platform !== 'win32' || (errCode(e) !== 'EPERM' && errCode(e) !== 'EACCES')) return false
      try { fs.chmod(p, 0o666); fs.unlink(p); return true } catch { return false }
    }
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

  function remove(ref: RealmRef, opts?: { contents?: 'empty-only' | 'all' }): Promise<RealmFolderResult> {
    return guard(async () => {
      const contents = opts && typeof opts === 'object' ? opts.contents : undefined
      if (contents !== 'empty-only' && contents !== 'all') return fail('io-failed')
      const at = await locate(ref, ['pending'])
      if (isFailure(at)) return at
      const first = inspect(at)
      if (first === 'absent') return { ok: true, removed: false }
      if (isFailure(first)) return first
      const release = deps.locks.holdRemoval(codexRealmLockKey(first.canonical, first.home.dev, first.home.ino))
      if (!release) return fail('busy')
      try {
        // Under the lock, the registry again: a sign-in that finished while
        // the first lookup was in flight may have been committed since. From
        // here to the end nothing awaits, so nothing can change the record in
        // between.
        // Bounded: a registry answer that never comes must not hold the realm.
        const now = await bounded(locate(ref, ['pending']), CODEX_UNDER_LOCK_LOOKUP_MS, fail('io-failed'))
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
          const refused = plan(now.home, homeId, 1, planned)
          if (refused) return refused
          for (const { p, e, parent } of planned) {
            // The entry, and the folder it is in: still at its own canonical
            // path (no folder on the way was swapped for a link since
            // planning, file ids or not) and still the folder planned.
            const dir = pathApi.dirname(p)
            if (!stillCanonical(dir) || !unchanged(dir, parent) || !unchanged(p, e)) return fail('changed')
            const gone = e.kind === 'dir' ? (() => { try { fs.rmdir(p); return true } catch { return false } })() : removeFile(p)
            if (!gone) return fail('io-failed')
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

  return { prepare, remove }
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
