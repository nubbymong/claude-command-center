// Agent Canvas — main-process store of canvases and their content versions.
//
// One canvas per session (per-session button ⇒ per-session ownership, spec D2);
// versions are linear and monotonic ('v1', 'v2', … — spec D11). Persistence is
// one JSON per canvas under `<resources>/canvas/<canvasId>/canvas.json`, with
// design-mode documents stored as real files under `versions/<vid>/` so the
// ccc-ux:// protocol can serve them straight from disk (never from a giant
// JSON blob). All writes go through mkdirSecure + atomicWriteSecure — the same
// hardened helpers the credential stores use.
//
// The store is the single mutation point: the IPC dev ingress today and the
// canvas_render MCP tool (P3) both call renderVersion(), and every mutation
// fans out through onCanvasChanged() so the renderer stays current no matter
// who rendered.

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomId } from '../../shared/id'
import {
  CANVAS_ID_RE,
  type CanvasAwaitingReview,
  type CanvasCompletion,
  type CanvasLibraryEntry,
  CANVAS_VERSION_ID_RE,
  CanvasChangedEvent,
  CanvasRenderSource,
  CanvasState,
  CanvasVersion,
  MAX_CANVAS_TITLE_CHARS,
  MAX_PACK_NAME_CHARS,
  MAX_PRIOR_VERDICTS,
  MAX_VERDICT_NOTE_CHARS,
  type AuditStamp,
  type ResumableRow,
  artifactRunContaining,
  artifactRuns,
  isKeepableVerdict,
  libraryRowKindOf,
  openVersionOf,
  sanitizeAuditStamp,
  sanitizeCanvasConfigId,
  type CanvasVersionVerdict,
} from '../../shared/canvas'
import { atomicWriteSecure, mkdirSecure } from '../account-profiles'
import { deriveInstallKey } from '../install-secret'
import { getResourcesDirectory } from '../ipc/setup-handlers'
import { isHomeOrAncestor } from '../path-utils'

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
/** Defensive cap on a design document; the IPC schema caps tighter. */
const MAX_DESIGN_HTML_BYTES = 8 * 1024 * 1024
const MAX_VERSIONS_PER_CANVAS = 500
/** Canvases one session may own. Generous for real work (each is a subject the
 *  user chose to review) and a hard stop for title-cycling. */
const MAX_CANVASES_PER_SESSION = 50

/** A Claude conversation uuid as it appears in transcript basenames. Kept loose
 *  (hex + dashes) — it is a MATCHING key, never a path segment. */
const CONVERSATION_UUID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/
const MAX_CWD_CHARS = 1024

/**
 * The canvas serving allowlist, PER SESSION.
 *
 * UAT versions serve a project's built `dist/` from an absolute path the CALLER
 * supplies, and `canvas_render`'s `htmlPath` reads a file the MODEL names. Both
 * paths are untrusted: unconfined, a caller could name `C:\` or a home dir and
 * turn the ccc-ux:// protocol into a whole-disk file server (adversarial
 * review, 2026-08-11). So a path is accepted ONLY when it resolves at or under
 * a base explicitly registered for THAT session. This is an ALLOWLIST, never a
 * denylist, and it is DEFAULT-EMPTY: with no base registered, every UAT render
 * and every htmlPath read is refused (fail closed).
 *
 * WHY IT IS KEYED BY SESSION (adversarial review, 2026-08-15 — BLOCKER 1). The
 * first cut was one global `Set<string>` that every spawn added to and nothing
 * ever removed. Three consequences, all reachable without an attacker doing
 * anything clever:
 *   - one session's prompt-injected agent could serve ANOTHER session's project
 *     (every local session on the machine had contributed its cwd);
 *   - an SSH session's agent, whose own cwd is remote and therefore registers
 *     nothing, still reached every local project through the shared set;
 *   - a root survived the session that justified it for the life of the app,
 *     with no production revocation at all.
 * Now: a root belongs to the session it was registered for, that session is the
 * only one that can resolve through it, and the set dies with the session's PTY
 * (revokeCanvasUatRoots, called from the pty cleanup path).
 */
const uatRootsBySession = new Map<string, Set<string>>()

/**
 * A session's DESIGNATED worktree root — a directory CCC named for it, that may
 * or may not exist yet.
 *
 * Why this exists (2026-08-17): session isolation (ADR-012) has every agent
 * claim its own git worktree beside the project (`<parent>/ccc-wt/<id>`) and
 * the guard hook blocks writes to the primary checkout. The canvas served
 * roots, meanwhile, are exactly the configured project directory. So an
 * agent that dutifully isolates itself writes its mockup into a directory the
 * canvas refuses to read: `canvas_render`'s `htmlPath` fails and it is forced
 * to the inline fallback. Two mandated features in conflict.
 *
 * WHY NOT the obvious fixes. "Serve whatever the guard's lease says the
 * session's worktree is" and "serve any git worktree of a served root" both
 * derive a served root from data the AGENT writes (`.git/ccc-sessions/*.json`,
 * `.git/worktrees/*`, a worktree's `.git` file). That is the exact class the
 * three earlier canvas reviews closed (transcript cwd, resume cwd, plugin dir):
 * a model that names its own allowlist entry. So instead CCC DESIGNATES the
 * location — `<worktree base>/<ccc-session-short>`, computed in pty-manager
 * from the CONFIGURED project directory and CCC's own session id, nothing the
 * agent supplies — tells the guard where via CCC_SESSION_WORKTREE, and records
 * it here. The guard creates the worktree there; if the agent claims anywhere
 * else, its worktree is simply not served (fail closed, today's behaviour).
 *
 * A designated root is PENDING: it is stored lexically and consulted only at
 * resolution time, when it must (a) exist, (b) be a real directory whose
 * realpath IS the designated path — an agent that pre-creates the directory
 * as a junction / symlink to somewhere else gets nothing, because serving is
 * containment under the REALPATH and that would point elsewhere — and (c)
 * pass the same floor as a live root. Only files physically under the
 * designated directory can ever be served through it, and every candidate is
 * still realpath'd itself, so a link planted inside cannot reach out.
 * Revoked with the session, like a live root.
 */
const designatedRootsBySession = new Map<string, Set<string>>()

/** `C:\`, `D:\`, `/`, `\\server\share\` — a whole volume is not a project. */
function isVolumeRoot(p: string): boolean {
  // `C:\` → dirname is itself; `path.parse('/').root === '/'`. Both spellings
  // are checked because a UNC share root satisfies one and not the other.
  return path.dirname(p) === p || path.parse(p).root === p
}

/** True when `p` is at or under a dot-prefixed directory inside the home dir. */
function isDotDirUnderHome(p: string): boolean {
  let home: string
  try {
    home = fs.realpathSync.native(os.homedir())
  } catch {
    home = path.resolve(os.homedir())
  }
  // path.relative is case-insensitive on win32, which is what makes a
  // `c:\users\me\.ssh` spelling land in the same place as `C:\Users\Me\.ssh`.
  const rel = path.relative(home, p)
  if (rel === '' || path.isAbsolute(rel)) return false
  const segments = rel.split(/[\\/]/).filter((s) => s.length > 0)
  if (segments.length === 0 || segments[0] === '..') return false // not under home
  return segments.some((s) => s.startsWith('.'))
}

/** True when `a` contains `b` (b lives somewhere under a). Case-insensitive on
 *  win32, because `path.relative` is. */
function contains(a: string, b: string): boolean {
  const rel = path.relative(a, b)
  if (rel === '' || path.isAbsolute(rel)) return false
  const first = rel.split(/[\\/]/).filter((s) => s.length > 0)[0]
  return first !== undefined && first !== '..'
}

/**
 * True when `p` is the app's own RESOURCES directory, anything under it, or any
 * ancestor of it (#371).
 *
 * The existing floor refuses the home directory, a volume root and the dot
 * directories under home — the places a user's credentials live. It did not
 * refuse the place THIS APP keeps credentials. The resources directory holds
 * `CONFIG/` (`ssh-credentials.json`, the DPAPI-encrypted SSH and sudo passwords
 * and secret arguments; `conductor-secret.json`, the MCP HMAC key),
 * `account-profiles/` and `account-homes/` (Claude OAuth tokens), plus the
 * canvas store itself. Served as a canvas root, all of it becomes readable over
 * the canvas HTTP surface.
 *
 * All three directions are refused, matching what `isHomeOrAncestor` already
 * does for home:
 *   - the directory itself,
 *   - anything UNDER it (`<resources>/CONFIG` named directly),
 *   - anything that CONTAINS it — serving a parent serves the resources dir,
 *     which is the case that bites when someone points their resources
 *     directory inside a project they actually work in.
 *
 * Same-user hardening, not a privilege boundary: the agent already runs as the
 * user. What it removes is the canvas turning "read a file" into "serve a
 * credential store over HTTP" without anyone deciding to.
 */
function isResourcesDirOrAround(p: string): boolean {
  let configured: string
  try {
    configured = getResourcesDirectory()
  } catch {
    return false // not resolvable this run — the other floors still apply
  }
  if (typeof configured !== 'string' || configured.length === 0) return false
  let res: string
  try {
    res = fs.realpathSync.native(configured)
  } catch {
    res = path.resolve(configured) // not on disk yet; the lexical answer still holds
  }
  return sameFsPath(res, p) || contains(res, p) || contains(p, res)
}

/**
 * Register a directory under which one session's canvas paths may live.
 *
 * Idempotent. Returns true only when the base was actually added, so the caller
 * can log a refusal. Everything here is a FLOOR under the caller's own checks,
 * not a substitute for them:
 *   - a relative base is refused outright — `path.resolve('')`/`resolve('.')`
 *     would silently allowlist the process cwd (adversarial review 2026-08-11);
 *   - a base that does not resolve is not added;
 *   - a FILE is not a root. `resolveInsideCanvasRoot` treats a root as its own
 *     first legal target, so registering `~/.ssh/id_rsa` would have served
 *     exactly that file (adversarial review 2026-08-15);
 *   - the home directory (or any ancestor of it) is refused, the same refusal
 *     and the same helper codex_review has carried since #188 — `~/.ssh`,
 *     `~/.claude` and `~/.aws` all resolve INSIDE a home root with no '..', so
 *     containment holds while the root itself is the whole exposure;
 *   - a VOLUME ROOT (`C:\`, `D:\`, `/`, `\\server\share\`) is refused. It is not
 *     home and it is not an ancestor of home on another drive, so the home check
 *     passes it — and it is the whole-disk file server the allowlist exists to
 *     prevent (`registerCanvasUatRoot(sid, 'C:\\Windows')` was accepted too, but
 *     a Windows dir is at least not the user's secrets; a volume root is both);
 *   - a DOT-DIRECTORY under home is refused (`~/.ssh`, `~/.claude`, `~/.aws`,
 *     `~/.config`, `~/.gnupg`, and anything under them). Home itself is already
 *     refused, but a CHILD of home is not an ancestor of home, so the #188 check
 *     is blind to exactly the three directories the attack wanted. Dot-prefixed
 *     directories under home are where per-user credentials live by convention
 *     on every platform, and no build output lives there.
 *
 * Over-denial is the intended direction: a refused root costs a canvas render,
 * an accepted one costs a credential.
 */
/**
 * WHY a directory cannot be a canvas root, or null when it can.
 *
 * Split out so a refusal can SAY which floor it hit (#371). The floor is
 * correct, but a refusal that reaches the user as nothing at all — and reaches
 * the agent as "write the html inside the project folder", which is where it
 * already wrote it — is an undiagnosable dead end. ADR-017's own words: being
 * locked out of your own canvas is a bug this app has already shipped once.
 */
export type CanvasRootRefusal =
  | 'bad-session-id'
  | 'not-absolute'
  | 'unresolvable'
  | 'not-a-directory'
  | 'home-or-ancestor'
  | 'volume-root'
  | 'dot-dir-under-home'
  | 'resources-dir'

/**
 * The refusal, plus the RESOLVED path when there is none.
 *
 * Returning the resolution is what closes a TOCTOU (#371, ADR-009 pass):
 * `registerCanvasUatRoot` used to realpath once to CHECK and again to ADD, so a
 * directory swapped for a symlink between the two calls was checked as itself
 * and added as its target. Check and use are now one resolution.
 */
export function canvasRootCheck(
  sessionId: string,
  baseDir: string,
): { refusal: CanvasRootRefusal; real?: undefined } | { refusal: null; real: string } {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return { refusal: 'bad-session-id' }
  if (typeof baseDir !== 'string' || !path.isAbsolute(baseDir)) return { refusal: 'not-absolute' }
  let real: string
  try {
    real = fs.realpathSync.native(path.resolve(baseDir))
  } catch {
    return { refusal: 'unresolvable' }
  }
  try {
    if (!fs.statSync(real).isDirectory()) return { refusal: 'not-a-directory' }
  } catch {
    return { refusal: 'not-a-directory' }
  }
  if (isHomeOrAncestor(real)) return { refusal: 'home-or-ancestor' }
  if (isVolumeRoot(real)) return { refusal: 'volume-root' }
  if (isDotDirUnderHome(real)) return { refusal: 'dot-dir-under-home' }
  if (isResourcesDirOrAround(real)) return { refusal: 'resources-dir' }
  return { refusal: null, real }
}

/** Just the reason, for callers that only have to explain themselves. */
export function canvasRootRefusalReason(sessionId: string, baseDir: string): CanvasRootRefusal | null {
  return canvasRootCheck(sessionId, baseDir).refusal
}

/**
 * One sentence a user or an agent can act on, for each refusal.
 *
 * `dir` is SANITISED before it is interpolated (#371, ADR-009 pass). The path
 * is CCC's own, but a folder NAME inside it is user-authored and this string is
 * relayed to a model — so control, format and bidi characters go, and the
 * length is capped. Same rule, and the same reason, as `safeRootLabel` in
 * canvas-mcp-tool: nothing outside the envelope is anything but operator text.
 */
export function describeCanvasRootRefusal(reason: CanvasRootRefusal, rawDir: string): string {
  const cleaned = String(rawDir ?? '').replace(FORMAT_CONTROLS_RE, '')
  const dir = cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned
  switch (reason) {
    case 'resources-dir':
      return `the canvas cannot serve ${dir} because the app's own resources directory (which holds your saved credentials and accounts) is inside it, or is it. Point this session at a project folder that does not contain the resources directory, or move the resources directory somewhere else in Settings.`
    case 'home-or-ancestor':
      return `the canvas cannot serve ${dir} because it is your home directory or a folder above it. Set this session's working directory to the specific project folder.`
    case 'volume-root':
      return `the canvas cannot serve ${dir} because it is a whole drive. Set this session's working directory to the specific project folder.`
    case 'dot-dir-under-home':
      return `the canvas cannot serve ${dir} because it is inside a hidden folder in your home directory (where credentials live).`
    case 'not-a-directory':
      return `the canvas cannot serve ${dir} because it is not a directory.`
    case 'unresolvable':
      return `the canvas cannot serve ${dir} because that path could not be resolved on disk.`
    case 'not-absolute':
      return `the canvas cannot serve ${dir} because it is not an absolute path.`
    case 'bad-session-id':
      return 'the canvas cannot serve this session (its id is not usable).'
  }
}

/**
 * Why this session has no project root, in words, for the surfaces that have to
 * tell somebody (#371). Without it the refusal reaches the agent as the generic
 * "write the html inside the project folder" — which is where it already wrote
 * it — and reaches the user as nothing at all.
 */
const rootRefusalBySession = new Map<string, string>()

export function setCanvasRootRefusal(sessionId: string, explanation: string): void {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return
  rootRefusalBySession.set(sessionId, explanation)
}

export function canvasRootRefusalFor(sessionId: string): string | null {
  return rootRefusalBySession.get(sessionId) ?? null
}

export function registerCanvasUatRoot(sessionId: string, baseDir: string): boolean {
  // ONE resolution, used for both the check and the add. Resolving twice let a
  // directory swapped for a symlink between the two calls be checked as itself
  // and added as its target (#371, ADR-009 pass). `canvasRootCheck` never
  // throws, so a mid-call ENOENT cannot escape into spawnPty either.
  const checked = canvasRootCheck(sessionId, baseDir)
  if (checked.refusal !== null) return false
  rootRefusalBySession.delete(sessionId) // it registered; there is nothing to explain
  const real = checked.real
  let roots = uatRootsBySession.get(sessionId)
  if (!roots) {
    roots = new Set<string>()
    uatRootsBySession.set(sessionId, roots)
  }
  roots.add(real)
  return true
}

/**
 * Designate the directory the session's isolated worktree is expected at (see
 * designatedRootsBySession). Nothing is checked on disk now — the directory
 * usually does not exist yet — beyond the lexical floor: absolute, normalised,
 * not home or an ancestor of it, not a volume root, not a dot-directory under
 * home. Idempotent; returns true when recorded. Consulted by
 * `resolveInsideCanvasRoot` / UAT `distRoot` only once it exists as a real,
 * un-linked directory.
 */
export function designateCanvasWorktreeRoot(sessionId: string, dir: string): boolean {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return false
  if (typeof dir !== 'string' || dir.length === 0 || !path.isAbsolute(dir)) return false
  const lexical = path.resolve(dir)
  if (isHomeOrAncestor(lexical)) return false
  if (isVolumeRoot(lexical)) return false
  if (isDotDirUnderHome(lexical)) return false
  if (isResourcesDirOrAround(lexical)) return false
  // Refuse a path already designated for a DIFFERENT session. Distinct tiles
  // derive distinct segments, so this only fires on a segment collision — and
  // there the FIRST tile owns the directory it populated; serving it to a second
  // tile would cross the per-session boundary (adversarial review). Fail closed:
  // the second tile is simply not canvas-served.
  for (const [otherSession, roots] of designatedRootsBySession) {
    if (otherSession !== sessionId && roots.has(lexical)) return false
  }
  let set = designatedRootsBySession.get(sessionId)
  if (!set) {
    set = new Set<string>()
    designatedRootsBySession.set(sessionId, set)
  }
  set.add(lexical)
  return true
}

/** Same-path test for the anti-link check: the filesystem's own notion of
 *  equality — case-insensitive on Windows and macOS, exact elsewhere. */
