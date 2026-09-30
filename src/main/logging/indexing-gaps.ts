/**
 * P3.12 (W4, X1-X3, Y1): when each Codex conversation was written while it
 * was not indexed, as wall-clock windows per conversation (its rollout id,
 * so its copy in another account is the same conversation). A window opens
 * when a local Codex session that is not indexed (logging off in Settings or
 * in its config, or before the indexing notice naming Codex was seen) holds
 * the conversation, and closes when that session stops holding it (its
 * exit, a Restart, a Switch, a claim of another conversation) or a launch of
 * it is indexed. The transcripts worker, for every read of that conversation
 * (any tab, session, copy or offset), skips each record stamped inside a
 * window. Windows describe history: nothing clears them.
 *
 * Failing toward not indexing: a window still open when the app stopped is
 * closed at the next start; a record found damaged at start is kept aside
 * (the newest three) and every record stamped before that start counts as
 * written while not indexed (`before`); a conversation's windows past
 * WINDOWS_PER_CONVERSATION_MAX are merged (the two oldest into one spanning
 * both), and past NOT_INDEXED_CONVERSATIONS_MAX conversations the least
 * recently changed goes after `before` is raised past its windows.
 *
 * Kept in the app's data folder; a newly opened window is written at once,
 * other changes coalesced from a timer, atomically, and at quit (which
 * closes the windows still open). In memory only until initIndexingGaps
 * names the file (tests never do).
 *
 * No default export (project convention).
 */
import { readFileSync, renameSync, readdirSync, unlinkSync } from 'fs'
import { basename, dirname, join } from 'path'
import { atomicWriteFileSync } from '../atomic-write'
import { codexConversationKey } from '../../shared/codex-conversation-key'

/** A window: [start, end) in wall-clock ms; end null while still open. */
export type NotIndexedWindow = [number, number | null]
export interface NotIndexedUpdate {
  /** The listed conversations' windows, whole. */
  conversations: Record<string, NotIndexedWindow[]>
  /** Every record stamped before this counts as written while not indexed. */
  before: number | null
}

export const NOT_INDEXED_CONVERSATIONS_MAX = 50000
export const WINDOWS_PER_CONVERSATION_MAX = 64
const KEY_MAX = 200
const SESSION_MAX = 200
const DAMAGED_KEPT = 3
const WRITE_DELAY_MS = 500

const windows = new Map<string, NotIndexedWindow[]>()
/** The conversation each session not indexed holds (its open window). */
const openBy = new Map<string, string>()
let before: number | null = null
let file: string | null = null
let dirty = false
let timer: ReturnType<typeof setTimeout> | null = null
let writes = 0
let listener: ((update: NotIndexedUpdate) => void) | null = null

/** A conversation's key (its rollout id), as the worker and search use it. */
export function conversationKey(rolloutPath: string): string {
  return codexConversationKey(rolloutPath)
}

function write(): void {
  if (!file || !dirty) return
  const body = { version: 3, conversations: Object.fromEntries(windows), ...(before !== null ? { before } : {}) }
  try {
    atomicWriteFileSync(file, JSON.stringify(body))
    writes++
    dirty = false
  } catch { /* kept dirty: the next change, or the quit flush, writes it */ }
}

function schedule(): void {
  dirty = true
  if (!file || timer) return
  timer = setTimeout(() => { timer = null; write() }, WRITE_DELAY_MS)
  ;(timer as { unref?: () => void }).unref?.()
}

function tell(keys: string[]): void {
  if (!listener) return
  const conversations: Record<string, NotIndexedWindow[]> = {}
  for (const k of keys) conversations[k] = (windows.get(k) ?? []).map((w) => [w[0], w[1]] as NotIndexedWindow)
  try { listener({ conversations, before }) } catch { /* the index is best-effort */ }
}

function raiseBefore(to: number): void {
  if (Number.isFinite(to)) before = before === null ? to : Math.max(before, to)
}

/** Keep a conversation's windows and the conversations within their caps,
 *  always toward not indexing. */
function bound(key: string, now: number): void {
  const list = windows.get(key)
  if (list && list.length > WINDOWS_PER_CONVERSATION_MAX) {
    list.sort((a, b) => a[0] - b[0])
    while (list.length > WINDOWS_PER_CONVERSATION_MAX) {
      const [a, b] = list.splice(0, 2)
      const end = a[1] === null || b[1] === null ? null : Math.max(a[1], b[1])
      list.unshift([Math.min(a[0], b[0]), end])
    }
  }
  while (windows.size > NOT_INDEXED_CONVERSATIONS_MAX) {
    const oldest = windows.keys().next().value as string
    if (oldest === key) break
    const dropped = windows.get(oldest) ?? []
    windows.delete(oldest)
    raiseBefore(dropped.reduce((m, w) => Math.max(m, w[1] ?? now), 0))
  }
}

function touch(key: string): NotIndexedWindow[] {
  const list = windows.get(key) ?? []
  windows.delete(key)
  windows.set(key, list)
  return list
}

/** The newest DAMAGED_KEPT records set aside stay; older ones go: only files
 *  in the record's own folder named exactly `<record>.damaged-<time>`. */
function pruneDamaged(path: string): void {
  const folder = dirname(path)
  const prefix = `${basename(path)}.damaged-`
  let names: string[]
  try { names = readdirSync(folder) } catch { return }
  const kept = names
    .filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
    .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)))
  for (const n of kept.slice(DAMAGED_KEPT)) { try { unlinkSync(join(folder, n)) } catch { /* best-effort */ } }
}

