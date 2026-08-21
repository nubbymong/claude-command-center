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
  type CanvasLibraryEntry,
  CANVAS_VERSION_ID_RE,
  CanvasChangedEvent,
  CanvasRenderSource,
  CanvasState,
  CanvasVersion,
  MAX_CANVAS_TITLE_CHARS,
  ReclaimableCanvas,
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
export function registerCanvasUatRoot(sessionId: string, baseDir: string): boolean {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return false
  if (typeof baseDir !== 'string' || !path.isAbsolute(baseDir)) return false
  let real: string
  try {
    real = fs.realpathSync.native(path.resolve(baseDir))
  } catch {
    return false // an unresolvable base is simply not added
  }
  try {
    if (!fs.statSync(real).isDirectory()) return false
  } catch {
    return false
  }
  if (isHomeOrAncestor(real)) return false
  if (isVolumeRoot(real)) return false
  if (isDotDirUnderHome(real)) return false
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
}

/**
 * The constraints that still apply even when the USER picks a canvas by id.
 *
 * There is no identity-matching key here any more, and that is the point. Two
 * rounds of adversarial review killed every automatic rule: the project
 * directory is ambiguous (two tiles on one repo), the conversation uuid is
 * derived from the transcript binder and is both heuristic and agent-writable,
 * and "is the owner still current" has no reliable oracle. A canvas carries
 * the user's private review notes, so moving one is an authorization decision
 * — and the only party able to make it is the user, who is asked (see
 * canvas-session-link.listReclaimableCanvases).
 *
 * What remains is one floor the user's choice cannot lower: a canvas whose owner
 * might still come back is never taken.
 *
 * The account is deliberately NOT part of this. A canvas belongs to the PROJECT
 * it was made for, not to whichever Claude account happened to be signed in when
 * it was drawn — switching accounts in a tile is an ordinary thing to do, and
 * making it an adoption key left users unable to open their own mockups. The
 * project is the axis, and it organises rather than forecloses: the library
 * scopes to it, the reclaim list marks and sorts by it. See ADR-017.
 */
export interface CanvasAdoptionQuery {
  /**
   * True when the given session can still come back and claim its canvas by
   * id — a live PTY, or a tile still in the saved-session list. Fails SAFE:
   * uncertain means current, and current means untouchable.
   */
  isSessionCurrent: (sessionId: string) => boolean
}

export type { ReclaimableCanvas }

/** What renderVersion stamps onto records; resolved per session by the pty
 *  layer (canvas-session-link) so this store stays lifecycle-blind. */
export type CanvasSessionInfoResolver = (
  sessionId: string,
) => { cwd?: string; conversationUuid?: string } | null

let sessionInfoResolver: CanvasSessionInfoResolver | null = null