function sameFsPath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = p.replace(/[\\/]+$/, '')
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/**
 * The live real path of a designated root, or null while it is not servable:
 * missing, not a directory, a junction/symlink (its realpath is somewhere else
 * — the agent pre-created it pointing at a directory it wants read), or a
 * realpath the floor refuses. Evaluated on EVERY resolution: a directory that
 * was real yesterday and is a junction today stops serving today.
 */
function liveDesignatedRoot(lexical: string): string | null {
  let real: string
  try {
    real = fs.realpathSync.native(lexical)
  } catch {
    return null // not there (yet)
  }
  if (!sameFsPath(real, lexical)) return null // a link, or a link on the way
  try {
    if (!fs.statSync(real).isDirectory()) return null
  } catch {
    return null
  }
  if (isHomeOrAncestor(real)) return null
  if (isVolumeRoot(real)) return null
  if (isDotDirUnderHome(real)) return null
  if (isResourcesDirOrAround(real)) return null
  return real
}

/**
 * The folders THIS session may render from, for the purpose of SAYING SO.
 *
 * The two refusal messages stated the rule and never named a destination, so an
 * agent that put a mockup in the wrong place learned only that it was wrong.
 * (Field notes from two separate sessions, 2026-08-20: one avoided it by having
 * read the skill, the other wrote the file to a scratch directory and never
 * recovered.) The refusal is the one moment we know exactly which folders would
 * have worked, so it should say them.
 *
 * Safe to disclose: both paths are CCC's own — the configured project directory
 * and a worktree location CCC computed itself — never anything the model
 * supplied, and the agent's own PTY is already cd'd into the first with the
 * second in its environment as CCC_SESSION_WORKTREE. Keyed on the
 * transport-bound session id only, so it can never widen to another session's.
 *
 * `worktreePending` distinguishes "designated but not created yet" from "no
 * worktree at all" — different advice.
 */
export function canvasRootsForSession(
  sessionId: string,
): { project: string | null; worktree: string | null; worktreePending: boolean } {
  if (!SESSION_ID_RE.test(sessionId)) return { project: null, worktree: null, worktreePending: false }
  const live = uatRootsBySession.get(sessionId)
  // A session registers exactly one live root (its resolved cwd); take the
  // first deterministically rather than assuming a count.
  const project = live && live.size > 0 ? [...live][0] : null
  const designated = designatedRootsBySession.get(sessionId)
  const lexical = designated && designated.size > 0 ? [...designated][0] : null
  const worktree = lexical ? liveDesignatedRoot(lexical) : null
  return { project, worktree, worktreePending: Boolean(lexical) && worktree === null }
}

/** Drop every root a session was allowed to serve — live and designated.
 *  Called when its PTY is gone (pty-manager cleanupSessionResources) — a root
 *  outlives nothing. */
export function revokeCanvasUatRoots(sessionId: string): void {
  uatRootsBySession.delete(sessionId)
  designatedRootsBySession.delete(sessionId)
  rootRefusalBySession.delete(sessionId)
}

/** True iff `candidate` physically resolves at/under a base registered for
 *  THIS session — a live root, or a designated worktree root that is live
 *  right now (liveDesignatedRoot). realpath both sides so a symlinked base or
 *  candidate cannot dodge the check. Unknown session ⇒ no roots ⇒ false (fail
 *  closed). */
function resolvesUnderSessionRoot(candidate: string, sessionId: string): string | null {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null
  const roots = uatRootsBySession.get(sessionId)
  const designated = designatedRootsBySession.get(sessionId)
  if ((!roots || roots.size === 0) && (!designated || designated.size === 0)) return null
  let real: string
  try {
    real = fs.realpathSync.native(candidate)
  } catch {
    return null
  }
  if (roots) {
    for (const base of roots) {
      if (real === base || real.startsWith(base + path.sep)) return real
    }
  }
  if (designated) {
    for (const lexical of designated) {
      const base = liveDesignatedRoot(lexical)
      if (base === null) continue
      if (real === base || real.startsWith(base + path.sep)) return real
    }
  }
  return null
}

function distRootAllowed(distRoot: string, sessionId: string): boolean {
  return resolvesUnderSessionRoot(distRoot, sessionId) !== null
}

/**
 * Resolve a caller-supplied absolute file path, confined to the roots
 * registered for `sessionId` (that session's own project directory).
 *
 * This is the containment for `canvas_render`'s `htmlPath` — a path the MODEL
 * chooses, read with the app's privileges. Unconfined it was an arbitrary-file
 * read (adversarial review 2026-08-14 drove it to a private key), and the only
 * thing in front of it was a human approval prompt, which is not containment.
 * Same allowlist and same realpath discipline `distRoot` already uses, so a
 * symlink inside the project cannot point out of it.
 *
 * `sessionId` MUST be the transport-bound session (conductor-mcp-server's
 * `boundSessionId`), never one the model supplied — the #188 precedent. Passing
 * a model-chosen id here would re-open exactly the cross-session read that
 * keying the allowlist by session closed.
 *
 * Throws (never returns a path outside a root); the thrown message is mapped
 * to a closed operator vocabulary by the caller and never relayed verbatim.
 */
export function resolveInsideCanvasRoot(absPath: string, sessionId: string): string {
  if (typeof absPath !== 'string' || absPath.length === 0 || !path.isAbsolute(absPath)) {
    throw new Error('path is not under a registered canvas root')
  }
  // realpath the FILE, not just its parent: this is what makes a symlink
  // planted inside the project unable to reach outside it.
  const real = resolvesUnderSessionRoot(absPath, sessionId)
  if (real === null) throw new Error('path is not under a registered canvas root')
  return real
}

/** A version `entry` must be a plain relative file path. Boolean form of
 *  `normalizeEntryPath`, for validating records loaded from disk / re-served.
 *  Deliberately NOT the HTML check — see normalizeEntryPath. */
function isSafeEntry(entry: unknown): entry is string {
  if (typeof entry !== 'string') return false
  try {
    normalizeEntryPath(entry)
    return true
  } catch {
    return false
  }
}

interface CanvasRecord extends CanvasState {
  createdAt: string
  /**
   * Continuity stamps (2026-08-14, the VM "repush" bug). The CCC session id a
   * canvas is keyed to is more ephemeral than the work it anchors: quit the
   * app, open a fresh tile in the same project, resume the same conversation —
   * new session id, stranded canvas. These two identify the WORK so a new
   * session can adopt it: the project directory the owning session ran in, and
   * the Claude conversation the canvas was last rendered under. First render
   * stamps them (via the injected session-info resolver); `cwd` never drifts
   * afterwards, `conversationUuid` tracks the latest render.
   */
  cwd?: string
  conversationUuid?: string
  /**
   * The next version number to mint — a MONOTONIC high-water mark (item C,
   * phase 5). Without it, `nextVersionId` derives the next id from `max(existing
   * ids) + 1`, so deleting the LATEST artifact would let a later render reuse a
   * deleted id — resurrecting a version the user permanently removed. This
   * counter never decreases on a delete, so a deleted id is never reissued.
   * Absent on records written before this: healed to `max(id) + 1` on load,
   * which is exactly the old behaviour for a canvas that has never deleted.
   */
  nextVersion?: number
}

/**
 * THE LEASE, as this store sees it (M4).
 *
 * The lease is LIVENESS, not a stored field: a canvas belongs to the session
 * that rendered it for exactly as long as that session is live, and when it is
 * not, the canvas is OWNERLESS IN FLIGHT — resumable, dismissable, but never
 * auto-attached to anybody.
 *
 * This store is deliberately lifecycle-blind (it cannot see PTYs or tiles), so
 * the answer is injected. It fails SAFE in the direction that matters: an
 * oracle that throws counts as LIVE, and live means untouchable.
 *
 * The account is deliberately NOT part of this. A canvas belongs to the PROJECT
 * it was made for, not to whichever Claude account happened to be signed in when
 * it was drawn — switching accounts in a tile is an ordinary thing to do, and
 * making it an adoption key left users unable to open their own mockups. The
 * project is the axis, and it organises rather than forecloses. See ADR-017.
 */
export interface CanvasLivenessQuery {
  /**
   * True when the given session is LIVE right now.
   *
   * THE ANSWER MUST COME FROM AN UNFORGEABLE SIGNAL — main's own PTY registry,
   * never anything a caller supplies. This predicate gates who may resume,
   * dismiss and even SEE another session's canvas, and an earlier cut ORed in
   * the renderer's open-tile hint: a per-call array the CALLING session
   * composes. A same-project peer needed no forgery to defeat that, only to
   * leave the owner out of its own request. See
   * canvas-session-link.isSessionLive for the split that replaced it.
   *
   * A closed app's saved tiles are NOT live either: they cannot review
   * anything, and treating them as owners is what left work stranded with no
   * route back.
   */
  isSessionLive: (sessionId: string) => boolean
}

/**
 * "May this session act on a canvas stamped with THAT workspace?" — the second
 * factor on every destructive cross-session action.
 *
 * Injected for the same reason the liveness oracle is: the store holds the
 * record's stamps but not the caller's. canvas-session-link owns the rule (see
 * `sameWorkspace`) and hands the SAME predicate to the resume LIST and the
 * resume ACTION, because a list that offers what the action refuses is the
 * hole rather than the fix.
 */
export type CanvasWorkspaceCheck = (info: { cwd?: string; configId?: string }) => boolean

/**
 * What renderVersion stamps onto records; resolved per session by the pty
 * layer (canvas-session-link) so this store stays lifecycle-blind.
 *
 * `cwd`/`conversationUuid` are the continuity keys. `configId` and `auditLabels`
 * are M4 audit metadata: a lookup key into the user's own configs.json, and the
 * two display strings the Library's audit line reads. Neither authorizes
 * anything.
 *
 * The labels arrive WITHOUT a moment, deliberately: `at` is minted in this
 * store from main's own clock, so a stamp can never claim to have been written
 * at a time of the resolver's choosing.
 */
export type CanvasSessionInfoResolver = (sessionId: string) => {
  cwd?: string
  conversationUuid?: string
  configId?: string
  auditLabels?: Pick<AuditStamp, 'sessionLabel' | 'account'>
} | null

let sessionInfoResolver: CanvasSessionInfoResolver | null = null

export function setCanvasSessionInfoResolver(resolver: CanvasSessionInfoResolver | null): void {
  sessionInfoResolver = resolver
}

/** The spawn record for a session, or null. Resolver failures are swallowed:
 *  the stamps IMPROVE a row, and their absence must never refuse a write. */
function sessionInfoFor(sessionId: string): ReturnType<CanvasSessionInfoResolver> {
  try {
    return sessionInfoResolver ? sessionInfoResolver(sessionId) : null
  } catch {
    return null
  }
}

/**
 * The audit stamp for a write made BY this session, right now (M4).
 *
 * Exported because the review store stamps notes with it and imports this store
 * already (the dependency points this way). `at` is main's own clock — a stamp
 * whose moment a caller could choose is not provenance. The labels are cleaned
 * by `sanitizeAuditStamp`, so nothing that could make one audit line read as
 * two ever reaches disk.
 */
export function auditStampForSession(sessionId: string): AuditStamp | undefined {
  if (!SESSION_ID_RE.test(sessionId)) return undefined
  const spawn = sessionInfoFor(sessionId)?.auditLabels
  return sanitizeAuditStamp({
    sessionId,
    ...(spawn?.sessionLabel ? { sessionLabel: spawn.sessionLabel } : {}),
    ...(spawn?.account ? { account: spawn.account } : {}),
    at: new Date().toISOString(),
  })
}

/** What the ccc-ux:// protocol needs to serve a version. `contentRoot` is the
 *  only directory reads may resolve into (containment-checked by the caller). */
export interface ServableVersion {
  mode: 'uat' | 'design'
  contentRoot: string
  entry: string
}

const canvases = new Map<string, CanvasRecord>()
const sessionIndex = new Map<string, string>()
/**
 * The AGENT-side pointer for a subject-change draft in flight (#366).
 *
 * A draft that names a new subject writes to a NEW canvas, but the session's
 * user-facing binding (`sessionIndex`) must not move until the ready-mark:
 * moving it mid-draft sent the user's note writes and review reads to a canvas
 * they had never seen, while the renderer (correctly) kept their pane on the
 * old one (adversarial review, 2026-08-23). So the repoint and the filing are
 * DEFERRED — this map remembers where the agent is drafting so canvas_snapshot
 * can reach it, and the ready-mark performs the hand-over. In-memory only: an
 * abandoned draft pointer costs nothing, and the next draft re-finds its
 * canvas by subject.
 */
const draftIndex = new Map<string, string>()
let diskScanned = false

type CanvasChangedListener = (event: CanvasChangedEvent) => void
const changeListeners = new Set<CanvasChangedListener>()

/** Subscribe to store mutations (IPC handlers push these to the renderer). */
export function onCanvasChanged(listener: CanvasChangedListener): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function emitChanged(record: CanvasRecord, opts?: { draft?: boolean; completed?: boolean; reopened?: boolean }): void {
  const event: CanvasChangedEvent = {
    sessionId: record.sessionId,
    canvasId: record.canvasId,
    activeVersionId: record.activeVersionId,
    ...(opts?.draft ? { draft: true } : {}),
    ...(opts?.completed ? { completed: true } : {}),
    ...(opts?.reopened ? { reopened: true } : {}),
  }
  for (const listener of changeListeners) {
    try {
      listener(event)
    } catch (err) {
      console.warn('[canvas-store] change listener failed:', err)
    }
  }
}

function canvasRoot(): string {
  return path.join(getResourcesDirectory(), 'canvas')
}

function canvasDir(canvasId: string): string {
  return path.join(canvasRoot(), canvasId)
}

function canvasJsonPath(canvasId: string): string {
  return path.join(canvasDir(canvasId), 'canvas.json')
}

function versionDir(canvasId: string, versionId: string): string {
  return path.join(canvasDir(canvasId), 'versions', versionId)
}

// ---------------------------------------------------------------------------
// Record authentication
// ---------------------------------------------------------------------------
//
// WHY A canvas.json NEEDS A MAC (adversarial review, 2026-08-15).
//
// `sanitizeRecord` below checks SHAPE. Nothing in it — nothing anywhere —
// bound a record to something CCC actually wrote, so anyone able to create a
// file under `<resources>/canvas/` could hand-write `<24-hex>/canvas.json`
// naming a victim `sessionId` and a `distRoot` of their choosing, and after the
// next app start the store served it and offered it to the user as their own
// earlier work. It survived a restart, which made it the one
// disk-persistent deception primitive in this feature.
//
// It compounded: `record.sessionId` is the AUTHORIZATION key for serving
// (`getServableVersion` resolves a UAT distRoot against the roots registered
// for the OWNER session named in the record), so an unauthenticated on-disk
// field decided whose allowlist applied.
//
// So: every record is written with an HMAC over its whole content, keyed by a
// subkey of the install secret that never leaves this process, and a record
// that does not verify is REFUSED — not repaired, not shown unlabelled, not
// served. The key is derived through `deriveInstallKey` rather than minted here
// so there is one secret on this install and one place that mints it.
//
// COST, STATED: a canvas.json written before this shipped carries no `mac` and
// is refused on the next start, with a warning naming the directory. Nothing is
// deleted — the user can still see the files — but the canvas is gone from the
// app. That is the correct direction for a record whose provenance cannot be
// established, and it is a one-time cost on a feature that has not shipped.

const CANVAS_RECORD_MAC_PURPOSE = 'canvas-record-v1'

let _canvasRecordKey: Buffer | null = null
function canvasRecordKey(): Buffer {
  if (_canvasRecordKey === null) _canvasRecordKey = deriveInstallKey(CANVAS_RECORD_MAC_PURPOSE)
  return _canvasRecordKey
}

/**
 * A canonical byte-string for a record: key order cannot change the MAC, and
 * two different records cannot produce one string.
 *
 * Written out rather than `JSON.stringify(record)` because stringify's key
 * order is insertion order — the same record loaded, sanitized and re-persisted
 * can serialize differently, which would make a MAC over it fail against
 * itself. Every value is length-prefixed by JSON quoting, so no concatenation
 * ambiguity ("ab"+"c" vs "a"+"bc") exists.
 *
 * `undefined` members are skipped exactly as JSON.stringify skips them, so what
 * is authenticated is what is written.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== 'function')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
}

/** The MAC of a record, over everything in it except the MAC itself. */
function canvasRecordMac(record: CanvasRecord): string {
  return crypto
    .createHmac('sha256', canvasRecordKey())
    .update(`${CANVAS_RECORD_MAC_PURPOSE}\n${canonicalize(record)}`, 'utf8')
    .digest('hex')
}

/**
 * Did WE write this? Constant-time, and false for anything malformed.
 *
 * Takes the raw parsed JSON: the MAC covers the bytes as persisted, before any
 * sanitisation, so an unknown extra field a planted file carries is inside the
 * authenticated blob rather than beside it.
 */
export function verifyCanvasRecordMac(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false
  const { mac, ...rest } = parsed as Record<string, unknown>
  if (typeof mac !== 'string' || !/^[0-9a-f]{64}$/.test(mac)) return false
  let expected: string
  try {
    expected = canvasRecordMac(rest as unknown as CanvasRecord)
  } catch {
    return false // no key (no resources dir yet) ⇒ nothing verifies ⇒ nothing loads
  }
  return crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))
}

function persist(record: CanvasRecord): void {
  const dir = canvasDir(record.canvasId)
  mkdirSecure(dir)
  atomicWriteSecure(
    canvasJsonPath(record.canvasId),
    JSON.stringify({ ...record, mac: canvasRecordMac(record) }, null, 2),
  )
}

/** Is one version of a record structurally safe to keep? A false here means the
 *  version could do something dangerous if served (traverse, name a device), so
 *  it is DROPPED. "Not an HTML document" is not checked — that version is kept
 *  and simply refused at serve time (getServableVersion). */
