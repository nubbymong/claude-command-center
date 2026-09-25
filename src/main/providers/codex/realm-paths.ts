// Where a Codex realm lives (WP2, plan A5; design 5.4, 5.5). PURE path
// arithmetic: a realm's pathRef is turned into a CODEX_HOME only here, in the
// main process, and only from the closed grammar the registry enforces.
//
//   managed:<realmId>  ->  <resources>/codex-realms/<realmId>
//   external-default   ->  the CODEX_HOME the app inherited, else ~/.codex
//
// Nothing a user or renderer typed is ever joined into a path: the realm id is
// an opaque hex id checked again here, and the result is checked to sit
// directly under the managed root. The external home may never overlap the
// managed root in either direction -- otherwise one directory would be two
// accounts' CODEX_HOME, and removing a managed realm could remove the user's
// own Codex home. Canonicalising (realpath) and creating directories happen in
// the main process, which repeats the overlap check on the canonical paths.
import path from 'node:path'
import { isOpaqueId, realmShapeProblem, MANAGED_PATH_REF_PREFIX, EXTERNAL_DEFAULT_PATH_REF } from '../../../shared/providers'
import type { AuthRealm } from '../../../shared/providers'

export const CODEX_REALMS_DIRNAME = 'codex-realms'

export interface CodexRealmRoots {
  /** The app's resources directory (fully qualified). */
  resourcesDir: string
  /** The canonical external default home, or null when it cannot be used. */
  externalDefaultHome: string | null
  /** The external home overlaps the managed tree (main's check on canonical
   *  paths and file identity): every Codex realm is unavailable until the
   *  user moves it, managed ones included. */
  externalConflict?: boolean
}

export type CodexRealmHome = { ok: true; home: string } | { ok: false; message: string }

const isWin = (pathApi: typeof path) => pathApi.sep === '\\'

/** Absolute AND anchored: on Windows a drive (`C:\`) or a UNC share
 *  (`\\server\share\`), never `\x` (relative to the current drive). */
export function isFullyQualifiedPath(p: string, pathApi: typeof path = path): boolean {
  if (typeof p !== 'string' || !p || !pathApi.isAbsolute(p)) return false
  if (!isWin(pathApi)) return true
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}(\?[\\/][A-Za-z]:[\\/]|[^\\/?.][^\\/]*[\\/][^\\/]+)/.test(p)
}

/** The spelling-independent form of a path for overlap checks: on Windows
 *  the `\\?\` and `\\?\UNC\` prefixes are dropped and each segment loses the
 *  trailing dots and spaces Windows itself ignores. Compared case-
 *  insensitively everywhere (macOS disks usually ignore case too): an overlap
 *  check that errs refuses, never allows. What no string can see -- 8.3 short
 *  names, `\\localhost\C$`, links -- main checks on file identity. */
function comparable(p: string, pathApi: typeof path): string {
  let s = p
  if (isWin(pathApi)) {
    s = s.replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, '\\\\').replace(/^[\\/]{2}\?[\\/]/, '')
    s = pathApi.resolve(s).split(/[\\/]/).map((seg, i) => (i === 0 ? seg : seg.replace(/[. ]+$/, ''))).join('\\')
  } else {
    s = pathApi.resolve(s)
  }
  return s.replace(/[\\/]+$/, '').toLowerCase()
}

/** a === b, or a inside b. */
function within(a: string, b: string, pathApi: typeof path): boolean {
  const [x, y] = [comparable(a, pathApi), comparable(b, pathApi)]
  return x === y || x.startsWith(y + pathApi.sep)
}

/** The external default home before canonicalisation, exactly as the CLI
 *  would find it: the parent's CODEX_HOME (by exact name; case-insensitive
 *  only on Windows), else `<home>/.codex`. A CODEX_HOME that is set but not
 *  a fully qualified path is not guessed at: null, and no external home. */
export function codexExternalDefaultHome(env: Readonly<Record<string, string | undefined>>, homeDir: string, pathApi: typeof path = path): string | null {
  const set = Object.keys(env).filter((k) => (isWin(pathApi) ? k.toUpperCase() === 'CODEX_HOME' : k === 'CODEX_HOME'))
  if (set.length > 1) return null
  if (set.length === 1) {
    const v = env[set[0]]
    if (typeof v === 'string' && v !== '') return isFullyQualifiedPath(v, pathApi) ? pathApi.normalize(v) : null
  }
  return isFullyQualifiedPath(homeDir, pathApi) ? pathApi.join(homeDir, '.codex') : null
}