function validWindow(w: unknown): w is NotIndexedWindow {
  return Array.isArray(w) && w.length === 2 && typeof w[0] === 'number' && Number.isFinite(w[0]) &&
    (w[1] === null || (typeof w[1] === 'number' && Number.isFinite(w[1]) && w[1] >= w[0]))
}

/** The record's content, or null when it is not a record this reads. A v2
 *  record (marks: a conversation written while not indexed since a time) is
 *  taken as a window from that time to `now`. */
function parse(raw: unknown, now: number): { windows: Map<string, NotIndexedWindow[]>; before: number | null } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { version?: unknown; conversations?: unknown; marks?: unknown; before?: unknown; suspectBefore?: unknown }
  const out = new Map<string, NotIndexedWindow[]>()
  let at: unknown
  if (r.version === 3) {
    if (!r.conversations || typeof r.conversations !== 'object' || Array.isArray(r.conversations)) return null
    for (const [k, list] of Object.entries(r.conversations as Record<string, unknown>)) {
      if (!k || k.length > KEY_MAX || !Array.isArray(list) || !list.every(validWindow)) return null
      out.set(k, (list as NotIndexedWindow[]).map((w) => [w[0], w[1]] as NotIndexedWindow))
    }
    at = r.before
  } else if (r.version === 2) {
    if (!r.marks || typeof r.marks !== 'object' || Array.isArray(r.marks)) return null
    for (const [k, v] of Object.entries(r.marks as Record<string, unknown>)) {
      if (!k || k.length > KEY_MAX || typeof v !== 'number' || !Number.isFinite(v)) return null
      out.set(k, [[v, Math.max(v, now)]])
    }
    at = r.suspectBefore
  } else {
    return null
  }
  if (at !== undefined && (typeof at !== 'number' || !Number.isFinite(at))) return null
  return { windows: out, before: typeof at === 'number' ? at : null }
}

/** Read the record at `path` (`now`: this start's time) and keep it there
 *  from now on. A window still open is closed at `now`. */
export function initIndexingGaps(path: string, now: number = Date.now()): void {
  file = path
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return // a fresh start
    raiseBefore(now)
    dirty = true
    write()
    return
  }
  let parsed: ReturnType<typeof parse> = null
  try { parsed = parse(JSON.parse(text), now) } catch { parsed = null }
  if (!parsed) {
    // Damaged (or another shape): kept aside, and toward not indexing.
    try { renameSync(path, `${path}.damaged-${now}`) } catch { /* left in place; overwritten below */ }
    pruneDamaged(path)
    raiseBefore(now)
    dirty = true
    write()
    return
  }
  let closed = false
  for (const [k, list] of parsed.windows) {
    for (const w of list) if (w[1] === null) { w[1] = Math.max(w[0], now); closed = true }
    windows.set(k, list)
  }
  before = parsed.before
  if (closed) { dirty = true; write() }
}

function closeOn(key: string, ts: number): void {
  const list = windows.get(key)
  if (!list) return
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i][1] === null) { list[i][1] = Math.max(list[i][0], ts); break }
  }
}

/** `sessionId`, not indexed, holds the conversation at `rolloutPath` from
 *  `ts`: a window opens (the one it held on another conversation closes). */
export function openNotIndexedWindow(sessionId: string, rolloutPath: string, ts: number): void {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > SESSION_MAX || typeof rolloutPath !== 'string' || !rolloutPath || !Number.isFinite(ts)) return
  const key = conversationKey(rolloutPath)
  const held = openBy.get(sessionId)
  if (held === key) return
  const changed: string[] = []
  if (held !== undefined) { closeOn(held, ts); changed.push(held) }
  const list = touch(key)
  list.push([ts, null])
  openBy.set(sessionId, key)
  bound(key, ts)
  changed.push(key)
  // A newly opened window is written at once.
  dirty = true
  write()
  tell(changed)
}

/** `sessionId` stops holding its conversation while not indexed (it ends,
 *  relaunches, lets the claim go, or is indexed). */
export function closeNotIndexedWindow(sessionId: string, ts: number): void {
  const key = openBy.get(sessionId)
  if (key === undefined) return
  openBy.delete(sessionId)
  if (Number.isFinite(ts)) closeOn(key, ts)
  schedule()
  tell([key])
}

/** Every conversation's windows, and `before`: what the worker starts with. */
export function notIndexedSnapshot(): NotIndexedUpdate {
  const conversations: Record<string, NotIndexedWindow[]> = {}
  for (const [k, list] of windows) conversations[k] = list.map((w) => [w[0], w[1]] as NotIndexedWindow)
  return { conversations, before }
}

/** Told of every change (the logging service passes it to the worker). */
export function setNotIndexedListener(fn: ((update: NotIndexedUpdate) => void) | null): void {
  listener = fn
}

/** Close the windows still open (`now`: the app is stopping) and write what
 *  is pending. */
export function flushIndexingGaps(now: number = Date.now()): void {
  if (timer) { clearTimeout(timer); timer = null }
  for (const [session, key] of [...openBy]) { closeOn(key, now); openBy.delete(session); dirty = true }
  write()
}

/** Tests only. */
export function indexingGapsWritesForTests(): number {
  return writes
}

/** Tests only. */
export function resetIndexingGapsForTests(): void {
  if (timer) { clearTimeout(timer); timer = null }
  windows.clear()
  openBy.clear()
  before = null
  file = null
  dirty = false
  listener = null
}