function isKeepableVersion(v: unknown): v is CanvasVersion {
  const ver = v as Partial<CanvasVersion> | undefined
  if (typeof ver?.id !== 'string' || !CANVAS_VERSION_ID_RE.test(ver.id)) return false
  if (ver.source?.mode !== 'uat' && ver.source?.mode !== 'design') return false
  // `mode` is what the page IS (chip + authoring skill); `source.mode` is how it
  // is stored. They are separate fields and only `source.mode` gates serving, so
  // a bad `mode` cannot reach the serve path -- but it is rendered as a label, and
  // this file's posture is that a hand-edited record is never repaired. A version
  // whose mode is not one of the three is dropped rather than shown as a chip
  // naming whatever the file said.
  if (ver.mode !== 'uat' && ver.mode !== 'design' && ver.mode !== 'plan') return false
  // The draft flag is a BOOLEAN or absent — a hand-edited truthy string must
  // not survive into a field the queue derivation reads. `false` is accepted
  // (it means what absence means), so a future writer spelling ready-ness as
  // draft:false cannot silently destroy versions on load.
  if (ver.draft !== undefined && typeof ver.draft !== 'boolean') return false
  // `archived` (item C, phase 5) is a BOOLEAN or absent, same posture as
  // `draft`: a hand-edited truthy string must not survive into a field the
  // history projection reads.
  if (ver.archived !== undefined && typeof ver.archived !== 'boolean') return false
  // `show` (show-and-tell) is a BOOLEAN or absent, same posture again: the
  // open-version derivation and the completion guard read it, so a hand-edited
  // truthy string must not survive to exempt a version from review debt.
  if (ver.show !== undefined && typeof ver.show !== 'boolean') return false
  // The C1 verdict is OUR shape or absent — the queue derivation and the
  // History badges read it, so a hand-edited blob is dropped with its version
  // (never repaired), the same all-or-nothing rule every field here follows.
  if (ver.verdict !== undefined && !isKeepableVerdict(ver.verdict)) return false
  // The reopen audit trail (adv FINDING 2): an array of past verdicts, each
  // OUR shape or the whole version drops. Bounded so a hand-edited record
  // cannot make the History row unboundedly large.
  if (ver.priorVerdicts !== undefined) {
    if (!Array.isArray(ver.priorVerdicts) || ver.priorVerdicts.length > 64) return false
    if (!ver.priorVerdicts.every((pv) => isKeepableVerdict(pv))) return false
  }
  // A hand-edited record must not smuggle a traversing/colon/device `entry`
  // past the live-render normalizer (the empty-path + SPA branches serve the
  // entry WITHOUT re-running the URL segment filter). distRoot containment is
  // re-checked at serve time (getServableVersion) so a de-registered base is
  // also honoured, but reject an obviously-broken distRoot shape here too.
  if (!isSafeEntry(ver.source.entry)) return false
  if (ver.source.mode === 'uat' && (typeof ver.source.distRoot !== 'string' || ver.source.distRoot.length === 0)) return false
  // The user's pack name (M3): OUR sanitised shape or absent. Checked by
  // ROUND-TRIP rather than by a character class — the value is written through
  // `sanitizePackName`, so a stored name that does not equal its own
  // re-sanitisation was not written by this build, and a hand-edited one
  // carrying bidi overrides or an over-long run is dropped with its version
  // rather than rendered in the header the user reads.
  if (ver.packName !== undefined && sanitizePackName(ver.packName) !== ver.packName) return false
  // WHO rendered it (M4). Checked by ROUND-TRIP against the shared healer, for
  // the same reason `packName` is: a stamp that does not equal its own
  // re-sanitisation was not written by this build. It is DROPPED rather than
  // fatal — `sanitizeRecord` strips a malformed one before this runs, so
  // reaching here out of shape means a writer inside this process produced
  // something this build does not define, and a version is worth more than an
  // audit line.
  if (ver.renderedBy !== undefined && sanitizeAuditStamp(ver.renderedBy) === undefined) return false
  return true
}

/**
 * Shape validation for a canvas.json read back from disk. A corrupt or
 * hand-edited file is never repaired and never served as-is — but the unit of
 * rejection is the VERSION, not the whole canvas.
 *
 * The first cut returned false for the whole record when any single version
 * failed, which made a canvas an all-or-nothing object: one legacy version with
 * an entry the current build will not accept (a pre-BLOCKER-1 `.xhtml`, say)
 * discarded every good design version beside it, along with the user's history.
 * A record's own identity fields still fail the record — those describe the
 * canvas rather than one item in it.
 *
 * Returns a record whose `versions` are all keepable and whose `activeVersionId`
 * still names one of them (or null). Nothing is written back: the in-memory
 * record is the sanitized one and the next render persists that shape.
 */
function sanitizeRecord(value: unknown): CanvasRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const r = value as Partial<CanvasRecord>
  if (typeof r.canvasId !== 'string' || !CANVAS_ID_RE.test(r.canvasId)) return null
  if (typeof r.sessionId !== 'string' || !SESSION_ID_RE.test(r.sessionId)) return null
  // Continuity stamps are optional, but a present one must be OUR shape — the
  // same strictness as every other field of a record read back from disk.
  if (r.cwd !== undefined && (typeof r.cwd !== 'string' || r.cwd.length === 0 || r.cwd.length > MAX_CWD_CHARS)) return null
  if (r.conversationUuid !== undefined && (typeof r.conversationUuid !== 'string' || !CONVERSATION_UUID_RE.test(r.conversationUuid))) return null
  // Records written before ADR-017 carry a `profileId` stamp. It decides
  // nothing now, so it is not validated — and because the record below is built
  // field by field rather than spread, it simply does not survive the read.
  // The title is re-cleaned rather than validated: it is free text from the
  // agent, so a record written by an older build (or hand-edited) is normalised
  // to the same shape a fresh render produces, and an unusable one simply drops
  // out rather than condemning the whole record.
  if (r.title !== undefined) {
    const cleanTitle = sanitizeCanvasTitle(r.title)
    if (cleanTitle) r.title = cleanTitle
    else delete r.title
  }
  if (r.activeVersionId !== null && (typeof r.activeVersionId !== 'string' || !CANVAS_VERSION_ID_RE.test(r.activeVersionId))) return null
  if (!Array.isArray(r.versions)) return null

  const versions: CanvasVersion[] = []
  for (const v of r.versions) {
    // AUDIT STAMPS HEAL, THEY NEVER CONDEMN (M4). A stamp is provenance, not
    // content: a malformed one is rebuilt to what this build understands and,
    // failing that, removed — dropping the whole VERSION (and with it the
    // user's rendered document) over an audit line would be the mistake this
    // file's load path exists to prevent. Done before the keeper runs, so what
    // it validates is either our shape or absent.
    const raw = v as { renderedBy?: unknown } | null
    if (raw && typeof raw === 'object' && raw.renderedBy !== undefined) {
      const healed = sanitizeAuditStamp(raw.renderedBy)
      if (healed) raw.renderedBy = healed
      else delete raw.renderedBy
    }
    if (!isKeepableVersion(v)) continue
    if (versions.some((kept) => kept.id === v.id)) continue // ids are the serve key
    versions.push(v)
  }
  // C1 healing: history written before version verdicts existed piles up as
  // "open" rounds — the exact phantom-count bug the state machine kills. Every
  // non-latest ready version of each artifact run is stamped SUPERSEDED by the
  // render that followed it (its successor's timestamp, actor 'system').
  // Idempotent — already-stamped versions are left alone — and in-memory like
  // the rest of this function: the next persist writes the healed shape.
  for (const run of artifactRuns(versions)) {
    // Show-and-tell versions sit OUTSIDE the review flow: they are neither
    // stamped superseded (they were never open) nor treated as a successor
    // that supersedes — otherwise a reload would durably retro-supersede an
    // open review version under a later show render, vanishing its debt with
    // no user gesture (independent review of the show lane, 2026-08-27).
    // WITHDRAWN versions are filtered for the same reason and to match
    // openVersionOf exactly: a reopened version has later withdrawn siblings, so
    // leaving them in reviewRun would make the reopened (open) version no longer
    // "last" and retro-supersede it on reload — stranding the review the user
    // just reopened (adversarial re-attack of the show lane, 2026-08-27).
    const reviewRun = run.filter((v) => !v.show && v.verdict?.state !== 'withdrawn')
    for (let i = 0; i < reviewRun.length - 1; i++) {
      if (!reviewRun[i].verdict) reviewRun[i].verdict = { state: 'superseded', by: 'system', at: reviewRun[i + 1].createdAt }
    }
  }
  // The active version must still exist. Only re-pointed when the one it named
  // was dropped — falling back to the newest SURVIVING version keeps the pane
  // showing something rather than an id that resolves to nothing. An explicit
  // null stays null.
  let activeVersionId = r.activeVersionId
  if (activeVersionId !== null && !versions.some((v) => v.id === activeVersionId)) {
    activeVersionId = versions[versions.length - 1]?.id ?? null
  }

  // The review-needed stamp (#366) is dropped, never repaired, when it is not
  // OUR shape or names a version that did not survive — and a stamp pointing
  // at a DRAFT is contradictory (a draft has not been offered for review), so
  // it is dropped too rather than surfacing a round the user cannot open.
  let awaitingReview: CanvasAwaitingReview | undefined
  const rawAwaiting = (r as { awaitingReview?: unknown }).awaitingReview
  if (rawAwaiting && typeof rawAwaiting === 'object') {
    const a = rawAwaiting as Partial<CanvasAwaitingReview>
    const target = typeof a.versionId === 'string' ? versions.find((v) => v.id === a.versionId) : undefined
    if (target && !target.draft && typeof a.at === 'string') {
      awaitingReview = { versionId: target.id, at: a.at }
    }
  }

  // The sign-off stamp (#476) is dropped, never repaired, when it is not OUR
  // shape — a malformed stamp must not resurrect as "completed by you".
  let completed: CanvasCompletion | undefined
  const rawCompleted = (r as { completed?: unknown }).completed
  if (rawCompleted && typeof rawCompleted === 'object') {
    const c = rawCompleted as Partial<CanvasCompletion>
    if (typeof c.at === 'string' && (c.by === 'user' || c.by === 'agent')) {
      completed = { at: c.at, by: c.by }
    }
  }

  // The monotonic version high-water mark (item C, phase 5). Healed to at least
  // `max(surviving id) + 1` so it can never mint an id that already exists, and
  // never below a value the file already recorded — a delete persists a counter
  // ABOVE the survivors precisely so the deleted ids are not reissued, and that
  // must survive a reload. A non-integer or too-low value is repaired UP, never
  // trusted down.
  const maxId = versions.reduce((m, v) => {
    const n = Number.parseInt(v.id.slice(1), 10)
    return Number.isFinite(n) && n > m ? n : m
  }, 0)
  const rawNext = (r as { nextVersion?: unknown }).nextVersion
  const nextVersion = Number.isInteger(rawNext) && (rawNext as number) > maxId ? (rawNext as number) : maxId + 1

  // The M4 audit fields. Both DROP rather than condemn, for the reason the
  // per-version stamp does: they describe provenance, and a record written by a
  // build that did not know them is not corrupt. Absent = unknown everywhere
  // downstream, which every reader already has to handle.
  const createdBy = sanitizeAuditStamp((r as { createdBy?: unknown }).createdBy)
  const configId = sanitizeCanvasConfigId((r as { configId?: unknown }).configId)

  // Built field by field, not spread from what was on disk.
  //
  // The MAC is the envelope rather than part of the record, so it has to come
  // off — otherwise the in-memory record, and therefore the NEXT persist which
  // re-MACs, carries a stale one inside the authenticated content. Spreading
  // `rest` did that but also carried anything ELSE the file happened to hold: an
  // unknown field survived validation and was written back into a freshly
  // signed record, which is the opposite of "a hand-edited file is never
  // repaired". Naming the fields keeps the record exactly the shape this build
  // understands, and is also how a field that has been retired (`profileId`,
  // ADR-017) stops travelling.
  return {
    canvasId: r.canvasId,
    sessionId: r.sessionId,
    createdAt: r.createdAt as string,
    ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
    ...(r.conversationUuid !== undefined ? { conversationUuid: r.conversationUuid } : {}),
    ...(r.title !== undefined ? { title: r.title } : {}),
    versions,
    activeVersionId,
    nextVersion,
    ...(awaitingReview ? { awaitingReview } : {}),
    ...(completed ? { completed } : {}),
    ...(createdBy ? { createdBy } : {}),
    ...(configId ? { configId } : {}),
  }
}

function loadFromDisk(canvasId: string): CanvasRecord | null {
  try {
    const raw = fs.readFileSync(canvasJsonPath(canvasId), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    // Provenance BEFORE shape. A planted record is well-shaped by construction
    // — shape validation was never the thing standing between a hand-written
    // canvas.json and the user being offered it as their own work.
    if (!verifyCanvasRecordMac(parsed)) {
      console.warn(
        `[canvas-store] refusing ${canvasJsonPath(canvasId)}: it carries no valid signature, so this app did not write it ` +
          '(a canvas.json from a build before record signing landed will also read this way).',
      )
      return null
    }
    const record = sanitizeRecord(parsed)
    if (!record || record.canvasId !== canvasId) return null
    return record
  } catch {
    return null
  }
}

/** One-time lazy scan so canvases survive an app restart. */
function ensureDiskScanned(): void {
  if (diskScanned) return
  diskScanned = true
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(canvasRoot(), { withFileTypes: true })
  } catch {
    return // no canvas dir yet
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !CANVAS_ID_RE.test(entry.name) || canvases.has(entry.name)) continue
    const record = loadFromDisk(entry.name)
    if (!record) continue
    canvases.set(record.canvasId, record)
    // The session's ACTIVE canvas is the one it rendered to most recently.
    //
    // This used to be "first record wins", written when a session had exactly
    // one canvas. Now that a subject change files a canvas and starts another,
    // several records share a session, and readdir order on NTFS is by id —
    // random. Relaunching then reopened the pane on whichever filed subject
    // sorted first, complete with that subject's old notes, and the next
    // same-title render forked a duplicate: both of the things the subject
    // rule exists to prevent.
    // A COMPLETED canvas never rebinds (#476): completion detached it, and
    // that must survive a relaunch — the session never comes back bound to a
    // signed-off subject. It falls to the most-recently-active canvas it still
    // owns that is NOT completed (a live filed subject), or to the front page
    // when it owns none. The canvas stays in the library either way.
    if (record.completed) continue
    const held = sessionIndex.get(record.sessionId)
    const heldRecord = held ? canvases.get(held) : undefined
    if (!heldRecord || moreRecentlyActive(record, heldRecord)) {
      sessionIndex.set(record.sessionId, record.canvasId)
    }
  }
}

/**
 * A render timestamp that is strictly later than the previous one this process
 * issued. Wall-clock ISO strings carry millisecond precision, and two renders
 * in one tick — file this subject, start that one — would tie, leaving "the
 * canvas last rendered to" undefined for the next launch to guess at. Bumping
 * a tie forward by one millisecond keeps the order the renders actually
 * happened in, which is the only order the user would recognise.
 */
let lastRenderStamp = ''
function nextRenderStamp(): string {
  let stamp = new Date().toISOString()
  if (stamp <= lastRenderStamp) {
    stamp = new Date(Date.parse(lastRenderStamp) + 1).toISOString()
  }
  lastRenderStamp = stamp
  return stamp
}

/** When a canvas last received a version; its own creation if it has none. */
function lastRenderedAt(record: CanvasRecord): string {
  return record.versions[record.versions.length - 1]?.createdAt ?? record.createdAt
}

/**
 * Is `a` the canvas the session was more recently working on than `b`?
 *
 * Timestamps first — but ISO strings carry millisecond precision and two
 * renders in one tick tie, which is exactly what a quick "file this, start
 * that" sequence produces (and what the CI macOS leg produced on the first
 * run). A tie must still resolve the SAME way on every launch, so it falls to
 * a stable, content-derived order rather than to readdir: more versions wins
 * (the canvas that saw more work), then the id, which is random but fixed.
 * Never the position in the directory listing, which is the arbitrary answer
 * this replaces.
 */
function moreRecentlyActive(a: CanvasRecord, b: CanvasRecord): boolean {
  const ta = lastRenderedAt(a)
  const tb = lastRenderedAt(b)
  if (ta !== tb) return ta > tb
  if (a.versions.length !== b.versions.length) return a.versions.length > b.versions.length
  return a.canvasId > b.canvasId
}

/**
 * The canvas this session is CURRENTLY pointed at — and only if the record
 * agrees that it is theirs.
 *
 * `sessionIndex` is a cache of a fact the RECORD owns, and this used to trust
 * it alone. Every session-keyed mutation resolves through here
 * (`setVersionVerdict`, `reopenVersionForReview`, `setActiveVersion`,
 * `setPackName`, and the review store's `canvasForSession`), so ONE stale entry
 * turns all of them into cross-session writes. The index can genuinely go
 * stale: a caller-supplied liveness oracle is invoked mid-resume, and a
 * re-entrant call from inside it moves ownership under the outer call's feet.
 * The resume and `deleteCanvas` both sweep the index, but a cache that is only
 * ever swept is one missed path away from lying — so the record is asked, every
 * time, and a disagreeing entry is DROPPED rather than served.
 */
function getRecordForSession(sessionId: string): CanvasRecord | null {
  ensureDiskScanned()
  const canvasId = sessionIndex.get(sessionId)
  if (!canvasId) return null
  const record = canvases.get(canvasId)
  // Self-heal: the entry names a canvas that is gone, or one the record says
  // belongs to somebody else. Either way this session is pointed at nothing.
  if (!record || record.sessionId !== sessionId) {
    sessionIndex.delete(sessionId)
    return null
  }
  return record
}

function getRecord(canvasId: string): CanvasRecord | null {
  if (!CANVAS_ID_RE.test(canvasId)) return null
  ensureDiskScanned()
  return canvases.get(canvasId) ?? null
}

function toState(record: CanvasRecord): CanvasState {
  return {
    canvasId: record.canvasId,
    sessionId: record.sessionId,
    activeVersionId: record.activeVersionId,
    versions: record.versions.map((v) => ({
      ...v,
      source: { ...v.source },
      ...(v.renderedBy ? { renderedBy: { ...v.renderedBy } } : {}),
    })),
    ...(record.title ? { title: record.title } : {}),
    ...(record.awaitingReview ? { awaitingReview: { ...record.awaitingReview } } : {}),
    ...(record.completed ? { completed: { ...record.completed } } : {}),
    ...(record.createdBy ? { createdBy: { ...record.createdBy } } : {}),
    ...(record.configId ? { configId: record.configId } : {}),
  }
}

