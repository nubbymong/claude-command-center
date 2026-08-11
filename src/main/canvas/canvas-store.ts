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

  let record = getRecordForSession(sessionId)
  if (!record) {
    record = {
      canvasId: randomId(),
      sessionId,
      createdAt: new Date().toISOString(),
      activeVersionId: null,
      versions: [],
    }
    canvases.set(record.canvasId, record)
    sessionIndex.set(sessionId, record.canvasId)
  }
  if (record.versions.length >= MAX_VERSIONS_PER_CANVAS) {
    throw new Error(`canvas ${record.canvasId} is at its version cap (${MAX_VERSIONS_PER_CANVAS})`)
  }

  const versionId = `v${record.versions.length + 1}`
  let version: CanvasVersion

  if (source.mode === 'design') {
    if (typeof source.html !== 'string' || source.html.length === 0) throw new Error('design render requires html')
    if (Buffer.byteLength(source.html, 'utf8') > MAX_DESIGN_HTML_BYTES) throw new Error('design document too large')
    const dir = versionDir(record.canvasId, versionId)
    mkdirSecure(dir)
    atomicWriteSecure(path.join(dir, 'index.html'), source.html)
    version = {
      id: versionId,
      mode: 'design',
      createdAt: new Date().toISOString(),
      source: { mode: 'design', entry: 'index.html' },
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
    const entry = normalizeEntry(source.entry ?? 'index.html')
    version = {
      id: versionId,
      mode: 'uat',
      createdAt: new Date().toISOString(),
      source: { mode: 'uat', distRoot, entry, ...(source.buildLabel ? { buildLabel: source.buildLabel } : {}) },
    }
  } else {
    throw new Error('unknown render mode')
  }

  record.versions.push(version)
  record.activeVersionId = versionId
  persist(record)
  emitChanged(record)
  return { canvasId: record.canvasId, versionId }
}

/** An entry must be a plain relative file path — no traversal, no absolutes,
 *  no drive/ADS colons, no backslashes. */
function normalizeEntry(entry: string): string {
  const clean = entry.replace(/^\/+/, '')
  if (clean.length === 0 || clean.length > 512) throw new Error('invalid entry')
  const segments = clean.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') throw new Error('invalid entry')
    if (/[\\:\0]/.test(seg)) throw new Error('invalid entry')
  }
  return segments.join('/')
}

export function setActiveVersion(sessionId: string, versionId: string): CanvasState {
  const record = getRecordForSession(sessionId)
  if (!record) throw new Error('no canvas for session')
  if (!record.versions.some((v) => v.id === versionId)) throw new Error('unknown version')
  record.activeVersionId = versionId
  persist(record)
  emitChanged(record)
  return toState(record)
}

/** Resolve what the ccc-ux:// protocol may serve for a canvas/version pair.
 *  Returns null for anything unknown — the protocol answers 404, never throws. */
export function getServableVersion(canvasId: string, versionId: string): ServableVersion | null {
  if (!CANVAS_VERSION_ID_RE.test(versionId)) return null
  const record = getRecord(canvasId)
  if (!record) return null
  const version = record.versions.find((v) => v.id === versionId)
  if (!version) return null
  if (version.source.mode === 'design') {
    return { mode: 'design', contentRoot: versionDir(canvasId, versionId), entry: version.source.entry }
  }
  return { mode: 'uat', contentRoot: version.source.distRoot, entry: version.source.entry }
}

/** Test seam: drop all in-memory state so each test starts cold. */
export function _resetCanvasStoreForTest(): void {
  canvases.clear()
  sessionIndex.clear()
  diskScanned = false
}
