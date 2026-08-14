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

import * as fs from 'fs'
import * as path from 'path'
import { randomId } from '../../shared/id'
import {
  CANVAS_ID_RE,
  CANVAS_VERSION_ID_RE,
  CanvasChangedEvent,
  CanvasRenderSource,
  CanvasState,
  CanvasVersion,
} from '../../shared/canvas'
import { atomicWriteSecure, mkdirSecure } from '../account-profiles'
import { getResourcesDirectory } from '../ipc/setup-handlers'

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
 * UAT versions serve a project's built `dist/` from an absolute path the CALLER
 * supplies. That path is NOT trusted: unconfined, a caller could register `C:\`
 * or a home dir and turn the ccc-ux:// protocol into a whole-disk file server
 * (adversarial review, 2026-08-11). So a `distRoot` is accepted ONLY when it
 * resolves at or under a base that was explicitly registered as a canvas UAT
 * root. This is an ALLOWLIST, never a denylist, and it is DEFAULT-EMPTY: with
 * no base registered, every UAT render is refused (fail closed). P1 wires no
 * base yet — design mode, which writes into the canvas dir and needs no
 * distRoot, is the exercised path — so UAT is inert-but-safe until the P3
 * session/MCP path registers a session's own project directory here.
 */
const uatRoots = new Set<string>()

/** Register a directory under which UAT `distRoot`s may live. Idempotent;
 *  a base that does not resolve is silently ignored. A relative base is
 *  refused outright — `path.resolve('')`/`resolve('.')` would silently
 *  allowlist the process cwd (adversarial review, 2026-08-11). */
export function registerCanvasUatRoot(baseDir: string): void {
  if (typeof baseDir !== 'string' || !path.isAbsolute(baseDir)) return
  try {
    uatRoots.add(fs.realpathSync.native(path.resolve(baseDir)))
  } catch {
    /* an unresolvable base is simply not added */
  }
}

/** True iff `distRoot` physically resolves at/under a registered UAT base.
 *  realpath both sides so a symlinked base or distRoot cannot dodge the check. */
function distRootAllowed(distRoot: string): boolean {
  if (uatRoots.size === 0) return false
  let real: string
  try {
    real = fs.realpathSync.native(distRoot)
  } catch {
    return false
  }
  for (const base of uatRoots) {
    if (real === base || real.startsWith(base + path.sep)) return true
  }
  return false
}

/**
 * Resolve a caller-supplied absolute file path, confined to the registered
 * canvas roots (the sessions' own project directories).
 *
 * This is the containment for `canvas_render`'s `htmlPath` — a path the MODEL
 * chooses, read with the app's privileges. Unconfined it was an arbitrary-file
 * read (adversarial review 2026-08-14 drove it to a private key), and the only
 * thing in front of it was a human approval prompt, which is not containment.
 * Same allowlist and same realpath discipline `distRoot` already uses, so a
 * symlink inside the project cannot point out of it.
 *
 * Throws (never returns a path outside a root); the thrown message is mapped
 * to a closed operator vocabulary by the caller and never relayed verbatim.
 */
export function resolveInsideCanvasRoot(absPath: string): string {
  if (typeof absPath !== 'string' || absPath.length === 0 || !path.isAbsolute(absPath)) {
    throw new Error('path is not under a registered canvas root')
  }
  if (uatRoots.size === 0) throw new Error('path is not under a registered canvas root')
  let real: string
  try {
    // realpath the FILE, not just its parent: this is what makes a symlink
    // planted inside the project unable to reach outside it.
    real = fs.realpathSync.native(absPath)
  } catch {
    throw new Error('path is not under a registered canvas root')
  }
  for (const base of uatRoots) {
    if (real === base || real.startsWith(base + path.sep)) return real
  }
  throw new Error('path is not under a registered canvas root')
}

/** A version `entry` must be a plain relative file path. Boolean form of
 *  `normalizeEntry`, for validating records loaded from disk / re-served. */
function isSafeEntry(entry: unknown): entry is string {
  if (typeof entry !== 'string') return false
  try {
    normalizeEntry(entry)
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
 * How a session with NO canvas of its own may claim an orphaned one.
 *
 * ADOPTION REQUIRES A CONVERSATION MATCH. It deliberately does NOT happen on a
 * project-directory match: adversarial review (2026-08-14) demonstrated that
 * cwd-alone adoption is a canvas-theft primitive in the app's most ordinary
 * state — two tiles open on one repo is normal usage, a PTY exit (`/exit`, a
 * crash, the Restart button) makes the first session look "not current", and
 * the second tile would inherit the first's canvas AND the user's private
 * review notes, across accounts. Resuming the same conversation is the only
 * signal that actually means "this is the same work".
 */
export interface CanvasAdoptionQuery {
  /** REQUIRED. The Claude conversation this session is resuming; adoption is
   *  refused outright without it. */
  conversationUuid?: string
  /** The account profile this session runs under. Must equal the record's
   *  stamp — an unstamped legacy record never crosses into a profiled session
   *  and vice versa. */
  profileId?: string
  /**
   * True when the given session can still come back and claim its canvas by
   * id — a live PTY, or a tile still in the saved-session list. Adoption must
   * never race a restoring tile at boot (spawn order is arbitrary), so this
   * check fails SAFE: uncertain means current, and current means untouchable.
   */
  isSessionCurrent: (sessionId: string) => boolean
}

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

function persist(record: CanvasRecord): void {
  const dir = canvasDir(record.canvasId)
  mkdirSecure(dir)
  atomicWriteSecure(canvasJsonPath(record.canvasId), JSON.stringify(record, null, 2))
}

/** Minimal shape validation for a canvas.json read back from disk. A corrupt
 *  or hand-edited file is skipped (never served), not repaired. */
function isValidRecord(value: unknown): value is CanvasRecord {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Partial<CanvasRecord>
  if (typeof r.canvasId !== 'string' || !CANVAS_ID_RE.test(r.canvasId)) return false
  if (typeof r.sessionId !== 'string' || !SESSION_ID_RE.test(r.sessionId)) return false
  // Continuity stamps are optional, but a present one must be OUR shape — the
  // same strictness as every other field of a record read back from disk.
  if (r.cwd !== undefined && (typeof r.cwd !== 'string' || r.cwd.length === 0 || r.cwd.length > MAX_CWD_CHARS)) return false
  if (r.conversationUuid !== undefined && (typeof r.conversationUuid !== 'string' || !CONVERSATION_UUID_RE.test(r.conversationUuid))) return false
  if (r.profileId !== undefined && (typeof r.profileId !== 'string' || !PROFILE_ID_RE.test(r.profileId))) return false
  if (r.activeVersionId !== null && (typeof r.activeVersionId !== 'string' || !CANVAS_VERSION_ID_RE.test(r.activeVersionId))) return false
  if (!Array.isArray(r.versions)) return false
  for (const v of r.versions) {
    if (typeof v?.id !== 'string' || !CANVAS_VERSION_ID_RE.test(v.id)) return false
    if (v.source?.mode !== 'uat' && v.source?.mode !== 'design') return false
    // A hand-edited record must not smuggle a traversing/colon/device `entry`
    // past the live-render normalizer (the empty-path + SPA branches serve the
    // entry WITHOUT re-running the URL segment filter). distRoot containment is
    // re-checked at serve time (getServableVersion) so a de-registered base is
    // also honoured, but reject an obviously-broken distRoot shape here too.
    if (!isSafeEntry(v.source.entry)) return false
    if (v.source.mode === 'uat' && (typeof v.source.distRoot !== 'string' || v.source.distRoot.length === 0)) return false
  }
  return true
}

function loadFromDisk(canvasId: string): CanvasRecord | null {
  try {
    const raw = fs.readFileSync(canvasJsonPath(canvasId), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isValidRecord(parsed) || parsed.canvasId !== canvasId) return null
    return parsed
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
  const versionId = `v${(existing?.versions.length ?? 0) + 1}`
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
    // Fail closed: a UAT root must sit under a registered base, or it is not a
    // canvas — this is the whole-disk-file-server defense (adversarial review).
    if (!distRootAllowed(distRoot)) throw new Error('distRoot is not under a registered canvas UAT root')
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
 * An entry must be a plain relative file path. The boundary is self-sufficient:
 * it rejects traversal, absolutes, drive/ADS colons, and backslashes, AND the
 * Win32 forms that a pure `path`/string check misses but libuv would silently
 * normalize (trailing dot/space stripping, all-dot segments, device names) —
 * so the confinement never relies on the fs layer's behaviour (adversarial
 * review, 2026-08-11).
 */
function normalizeEntry(entry: string): string {
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
export function adoptCanvasForSession(
  sessionId: string,
  query: CanvasAdoptionQuery,
): { canvasId: string; activeVersionId: string | null } | null {
  if (!SESSION_ID_RE.test(sessionId)) return null
  ensureDiskScanned()
  if (sessionIndex.has(sessionId)) return null

  const wantConversation =
    typeof query.conversationUuid === 'string' && CONVERSATION_UUID_RE.test(query.conversationUuid)
      ? query.conversationUuid.toLowerCase()
      : null
  // Fail closed: without a conversation there is nothing that legitimately
  // identifies this work, and a directory is not a substitute for one.
  if (!wantConversation) return null

  const wantProfile =
    typeof query.profileId === 'string' && PROFILE_ID_RE.test(query.profileId) ? query.profileId : undefined

  let best: CanvasRecord | null = null
  let bestTime = ''
  for (const record of canvases.values()) {
    if (record.sessionId === sessionId) continue
    if (record.versions.length === 0) continue // nothing to inherit
    if (record.conversationUuid?.toLowerCase() !== wantConversation) continue
    // Exact, `undefined` included: an unstamped legacy record does not cross
    // into a profiled session, and a profiled record does not cross out.
    if (record.profileId !== wantProfile) continue
    let current = true
    try {
      current = query.isSessionCurrent(record.sessionId)
    } catch {
      current = true // cannot tell → treat as current → untouchable
    }
    if (current) continue
    const time = record.versions[record.versions.length - 1]?.createdAt ?? record.createdAt
    if (best === null || time > bestTime) {
      best = record
      bestTime = time
    }
  }
  if (!best) return null

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
  if (version.source.mode === 'design') {
    return { mode: 'design', contentRoot: versionDir(canvasId, versionId), entry: version.source.entry }
  }
  // Re-check distRoot containment on every serve: this is what confines a UAT
  // record loaded from disk after a restart, and honours a base that was later
  // de-registered. No registered base ⇒ nothing served.
  if (!distRootAllowed(version.source.distRoot)) return null
  return { mode: 'uat', contentRoot: version.source.distRoot, entry: version.source.entry }
}

/** Test seam: drop all in-memory state so each test starts cold. */
export function _resetCanvasStoreForTest(): void {
  canvases.clear()
  sessionIndex.clear()
  uatRoots.clear()
  diskScanned = false
  sessionInfoResolver = null
}