/** One canvas's state by id — the completion guard's read (#476). */
export function getCanvasStateById(canvasId: string): CanvasState | null {
  const record = getRecord(canvasId)
  return record ? toState(record) : null
}

/** The renderer's view of a session's canvas; null until something rendered. */
export function getCanvasStateForSession(sessionId: string): CanvasState | null {
  if (!SESSION_ID_RE.test(sessionId)) return null
  const record = getRecordForSession(sessionId)
  return record ? toState(record) : null
}

/**
 * The canvas the AGENT is working on: the drafting canvas while a
 * subject-change draft is in flight (#366), else the session's own. Feeds
 * `canvas_snapshot` ONLY, so the self-check loop can read the draft — review
 * reads and note writes stay on the user-facing binding, because reviews live
 * where the user can see.
 */
export function getAgentCanvasStateForSession(sessionId: string): CanvasState | null {
  if (!SESSION_ID_RE.test(sessionId)) return null
  const draftingId = draftIndex.get(sessionId)
  if (draftingId) {
    const record = canvases.get(draftingId)
    if (record) return toState(record)
    draftIndex.delete(sessionId)
  }
  return getCanvasStateForSession(sessionId)
}

/** The next linear version NUMBER for a record with no counter yet: one past
 *  the highest already present. The healing floor for a pre-counter record and
 *  for a brand-new canvas; once a record has `nextVersion`, that is used
 *  instead (it can sit ABOVE this after a delete). */
function nextVersionNumber(versions: CanvasVersion[]): number {
  let max = 0
  for (const v of versions) {
    const n = Number.parseInt(v.id.slice(1), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max + 1
}

/**
 * Register a new content version for the session's canvas (creating the canvas
 * on first render) and make it active. This is THE ingress for content — the
 * IPC dev path and the future canvas_render MCP tool both land here.
 */
/**
 * A canvas title as it will be STORED: a label, and treated like every other
 * label that crosses this boundary. Control and format characters go (they can
 * reorder or hide what the user reads), whitespace collapses, and the result is
 * capped. Empty after cleaning means "no title given", not an error — a render
 * without one keeps the old behaviour of appending to whatever canvas the
 * session holds.
 */
function sanitizeLabelText(raw: unknown, maxChars: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  // Strip → cap → strip again. The cap is in UTF-16 code units and can cut a
  // surrogate pair in half, and it can leave a trailing space that a re-clean
  // on load would then remove — either way the stored title would not equal its
  // own re-sanitisation, which is the shape of a MAC hazard. Cleaning after the
  // cap makes the function idempotent, and Array.from splits by code point so
  // an emoji at the boundary is dropped whole rather than halved.
  const clean = (s: string) => s.replace(TITLE_STRIP_RE, '').replace(/\s+/g, ' ').trim()
  const cleaned = clean(raw)
  if (cleaned.length === 0) return undefined
  const capped = Array.from(cleaned).slice(0, maxChars).join('')
  const final = clean(capped)
  return final.length === 0 ? undefined : final
}

function sanitizeCanvasTitle(raw: unknown): string | undefined {
  return sanitizeLabelText(raw, MAX_CANVAS_TITLE_CHARS)
}

/**
 * The user's own name for a TEST PACK (M3).
 *
 * The title's rules, at the pack's cap: the pack name sits in the pane header
 * and in the Library beside a delete button, so the question is the title's
 * question — can this make one row read as another — and the answer is the same
 * strip list. Idempotent for the same MAC reason: this string is inside the
 * record the HMAC covers.
 */
function sanitizePackName(raw: unknown): string | undefined {
  return sanitizeLabelText(raw, MAX_PACK_NAME_CHARS)
}

/**
 * Characters a title may not carry, over and above FORMAT_CONTROLS_RE.
 *
 * The title sits in the library beside a delete button, so the question is not
 * "can this break anything" but "can this make one row read as another". Format
 * controls (bidi overrides) are the classic; combining marks, variation
 * selectors, private-use, unassigned and surrogate code points also render as
 * nothing or as decoration and let `Chеckout` (Cyrillic е) or `Check͏out`
 * pass for `Checkout`. All of those go. Letters and digits of every script stay,
 * which is what `sameSubject` below is written against.
 */
const TITLE_STRIP_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Mn}\p{Me}\p{Co}\p{Cn}\p{Cs}ᅟᅠㅤﾠ]/gu

/**
 * The comparison key for a subject.
 *
 * NFKC-folded, lower-cased, reduced to letters and digits OF ANY SCRIPT. The
 * first version of this used `[^a-z0-9]`, which turned every non-Latin title —
 * Cyrillic, CJK, Arabic, emoji-only — into the empty string, so all of them
 * were "the same subject" and the feature did nothing for anyone not writing
 * English. Returns undefined when nothing survives, and callers must treat that
 * as "no comparable subject" rather than compare two empties as equal.
 */
function subjectKey(title: string): string | undefined {
  const key = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return key.length > 0 ? key : undefined
}

/**
 * Do two titles name the same subject?
 *
 * Deliberately forgiving: case and surrounding punctuation should not split a
 * canvas in two, because the cost of a false DIFFERENT (the user's version
 * history silently forks) is worse than the cost of a false SAME (one extra
 * version on the right canvas). An agent that means a new subject will not
 * express it as a change of capitalisation. Two titles that reduce to NOTHING
 * are not the same subject — they are unrelated titles we cannot compare.
 */
function sameSubject(a: string, b: string): boolean {
  const ka = subjectKey(a)
  const kb = subjectKey(b)
  return ka !== undefined && ka === kb
}

/**
 * A canvas this session filed earlier under the same subject, if any. Owned by
 * THIS session only: another session's canvas is never adopted here — that is
 * an authorization decision and stays with `resumeCanvasForSession`, which the
 * user drives. Newest first, so returning to a subject the session has filed
 * twice picks the one most recently worked on.
 */
function countCanvasesForSession(sessionId: string): number {
  let n = 0
  for (const record of canvases.values()) if (record.sessionId === sessionId) n++
  return n
}

function findFiledCanvas(sessionId: string, title: string): CanvasRecord | undefined {
  let best: CanvasRecord | undefined
  for (const record of canvases.values()) {
    if (record.sessionId !== sessionId || !record.title || !sameSubject(title, record.title)) continue
    // A signed-off subject (#476) is terminal history: coming back to its
    // TITLE starts a fresh canvas rather than silently resuming the one the
    // user completed. Reopen from the library is the deliberate way back.
    if (record.completed) continue
    if (!best || lastRenderedAt(record) > lastRenderedAt(best)) best = record
  }
  return best
}

export function renderVersion(
  sessionId: string,
  source: CanvasRenderSource,
): {
  canvasId: string
  versionId: string
  draft?: boolean
  filed?: { canvasId: string; returnedToExisting: boolean }
  /** C1: ready versions this render auto-superseded — the ingress settles
   *  their review notes (the store cannot import the review store). */
  superseded?: string[]
} {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('invalid session id')

  // A COMPLETED canvas bound as current (the user opened it from the library
  // to look, #476) is a viewing surface, not a rendering target: treat it as
  // no-held, so the render starts a fresh canvas exactly as it would from the
  // front page — including the untitled case, which could otherwise never
  // render again. The refusal below stays as the invariant's backstop.
  const boundRecord = getRecordForSession(sessionId)
  const detachedByCompletion = Boolean(boundRecord?.completed)
  const held = detachedByCompletion ? null : boundRecord
  const title = sanitizeCanvasTitle(source.title)

  // A canvas holds ONE subject, and this is where that is decided.
  //
  // Without it a session has exactly one canvas forever: every render appends,
  // whatever it is of. Show a login screen, then a title bar, then a chart, and
  // all three are "the same canvas" — the version list mixes unrelated work and,
  // worse, unresolved notes from the earlier subject are carried forward and
  // presented as open notes against the new page, anchored to elements that do
  // not exist in it. That is confusing on its own and it makes the user wary of
  // annotating at all, which costs the whole review loop.
  //
  // So a render that names a DIFFERENT subject files the current canvas — it
  // stays on disk and in the library, it simply stops being this session's
  // active one — and starts a fresh canvas. Same subject (or no title given at
  // all, which is the pre-existing behaviour) appends a version as before.
  // A title with no readable subject — emoji only, punctuation only — is
  // treated as no title: it cannot start a canvas we could ever come back to,
  // and it must not fork the one we are on. It still gets stored as the label.
  const comparable = title !== undefined && subjectKey(title) !== undefined
  const subjectChanged = Boolean(held && comparable && held.title && !sameSubject(title!, held.title))
  // Coming BACK to a subject re-activates its canvas rather than minting a
  // third: "Login page" → "Checkout" → "Login page" must land on the login
  // canvas, with its versions and its notes, not open a second one beside it.
  //
  // The filed lookup also runs when there is NO held canvas (#476): the front
  // page, or the state completion leaves behind — it detaches the session, so
  // the next render sees held null. A comparable title may name a DIFFERENT
  // subject the session filed earlier and left LIVE; returning to it is the
  // subject rule, and skipping the lookup forked a duplicate (and stranded a
  // deferred subject-change draft, whose ready-mark then minted a third canvas
  // instead of promoting). The lookup skips completed records, so it never
  // resumes the signed-off one. A brand-new session finds nothing here and
  // starts fresh exactly as before.
  const wantsFiled = Boolean(comparable && title && (subjectChanged || !held))
  const returnedTo = wantsFiled ? findFiledCanvas(sessionId, title!) : undefined
  // subjectChanged (held, different subject) → the filed canvas of the NEW
  // subject, or a fresh one. No held (front page / post-completion) →
  // likewise. Same subject on a held canvas → append to it.
  const existing = subjectChanged ? returnedTo : (held ?? returnedTo)

  // #476: a signed-off subject is terminal. `existing` can no longer BE a
  // completed record — `held` is nulled for one and `findFiledCanvas` skips
  // them — so this is an unreachable defence-in-depth backstop, kept so the
  // invariant has a hard floor if either of those skips ever regresses.
  if (existing?.completed) {
    throw new Error(
      `this canvas was signed off as complete; the user can Reopen it from the library — otherwise render under a title as usual to start fresh`,
    )
  }

  // The ready flag (#366). `false` = a DRAFT that supersedes the previous
  // draft in place; `true` = the deliberate ready-mark that promotes it;
  // absent = the pre-draft behaviour (append, surface, count as ready).
  const isDraft = source.ready === false
  // Show-and-tell (owner call, 2026-08-27): a READY render that owes no
  // review. Meaningless on a draft — the draft path already surfaces nothing.
  const isShow = !isDraft && source.intent === 'show'
  const latest = existing?.versions[existing.versions.length - 1]
  // A draft replaces the previous DRAFT; the ready-mark promotes it. Both
  // reuse the version id, so an agent's self-review loop cannot burn the
  // version cap — only content the user can actually be shown consumes ids.
  const reuseLatest = latest?.draft === true && (isDraft || source.ready === true)

  if (!reuseLatest && existing && existing.versions.length >= MAX_VERSIONS_PER_CANVAS) {
    throw new Error(`canvas ${existing.canvasId} is at its version cap (${MAX_VERSIONS_PER_CANVAS})`)
  }
  // Minting a NEW canvas (no `existing` to append to) is the one thing that
  // grows the number a session owns. Cap it, so an agent cannot mint
  // directories without bound — each is a synchronous read and an HMAC at the
  // next launch. Gated on `!existing` alone, NOT on `subjectChanged` (#476):
  // completion detaches, so every post-completion render has `held === null`
  // and `subjectChanged === false`, and the old gate let an agent that
  // completes-then-renders in a loop bypass the cap entirely. The session's
  // first-ever render is `!existing` too but `countCanvasesForSession` is 0
  // then, so it is never the one refused. Filing goes on working: the user
  // clears room from the library.
  if (!existing && countCanvasesForSession(sessionId) >= MAX_CANVASES_PER_SESSION) {
    throw new Error(
      `this session already has ${MAX_CANVASES_PER_SESSION} canvases; delete some from the library before starting another subject`,
    )
  }

  // Everything that can REJECT the render is validated up front, before any
  // canvas state is created or mutated — a rejected render leaves nothing
  // behind (no empty canvas, no half-written version).
  const canvasId = existing?.canvasId ?? randomId()
  // The next number from the MONOTONIC counter, not `max(existing) + 1`. A
  // record loaded from disk always carries `nextVersion` (healed in
  // sanitizeRecord to at least max+1), and a delete leaves it ABOVE the
  // survivors — so a deleted id is never reissued. A brand-new canvas (no
  // `existing`) starts at 1. A superseding draft (or the promote of one) keeps
  // the id it already holds and mints nothing.
  const mintNum = existing?.nextVersion ?? nextVersionNumber(existing?.versions ?? [])
  const versionId = reuseLatest ? latest!.id : `v${mintNum}`
  const createdAt = nextRenderStamp()
  let version: CanvasVersion

  if (source.mode === 'design' || source.mode === 'plan') {
    // One branch for both on purpose. A plan is an agent-authored standalone
    // document exactly as a design is, so it is written, stored and later served
    // through the identical path -- see CanvasRenderSource. Only the VERSION's mode
    // differs, which is what the pane's chip and the authoring skill read. No
    // serving or validation path gains a branch, so plan mode reaches no surface
    // design mode did not already reach.
    if (typeof source.html !== 'string' || source.html.length === 0) throw new Error('design render requires html')
    if (Buffer.byteLength(source.html, 'utf8') > MAX_DESIGN_HTML_BYTES) throw new Error('design document too large')
    // A superseding draft (and the ready-mark that promotes one) writes into
    // the SAME version directory — atomicWriteSecure replaces the file whole,
    // so a reader never sees a half-written document.
    const dir = versionDir(canvasId, versionId)
    mkdirSecure(dir)
    atomicWriteSecure(path.join(dir, 'index.html'), source.html)
    version = {
      id: versionId,
      mode: source.mode,
      createdAt,
      source: { mode: 'design', entry: 'index.html' },
      ...(isDraft ? { draft: true as const } : {}),
      ...(isShow ? { show: true as const } : {}),
    }
  } else if (source.mode === 'uat') {
    const distRoot = path.resolve(source.distRoot)
    let stat: fs.Stats
    try {
      stat = fs.statSync(distRoot)
    } catch {
      throw new Error('distRoot does not exist')
    }
    if (!stat.isDirectory()) throw new Error('distRoot is not a directory')
    // Fail closed: a UAT root must sit under a base registered for THIS session,
    // or it is not a canvas — the whole-disk-file-server defense (adversarial
    // review 2026-08-11), now per-session (2026-08-15).
    if (!distRootAllowed(distRoot, sessionId)) throw new Error('distRoot is not under a registered canvas UAT root')
    const entry = normalizeEntry(source.entry ?? 'index.html')
    version = {
      id: versionId,
      mode: 'uat',
      createdAt,
      source: { mode: 'uat', distRoot, entry, ...(source.buildLabel ? { buildLabel: source.buildLabel } : {}) },
      ...(isDraft ? { draft: true as const } : {}),
      ...(isShow ? { show: true as const } : {}),
    }
  } else {
    throw new Error('unknown render mode')
  }

  // Persist BEFORE the in-memory commit, and to a record built off to the side
  // rather than by mutating the live one.
  //
  // The old order pushed the version, set it active, and put the record in the
  // maps, and only THEN wrote canvas.json. If that write threw — a held handle
  // on the hot, rewritten-every-render file, ENOSPC, a Defender/indexer lock —
  // the caller got a rejected render (the throw propagates) while the store had
  // already made the rejected document the ACTIVE, servable version in memory:
  // `getServableVersion` returned it and the version counter had advanced. That
  // is the exact fail-open this path claims not to have, and the canvas_render
  // MCP tool (P3) makes the sink reachable by a prompt-injectable agent, so a
  // document the agent was told failed to render could be served to the user as
  // its work (adversarial review, 2026-08-12).
  //
  // Now nothing in memory changes until the durable write has succeeded. A
  // persist failure leaves the live maps untouched — the render fails closed —
  // and at worst orphans the already-written `versions/<vid>/` dir, which no
  // record references and the protocol never serves.
  // Continuity stamps (adoption keys): cwd is stamped once and never drifts —
  // the canvas belongs to the project it was born in; conversationUuid tracks
  // the LATEST render, so a canvas re-rendered under a resumed conversation
  // follows that conversation. Resolver failures stamp nothing (fail open —
  // stamps improve adoption, their absence must never refuse a render).
  const info: ReturnType<CanvasSessionInfoResolver> = sessionInfoFor(sessionId)
  const cwdStamp =
    typeof info?.cwd === 'string' && info.cwd.length > 0 && info.cwd.length <= MAX_CWD_CHARS ? info.cwd : undefined
  const conversationStamp =
    typeof info?.conversationUuid === 'string' && CONVERSATION_UUID_RE.test(info.conversationUuid)
      ? info.conversationUuid
      : undefined
  // M4 audit metadata. `configId` and `createdBy` are CREATION stamps: they say
  // what the canvas was made under and by whom, so — like `cwd` — they are
  // written once and never drift. A later render (or an adoption) changes the
  // owner, not the history. `renderedBy` is per version, so it tracks whoever
  // actually produced that version.
  const configIdStamp = sanitizeCanvasConfigId(info?.configId)
  const renderStamp = sanitizeAuditStamp({
    sessionId,
    ...(info?.auditLabels?.sessionLabel ? { sessionLabel: info.auditLabels.sessionLabel } : {}),
    ...(info?.auditLabels?.account ? { account: info.auditLabels.account } : {}),
    at: createdAt,
  })
  version = { ...version, ...(renderStamp ? { renderedBy: renderStamp } : {}) }

  const base: CanvasRecord = existing ?? { canvasId, sessionId, createdAt, activeVersionId: null, versions: [] }
  // Not-a-draft means READY — a deliberate ready-mark, or a render from a flow
  // that has not learned the flag (which must never be invisible). Either way
  // the round now awaits the user's first review; a draft leaves whatever was
  // already owed exactly as it stood. A SHOW-AND-TELL render is ready but owes
  // no review: like a draft it leaves the existing debt untouched — it neither
  // creates a first-look obligation nor clears one already standing.
  const awaitingReview = isDraft || isShow ? base.awaitingReview : { versionId, at: createdAt }
  // C1: a READY render supersedes the ARTIFACT's previously open version —
  // the one-open-per-artifact invariant, enforced at the only place a new
  // open version can be born, so "23 versions pending review" is impossible
  // by construction rather than by patched counters. Scoped to the run the
  // new version JOINS (same mode, not archived — artifactRuns' own break
  // rule): a mockup render must not stamp the plan beside it, whose review
  // may be mid-flight (quality review HIGH-1, proven repro). Verdicted,
  // archived and draft versions are untouched; the ids are reported so the
  // ingress can settle the superseded versions' notes.
  const priorVersions = reuseLatest ? base.versions.slice(0, -1) : base.versions
  const supersededIds: string[] = []
  let stampedPrior = priorVersions
  // Show-and-tell renders supersede NOTHING: stamping a prior open REVIEW
  // version superseded would settle its notes through an agent action with no
  // seen barrier — exactly the debt-vanishing the C1 machine forbids. A show
  // version sits beside the review flow, it never advances it.
  if (!isDraft && !isShow) {
    // Supersede the OPEN version of every earlier run of the SAME KIND (adv
    // FINDING C-1). Not just the run the new version joins: a mockup rendered
    // between two plans breaks the plan into two runs, and the earlier plan's
    // open version would otherwise stay open forever with a never-settling
    // review (the exact phantom this machine kills). A newer take of a kind
    // supersedes older takes of that kind; a DIFFERENT kind (the HIGH-1 case)
    // is left untouched — its run's mode does not match. Archived runs and
    // already-verdicted/withdrawn/draft versions are excluded by openVersionOf.
    const toSupersede = new Set<string>()
    for (const run of artifactRuns(priorVersions)) {
      if (run[0].mode !== version.mode || run[0].archived) continue
      const open = openVersionOf(run)
      if (open) toSupersede.add(open.id)
    }
    if (toSupersede.size > 0) {
      stampedPrior = priorVersions.map((v) => {
        if (!toSupersede.has(v.id)) return v
        supersededIds.push(v.id)
        return { ...v, verdict: { state: 'superseded', by: 'system', at: createdAt } satisfies CanvasVersionVerdict }
      })
    }
  }
  const nextRecord: CanvasRecord = {
    ...base,
    ...(cwdStamp && !base.cwd ? { cwd: cwdStamp } : {}),
    ...(conversationStamp ? { conversationUuid: conversationStamp } : {}),
    // CREATION STAMPS, and only on the NEW-CANVAS branch (`!existing`).
    //
    // Backfilling them onto a record that already exists would let a RESUME
    // rewrite history: session B picks up a canvas A made before stamps
    // existed, renders once, and the record now says B created it under B's
    // config — which the Library then prints as the canvas's authorship. A
    // resume moves the work, not its history. A legacy canvas simply keeps no
    // creation stamp; the row still has an audit line, because `renderedBy` is
    // stamped per VERSION and says who actually produced each one.
    ...(!existing && configIdStamp ? { configId: configIdStamp } : {}),
    ...(!existing && renderStamp ? { createdBy: renderStamp } : {}),
    // The subject. Only ever set to a title that names the SAME subject (a
    // different one took the new-canvas branch above), so this fills in a
    // missing title and refreshes the wording, never repurposes the canvas.
    // An UNREADABLE title (emoji-only) may fill an empty label but never
    // overwrite a readable one — that would relabel "Checkout flow" as "🔥🔥🔥"
    // in the library while the notes underneath stayed about checkout.
    ...(title && (comparable || !base.title) ? { title } : {}),
    versions: reuseLatest ? [...stampedPrior, version] : [...stampedPrior, version],
    activeVersionId: versionId,
    // Advance the high-water mark only when a NEW id was minted — a superseding
    // draft reuses its id and must not burn a number. Never goes backwards.
    nextVersion: reuseLatest ? (base.nextVersion ?? mintNum) : mintNum + 1,
    ...(awaitingReview ? { awaitingReview } : {}),
  }
  persist(nextRecord)
  canvases.set(canvasId, nextRecord)
  // A subject-change DRAFT defers the whole hand-over (#366): the user-facing
  // binding stays on the canvas the user is on, nothing is filed, and only
  // the agent-side draft pointer moves — so the pane, the user's note writes
  // and the review reads all keep resolving the canvas the user can SEE for
  // the whole drafting loop. The ready-mark (or a legacy render) performs the
  // repoint and reports the filing — which is also what lets the renderer
  // announce it against that event's own `prev`.
  const deferRepoint = isDraft && subjectChanged
  if (deferRepoint) {
    draftIndex.set(sessionId, canvasId)
  } else {
    sessionIndex.set(sessionId, canvasId)
    draftIndex.delete(sessionId)
  }
  emitChanged(nextRecord, { draft: isDraft })
  // Report a FILING to the caller. `subjectChanged` was a local boolean that
  // never left this function, so nothing downstream could tell that the canvas
  // the user was reviewing had just been moved aside -- taking any unresolved
  // notes on it out of view. The ID only: the filed canvas's title is
  // agent-authored text, and the tool reply it feeds is operator voice.
  // A deferred draft files NOTHING: the held canvas is still the session's.
  const filedId = !deferRepoint && subjectChanged && held && held.canvasId !== canvasId ? held.canvasId : undefined
  // Whether the canvas now active is BRAND NEW or one this session filed
  // earlier and has just come back to. The tool reply said "this is a new
  // canvas" either way, which is false on the returnedTo path -- and that path
  // is the one where it matters, because the canvas being returned to already
  // has versions and notes of its own.
  const returnedToExisting = !!(subjectChanged && returnedTo)
  return {
    canvasId,
    versionId,
    ...(isDraft ? { draft: true as const } : {}),
    ...(filedId ? { filed: { canvasId: filedId, returnedToExisting } } : {}),
    ...(supersededIds.length ? { superseded: supersededIds } : {}),
  }
}

