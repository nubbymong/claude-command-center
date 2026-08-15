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
  CANVAS_VERSION_ID_RE,
  CanvasChangedEvent,
  CanvasRenderSource,
  CanvasState,
  CanvasVersion,
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

/** A Claude conversation uuid as it appears in transcript basenames. Kept loose
 *  (hex + dashes) — it is a MATCHING key, never a path segment. */
const CONVERSATION_UUID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/
const MAX_CWD_CHARS = 1024
/** Account-profile ids are app-minted; bounded defensively like the others. */
const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

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

/** Drop every root a session was allowed to serve. Called when its PTY is gone
 *  (pty-manager cleanupSessionResources) — a root outlives nothing. */
export function revokeCanvasUatRoots(sessionId: string): void {
  uatRootsBySession.delete(sessionId)
}

/** True iff `candidate` physically resolves at/under a base registered for
 *  THIS session. realpath both sides so a symlinked base or candidate cannot
 *  dodge the check. Unknown session ⇒ no roots ⇒ false (fail closed). */
function resolvesUnderSessionRoot(candidate: string, sessionId: string): string | null {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null
  const roots = uatRootsBySession.get(sessionId)
  if (!roots || roots.size === 0) return null
  let real: string
  try {
    real = fs.realpathSync.native(candidate)
  } catch {
    return null
  }
  for (const base of roots) {
    if (real === base || real.startsWith(base + path.sep)) return real
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
  /** The account profile the owning session ran under. Part of the adoption
   *  key: a canvas must never cross accounts (adversarial review 2026-08-14). */
  profileId?: string
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
 * What remains is a floor the user's choice cannot lower: an account never
 * changes, and a canvas whose owner might still come back is never taken.
 */
export interface CanvasAdoptionQuery {
  /** The account profile this session runs under. Must equal the record's
   *  stamp — an unstamped legacy record never crosses into a profiled session
   *  and vice versa. */
  profileId?: string
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
) => { cwd?: string; conversationUuid?: string; profileId?: string } | null

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
  if (r.profileId !== undefined && (typeof r.profileId !== 'string' || !PROFILE_ID_RE.test(r.profileId))) return null
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

  // The MAC is the envelope, not part of the record: strip it so the in-memory
  // record (and therefore the NEXT persist, which re-MACs) never carries a
  // stale one inside the authenticated content.
  const { mac: _mac, ...rest } = r as Partial<CanvasRecord> & { mac?: unknown }
  return { ...(rest as CanvasRecord), versions, activeVersionId }
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
    // First record wins for a session; later duplicates stay addressable by canvasId.
    if (!sessionIndex.has(record.sessionId)) sessionIndex.set(record.sessionId, record.canvasId)
  }
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
export function renderVersion(
  sessionId: string,
  source: CanvasRenderSource,
): { canvasId: string; versionId: string } {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error('invalid session id')

  const existing = getRecordForSession(sessionId)
  if (existing && existing.versions.length >= MAX_VERSIONS_PER_CANVAS) {
    throw new Error(`canvas ${existing.canvasId} is at its version cap (${MAX_VERSIONS_PER_CANVAS})`)
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
  const createdAt = new Date().toISOString()
  let version: CanvasVersion

  if (source.mode === 'design') {
    if (typeof source.html !== 'string' || source.html.length === 0) throw new Error('design render requires html')
    if (Buffer.byteLength(source.html, 'utf8') > MAX_DESIGN_HTML_BYTES) throw new Error('design document too large')
    const dir = versionDir(canvasId, versionId)
    mkdirSecure(dir)
    atomicWriteSecure(path.join(dir, 'index.html'), source.html)
    version = { id: versionId, mode: 'design', createdAt, source: { mode: 'design', entry: 'index.html' } }
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
  const profileStamp =
    typeof info?.profileId === 'string' && PROFILE_ID_RE.test(info.profileId) ? info.profileId : undefined

  const base: CanvasRecord = existing ?? { canvasId, sessionId, createdAt, activeVersionId: null, versions: [] }
  const nextRecord: CanvasRecord = {
    ...base,
    ...(cwdStamp && !base.cwd ? { cwd: cwdStamp } : {}),
    ...(conversationStamp ? { conversationUuid: conversationStamp } : {}),
    // Stamped once, like cwd: the account a canvas was born under is fixed.
    ...(profileStamp && !base.profileId ? { profileId: profileStamp } : {}),
    versions: [...base.versions, version],
    activeVersionId: versionId,
  }
  persist(nextRecord)
  canvases.set(canvasId, nextRecord)
  sessionIndex.set(sessionId, canvasId)
  emitChanged(nextRecord)
  return { canvasId, versionId }
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
 * Both halves of the key must agree and neither may be absent:
 *   - `conversationUuid` — required; no conversation, no adoption;
 *   - `profileId` — the account, compared exactly, `undefined` included, so a
 *     canvas never crosses accounts in either direction.
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
function normalizedProfile(query: CanvasAdoptionQuery): string | undefined {
  return typeof query.profileId === 'string' && PROFILE_ID_RE.test(query.profileId) ? query.profileId : undefined
}

/** Is `record` one this session could be OFFERED? Shared by the lister and the
 *  reclaim, so the list can never advertise something reclaim would refuse. */
function isReclaimCandidate(record: CanvasRecord, sessionId: string, query: CanvasAdoptionQuery): boolean {
  if (record.sessionId === sessionId) return false
  if (record.versions.length === 0) return false // nothing to inherit
  // Exact, `undefined` included: an unstamped legacy record does not cross
  // into a profiled session, and a profiled record does not cross out.
  if (record.profileId !== normalizedProfile(query)) return false
  try {
    if (query.isSessionCurrent(record.sessionId)) return false
  } catch {
    return false // cannot tell → treat as current → untouchable
  }
  return true
}

/**
 * Characters that reorder or hide the text around them: the bidi overrides and
 * isolates, the zero-width joiners/spaces, and the deprecated interlinear
 * annotation marks.
 *
 * Stripped from the `cwd` before it leaves this process. It is a path the user
 * is shown so they can tell one canvas from another, and a `U+202E` in it flips
 * the rest of the line — `C:\work\<RLO>gnp.evil\` reads as a different
 * directory than it is. The strip happens HERE rather than in the component so
 * the value never exists in a renderable form anywhere.
 */
// eslint-disable-next-line no-control-regex
const FORMAT_CONTROLS_RE = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g

/** Never render a stamp from the future: it would sort above every real canvas
 *  in the reclaim list. Server-generated today (so this is a floor against
 *  clock skew rather than against a caller), and cheap enough to keep. */
function clampToNow(iso: string): string {
  const ms = Date.parse(iso)
  const now = Date.now()
  return Number.isFinite(ms) && ms <= now ? iso : new Date(now).toISOString()
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
 * same account, owner not current — so a stale id or a canvas that came back
 * to life is refused rather than taken.
 *
 * Persists BEFORE memory moves (the renderVersion discipline), and the caller
 * re-binds the review store next (rebindReviewsToSession) — reviews.json
 * carries the owner session id too.
 */
export function adoptCanvasForSession(
  sessionId: string,
  canvasId: string,
  query: CanvasAdoptionQuery,
): { canvasId: string; activeVersionId: string | null } | null {
  if (!SESSION_ID_RE.test(sessionId)) return null
  if (typeof canvasId !== 'string' || !CANVAS_ID_RE.test(canvasId)) return null
  ensureDiskScanned()
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
  diskScanned = false
  sessionInfoResolver = null
  _canvasRecordKey = null
}