export function setCanvasSessionInfoResolver(resolver: CanvasSessionInfoResolver | null): void {
  sessionInfoResolver = resolver
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
let diskScanned = false

type CanvasChangedListener = (event: CanvasChangedEvent) => void
const changeListeners = new Set<CanvasChangedListener>()

/** Subscribe to store mutations (IPC handlers push these to the renderer). */
export function onCanvasChanged(listener: CanvasChangedListener): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function emitChanged(record: CanvasRecord): void {
  const event: CanvasChangedEvent = {
    sessionId: record.sessionId,
    canvasId: record.canvasId,
    activeVersionId: record.activeVersionId,
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
// next app start the store served it and the reclaim card offered it to the
// user as their own earlier work. It survived a restart, which made it the one
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
  // A hand-edited record must not smuggle a traversing/colon/device `entry`
  // past the live-render normalizer (the empty-path + SPA branches serve the
  // entry WITHOUT re-running the URL segment filter). distRoot containment is
  // re-checked at serve time (getServableVersion) so a de-registered base is
  // also honoured, but reject an obviously-broken distRoot shape here too.
  if (!isSafeEntry(ver.source.entry)) return false
  if (ver.source.mode === 'uat' && (typeof ver.source.distRoot !== 'string' || ver.source.distRoot.length === 0)) return false
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
    if (!isKeepableVersion(v)) continue
    if (versions.some((kept) => kept.id === v.id)) continue // ids are the serve key
    versions.push(v)
  }
  // The active version must still exist. Only re-pointed when the one it named
  // was dropped — falling back to the newest SURVIVING version keeps the pane
  // showing something rather than an id that resolves to nothing. An explicit
  // null stays null.
  let activeVersionId = r.activeVersionId
  if (activeVersionId !== null && !versions.some((v) => v.id === activeVersionId)) {
    activeVersionId = versions[versions.length - 1]?.id ?? null
  }

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

function getRecordForSession(sessionId: string): CanvasRecord | null {
  ensureDiskScanned()
  const canvasId = sessionIndex.get(sessionId)
  return canvasId ? (canvases.get(canvasId) ?? null) : null
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
    versions: record.versions.map((v) => ({ ...v, source: { ...v.source } })),
    ...(record.title ? { title: record.title } : {}),
  }
}

/** The renderer's view of a session's canvas; null until something rendered. */
export function getCanvasStateForSession(sessionId: string): CanvasState | null {
  if (!SESSION_ID_RE.test(sessionId)) return null
  const record = getRecordForSession(sessionId)
  return record ? toState(record) : null
}

/** The next linear version id: one past the highest number already present.
 *  Identical to `length + 1` for a contiguous list, and correct for one with a
 *  gap (a version dropped by sanitizeRecord). */
function nextVersionId(versions: CanvasVersion[]): string {
  let max = 0
  for (const v of versions) {
    const n = Number.parseInt(v.id.slice(1), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `v${max + 1}`
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
function sanitizeCanvasTitle(raw: unknown): string | undefined {
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
  const capped = Array.from(cleaned).slice(0, MAX_CANVAS_TITLE_CHARS).join('')
  const final = clean(capped)
  return final.length === 0 ? undefined : final
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
 * an authorization decision and stays with `adoptCanvasForSession`, which the
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
    if (!best || lastRenderedAt(record) > lastRenderedAt(best)) best = record
  }
  return best
}

export function renderVersion(
  sessionId: string,
  source: CanvasRenderSource,
): { canvasId: string; versionId: string; filed?: { canvasId: string } } {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('invalid session id')

  const held = getRecordForSession(sessionId)
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
  const returnedTo = subjectChanged && title ? findFiledCanvas(sessionId, title) : undefined
  const existing = subjectChanged ? returnedTo : held

  if (existing && existing.versions.length >= MAX_VERSIONS_PER_CANVAS) {
    throw new Error(`canvas ${existing.canvasId} is at its version cap (${MAX_VERSIONS_PER_CANVAS})`)
  }
  // A subject change that starts a NEW canvas is the one thing that can grow
  // the number of canvases a session owns; before it, a session had one. Cap
  // it, so an agent cycling titles cannot mint directories without bound —
  // each is a synchronous read and an HMAC at the next launch. Filing goes on
  // working: the user clears room from the library.
  if (subjectChanged && !existing && countCanvasesForSession(sessionId) >= MAX_CANVASES_PER_SESSION) {
    throw new Error(
      `this session already has ${MAX_CANVASES_PER_SESSION} canvases; delete some from the library before starting another subject`,
    )
  }

  // Everything that can REJECT the render is validated up front, before any
  // canvas state is created or mutated — a rejected render leaves nothing
  // behind (no empty canvas, no half-written version).
  const canvasId = existing?.canvasId ?? randomId()
  // Highest existing number + 1, not `length + 1`. A record loaded from disk may
  // legitimately have gaps now that sanitizeRecord drops individual versions
  // ([v1, v3] has length 2), and `length + 1` would mint a SECOND 'v3' — two
  // versions with one serve key.
  const versionId = nextVersionId(existing?.versions ?? [])
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
    const dir = versionDir(canvasId, versionId)
    mkdirSecure(dir)
    atomicWriteSecure(path.join(dir, 'index.html'), source.html)
    version = { id: versionId, mode: source.mode, createdAt, source: { mode: 'design', entry: 'index.html' } }
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
  let info: ReturnType<CanvasSessionInfoResolver> = null
  try {
    info = sessionInfoResolver ? sessionInfoResolver(sessionId) : null
  } catch {
    info = null
  }
  const cwdStamp =
    typeof info?.cwd === 'string' && info.cwd.length > 0 && info.cwd.length <= MAX_CWD_CHARS ? info.cwd : undefined
  const conversationStamp =
    typeof info?.conversationUuid === 'string' && CONVERSATION_UUID_RE.test(info.conversationUuid)
      ? info.conversationUuid
      : undefined

  const base: CanvasRecord = existing ?? { canvasId, sessionId, createdAt, activeVersionId: null, versions: [] }
  const nextRecord: CanvasRecord = {
    ...base,
    ...(cwdStamp && !base.cwd ? { cwd: cwdStamp } : {}),
    ...(conversationStamp ? { conversationUuid: conversationStamp } : {}),
    // The subject. Only ever set to a title that names the SAME subject (a
    // different one took the new-canvas branch above), so this fills in a
    // missing title and refreshes the wording, never repurposes the canvas.
    // An UNREADABLE title (emoji-only) may fill an empty label but never
    // overwrite a readable one — that would relabel "Checkout flow" as "🔥🔥🔥"
    // in the library while the notes underneath stayed about checkout.
    ...(title && (comparable || !base.title) ? { title } : {}),
    versions: [...base.versions, version],
    activeVersionId: versionId,
  }
  persist(nextRecord)
  canvases.set(canvasId, nextRecord)
  sessionIndex.set(sessionId, canvasId)
  emitChanged(nextRecord)
  // Report a FILING to the caller. `subjectChanged` was a local boolean that
  // never left this function, so nothing downstream could tell that the canvas
  // the user was reviewing had just been moved aside -- taking any unresolved
  // notes on it out of view. The ID only: the filed canvas's title is
  // agent-authored text, and the tool reply it feeds is operator voice.
  const filedId = subjectChanged && held && held.canvasId !== canvasId ? held.canvasId : undefined
  return { canvasId, versionId, ...(filedId ? { filed: { canvasId: filedId } } : {}) }
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

/**
 * Let a session that owns NO canvas reclaim the canvas of the SAME CONVERSATION
 * (2026-08-14, the VM "repush" bug: app restart → fresh tile → same
 * conversation resumed → the canvas stranded under the dead session id and a
 * second render minted a parallel canvas, both called "v1").
 *
 * THE MATCH KEY IS THE CONVERSATION, AND ONLY THE CONVERSATION.
 *
 * The first cut of this also adopted on a project-directory match. Adversarial
 * review (2026-08-14) showed that to be a canvas-theft primitive reachable in
 * the app's most ordinary state, with no attacker required: two tiles open on
 * one repo is normal usage; a PTY exit (`/exit`, a crash, the Restart button)
 * makes the first session stop looking "current"; the second tile would then
 * inherit the first's canvas AND the user's private review notes — and, since
 * nothing consulted the account, across two different Claude accounts. Three
 * further findings (Windows Unicode case-folding matching two DISTINCT real
 * directories, a relative/'.' cwd resolving onto one shared key, no realpath)
 * were all consequences of treating a directory as an identity. It is not one.
 * Resuming a conversation is.
 *
 * There is no identity key here at all any more. The account used to be one —
 * compared exactly, `undefined` included — and ADR-017 removed it: a canvas
 * belongs to the PROJECT it was made for, not to whichever Claude account
 * happened to be signed in, and a session id outlives an account switch, so the
 * check locked users out of their own mockups. Do not re-add it without a new
 * decision; the ADR is the record of why it went.
 *
 * A canvas is only adoptable when its owner session is not current per the
 * caller's check — a live PTY or a saved tile keeps its canvas reclaimable by
 * id, and this function will not touch it. That check fails SAFE (see
 * canvas-session-link).
 *
 * The re-bind persists BEFORE memory moves (the renderVersion discipline), and
 * the caller is expected to re-bind the canvas's review store next
 * (rebindReviewsToSession) — reviews.json carries the owner session id too.
 */
/**
 * Is `record` one this session could be OFFERED? Shared by the lister and the
 * reclaim, so the list can never advertise something reclaim would refuse.
 *
 * The project is NOT a filter here, deliberately. The library is already
 * per-project, so if this path hid other projects' canvases too, a canvas whose
 * project you never open again would have no route back at all — and being
 * locked out of your own canvas is a bug this app has already shipped once. The
 * reclaim list instead offers everything reclaimable and MARKS which rows are
 * from the project you are in (`sameProject`, sorted first), so the project is
 * what organises the choice rather than what forecloses it.
 */
function isReclaimCandidate(record: CanvasRecord, sessionId: string, query: CanvasAdoptionQuery): boolean {
  if (record.sessionId === sessionId) return false
  if (record.versions.length === 0) return false // nothing to inherit
  try {
    if (query.isSessionCurrent(record.sessionId)) return false
  } catch {
    return false // cannot tell → treat as current → untouchable
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
 * reclaim card's text and its `title` tooltip. `\p{Cf}` is the set the gaps kept
 * falling out of — it also covers the tag characters U+E0020-U+E007F, which no
 * enumeration written by hand was ever going to include. Display-only: nothing
 * downstream matches on this value (a reclaim is addressed by canvas id).
 */
const FORMAT_CONTROLS_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/** Never render a stamp from the future: it would sort above every real canvas
 *  in the reclaim list. Server-generated today (so this is a floor against
 *  clock skew rather than against a caller), and cheap enough to keep. */
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
function sameProjectDir(a: string, b: string): boolean {
  const clean = (p: string) => {
    const stripped = p.replace(FORMAT_CONTROLS_RE, '')
    // path.resolve normalises separators and `.` segments, but only makes sense
    // on an absolute path -- a relative one would be resolved against the main
    // process's cwd, which has nothing to do with either session.
    return path.isAbsolute(stripped) ? path.resolve(stripped) : stripped
  }
  return sameFsPath(clean(a), clean(b))
}

/** Canvases this session could reclaim, for the user to choose from. Pure read
 *  — nothing moves until the user names one. */
export function listOrphanCandidateCanvases(sessionId: string, query: CanvasAdoptionQuery): ReclaimableCanvas[] {
  if (!SESSION_ID_RE.test(sessionId)) return []
  ensureDiskScanned()
  if (sessionIndex.has(sessionId)) return [] // already owns one
  const out: ReclaimableCanvas[] = []
  for (const record of canvases.values()) {
    if (!isReclaimCandidate(record, sessionId, query)) continue
    const cwd = record.cwd?.replace(FORMAT_CONTROLS_RE, '')
    out.push({
      canvasId: record.canvasId,
      versionCount: record.versions.length,
      lastRenderedAt: clampToNow(record.versions[record.versions.length - 1]?.createdAt ?? record.createdAt),
      // The disambiguator. Two canvases from one project were previously
      // indistinguishable on the card — same title, same cwd, often the same
      // version count — and picking the wrong one re-binds ANOTHER project's
      // private review notes to this session, which the pre-allowed
      // `canvas_review` can then read. The conversation is what actually
      // differs between them, so it is what the user is shown.
      ...(record.conversationUuid ? { conversationShortId: record.conversationUuid.slice(0, 8) } : {}),
      ...(cwd ? { cwd } : {}),
    })
  }
  return out
}

/**
 * Move the canvas the USER named to this session.
 *
 * Addressed by id, never matched: the canvas the user picked out of
 * listOrphanCandidateCanvases is the one that moves. The floor still applies —
 * owner not current — so a stale id or a canvas that came back to life is
 * refused rather than taken. That floor is now the ONLY one (ADR-017 removed
 * the account half), so its oracle is what the whole guarantee rests on.
 *
 * Persists BEFORE memory moves (the renderVersion discipline), and the caller
 * re-binds the review store next (rebindReviewsToSession) — reviews.json
 * carries the owner session id too.
 */
/**
 * The canvas LIBRARY: every canvas on disk, newest first.
 *
 * Housekeeping, not authorization. Unlike `listOrphanCandidateCanvases` this
 * deliberately does NOT filter to what the asking session could adopt — the
 * whole point is to show the user what has accumulated so they can remove it.
 * Nothing here binds a canvas to a session; only `adoptCanvasForSession` does,
 * and it is unchanged.
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
   * ownership is decided by adoptCanvasForSession alone.
   */
  projectCwd?: string,
  /**
   * The session ASKING. Purely so the list can say which rows are this
   * session's own and which one it is showing — the in-pane switcher offers
   * only its own, while the library shows everything.
   *
   * DISPLAY ONLY, and the distinction matters: nothing here grants anything.
   * Ownership is decided by adoptCanvasForSession, and delete is id-only with
   * no ownership check at the IPC seam, so a "mine" badge must never be read as
   * a permission.
   */
  askingSessionId?: string,
): CanvasLibraryEntry[] {
  ensureDiskScanned()
  const open = new Set(openTileSessionIds.filter((id) => SESSION_ID_RE.test(id)))
  const asking = askingSessionId && SESSION_ID_RE.test(askingSessionId) ? askingSessionId : undefined
  const activeForAsking = asking ? sessionIndex.get(asking) : undefined
  const out: CanvasLibraryEntry[] = []
  for (const record of canvases.values()) {
    // The same question adoptCanvasForSession answers, so the badge and the
    // action can never disagree: did THIS session author it.
    const mine = asking !== undefined && record.sessionId === asking
    // Project scope NEVER hides a session's own canvas.
    //
    // ADR-017 scopes the library to the project, and justifies it by saying the
    // reclaim list stays unfiltered so a canvas whose project you never open
    // again still has a route back. It does not: listOrphanCandidateCanvases
    // returns [] the moment the asking session owns a canvas, and excludes the
    // session's own regardless. So for any session that has ever rendered, the
    // scoped library is the ONLY route to its own work -- and a project key that
    // merely RESPELLS (a trailing separator, a relaunch reading cwd from the
    // transcript instead of the config) would strand every canvas it authored,
    // including the one currently active. Filtering by relevance is right;
    // foreclosing is not, so own rows are always kept and the picker sorts them
    // to the top.
    if (!mine && projectCwd && record.cwd && !sameProjectDir(record.cwd, projectCwd)) continue
    const latest = record.versions[record.versions.length - 1]
    const cwd = record.cwd?.replace(FORMAT_CONTROLS_RE, '')
    out.push({
      canvasId: record.canvasId,
      versionCount: record.versions.length,
      createdAt: clampToNow(record.createdAt),
      lastRenderedAt: clampToNow(latest?.createdAt ?? record.createdAt),
      ...(latest?.source.mode ? { latestMode: latest.source.mode } : {}),
      ...(record.conversationUuid ? { conversationShortId: record.conversationUuid.slice(0, 8) } : {}),
      ...(cwd ? { cwd } : {}),
      ...(record.title ? { title: record.title } : {}),
      ...(open.has(record.sessionId) ? { ownedByOpenSession: true } : {}),
      // A session OWNS up to MAX_CANVASES_PER_SESSION records while pointing at
      // exactly one, so these two are different questions and both are asked.
      ...(mine ? { ownedByThisSession: true } : {}),
      ...(mine && activeForAsking === record.canvasId ? { isActiveForThisSession: true } : {}),
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
  // Tell any pane still showing this canvas that it is gone: the event carries
  // a null active version, which is the same shape the pane already handles for
  // "this session has no canvas".
  if (record) {
    emitChanged({ ...record, activeVersionId: null })
  }
  return record !== undefined || outcome === 'removed'
}

export function adoptCanvasForSession(
  sessionId: string,
  canvasId: string,
  query: CanvasAdoptionQuery,
): { canvasId: string; activeVersionId: string | null } | null {
  if (!SESSION_ID_RE.test(sessionId)) return null
  if (typeof canvasId !== 'string' || !CANVAS_ID_RE.test(canvasId)) return null
  ensureDiskScanned()

  // RE-OPENING YOUR OWN CANVAS IS NOT AN ADOPTION.
  //
  // A session owns one ACTIVE canvas (sessionIndex) but may have authored many:
  // rendering a new subject files the previous one and points the index at the
  // new record, leaving the earlier canvases still stamped with this session's
  // id. Switching back to one of them transfers nothing — the record already
  // says this session — so none of the ownership machinery below applies.
  //
  // The `sessionIndex.has(sessionId)` guard underneath is what stops a session
  // that already holds a canvas from taking SOMEONE ELSE'S. It ran first, so it
  // also refused every canvas the session had made itself, which made the
  // library's "Open here" fail for any session that had ever rendered — i.e.
  // every session that has a library to open. Reported as "it says I can't open
  // it", with the list showing the user's own three canvases as belonging to
  // another session.
  // Nothing else applies to it. An earlier cut also required the record's
  // account stamp to match the asking session's, which made a tile that had
  // switched accounts unable to re-open the canvases it had drawn itself — the
  // account is not what a canvas belongs to (ADR-017).
  const own = canvases.get(canvasId)
  if (own && own.sessionId === sessionId) {
    sessionIndex.set(sessionId, own.canvasId)
    emitChanged(own)
    return { canvasId: own.canvasId, activeVersionId: own.activeVersionId }
  }

  if (sessionIndex.has(sessionId)) return null

  const best = canvases.get(canvasId)
  if (!best || !isReclaimCandidate(best, sessionId, query)) return null

  // Only the owner changes. The stamps are the record's identity — rewriting
  // them here is how the first cut let an adopting session redefine what the
  // canvas "is" (it re-stamped cwd to the adopter's directory).
  const next: CanvasRecord = { ...best, sessionId }
  persist(next)
  const previousOwner = best.sessionId
  canvases.set(next.canvasId, next)
  if (sessionIndex.get(previousOwner) === next.canvasId) sessionIndex.delete(previousOwner)
  sessionIndex.set(sessionId, next.canvasId)
  emitChanged(next)
  return { canvasId: next.canvasId, activeVersionId: next.activeVersionId }
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
  uatRootsBySession.clear()
  designatedRootsBySession.clear()
  diskScanned = false
  sessionInfoResolver = null
  _canvasRecordKey = null
}