/**
 * The user has responded to the ready-marked round on this canvas — clear the
 * "review needed" entry (#366). Called by the review store on submit (it
 * already imports this store, so the dependency points the existing way). A
 * user gesture; no MCP path reaches this. Idempotent, and a no-op for a canvas
 * that owes nothing.
 *
 * `setVersionVerdict` clears the same stamp inside its own persist, so a
 * decision and the queue can never disagree — this entry point exists for the
 * submit, which freezes and stamps in two steps.
 */
export function clearAwaitingReview(canvasId: string): void {
  if (typeof canvasId !== 'string' || !CANVAS_ID_RE.test(canvasId)) return
  ensureDiskScanned()
  const record = canvases.get(canvasId)
  if (!record?.awaitingReview) return
  const { awaitingReview: _cleared, ...rest } = record
  const next: CanvasRecord = rest
  // Same persist-before-commit discipline as renderVersion: a failed write
  // leaves the owed state standing rather than clearing it in memory only.
  persist(next)
  canvases.set(canvasId, next)
  emitChanged(next)
}

/** Verdict-note hygiene: user (or user-relayed) prose — cap and strip the
 *  control characters that could smuggle markup into the audit trail, keeping
 *  ordinary newlines and tabs. */
function cleanVerdictNote(note: unknown): string | undefined {
  if (typeof note !== 'string') return undefined
  const cleaned = note.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]|\p{Cf}/gu, '').trim()
  if (!cleaned) return undefined
  return cleaned.slice(0, MAX_VERDICT_NOTE_CHARS)
}

/** The OPEN version (C1) of the artifact run containing `versionId` — or of
 *  the active artifact when no id is given. */
function openVersionInRecord(record: CanvasRecord, versionId?: string): CanvasVersion | null {
  const anchor = versionId ?? record.activeVersionId
  if (!anchor) return null
  const run = artifactRunContaining(record.versions, anchor)
  if (!run) return null
  // `!v.show` matches shared openVersionOf: a chat verdict with no named
  // version must land on the artifact's open REVIEW version, never on a
  // show-and-tell rendered after it (mis-recording the user's "approve it").
  const lastReady = [...run].reverse().find((v) => !v.draft && !v.show && v.verdict?.state !== 'withdrawn')
  return lastReady && !lastReady.verdict ? lastReady : null
}

/**
 * WHICH version a verdict with this (possibly absent) id would land on.
 *
 * Exported because the IPC handler has to know it BEFORE the write: after
 * `setVersionVerdict` runs, that version is decided and no longer "the open
 * one", so the handler could not read it back — and it needs the id to settle
 * that artefact's earlier rounds (W4). Read-only; the same resolution
 * `setVersionVerdict` performs, kept in one place so the two cannot diverge.
 */
export function verdictTargetVersionId(sessionId: string, versionId?: string): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null
  if (versionId !== undefined && !CANVAS_VERSION_ID_RE.test(versionId)) return null
  const record = getRecordForSession(sessionId)
  if (!record) return null
  if (versionId) return record.versions.some((v) => v.id === versionId) ? versionId : null
  return openVersionInRecord(record)?.id ?? null
}

/**
 * Stamp a version's review outcome (C1) — the write behind BOTH mouths:
 * the user's own submit in the pane (`by: 'user'`) and the agent recording
 * the user's chat words (`by: 'agent-chat'`, always rendered as such).
 *
 * The target is the named version, or the active artifact's OPEN version when
 * none is named — resolved by `verdictTargetVersionId`, the ONE implementation
 * of that question, so this and the handler that settles rounds around it can
 * never land on different versions. Refused for drafts, for a version already
 * decided (reopen it first — a verdict is never silently overwritten), and on a
 * completed canvas. Clearing `awaitingReview` rides the same persist so the
 * queue and the verdict can never disagree.
 *
 * A USER REJECTION MUST SAY WHY. "Rejected" with no words leaves the agent a
 * verdict it cannot act on and the History a row that explains nothing — the
 * pane's own composer mandates a note, and this is the boundary that means it.
 * An agent-chat rejection relays the user's words, which is the note.
 */
export function setVersionVerdict(
  sessionId: string,
  versionId: string | undefined,
  decision: { state: 'approved' | 'rejected' | 'dismissed'; note?: string },
  by: 'user' | 'agent-chat',
): CanvasState | { error: string } {
  if (!SESSION_ID_RE.test(sessionId)) return { error: 'invalid session id' }
  if (versionId !== undefined && !CANVAS_VERSION_ID_RE.test(versionId)) return { error: 'invalid version id' }
  if (decision.state !== 'approved' && decision.state !== 'rejected' && decision.state !== 'dismissed') {
    return { error: 'invalid verdict state' }
  }
  if (decision.state === 'rejected' && !cleanVerdictNote(decision.note)) {
    return { error: 'a rejection needs a note — say what is wrong' }
  }
  const record = getRecordForSession(sessionId)
  if (!record) return { error: 'no canvas for this session' }
  if (record.completed) return { error: 'this canvas is signed off; reopen it from the library first' }
  const targetId = verdictTargetVersionId(sessionId, versionId)
  const target = targetId ? record.versions.find((v) => v.id === targetId) : undefined
  if (!target) return { error: versionId ? `no version ${versionId} on this canvas` : 'no open version awaiting a verdict' }
  if (target.draft) return { error: 'that version is still a draft' }
  if (target.verdict) return { error: `${target.id} is already decided (${target.verdict.state}) — reopen it first` }
  const verdict: CanvasVersionVerdict = {
    state: decision.state,
    by,
    at: new Date().toISOString(),
    ...(cleanVerdictNote(decision.note) ? { note: cleanVerdictNote(decision.note) } : {}),
  }
  const versions = record.versions.map((v) => (v.id === target.id ? { ...v, verdict } : v))
  const clearsAwaiting = record.awaitingReview?.versionId === target.id
  const { awaitingReview: _aw, ...rest } = record
  const next: CanvasRecord = { ...rest, versions, ...(clearsAwaiting || !record.awaitingReview ? {} : { awaitingReview: record.awaitingReview }) }
  persist(next)
  canvases.set(record.canvasId, next)
  emitChanged(next)
  return toState(next)
}

/**
 * Name the TEST PACK (M3) — the inline rename in the Testing header.
 *
 * OWNER-SCOPED, like every other renderer write on this store: the canvas named
 * has to be the one this session actually holds. A pack name is a label the user
 * reads in their own Library, and letting a session rename another's would be a
 * way to make one row read as another.
 *
 * `null` clears it, which is how "empty the field and press Enter" gets back to
 * the generated default — and the default is DERIVED, never written, so clearing
 * is a delete rather than a write of today's default frozen forever.
 *
 * The version does not have to be `uat`: a pack name on a mockup version is
 * harmless (nothing reads it there), and refusing here would mean the pane had
 * to know the mode before it could offer the field. What it must be is a version
 * on THIS canvas, and not a draft — a draft is invisible to the user, so a name
 * on one names something they cannot see.
 */
export function setPackName(
  sessionId: string,
  canvasId: string,
  versionId: string,
  name: string | null,
): CanvasState | { error: string } {
  if (!SESSION_ID_RE.test(sessionId)) return { error: 'invalid session id' }
  if (!CANVAS_ID_RE.test(canvasId)) return { error: 'invalid canvas id' }
  if (!CANVAS_VERSION_ID_RE.test(versionId)) return { error: 'invalid version id' }
  const record = getRecordForSession(sessionId)
  if (!record) return { error: 'no canvas for this session' }
  if (record.canvasId !== canvasId) return { error: 'that canvas is not this session’s' }
  const target = record.versions.find((v) => v.id === versionId)
  if (!target) return { error: `no version ${versionId} on this canvas` }
  if (target.draft) return { error: 'that version is still a draft' }
  const cleaned = name === null ? undefined : sanitizePackName(name)
  const versions = record.versions.map((v) => {
    if (v.id !== target.id) return v
    const { packName: _old, ...rest } = v
    return cleaned ? { ...rest, packName: cleaned } : rest
  })
  const next: CanvasRecord = { ...record, versions }
  persist(next)
  canvases.set(record.canvasId, next)
  emitChanged(next)
  return toState(next)
}

/**
 * The project directory a canvas was rendered in, for SCOPING a read.
 *
 * A LABEL everywhere else in this store (ADR-017: the project organises, it
 * never forecloses), and it stays one here — this answers "are these two things
 * in the same project", which is a relevance question the evidence read channel
 * turns into a scope. It is never an ownership key: ownership is the record's
 * own `sessionId`, and the read channel checks that first.
 */
export function canvasProjectDirOf(canvasId: string): string | undefined {
  if (!CANVAS_ID_RE.test(canvasId)) return undefined
  ensureDiskScanned()
  return canvases.get(canvasId)?.cwd
}

/** Whether two directories name the same project, by this store's own rule —
 *  exported so the evidence read channel scopes exactly as the Library lists. */
export function isSameCanvasProject(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return sameProjectDir(a, b)
}

/**
 * Reopen a version for review (C1 flexibility: "go back to v5, get rid of
 * v6"). The target's verdict is cleared — it becomes the artifact's one OPEN
 * version — and every LATER ready version in the same artifact is stamped
 * WITHDRAWN (hidden from the default history, kept in the audit trail). The
 * pane is pointed back at it. `by` records whose instruction did it.
 */
export function reopenVersionForReview(
  sessionId: string,
  versionId: string,
  by: 'user' | 'agent-chat',
): { state: CanvasState; withdrawn: string[] } | { error: string } {
  if (!SESSION_ID_RE.test(sessionId)) return { error: 'invalid session id' }
  if (!CANVAS_VERSION_ID_RE.test(versionId)) return { error: 'invalid version id' }
  const record = getRecordForSession(sessionId)
  if (!record) return { error: 'no canvas for this session' }
  if (record.completed) return { error: 'this canvas is signed off; reopen it from the library first' }
  const target = record.versions.find((v) => v.id === versionId)
  if (!target) return { error: `no version ${versionId} on this canvas` }
  if (target.draft) return { error: 'that version is still a draft' }
  const run = artifactRunContaining(record.versions, versionId)
  if (!run) return { error: 'that version is not part of a reviewable artifact' }
  // Later = run position, not timestamps (quality LOW-3): stamps reset
  // across restarts, run order never lies.
  const laterIds = new Set(run.slice(run.findIndex((v) => v.id === target.id) + 1).filter((v) => !v.draft).map((v) => v.id))
  const at = new Date().toISOString()
  // Push a verdict being cleared or overwritten into the audit trail rather
  // than dropping it (adv FINDING 2) — a user rejection survives a reopen.
  // Clamped to the newest MAX_PRIOR_VERDICTS so a repeated reopen can never
  // grow a version past the load-time cap and make sanitizeRecord DROP it
  // (adv round 2 — reopen must be idempotent and non-destructive).
  const archived = (v: CanvasVersion): CanvasVersionVerdict[] | undefined => {
    if (!v.verdict) return v.priorVerdicts
    const all = [...(v.priorVerdicts ?? []), v.verdict]
    return all.slice(-MAX_PRIOR_VERDICTS)
  }
  const versions = record.versions.map((v) => {
    if (v.id === target.id) {
      const { verdict: _v, ...restV } = v
      const prior = archived(v)
      return prior ? { ...restV, priorVerdicts: prior } : restV
    }
    if (laterIds.has(v.id)) {
      // Idempotent: an already-withdrawn later version is left exactly as it
      // is — re-withdrawing it would append a duplicate to priorVerdicts on
      // every reopen and eventually breach the cap.
      if (v.verdict?.state === 'withdrawn') return v
      const prior = archived(v)
      return { ...v, ...(prior ? { priorVerdicts: prior } : {}), verdict: { state: 'withdrawn', by, at } satisfies CanvasVersionVerdict }
    }
    return v
  })
  const next: CanvasRecord = {
    ...record,
    versions,
    activeVersionId: target.id,
    awaitingReview: { versionId: target.id, at },
  }
  persist(next)
  canvases.set(record.canvasId, next)
  emitChanged(next)
  return { state: toState(next), withdrawn: [...laterIds] }
}

/**
 * Sign the subject off (#476): stamp the canvas COMPLETE and, when it is the
 * owning session's current canvas, detach it — the pane falls back to its
 * front page, and the canvas lives on in the library as history.
 *
 * This is the RECORDING half only. The "nothing left owed either way" guard
 * lives in canvas-completion.ts, which composes this store with the review
 * store — this store cannot read reviews (the import points the other way).
 * Callers other than that guard are a bug.
 *
 * `by: 'agent'` is written only on the user's explicit instruction (the MCP
 * tool's contract) and renders as "completed by the agent on your
 * instruction"; Reopen clears it in one click either way.
 */