/** The external home setting, for main's overlap check (slice 3d): none (no
 *  CODEX_HOME and no usable home directory), the path exactly as the CLI is
 *  given it -- NOT normalised, because `..` after a link is the kernel's to
 *  resolve, and a Windows verbatim or device path (`\\?\`, `\\.\`) is
 *  literal -- or `unusable`: a CODEX_HOME that is set but relative, drive-
 *  or root-relative, or ambiguous (two spellings), or -- on Windows, outside
 *  a `\\?\` or `\\.\` path -- with a name ending in a dot or a space: Win32
 *  path normalisation (which the CLI's file calls go through) drops those,
 *  while Node looks the name up as written, so the two would see different
 *  folders. The app cannot show an unusable one does not overlap its managed
 *  homes, so main treats it as if it did: an overlap check that errs refuses. */
export type CodexExternalCandidate = { kind: 'none' } | { kind: 'path'; path: string } | { kind: 'unusable' }

export function codexExternalHomeCandidate(env: Readonly<Record<string, string | undefined>>, homeDir: string, pathApi: typeof path = path): CodexExternalCandidate {
  const win = isWin(pathApi)
  const literal = (p: string) => win && /^[\\/]{2}[.?][\\/]/.test(p)
  const checked = (p: string): CodexExternalCandidate =>
    win && !literal(p) && p.split(/[\\/]/).slice(1).some((seg) => /[. ]$/.test(seg)) ? { kind: 'unusable' } : { kind: 'path', path: p }
  const set = Object.keys(env).filter((k) => (win ? k.toUpperCase() === 'CODEX_HOME' : k === 'CODEX_HOME'))
  if (set.length > 1) return { kind: 'unusable' }
  if (set.length === 1) {
    const v = env[set[0]]
    if (typeof v === 'string' && v !== '') {
      // \\.\C:\..., \\?\UNC\..., \\?\Volume{...}\...: absolute; realpath decides.
      if (isFullyQualifiedPath(v, pathApi) || (literal(v) && /^[\\/]{2}[.?][\\/]./.test(v))) return checked(v)
      return { kind: 'unusable' }
    }
  }
  // Joined by hand, not normalised: `..` in HOME is the kernel's to resolve.
  return isFullyQualifiedPath(homeDir, pathApi) ? checked(`${homeDir.replace(/[\\/]+$/, '')}${pathApi.sep}.codex`) : { kind: 'none' }
}

/** The managed realms root under a resources directory. */
export function codexManagedRealmsRoot(resourcesDir: string, pathApi: typeof path = path): string {
  return pathApi.join(pathApi.resolve(resourcesDir), CODEX_REALMS_DIRNAME)
}

/** True when an external home and the managed root overlap in either
 *  direction (compared case-insensitively on Windows). */
export function codexHomesOverlap(externalHome: string, resourcesDir: string, pathApi: typeof path = path): boolean {
  const root = codexManagedRealmsRoot(resourcesDir, pathApi)
  return within(externalHome, root, pathApi) || within(root, externalHome, pathApi)
}

/** The CODEX_HOME for one realm, or why there is none. */
export function codexRealmHome(
  realm: Pick<AuthRealm, 'id' | 'providerId' | 'kind' | 'ownership' | 'pathRef'>,
  roots: CodexRealmRoots,
  pathApi: typeof path = path,
): CodexRealmHome {
  if (realm.providerId !== 'codex' || realm.kind !== 'codex-home') return { ok: false, message: 'not a Codex realm' }
  const shape = realmShapeProblem(realm)
  if (shape) return { ok: false, message: shape }
  if (!isFullyQualifiedPath(roots.resourcesDir, pathApi)) return { ok: false, message: 'the resources directory is not available' }
  if (roots.externalConflict === true) return { ok: false, message: "the external Codex home overlaps the app's managed Codex homes" }
  if (realm.ownership === 'external-default') {
    if (realm.pathRef !== EXTERNAL_DEFAULT_PATH_REF) return { ok: false, message: 'not the external default home' }
    const home = roots.externalDefaultHome
    if (!home || !isFullyQualifiedPath(home, pathApi)) return { ok: false, message: 'the external Codex home is not available' }
    if (codexHomesOverlap(home, roots.resourcesDir, pathApi)) return { ok: false, message: "the external Codex home overlaps the app's managed Codex homes" }
    return { ok: true, home }
  }
  if (!isOpaqueId(realm.id, 'realm') || realm.pathRef !== `${MANAGED_PATH_REF_PREFIX}${realm.id}`) return { ok: false, message: 'not a managed realm reference' }
  const root = codexManagedRealmsRoot(roots.resourcesDir, pathApi)
  const home = pathApi.join(root, realm.id)
  // Belt and braces: exactly one segment below the root, whatever the id.
  if (pathApi.dirname(home) !== root || pathApi.basename(home) !== realm.id) return { ok: false, message: 'the realm path escapes the managed root' }
  return { ok: true, home }
}
