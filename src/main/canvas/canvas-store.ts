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
  const base: CanvasRecord = existing ?? { canvasId, sessionId, createdAt, activeVersionId: null, versions: [] }
  const nextRecord: CanvasRecord = { ...base, versions: [...base.versions, version], activeVersionId: versionId }
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
}