export function setCanvasCompleted(
  canvasId: string,
  by: CanvasCompletion['by'],
  requireOwnerSessionId?: string,
): CanvasState | { error: string } {
  if (typeof canvasId !== 'string' || !CANVAS_ID_RE.test(canvasId)) return { error: 'invalid canvas id' }
  if (by !== 'user' && by !== 'agent') return { error: 'invalid completion source' }
  ensureDiskScanned()
  const record = canvases.get(canvasId)
  if (!record) return { error: 'no such canvas' }
  // Sign-off is the owner's act: both ingresses name the session they act for,
  // and a canvas owned by another session is refused rather than signed off
  // under the wrong name.
  if (requireOwnerSessionId !== undefined && record.sessionId !== requireOwnerSessionId) {
    return { error: 'not this session’s canvas' }
  }
  if (record.completed) return { error: 'already completed' }
  const { awaitingReview: _cleared, ...rest } = record
  const next: CanvasRecord = { ...rest, completed: { at: new Date().toISOString(), by } }
  // Persist-before-commit, like clearAwaitingReview: a failed write leaves the
  // canvas active rather than completed in memory only.
  persist(next)
  canvases.set(canvasId, next)
  // Detaching the session drops BOTH of its bindings. sessionIndex when this
  // was its current canvas; AND its deferred subject-change draft pointer
  // (#476 adversarial) — that draft points at a DIFFERENT canvas than the one
  // being completed, so keying the delete on `=== canvasId` (the round-1 cut)
  // never fired and left getAgentCanvasStateForSession resolving a stale draft
  // after the session had fallen back to the front page. A draft's own
  // canvas can never itself be completed (draft-only has no ready version, and
  // the guard refuses it), so clearing on the owner's detach is the only case.
  if (sessionIndex.get(record.sessionId) === canvasId) {
    sessionIndex.delete(record.sessionId)
    draftIndex.delete(record.sessionId)
  }
  emitChanged(next, { completed: true })
  return toState(next)
}

/**
 * Reopen a completed canvas (#476): clear the stamp and, when the owning
 * session is not currently showing another canvas, make it current again so
 * the pane lands straight back on it. Recorded state only changes by removal;
 * nothing else is touched.
 */
export function reopenCompletedCanvas(canvasId: string, requireOwnerSessionId?: string): CanvasState | { error: string } {
  if (typeof canvasId !== 'string' || !CANVAS_ID_RE.test(canvasId)) return { error: 'invalid canvas id' }
  ensureDiskScanned()
  const record = canvases.get(canvasId)
  if (!record) return { error: 'no such canvas' }
  if (requireOwnerSessionId !== undefined && record.sessionId !== requireOwnerSessionId) {
    return { error: 'not this session’s canvas' }
  }
  if (!record.completed) return { error: 'not completed' }
  const { completed: _cleared, ...rest } = record
  const next: CanvasRecord = rest
  persist(next)
  canvases.set(canvasId, next)
  if (!sessionIndex.has(record.sessionId)) sessionIndex.set(record.sessionId, canvasId)
  emitChanged(next, { reopened: true })
  return toState(next)
}

/**
 * The session's most recently completed canvas, read-only (#573).
 *
 * Completion detaches the sessionIndex pointer, which is right for the PANE
 * (it falls back to its front page) and wrong for the one read the agent still
 * owes: an approval-with-notes auto-completes the subject, and the very review
 * that carried the approval became unfetchable ("no canvas for session")
 * before the agent could read its notes. Records keep `sessionId`, so the
 * session's own history is resolvable without the index. Serve READS from it;
 * renders and completion still refuse completed canvases, and this never
 * resolves another session's canvas.
 */
export function getLastCompletedCanvasStateForSession(sessionId: string): CanvasState | null {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null
  ensureDiskScanned()
  let latest: CanvasRecord | null = null
  for (const record of canvases.values()) {
    if (record.sessionId !== sessionId || !record.completed) continue
    if (!latest || record.completed.at > latest.completed!.at) latest = record
  }
  return latest ? toState(latest) : null
}

/** Windows reserved device basenames — a request for `CON`/`NUL`/`COM1`/… can
 *  open a device rather than a file. Matched on the pre-extension basename. */
const WIN_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/i

/**
 * THE definition of "this path names an HTML document", used by both halves of
 * the boundary — the write ingress here and `serveFile` in ccc-ux-protocol.
 *
 * It is one exported function rather than a regex on one side and
 * `path.extname` on the other because those two disagreed: `/\.(html|htm)$/i`
 * matches the whole string `.html`, while `path.extname('.html')` is `''`. An
 * entry of `".html"` therefore passed the render check and was then refused by
 * the serve check — harmless in that direction, and a bypass in the other. Two
 * spellings of one predicate is the defect; the extension-based one is kept
 * because it is the one the MIME lookup already keys off.
 */
export function isHtmlDocumentPath(p: string): boolean {
  const ext = path.extname(p).toLowerCase()
  return ext === '.html' || ext === '.htm'
}

/**
 * An entry must be a plain relative path. The boundary is self-sufficient: it
 * rejects traversal, absolutes, drive/ADS colons, and backslashes, AND the
 * Win32 forms that a pure `path`/string check misses but libuv would silently
 * normalize (trailing dot/space stripping, all-dot segments, device names) — so
 * the confinement never relies on the fs layer's behaviour (adversarial review,
 * 2026-08-11).
 *
 * STRUCTURAL ONLY — no HTML requirement. That split matters: this predicate is
 * what `isValidRecord` runs over a record read back from disk, and a violation
 * there means the entry is DANGEROUS (it could traverse). "Is not an HTML file"
 * is a different statement — it means the version is not servable, not that the
 * record is corrupt — and folding the two together made one legacy version
 * invalidate an entire canvas, taking every good design version with it.
 */
function normalizeEntryPath(entry: string): string {
  const clean = entry.replace(/^\/+/, '')
  if (clean.length === 0 || clean.length > 512) throw new Error('invalid entry')
  const segments = clean.split('/')
  for (const seg of segments) {
    if (seg === '' || /^\.+$/.test(seg)) throw new Error('invalid entry') // '', '.', '..', '...'
    if (/[\\:\0]/.test(seg)) throw new Error('invalid entry')
    if (/[. ]$/.test(seg)) throw new Error('invalid entry') // Win32 strips a trailing '.'/' '
    if (WIN_RESERVED_BASENAME.test(seg.split('.')[0])) throw new Error('invalid entry')
  }
  return segments.join('/')
}

/**
 * The WRITE ingress: structural safety plus the HTML requirement.
 *
 * The `.html`/`.htm` requirement is the render half of BLOCKER 1 (adversarial
 * review, 2026-08-15): the protocol used to force the ENTRY to `text/html`
 * whatever it actually was and inject the bridge into it, so a version whose
 * entry named `.credentials.json` came back `200 text/html` with the bridge
 * attached and was then readable by the pre-allowed `canvas_snapshot`. Refusing
 * the entry here is the first of the two fixes; the protocol refuses to serve a
 * non-HTML entry as a document as well, so neither ingress leans on the other.
 * Nothing new can be WRITTEN with a non-HTML entry; a record that already
 * carries one keeps its other versions and loses only that version's serve.
 */
function normalizeEntry(entry: string): string {
  const normalized = normalizeEntryPath(entry)
  if (!isHtmlDocumentPath(normalized)) throw new Error('entry must be an html file')
  return normalized
}

export function setActiveVersion(sessionId: string, versionId: string): CanvasState {
  const record = getRecordForSession(sessionId)
  if (!record) throw new Error('no canvas for session')
  if (!record.versions.some((v) => v.id === versionId)) throw new Error('unknown version')
  // Same persist-before-commit order as renderVersion, for the same reason: a
  // persist throw must not leave the in-memory active version ahead of disk.
  // This one can only ever toggle between two ALREADY-servable versions, so the
  // fail-open here was benign (self-healing on restart) rather than the
  // serve-a-rejected-document hole renderVersion had — but the two writers
  // should not disagree about when a change is durable (adversarial review,
  // 2026-08-12, second pass).
  const next: CanvasRecord = { ...record, activeVersionId: versionId }
  persist(next)
  canvases.set(next.canvasId, next)
  emitChanged(next)
  return toState(next)
}

/** "Is this session live, and is an oracle that throws allowed to say no?" —
 *  no. Every privacy and ownership decision in this store fails CLOSED: an
 *  oracle that cannot answer is treated as "live", which withholds a row and
 *  refuses a transfer rather than leaking or taking. */
function isLiveOrUnknown(sessionId: string, isSessionLive: (sid: string) => boolean): boolean {
  try {
    return isSessionLive(sessionId)
  } catch {
    return true
  }
}

/**
 * Is this canvas OWNERLESS IN FLIGHT for the asking session — i.e. resumable?
 *
 * Three floors, and each closes a different hole:
 *
 *   - it is not already the caller's (resuming your own is `openOwnCanvas`,
 *     which transfers nothing);
 *   - it has versions (there is nothing to inherit from an empty canvas);
 *   - it is NOT completed. A signed-off canvas is terminal history (#476): it
 *     must not be offered as orphaned work, and — the sharper hole — must not
 *     be adoptable at all, which would hand over its private review notes AND
 *     let the adopter Reopen a sign-off it never made. Completion detached it
 *     from its owner's sessionIndex, so without this it looks exactly like an
 *     orphan;
 *   - its owner is NOT LIVE. In flight is PRIVATE to the live session that
 *     rendered it.
 *
 * Fails safe: an oracle that throws counts as live, and live means untouchable.
 */
function isResumeCandidate(record: CanvasRecord, sessionId: string, query: CanvasLivenessQuery): boolean {
  if (record.sessionId === sessionId) return false
  if (record.versions.length === 0) return false // nothing to inherit
  if (record.completed) return false
  try {
    if (query.isSessionLive(record.sessionId)) return false
  } catch {
    return false // cannot tell → treat as live → untouchable
  }
  return true
}

/**
 * Characters that reorder or hide the text around them: the bidi overrides and
 * isolates, the zero-width joiners/spaces, the line/paragraph separators and
 * every C0/C1 control.
 *
 * Stripped from the `cwd` before it leaves this process. It is a path the user
 * is shown so they can tell one canvas from another, and a `U+202E` in it flips
 * the rest of the line — `C:\work\<RLO>gnp.evil\` reads as a different
 * directory than it is. The strip happens HERE rather than in the component so
 * the value never exists in a renderable form anywhere.
 *
 * SPELLED AS UNICODE PROPERTIES, not as hand-written ranges (adversarial review,
 * 2026-08-16). The ranges had gaps that were invisible to read and measurable to
 * test: U+061C ARABIC LETTER MARK (a Bidi_Control), U+00AD SOFT HYPHEN, the C1
 * controls U+0080-U+009F, and U+2028/U+2029 all walked straight through into the
 * Library row's text and its `title` tooltip. `\p{Cf}` is the set the gaps kept
 * falling out of — it also covers the tag characters U+E0020-U+E007F, which no
 * enumeration written by hand was ever going to include. Display-only: nothing
 * downstream matches on this value (every action is addressed by canvas id).
 */
const FORMAT_CONTROLS_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/** Never render a stamp from the future: it would sort above every real canvas
 *  in the resume list and the Library. Server-generated today (so this is a
 *  floor against clock skew rather than against a caller), and cheap to keep. */
function clampToNow(iso: string): string {
  const ms = Date.parse(iso)
  const now = Date.now()
  return Number.isFinite(ms) && ms <= now ? iso : new Date(now).toISOString()
}

/**
 * Do two recorded working directories name the same project?
 *
 * The library's project scope compares a canvas record's stamped `cwd` against
 * the cwd of the session ASKING, and those two strings come from different
 * places at different times: the record is stamped once at first render and
 * never drifts, while the asking side is whatever the latest spawn recorded.
 * On the app-relaunch path that is a different SOURCE entirely -- `pty-handlers`
 * records `options?.resume?.cwd ?? options?.cwd`, and `resume.cwd` is the first
 * cwd string in the conversation JSONL, trimmed verbatim. So one tile's key can
 * alternate between two independent spellings across its life.
 *
 * A raw `!==` therefore fails on differences that are not differences: a
 * trailing separator, a case difference on a case-insensitive filesystem,
 * forward vs back slashes on Windows. Normalise the way the filesystem itself
 * would, matching `sameFsPath`. Deliberately LEXICAL: realpath would be
 * stronger but throws on a directory that no longer exists, which is exactly
 * the case where someone most needs to find their old canvases.
 */
export function sameProjectDir(a: string, b: string): boolean {
  return sameFsPath(cleanProjectDir(a), cleanProjectDir(b))
}

/** The shared normalisation both project comparisons use: format controls out,
 *  separators and `.` segments resolved. `path.resolve` only makes sense on an
 *  absolute path -- a relative one would resolve against the MAIN process's
 *  cwd, which has nothing to do with either session -- so it is applied only
 *  there. */
function cleanProjectDir(p: string): string {
  const stripped = p.replace(FORMAT_CONTROLS_RE, '')
  return path.isAbsolute(stripped) ? path.resolve(stripped) : stripped
}

/**
 * The same question, asked CASE-SENSITIVELY — for the destructive
 * cross-session paths only.
 *
 * `sameProjectDir` folds case whenever `process.platform` is win32 or darwin,
 * i.e. for the whole machine. Both platforms can carry case-SENSITIVE volumes
 * (an NTFS directory with the per-directory flag, an APFS case-sensitive
 * volume), on which `…\Foo` and `…\foo` are two genuinely different projects
 * that it calls equal. For a LISTING that is the right trade — the cost of a
 * false match is a row you did not need to see, and the cost of a false miss is
 * being unable to find your own work. For a DISMISS or a RESUME of somebody
 * else's canvas it is not: choosing which directory to sit in is not an attack
 * that needs any privilege.
 *
 * Still normalised the way the filesystem would for everything EXCEPT case:
  * one tile's recorded cwd legitimately alternates spelling across its life (a
 * trailing separator; a relaunch reading it out of the transcript rather than
 * the config), so raw string equality would refuse honest peers. Only case is
 * treated as a real difference.
 */
export function sameProjectDirExactCase(a: string, b: string): boolean {
  const norm = (p: string) => cleanProjectDir(p).replace(/[\\/]+$/, '')
  return norm(a) === norm(b)
}

/**
 * How many resume rows the front page is ever offered.
 *
 * A card the user has to read is a card they can mis-click, and the list is
 * input to a component that renders every entry. The most recently worked
 * survive (the sort runs first), which is what someone scanning for their own
 * work would have looked at anyway.
 */
const MAX_RESUMABLE_ROWS = 12

/**
 * OWNERLESS IN-FLIGHT canvases this session could resume. Pure read — nothing
 * moves until the user names one and `resumeCanvasForSession` performs the
 * compare-and-set.
 *
 * INDEPENDENT OF WHAT THE CALLER ALREADY OWNS, and that is a deliberate fix.
 * The old lister returned [] the moment the asking session held any canvas,
 * which meant a session that had ever rendered could never see stranded work —
 * so the only route back to it was the library, and the library is scoped to
 * the project. Owning a canvas is not a reason to be unable to pick up another.
 *
 * Scoped by `isEligible`, which is the SAME predicate the resume ACTION
 * applies: this is a list of canvases the user may actually take, so offering
 * more than that would be advertising a refusal. `configId` here tightens the
 * ORDER only — the caller's own config floats its work to the top.
 */
export function listResumableCanvases(
  sessionId: string,
  query: CanvasLivenessQuery,
  opts: {
    /** The SAME rule the resume action applies (see `CanvasWorkspaceCheck`), so
     *  the list can never advertise a canvas the action would refuse. Absent =
     *  no workspace restriction, which is a TEST affordance: the one production
     *  caller (canvas-session-link) always supplies it. */
    isEligible?: CanvasWorkspaceCheck
    /** ORDERING only. */
    configId?: string
    noteCountOf?: (canvasId: string) => number
    /** configId -> the config's CURRENT display name. Injected because this
     *  store cannot read configs.json, and resolved AT READ so a renamed config
     *  renames the row. An id that names no config resolves to nothing: a raw
     *  id on a card is noise, not a name. */
    configNameOf?: (configId: string) => string | undefined
  } = {},
): ResumableRow[] {
  if (!SESSION_ID_RE.test(sessionId)) return []
  ensureDiskScanned()
  const rows: Array<ResumableRow & { sameConfig: boolean }> = []
  for (const record of canvases.values()) {
    if (!isResumeCandidate(record, sessionId, query)) continue
    if (opts.isEligible && !opts.isEligible({ cwd: record.cwd, configId: record.configId })) continue
    const shown = record.versions.filter((v) => !v.draft)
    const latest = shown[shown.length - 1]
    if (!latest) continue
    // The title has to tell two canvases from one project apart. The subject is
    // best; a pack name next; and failing both the CONVERSATION short id, which
    // is the thing that actually differs when everything else matches (the
    // mis-click that re-binds another project's private notes is what this
    // exists to prevent).
    const title =
      record.title ??
      (latest.mode === 'uat' ? latest.packName : undefined) ??
      (record.conversationUuid ? `conversation ${record.conversationUuid.slice(0, 8)}` : 'Untitled canvas')
    let noteCount = 0
    try {
      noteCount = opts.noteCountOf ? opts.noteCountOf(record.canvasId) : 0
    } catch {
      noteCount = 0 // an unreadable review store costs a number, never the row
    }
    const configName = record.configId ? opts.configNameOf?.(record.configId) : undefined
    rows.push({
      canvasId: record.canvasId,
      title,
      kind: libraryRowKindOf(latest.mode),
      noteCount,
      lastRenderedAt: clampToNow(latest.createdAt),
      // The config the canvas was MADE under, by its CURRENT name. Absent is
      // absent — never a placeholder, and never the raw id.
      ...(configName ? { configName } : {}),
      expectedOwnerSessionId: record.sessionId,
      sameConfig: !!opts.configId && record.configId === opts.configId,
    })
  }
  rows.sort((a, b) => {
    if (a.sameConfig !== b.sameConfig) return a.sameConfig ? -1 : 1
    return b.lastRenderedAt.localeCompare(a.lastRenderedAt)
  })
  return rows.slice(0, MAX_RESUMABLE_ROWS).map(({ sameConfig: _drop, ...row }) => row)
}

