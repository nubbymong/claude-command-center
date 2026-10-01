/**
 * P3.12 (W4, X1-X3, Y1, Z1, Z2, K1, K3): when each Codex conversation was
 * written while it was not indexed, as wall-clock windows per conversation
 * (its rollout id, so its copy in another account is the same conversation).
 * A window opens when a local Codex session that is not indexed (logging off
 * in Settings or in its config, or before the indexing notice naming Codex
 * was seen) holds the conversation, and closes when that session stops
 * holding it (its exit, a Restart, a Switch, a claim of another
 * conversation) or a launch of it is indexed. The transcripts worker, for
 * every read of that conversation (any tab, session, copy or offset), skips
 * each record stamped inside a window. Windows describe history: nothing
 * clears them.
 *
 * P3.16 (M1): a Claude conversation the same way (its key is its transcript's
 * id, the file name, as a rollout's ends with its id): a window opens when a
 * local Claude session that is not indexed is on it (its hooks and status line
 * name the transcript, or its exact resume at launch), and the worker leaves
 * out its records by record time as it does a rollout's.
 *
 * A window opens at the moment the session BECAME not indexed (its launch, or
 * the switch-off), not at its claim of the conversation: Codex writes the
 * rollout's session_meta and the first prompt before the claim, and a later
 * reader from the start would index them. A conversation begun earlier (a
 * resume) opens at that moment too, so what it had indexed stays indexed.
 *
 * A session that is killed (a tab closed, a Restart, a Switch) is released
 * from its window at once, and the window is closed by the closer
 * releaseNotIndexedWindow returns, when the process's exit is reported: a
 * killed Codex goes on writing while it winds down.
 *
 * Failing toward not indexing: a window still open when the app stopped (a
 * crash, or a final flush at quit: Codex's last writes land after it, so a
 * quit leaves them open) is closed at the next start; a record found damaged
 * at start is kept aside
 * (the newest three) and every record stamped before that start counts as
 * written while not indexed (`before`); a conversation's windows past
 * WINDOWS_PER_CONVERSATION_MAX are merged (the two oldest into one spanning
 * both), and past NOT_INDEXED_CONVERSATIONS_MAX conversations the least
 * recently changed goes after `before` is raised past its windows.
 *
 * Kept in the app's data folder; a newly opened window is written at once,
 * other changes coalesced from a timer, atomically, and at quit (which
 * leaves the windows still open as they are). In memory only until
 * initIndexingGaps names the file (tests never do).
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
/** The conversation each session not indexed holds, and its open window. */
const openBy = new Map<string, { key: string; win: NotIndexedWindow }>()
let before: number | null = null
/** The app is stopping (a final flushIndexingGaps): the windows still open stay open. */
let stopping = false
let file: string | null = null
let dirty = false
let timer: ReturnType<typeof setTimeout> | null = null
let writes = 0
let listener: ((update: NotIndexedUpdate) => void) | null = null

/** A conversation's key (its rollout id, or a Claude transcript's id), as the
 *  worker and search use it. */
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

/** Close the window a session held: that exact one, never another session's on the
 *  same conversation. One that was merged into an older window is left open (the
 *  merged window is no longer the session's alone): toward not indexing. */
function closeHeld(held: { key: string; win: NotIndexedWindow }, ts: number): void {
  held.win[1] = Math.max(held.win[0], ts)
}

/** `sessionId`, not indexed since `since` (its launch, or the switch-off),
 *  holds the conversation at `rolloutPath` as of `now` (the claim; by default
 *  `since`): a window opens at `since`, and the window the session held on
 *  another conversation closes at `now`. */
export function openNotIndexedWindow(sessionId: string, rolloutPath: string, since: number, now: number = since): void {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > SESSION_MAX || typeof rolloutPath !== 'string' || !rolloutPath || !Number.isFinite(since) || !Number.isFinite(now)) return
  const key = conversationKey(rolloutPath)
  const held = openBy.get(sessionId)
  if (held?.key === key) return
  const changed: string[] = []
  if (held !== undefined) { closeHeld(held, now); changed.push(held.key) }
  const win: NotIndexedWindow = [Math.min(since, now), null]
  touch(key).push(win)
  openBy.set(sessionId, { key, win })
  bound(key, now)
  changed.push(key)
  // A newly opened window is written at once.
  dirty = true
  write()
  tell(changed)
}

/** `sessionId` stops holding its conversation while not indexed (it ends,
 *  relaunches, lets the claim go, or is indexed). */
export function closeNotIndexedWindow(sessionId: string, ts: number): void {
  // Stopping: Codex's last writes land after this, so the window stays open (the next start closes it).
  if (stopping) return
  const held = openBy.get(sessionId)
  if (held === undefined) return
  openBy.delete(sessionId)
  if (Number.isFinite(ts)) closeHeld(held, ts)
  schedule()
  tell([held.key])
}

/** `sessionId` is killed (a tab closed, a Restart, a Switch): it holds its
 *  window no more (its next launch opens one of its own), but a killed Codex
 *  goes on writing while it winds down, so the window stays open until the
 *  returned closer runs, when the process's exit is reported. The closer closes
 *  that exact window, once, and nothing once the app is stopping; a window
 *  merged into an older one is left open (toward not indexing). null when the
 *  session holds none. */
export function releaseNotIndexedWindow(sessionId: string): ((ts: number) => void) | null {
  const held = openBy.get(sessionId)
  if (held === undefined) return null
  openBy.delete(sessionId)
  return (ts: number): void => {
    if (stopping || held.win[1] !== null || !Number.isFinite(ts)) return
    held.win[1] = Math.max(held.win[0], ts)
    schedule()
    tell([held.key])
  }
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

/** Write what is pending. A final flush (the app is quitting: the default) also
 *  latches: the windows still open are left open, here and on disk, and a
 *  session's end reported while the app tears down closes none, because Codex's
 *  last records land after the quit; the next start closes them at its time (as
 *  it does after a crash). A flush that is not final (an OS shutdown that may be
 *  vetoed, the app running on) only writes. */
export function flushIndexingGaps(opts: { final?: boolean } = {}): void {
  if (opts.final !== false) stopping = true
  if (timer) { clearTimeout(timer); timer = null }
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
  stopping = false
  file = null
  dirty = false
  listener = null
}