/**
 * RESUME an ownerless in-flight canvas — the one path that moves ownership
 * between sessions, and the only one there is.
 *
 * COMPARE-AND-SET, AND IT IS SYNCHRONOUS END TO END. The caller passes the
 * owner it SAW when the row was listed; between the read of `record.sessionId`
 * here and the `persist` + map write below there is no `await`, no I/O the
 * event loop can interleave a second resume into, and no re-read. That is what
 * makes first-wins mean something: two sessions racing on the same row both
 * pass the liveness floor (nobody is live), and without the CAS both would
 * "succeed", the second silently taking a canvas the first had already started
 * working in. With it, the loser is told 'changed'.
 *
 * `persist` throwing leaves memory untouched (the renderVersion discipline), so
 * a failed write is a refused resume rather than a half-moved canvas. The
 * caller re-binds the review store next (rebindReviewsToSession) — reviews.json
 * carries the owner session id too.
 */
export function resumeCanvasForSession(
  sessionId: string,
  canvasId: string,
  expectedOwnerSessionId: string,
  query: CanvasLivenessQuery,
  /**
   * The WORKSPACE gate — same project AND same config, per
   * `CanvasWorkspaceCheck`. Absent = unrestricted, a TEST affordance:
   * canvas-session-link is the only production caller and always supplies it.
   *
   * This path had NO project term at all before, so a peer that learned a
   * canvas id could take work out of a project it has never opened.
   *
   * Evaluated inside the critical section below, beside the compare-and-set, so
   * one synchronous block decides the whole question. (The facts it reads —
   * `cwd`, `configId` — are creation stamps that never drift, so it could not
   * race even if it ran earlier; keeping it here is about having one place to
   * read the decision from.)
   */
  isEligible?: CanvasWorkspaceCheck,
): { ok: true; canvasId: string; activeVersionId: string | null } | { ok: false; reason: 'owner-live' | 'changed' | 'completed' | 'gone' } {
  if (!SESSION_ID_RE.test(sessionId)) return { ok: false, reason: 'gone' }
  if (typeof canvasId !== 'string' || !CANVAS_ID_RE.test(canvasId)) return { ok: false, reason: 'gone' }
  if (!SESSION_ID_RE.test(expectedOwnerSessionId)) return { ok: false, reason: 'changed' }
  ensureDiskScanned()

  // ── the critical section: read, decide, write. NO await below this line. ──
  const record = canvases.get(canvasId)
  if (!record) return { ok: false, reason: 'gone' }
  if (record.versions.length === 0) return { ok: false, reason: 'gone' }
  // Resuming your own canvas is not a resume; it is Open here, and it has its
  // own entry point. Reported as 'changed' rather than as success so a stale
  // row can never look like it did something.
  if (record.sessionId === sessionId) return { ok: false, reason: 'changed' }
  if (record.sessionId !== expectedOwnerSessionId) return { ok: false, reason: 'changed' }
  if (record.completed) return { ok: false, reason: 'completed' }
  // Reported as 'gone', deliberately: a caller outside this canvas's workspace
  // learns that there is nothing here for it, and nothing else. A distinct
  // reason would answer "does a canvas with this id exist elsewhere on this
  // machine", which is not a question a peer gets to ask.
  if (isEligible && !isEligible({ cwd: record.cwd, configId: record.configId })) return { ok: false, reason: 'gone' }
  let live: boolean
  try {
    live = query.isSessionLive(record.sessionId)
  } catch {
    live = true // cannot tell → treat as live → untouchable
  }
  if (live) return { ok: false, reason: 'owner-live' }

  // Only the OWNER changes. The stamps are the record's identity — rewriting
  // them here is how an earlier cut let an adopting session redefine what the
  // canvas "is" (it re-stamped cwd to the adopter's directory). `createdBy` is
  // untouched for the same reason: a resume moves the work, not its history.
  const next: CanvasRecord = { ...record, sessionId }
  persist(next)
  canvases.set(next.canvasId, next)
  // EXHAUSTIVE, the way `deleteCanvas` has always been. Clearing only the owner
  // THIS call happened to read leaves any other session that was pointed here
  // — reachable when a caller-supplied liveness oracle re-enters this very
  // function and moves the canvas first — holding an index entry that names a
  // canvas it no longer owns, which is a cross-session write waiting for its
  // next mutation. `getRecordForSession` is the second line under this one.
  for (const [sid, id] of sessionIndex) {
    if (id === next.canvasId && sid !== sessionId) sessionIndex.delete(sid)
  }
  // The resumed canvas becomes the caller's CURRENT one. A caller that already
  // owns canvases MAY resume: its previous current stays owned, it simply stops
  // being what the pane points at.
  sessionIndex.set(sessionId, next.canvasId)
  draftIndex.delete(sessionId)
  // ── end of critical section ──────────────────────────────────────────────
  emitChanged(next)
  return { ok: true, canvasId: next.canvasId, activeVersionId: next.activeVersionId }
}

/** Who owns a canvas right now, and whether it is memorialised — the read every
 *  mutation guard at the IPC seam is built from. Undefined for an unknown id. */
export function canvasOwnershipOf(
  canvasId: string,
): { sessionId: string; completed: boolean; cwd?: string; configId?: string } | undefined {
  if (typeof canvasId !== 'string' || !CANVAS_ID_RE.test(canvasId)) return undefined
  ensureDiskScanned()
  const record = canvases.get(canvasId)
  if (!record) return undefined
  return {
    sessionId: record.sessionId,
    completed: !!record.completed,
    ...(record.cwd ? { cwd: record.cwd } : {}),
    // The workspace's SECOND factor. A creation stamp, so it names the config
    // the canvas was made under and cannot be re-pointed by whoever holds it.
    ...(record.configId ? { configId: record.configId } : {}),
  }
}

/**
 * The canvas LIBRARY: every canvas on disk, newest first.
 *
 * Housekeeping, not authorization. Unlike `listResumableCanvases` this
 * deliberately does NOT filter to what the asking session could resume — the
 * whole point is to show the user what has accumulated so they can remove it.
 * Nothing here binds a canvas to a session; only `resumeCanvasForSession` and
 * `openOwnCanvasForSession` do. It DOES apply the M4 privacy rule: another
 * live session's in-flight work is not the asking session's to see.
 */
export function listAllCanvases(
  openTileSessionIds: readonly string[] = [],
  /**
   * Show only canvases rendered in this project directory. The library is
   * per-PROJECT because that is the unit the user thinks in: opening it from a
   * session in one project and being shown every mockup from every other one
   * makes the list unreadable and the interesting rows unfindable.
   *
   * Undefined = no filter (a session we have no cwd for still sees everything,
   * which is the fail-open side). This is relevance, never authorization —
   * ownership is decided by the record's own `sessionId` alone.
   */
  projectCwd?: string,
  /**
   * The session ASKING. Purely so the list can say which rows are this
   * session's own and which one it is showing — the in-pane switcher offers
   * only its own, while the library shows everything.
   *
   * DISPLAY ONLY, and the distinction matters: nothing here grants anything.
   * Ownership is decided by the record's own `sessionId`, so a "mine" badge
   * must never be read as a permission — every mutating channel re-checks it.
   */
  askingSessionId?: string,
  /**
   * THE PRIVACY RULE'S ORACLE (M4). In-flight work is private to the LIVE
   * session that rendered it, so a row whose owner is live and is not the
   * caller is withheld here unless the canvas is completed.
   *
   * Injected because this store is lifecycle-blind — and it must NOT be derived
   * from `openTileSessionIds`. That array is composed by the CALLING session,
   * so deriving a protection from it makes the protection opt-in by whoever it
   * protects against: a peer that leaves the owner out of its own request makes
   * a live owner look dead. The one production caller passes main's PTY
   * registry. Absent = nothing is live, a TEST affordance for a cold read.
   */
  isSessionLive?: (sessionId: string) => boolean,
): CanvasLibraryEntry[] {
  ensureDiskScanned()
  const open = new Set(openTileSessionIds.filter((id) => SESSION_ID_RE.test(id)))
  const asking = askingSessionId && SESSION_ID_RE.test(askingSessionId) ? askingSessionId : undefined
  const activeForAsking = asking ? sessionIndex.get(asking) : undefined
  const live = isSessionLive ?? (() => false)
  const out: CanvasLibraryEntry[] = []
  for (const record of canvases.values()) {
    // The same question every mutation guard answers, so the badge and the
    // action can never disagree: did THIS session author it.
    const mine = asking !== undefined && record.sessionId === asking
    // THE PRIVACY RULE (M4). Another live session's IN-FLIGHT canvas is
    // invisible — no row here, and therefore no count in the totals sweep this
    // list feeds. Enforced in MAIN rather than in the renderer, because a
    // filter the renderer applies is a filter that shipped the data first. A
    // COMPLETED canvas is memorialised into the shared project library and
    // stays visible (read-only to non-owners); an OWNERLESS in-flight one stays
    // visible so it can be resumed.
    if (!mine && !record.completed && isLiveOrUnknown(record.sessionId, live)) continue
    // Project scope NEVER hides a session's own canvas.
    //
    // ADR-017 scopes the library to the project, and justifies it by saying the
    // resume list stays unfiltered so a canvas whose project you never open
    // again still has a route back. It is scoped too (by relevance, never by
    // authorization) and excludes the session's own. So for a session whose own
    // work is what it is looking for, the
    // scoped library is the ONLY route to its own work -- and a project key that
    // merely RESPELLS (a trailing separator, a relaunch reading cwd from the
    // transcript instead of the config) would strand every canvas it authored,
    // including the one currently active. Filtering by relevance is right;
    // foreclosing is not, so own rows are always kept and the picker sorts them
    // to the top.
    if (!mine && projectCwd && record.cwd && !sameProjectDir(record.cwd, projectCwd)) continue
    // Row RECENCY and the mode chip describe what the USER can see: a draft
    // (#366) must not re-sort the picker under them or flip the chip — the
    // shape of invisible work must not leak into a surface the user reads.
    // versionCount stays the TOTAL, drafts included, because it labels the
    // delete button, and delete destroys the whole directory — a label that
    // under-counts a destructive action is worse than a one-off leak.
    const shown = record.versions.filter((v) => !v.draft)
    const latest = shown[shown.length - 1]
    const cwd = record.cwd?.replace(FORMAT_CONTROLS_RE, '')
    out.push({
      canvasId: record.canvasId,
      versionCount: record.versions.length,
      createdAt: clampToNow(record.createdAt),
      lastRenderedAt: clampToNow(latest?.createdAt ?? record.createdAt),
      ...(latest?.source.mode ? { latestMode: latest.source.mode } : {}),
      // The TEST PACK's identity (M3), for uat rows. Only the user's own name is
      // carried: the generated default is composed by whoever renders the row,
      // from `defaultPackName`, so a row never shows a default frozen at the
      // moment of capture. `buildLabel` is the agent's own label for the build.
      ...(latest?.source.mode === 'uat' && latest.packName ? { packName: latest.packName } : {}),
      ...(latest?.source.mode === 'uat' && latest.source.buildLabel ? { buildLabel: latest.source.buildLabel } : {}),
      ...(record.conversationUuid ? { conversationShortId: record.conversationUuid.slice(0, 8) } : {}),
      ...(cwd ? { cwd } : {}),
      ...(record.title ? { title: record.title } : {}),
      ...(open.has(record.sessionId) ? { ownedByOpenSession: true } : {}),
      // A session OWNS up to MAX_CANVASES_PER_SESSION records while pointing at
      // exactly one, so these two are different questions and both are asked.
      ...(mine ? { ownedByThisSession: true } : {}),
      ...(mine && activeForAsking === record.canvasId ? { isActiveForThisSession: true } : {}),
      // From the record itself, not the review sweep, so it is present on every
      // row — a "review needed" round must never hide behind the sweep bound.
      ...(record.awaitingReview ? { awaitingReview: true, awaitingReviewAt: clampToNow(record.awaitingReview.at) } : {}),
      ...(record.completed ? { completed: { ...record.completed } } : {}),
    })
  }
  // Banded, then newest-first inside each band: the canvas you are looking at,
  // then the rest of your own, then everyone else's. A flat recency list is
  // unreadable once a project has accumulated a few dozen, and the cap below
  // would slice an unbanded list arbitrarily.
  //
  // Sorted on parsed time, not on the ISO strings: lexical order is only
  // correct while every stamp is the same UTC spelling, and a tie previously
  // left the order down to Map insertion.
  const band = (e: CanvasLibraryEntry): number =>
    e.isActiveForThisSession ? 0 : e.ownedByThisSession ? 1 : 2
  out.sort((a, b) => {
    const bandDiff = band(a) - band(b)
    if (bandDiff !== 0) return bandDiff
    const at = Date.parse(a.lastRenderedAt)
    const bt = Date.parse(b.lastRenderedAt)
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at
    return a.canvasId < b.canvasId ? -1 : a.canvasId > b.canvasId ? 1 : 0
  })
  // One library open must not become an unbounded wall. Sliced AFTER the sort,
  // so what survives is the most relevant, never an arbitrary prefix.
  return out.length > MAX_LIBRARY_ENTRIES ? out.slice(0, MAX_LIBRARY_ENTRIES) : out
}

/** How many library rows one call returns. Well above a session's own cap
 *  (MAX_CANVASES_PER_SESSION) so a session always sees all of its own. */
const MAX_LIBRARY_ENTRIES = 120

/**
 * One canvas the LIBRARY may show, with its versions — the artefact-level read
 * `canvas:libraryList` builds rows from (M4).
 *
 * `listAllCanvases` answers a canvas-level question and cannot serve this: a
 * canvas accumulates several ARTEFACTS (a mockup run, then a plan, then a test
 * pack) and a per-canvas row could only ever describe the newest of them. This
 * hands back the versions so the caller — which also holds the review store and
 * config-manager, neither of which this store may import — can split them into
 * runs and compose a row per artefact.
 *
 * Same project scope and the SAME privacy rule, applied here rather than left
 * to the caller, so the two listing channels cannot drift apart.
 */
export interface LibraryCanvas {
  state: CanvasState
  createdAt: string
  cwd?: string
  ownedByThisSession: boolean
  isActiveForThisSession: boolean
}

export function listCanvasesForLibrary(args: {
  askingSessionId: string
  projectCwd?: string
  /**
   * THE PRIVACY RULE'S ORACLE. NEVER derived from an open-tile hint — see
   * `listAllCanvases` for why a caller-composed array cannot gate the
   * visibility of another session's work. Absent = nothing is live.
   */
  isSessionLive?: (sessionId: string) => boolean
}): LibraryCanvas[] {
  ensureDiskScanned()
  if (!SESSION_ID_RE.test(args.askingSessionId)) return []
  const live = args.isSessionLive ?? (() => false)
  const activeForAsking = sessionIndex.get(args.askingSessionId)
  const out: LibraryCanvas[] = []
  for (const record of canvases.values()) {
    const mine = record.sessionId === args.askingSessionId
    // THE PRIVACY RULE (M4) — the same one `listAllCanvases` applies, and for
    // the same reason: an in-flight canvas whose owner is LIVE and is not the
    // caller is not the caller's to see. Completed work is memorialised into
    // the shared project library; ownerless work is resumable, so it shows.
    if (!mine && !record.completed && isLiveOrUnknown(record.sessionId, live)) continue
    // Project scope NEVER hides a session's own canvas — the same fail-open
    // `listAllCanvases` takes, because the library is the only route back to
    // work whose project key merely respells.
    if (!mine && args.projectCwd && record.cwd && !sameProjectDir(record.cwd, args.projectCwd)) continue
    out.push({
      state: toState(record),
      createdAt: clampToNow(record.createdAt),
      ...(record.cwd ? { cwd: record.cwd.replace(FORMAT_CONTROLS_RE, '') } : {}),
      ownedByThisSession: mine,
      isActiveForThisSession: mine && activeForAsking === record.canvasId,
    })
  }
  return out
}

/**
 * Remove a tree WITHOUT ever descending through a reparse point.
 *
 * `fs.rmSync(dir, { recursive: true })` must NOT be used for this, and the
 * reason is worth stating because it is invisible in a normal test run:
 * `rmSync(recursive)` FOLLOWS an NTFS junction nested inside the tree on the
 * Electron runtime and deletes the junction's *target*, while the same call on
 * plain Node unlinks the link and leaves the target alone. Same Node version
 * (24.18.0), opposite behaviour — measured against Electron 43.2.0. vitest
 * executes under plain Node, so a unit test asserting "the target survived"
 * passes whether or not the bug is present. That is precisely how a
 * nested-junction escape reached review labelled "confined".
 *
 * Confinement therefore rests on this walker, not on any property of `rmSync`:
 * every entry is `lstat`ed and a link is removed AS a link, never walked. The
 * depth cap bounds recursion over a tree that has been tampered with; a real
 * canvas is three levels deep.
 */
/**
 * Remove one canvas directory, reporting what actually happened.
 *
 * Three outcomes rather than a boolean, because "I deleted nothing" and "the
 * canvas is gone" were previously indistinguishable and the caller guessed
 * wrong: a sharing violation from AV or the search indexer left the canvas
 * fully intact on disk while the UI said it had been deleted, and the record
 * came back on the next disk scan.
 */
function removeCanvasDirectory(dir: string): 'removed' | 'absent' | 'failed' {
  let st: fs.Stats
  try {
    st = fs.lstatSync(dir)
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'failed'
  }
  // A link sitting where the canvas directory should be is refused outright:
  // every path built from here would resolve through it.
  if (!st.isDirectory() || st.isSymbolicLink()) return 'failed'

  // canvas.json is the provenance anchor — `ensureDiskScanned` does not see a
  // canvas without one — so removing it FIRST makes the deletion irreversible
  // before any bulk removal can fail part-way. `dir` was just confirmed to be a
  // real directory, so this join cannot resolve through a planted link.
  try {
    fs.unlinkSync(path.join(dir, 'canvas.json'))
  } catch (err) {
    // Already gone is fine. Anything else means the anchor SURVIVES, so the
    // canvas would reappear on the next scan — report failure instead of
    // half-deleting it and dropping the record.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return 'failed'
  }

  try {
    removeTreeNoFollow(dir)
  } catch (err) {
    // The anchor is already gone, so the canvas cannot return; some files just
    // could not be unlinked. Destroyed either way — say so, and leave a trace.
    console.warn('[canvas-store] canvas deleted with files left behind:', err)
  }
  return 'removed'
}

function removeTreeNoFollow(target: string, depth = 0): void {
  if (depth > 64) throw new Error('canvas delete: tree deeper than expected, refusing to recurse')
  let st: fs.Stats
  try {
    st = fs.lstatSync(target)
  } catch {
    return // already gone
  }
  if (st.isSymbolicLink()) {
    // A junction or directory symlink needs rmdir; a file symlink needs unlink.
    // Removing either detaches the link and never touches what it points at —
    // the same idiom the profile-junction repair uses in account-profiles.ts.
    try {
      fs.rmdirSync(target)
    } catch {
      fs.unlinkSync(target)
    }
    return
  }
  if (!st.isDirectory()) {
    fs.unlinkSync(target)
    return
  }
  for (const entry of fs.readdirSync(target)) removeTreeNoFollow(path.join(target, entry), depth + 1)
  fs.rmdirSync(target)
}

/**
 * Delete one canvas: its record, its indexes, and its directory on disk.
 *
 * The only destructive operation this store has, so the path discipline is
 * explicit rather than inherited. `canvasId` is charset-gated (it is a
 * `randomId()`, so the gate only ever rejects something a real id could not be)
 * and the directory it names is REALPATH-resolved and required to sit directly
 * inside the canvas root before anything is removed — a symlink planted at
 * `<root>/<id>` pointing elsewhere resolves out of the root and is refused
 * rather than followed. That check covers the TOP of the tree only, so the
 * removal itself goes through `removeTreeNoFollow`, which refuses to descend a
 * link planted further down. Both halves are needed: without the walker, a
 * junction at `<root>/<id>/versions/<v>/x` pointing at a user's project is a
 * deterministic arbitrary-directory-deletion primitive on the shipped runtime.
 *
 * The version files are the user's own rendered documents; removing the canvas
 * removes them, which is the point of the button. A canvas whose directory is
 * already gone still drops out of the in-memory maps, because the record is
 * what surfaces it in the UI.
 */
export function deleteCanvas(canvasId: string): boolean {
  if (typeof canvasId !== 'string' || !CANVAS_ID_RE.test(canvasId)) return false
  ensureDiskScanned()
  const record = canvases.get(canvasId)

  const root = canvasRoot()
  let realRoot: string
  try {
    realRoot = fs.realpathSync(root)
  } catch {
    realRoot = root
  }
  const dir = path.join(root, canvasId)
  let removable = false
  let alreadyGone = false
  try {
    // realpath, NOT the joined string: the join is traversal-safe thanks to the
    // charset gate, but only resolving links proves the directory is really
    // inside the store rather than a link pointing at someone's project.
    //
    // The test is IDENTITY, not containment: the directory must BE
    // `<root>/<id>`. "Resolves to somewhere inside the root" is too weak — a
    // link at `<root>/<idA>` pointing at sibling `<root>/<idB>` resolves to a
    // single in-root segment and passes a containment check, so deleting A
    // would take B's files with it.
    const realDir = fs.realpathSync(dir)
    const expected = path.join(realRoot, canvasId)
    // Windows resolves paths case-insensitively, and realpath returns on-disk
    // casing that need not match the id's; elsewhere the comparison is exact.
    removable =
      process.platform === 'win32'
        ? realDir.toLowerCase() === expected.toLowerCase()
        : realDir === expected
  } catch (err) {
    // ENOENT is a successful outcome for a delete — there is nothing there to
    // remove. Any other error (typically a sharing violation) means we do NOT
    // know what is on disk, and must not report success.
    alreadyGone = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
    removable = false
  }

  const outcome = removable ? removeCanvasDirectory(dir) : alreadyGone ? 'absent' : 'failed'
  if (outcome === 'failed') {
    // Nothing was removed and the canvas is still whole. Keep the record: a row
    // the user can retry is honest, where dropping it would hide a canvas that
    // reappears at the next launch — and would take its reviews with it.
    return false
  }

  canvases.delete(canvasId)
  for (const [sessionId, id] of sessionIndex) {
    if (id === canvasId) sessionIndex.delete(sessionId)
  }
  for (const [sessionId, id] of draftIndex) {
    if (id === canvasId) draftIndex.delete(sessionId)
  }
  // Tell any pane still showing this canvas that it is gone: the event carries
  // a null active version, which is the same shape the pane already handles for
  // "this session has no canvas".
  if (record) {
    emitChanged({ ...record, activeVersionId: null })
  }
  return record !== undefined || outcome === 'removed'
}

/**
 * Archive (or un-archive) the ARTIFACT a version belongs to (item C, phase 5).
 *
 * Reversible and non-destructive: it only sets the `archived` flag on every
 * version of the artifact run, which moves it into the muted Archived history
 * group. Nothing on disk is removed and no review note is touched. Keyed by
 * canvasId (the pane passes its own), and it no-ops safely when the version or
 * its run is not found.
 */
export function setArtifactArchived(canvasId: string, versionId: string, archived: boolean): CanvasState | null {
  if (!CANVAS_ID_RE.test(canvasId) || !CANVAS_VERSION_ID_RE.test(versionId)) return null
  const record = getRecord(canvasId)
  if (!record) return null
  const run = artifactRunContaining(record.versions, versionId)
  if (!run) return toState(record)
  const runIds = new Set(run.map((v) => v.id))
  // ARCHIVING CLEARS A REVIEW-NEEDED STAMP THAT POINTS INTO THIS RUN (W3, live
  // repro).
  //
  // The two had drifted apart: every OTHER reader treats an archived run as not
  // owed — `openVersionIdsOf` skips it, so a force never dismisses its open
  // version — while `awaitingReview` went on naming a version inside it. The
  // force path checks that stamp AFTER it has already force-closed everything
  // else, so the canvas reached a state where Mark complete refused for ever
  // and no gesture remained that could clear it: the version it named was
  // archived, so nothing would ever rule on it. "Mark complete is never dead"
  // has to hold.
  //
  // Cleared HERE rather than tolerated in the force path, so the queue, the
  // pill, the Library's owed text and the completion guard all read one answer.
  // Un-archiving restores nothing: the version still carries no verdict, so it
  // is an OPEN version again and the ordinary owed rules pick it straight up.
  const dropAwaiting = archived && !!record.awaitingReview && runIds.has(record.awaitingReview.versionId)
  const nextRecord: CanvasRecord = {
    ...record,
    versions: record.versions.map((v) => {
      if (!runIds.has(v.id)) return v
      if (archived) return { ...v, archived: true as const }
      const { archived: _drop, ...rest } = v
      return rest
    }),
  }
  if (dropAwaiting) delete (nextRecord as { awaitingReview?: unknown }).awaitingReview
  persist(nextRecord)
  canvases.set(canvasId, nextRecord)
  emitChanged(nextRecord)
  return toState(nextRecord)
}

/**
 * Permanently delete the ARTIFACT a version belongs to (item C, phase 5): its
 * versions, their rendered files on disk, and — via the caller, which holds the
 * review store — their review notes. Irreversible, and DURABLE: the record's
 * monotonic `nextVersion` counter is preserved untouched, so a later render
 * mints a fresh id and never resurrects a deleted one.
 *
 * Returns the deleted version ids so the IPC handler can drop their reviews
 * (the review store imports this one, so the cross-store step lives with the
 * caller, exactly as `deleteCanvas` + `dropReviewsForCanvas` do). Refuses to
 * delete the canvas's ONLY artifact — that is "delete the canvas", which the
 * library owns and which has its own confirmation and path discipline.
 *
 * Path safety mirrors `deleteCanvas`: the canvas directory is realpath-confirmed
 * to sit directly in the canvas root before anything is removed, and each
 * version directory is removed through `removeTreeNoFollow`, which unlinks a
 * planted junction AS a link rather than descending it.
 */
export function deleteArtifact(
  canvasId: string,
  versionId: string,
): { ok: true; deletedVersionIds: string[] } | { ok: false; reason: 'not-found' | 'only-artifact' | 'unsafe' } {
  if (!CANVAS_ID_RE.test(canvasId) || !CANVAS_VERSION_ID_RE.test(versionId)) return { ok: false, reason: 'not-found' }
  const record = getRecord(canvasId)
  if (!record) return { ok: false, reason: 'not-found' }
  const run = artifactRunContaining(record.versions, versionId)
  if (!run) return { ok: false, reason: 'not-found' }
  // Deleting every version is deleting the canvas — a different operation, with
  // its own confirmation, in the library. Refuse rather than silently emptying
  // the pane to an id-less husk.
  const readyCount = record.versions.filter((v) => !v.draft).length
  const runReady = run.filter((v) => !v.draft).length
  if (runReady >= readyCount) return { ok: false, reason: 'only-artifact' }

  // Top-of-tree confinement (same as deleteCanvas): the canvas directory must
  // realpath to <root>/<id> before any version directory under it is removed.
  const root = canvasRoot()
  let realRoot: string
  try {
    realRoot = fs.realpathSync(root)
  } catch {
    realRoot = root
  }
  let realCanvasDir: string | null = null
  try {
    realCanvasDir = fs.realpathSync(canvasDir(canvasId))
    const expected = path.join(realRoot, canvasId)
    const same =
      process.platform === 'win32'
        ? realCanvasDir.toLowerCase() === expected.toLowerCase()
        : realCanvasDir === expected
    if (!same) return { ok: false, reason: 'unsafe' }
  } catch (err) {
    // ENOENT — the canvas dir is already gone; the record mutation below is
    // still the durable truth, so continue with no file removal. Any other
    // error means we cannot vouch for the path and must not remove under it.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return { ok: false, reason: 'unsafe' }
    realCanvasDir = null
  }

  const deletedVersionIds = run.map((v) => v.id)
  const deleted = new Set(deletedVersionIds)
  // `versions/` itself is lstat'd as a FINAL component (which the OS does not
  // follow), so a reparse point planted there is caught as a link and ALL file
  // removal is skipped — the deterministic form of the intermediate-junction
  // escape, closed the same way `deleteCanvas`'s walker catches it (ADR-009
  // round 2). This is checked once, up front, before any per-version work.
  if (realCanvasDir !== null) {
    try {
      const vst = fs.lstatSync(path.join(canvasDir(canvasId), 'versions'))
      if (vst.isSymbolicLink() || !vst.isDirectory()) {
        console.warn('[canvas-store] refusing version-file removal: versions/ is not a plain directory')
        realCanvasDir = null // skip all file removal; the metadata delete still lands
      }
    } catch (err) {
      // No versions dir at all — nothing to remove. Skip file removal; the
      // record mutation below is still the durable truth.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') realCanvasDir = null
    }
  }
  // Realpath EACH version directory to its expected slot before removing it —
  // not just the canvas dir. `removeTreeNoFollow` refuses to follow the FINAL
  // path component, but the OS resolves an intermediate reparse point (a
  // junction planted at `<canvasDir>/versions`) transparently, so starting the
  // walk below the checked boundary let a `versions` junction redirect the
  // per-version delete out of the canvas dir entirely (ADR-009, this change).
  // The identity check catches exactly that: a redirected version dir realpaths
  // somewhere other than `<realCanvasDir>/versions/<id>` and is skipped. Its
  // metadata still goes below, so the delete is durable; only the out-of-tree
  // unlink is refused. Skipped whole when the canvas dir was already gone.
  if (realCanvasDir !== null) {
    for (const id of deletedVersionIds) {
      const dir = versionDir(canvasId, id)
      try {
        const realDir = fs.realpathSync(dir)
        const expectedDir = path.join(realCanvasDir, 'versions', id)
        const same =
          process.platform === 'win32'
            ? realDir.toLowerCase() === expectedDir.toLowerCase()
            : realDir === expectedDir
        if (!same) {
          console.warn(`[canvas-store] refusing to remove ${dir}: it resolves outside the canvas dir`)
          continue
        }
      } catch (err) {
        // ENOENT — nothing there to remove. Anything else — cannot vouch for
        // the path; leave it rather than risk removing out of tree.
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.warn('[canvas-store] artifact version dir not removable:', err)
        }
        continue
      }
      try {
        removeTreeNoFollow(dir)
      } catch (err) {
        // Best-effort: the record mutation is what makes the delete durable, so
        // a file that will not unlink leaves an orphan, never a resurrected
        // version.
        console.warn('[canvas-store] artifact version files left behind:', err)
      }
    }
  }

  const remaining = record.versions.filter((v) => !deleted.has(v.id))
  // Repoint the active version if it was in the deleted run — to the newest
  // survivor, the same fallback sanitizeRecord uses.
  const activeVersionId =
    record.activeVersionId && deleted.has(record.activeVersionId)
      ? (remaining[remaining.length - 1]?.id ?? null)
      : record.activeVersionId
  // The review-needed stamp goes if it pointed at a deleted version.
  const awaitingReview =
    record.awaitingReview && deleted.has(record.awaitingReview.versionId) ? undefined : record.awaitingReview

  const nextRecord: CanvasRecord = {
    ...record,
    versions: remaining,
    activeVersionId,
    // The counter is NEVER lowered — this is the durability guarantee.
    nextVersion: record.nextVersion,
    ...(awaitingReview ? { awaitingReview } : {}),
  }
  // A dropped awaitingReview must actually be removed, not left from the spread.
  if (!awaitingReview) delete (nextRecord as { awaitingReview?: unknown }).awaitingReview
  persist(nextRecord)
  canvases.set(canvasId, nextRecord)
  emitChanged(nextRecord)
  return { ok: true, deletedVersionIds }
}

/**
 * OPEN HERE: point this session at a canvas IT ALREADY OWNS.
 *
 * RE-OPENING YOUR OWN CANVAS IS NOT AN ADOPTION, and since M4 it is all this
 * function does. A session owns one ACTIVE canvas (sessionIndex) but may have
 * authored many: rendering a new subject files the previous one and points the
 * index at the new record, leaving the earlier canvases still stamped with this
 * session's id. Switching back to one of them transfers nothing — the record
 * already says this session — so no ownership machinery applies.
 *
 * THE FOREIGN BRANCH IS GONE. It used to adopt an orphan here, guarded by
 * "is the owner still current" and by `sessionIndex.has(sessionId)`, with no
 * compare-and-set: two sessions racing on one stranded canvas both passed. That
 * transfer now lives in `resumeCanvasForSession`, which is the single ownership
 * -moving path and does the CAS synchronously. A foreign canvas named here is
 * simply refused — which is also what the Library's own-rows-only actions
 * expect.
 *
 * An earlier cut additionally required the record's account stamp to match the
 * asking session's, which made a tile that had switched accounts unable to
 * re-open the canvases it had drawn itself — the account is not what a canvas
 * belongs to (ADR-017).
 */
export function openOwnCanvasForSession(
  sessionId: string,
  canvasId: string,
): { canvasId: string; activeVersionId: string | null } | null {
  if (!SESSION_ID_RE.test(sessionId)) return null
  if (typeof canvasId !== 'string' || !CANVAS_ID_RE.test(canvasId)) return null
  ensureDiskScanned()

  const own = canvases.get(canvasId)
  if (!own || own.sessionId !== sessionId) return null
  sessionIndex.set(sessionId, own.canvasId)
  draftIndex.delete(sessionId)
  emitChanged(own)
  return { canvasId: own.canvasId, activeVersionId: own.activeVersionId }
}

/** Resolve what the ccc-ux:// protocol may serve for a canvas/version pair.
 *  Returns null for anything unknown — the protocol answers 404, never throws. */
export function getServableVersion(canvasId: string, versionId: string): ServableVersion | null {
  if (!CANVAS_VERSION_ID_RE.test(versionId)) return null
  const record = getRecord(canvasId)
  if (!record) return null
  const version = record.versions.find((v) => v.id === versionId)
  if (!version) return null
  // Re-validate the entry at serve time: the empty-path and SPA branches use it
  // as the served path WITHOUT the URL segment filter, so a record that reached
  // memory another way (disk reload) must not carry a colon/traversal entry.
  if (!isSafeEntry(version.source.entry)) return null
  // …and the entry must be an HTML DOCUMENT. This is the half that survives a
  // record the current write ingress would never have produced: a legacy or
  // hand-edited version whose entry names a data file is kept in the record
  // (its siblings are still good) and refused HERE, one version at a time,
  // rather than being dressed up as text/html with the bridge injected.
  if (!isHtmlDocumentPath(version.source.entry)) return null
  if (version.source.mode === 'design') {
    return { mode: 'design', contentRoot: versionDir(canvasId, versionId), entry: version.source.entry }
  }
  // Re-check distRoot containment on every serve: this is what confines a UAT
  // record loaded from disk after a restart, and honours a base that was later
  // de-registered (a session's roots are revoked when its PTY exits). No
  // registered base ⇒ nothing served.
  //
  // The session checked is the canvas's OWNER, taken from the record — the
  // ccc-ux:// protocol has no transport session to bind to, and it does not
  // need one: a canvas belongs to exactly one session (spec D2) and the canvas
  // id is the URL's HOST, so "whose roots apply" is answered by the record
  // rather than by anything the request carries.
  if (!distRootAllowed(version.source.distRoot, record.sessionId)) return null
  return { mode: 'uat', contentRoot: version.source.distRoot, entry: version.source.entry }
}

/**
 * Test seam: the MAC this store would write for a record.
 *
 * Exists so a test can express "a record CCC WROTE, whose contents are then
 * hostile" (an older build's entry, a zero-version record) as distinct from
 * "a record CCC never wrote". Without it every hand-written fixture is refused
 * at the signature and the guard the test is actually about never runs — the
 * test passes while testing nothing.
 */
export function _canvasRecordMacForTest(record: unknown): string {
  return canvasRecordMac(record as CanvasRecord)
}

/** Test seam: drop all in-memory state so each test starts cold. */
export function _resetCanvasStoreForTest(): void {
  canvases.clear()
  sessionIndex.clear()
  draftIndex.clear()
  uatRootsBySession.clear()
  designatedRootsBySession.clear()
  diskScanned = false
  sessionInfoResolver = null
  _canvasRecordKey = null
}
