/**
 * P3.12 (W4, X1-X3): the Codex conversations written while they were not
 * indexed (a Codex session on them with logging off in Settings or in its
 * config, or before the indexing notice naming Codex was seen), by
 * conversation: its rollout id, so its copy in another account is the same
 * conversation. Any later run that binds one, from any tab or session,
 * never indexes what was written then (transcripts-worker
 * continuationStart); once a run has bound it, its mark goes.
 *
 * Failing toward not indexing: a record found damaged at start (or in
 * another shape) is kept aside, and every conversation begun before then
 * counts as written while not indexed until a run binds it; a record full
 * (NOT_INDEXED_MARKS_MAX) drops its oldest marks only after taking the same
 * rule from that moment, so no mark for a conversation not bound since is
 * lost.
 *
 * Kept in the app's data folder, written coalesced from a timer (never on
 * the claim path), atomically, and at quit (flushIndexingGaps); it holds
 * across app restarts, including a start with logging off, when no index
 * runs at all. In memory only until initIndexingGaps names the file (tests
 * never do).
 *
 * No default export (project convention).
 */
import { readFileSync, renameSync, readdirSync, unlinkSync } from 'fs'
import { basename, dirname, join } from 'path'
import { atomicWriteFileSync } from '../atomic-write'

/** The most conversations marked; past it the begun-before rule covers the
 *  oldest (see above). */
export const NOT_INDEXED_MARKS_MAX = 50000
/** The most conversations kept as bound since the begun-before rule began;
 *  the oldest dropped count again (toward not indexing). */
const CLEARED_MAX = 50000
const KEY_MAX = 200
/** The damaged records kept aside, the newest first. */
const DAMAGED_KEPT = 3
/** How long marks gather before they are written. */
const WRITE_DELAY_MS = 500
const ROLLOUT_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

const marks = new Map<string, number>()
/** Conversations begun before this time count as written while not indexed
 *  until bound (null: no such rule). */
let suspectBefore: number | null = null
const cleared = new Set<string>()
let file: string | null = null
let dirty = false
let timer: ReturnType<typeof setTimeout> | null = null
let writes = 0

/** A conversation's key: the rollout id in its file name (lower case), else
 *  the file name. */
export function conversationKey(rolloutPath: string): string {
  const name = basename(String(rolloutPath))
  const m = ROLLOUT_ID_RE.exec(name)
  return (m ? m[1].toLowerCase() : name).slice(0, KEY_MAX)
}

function write(): void {
  if (!file || !dirty) return
  const body: { version: 2; marks: Record<string, number>; suspectBefore?: number; cleared?: string[] } = { version: 2, marks: Object.fromEntries(marks) }
  if (suspectBefore !== null) { body.suspectBefore = suspectBefore; body.cleared = [...cleared] }
  try {
    atomicWriteFileSync(file, JSON.stringify(body))
    writes++
    dirty = false
  } catch { /* kept dirty: the next mark, or the quit flush, writes it */ }
}

function schedule(): void {
  dirty = true
  if (!file || timer) return
  timer = setTimeout(() => { timer = null; write() }, WRITE_DELAY_MS)
  ;(timer as { unref?: () => void }).unref?.()
}

/** Every conversation begun before `at` counts as written while not
 *  indexed until bound (a damaged or full record). */
function suspectFrom(at: number): void {
  suspectBefore = suspectBefore === null ? at : Math.max(suspectBefore, at)
  cleared.clear()
}

function parse(raw: unknown): { marks: Map<string, number>; suspectBefore: number | null; cleared: string[] } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { version?: unknown; marks?: unknown; suspectBefore?: unknown; cleared?: unknown }
  if (r.version !== 2 || !r.marks || typeof r.marks !== 'object' || Array.isArray(r.marks)) return null
  const out = new Map<string, number>()
  for (const [k, v] of Object.entries(r.marks as Record<string, unknown>)) {
    if (!k || k.length > KEY_MAX || typeof v !== 'number' || !Number.isFinite(v)) return null
    out.set(k, v)
  }
  let since: number | null = null
  if (r.suspectBefore !== undefined) {
    if (typeof r.suspectBefore !== 'number' || !Number.isFinite(r.suspectBefore)) return null
    since = r.suspectBefore
  }
  const done: string[] = []
  if (r.cleared !== undefined) {
    if (!Array.isArray(r.cleared)) return null
    for (const k of r.cleared) { if (typeof k !== 'string' || !k || k.length > KEY_MAX) return null; done.push(k) }
  }
  return { marks: out, suspectBefore: since, cleared: done }
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

/** Read the record at `path` (`now`: this start's time) and keep it there
 *  from now on. */
export function initIndexingGaps(path: string, now: number = Date.now()): void {
  file = path
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return // a fresh start
    suspectFrom(now)
    dirty = true
    write()
    return
  }
  let parsed: ReturnType<typeof parse> = null
  try { parsed = parse(JSON.parse(text)) } catch { parsed = null }
  if (!parsed) {
    // Damaged (or another shape): kept aside, and toward not indexing.
    try { renameSync(path, `${path}.damaged-${now}`) } catch { /* left in place; overwritten below */ }
    pruneDamaged(path)
    suspectFrom(now)
    dirty = true
    write()
    return
  }
  for (const [k, v] of parsed.marks) marks.set(k, v)
  suspectBefore = parsed.suspectBefore
  for (const k of parsed.cleared.slice(-CLEARED_MAX)) cleared.add(k)
}

/** The conversation at `rolloutPath` is being written while not indexed. */
export function markNotIndexed(rolloutPath: string, ts: number): void {
  if (typeof rolloutPath !== 'string' || !rolloutPath || !Number.isFinite(ts)) return
  const key = conversationKey(rolloutPath)
  const was = marks.get(key)
  const first = typeof was !== 'number'
  marks.delete(key)
  marks.set(key, typeof was === 'number' ? Math.max(was, ts) : ts)
  cleared.delete(key)
  if (marks.size > NOT_INDEXED_MARKS_MAX) {
    // Full: from now, every conversation begun before counts as not indexed
    // until bound, so the oldest marks may go.
    suspectFrom(Date.now())
    while (marks.size > NOT_INDEXED_MARKS_MAX) marks.delete(marks.keys().next().value as string)
  }
  // A conversation's first mark is written at once; later ones coalesce.
  if (first) { dirty = true; write() } else schedule()
}

/** What is known of the conversation at `rolloutPath`: written while not
 *  indexed (`since`), or possibly so (`ifBegunBefore`); null when neither. */
export function notIndexedFor(rolloutPath: string): { since?: number; ifBegunBefore?: number } | null {
  const key = conversationKey(rolloutPath)
  const since = marks.get(key)
  if (typeof since === 'number') return { since }
  if (suspectBefore !== null && !cleared.has(key)) return { ifBegunBefore: suspectBefore }
  return null
}

/** A run bound the conversation at `rolloutPath` with what was known of it:
 *  its mark goes. */
export function noteNotIndexedBound(rolloutPath: string): void {
  const key = conversationKey(rolloutPath)
  const had = marks.delete(key)
  let changed = had
  if (suspectBefore !== null && !cleared.has(key)) {
    cleared.add(key)
    while (cleared.size > CLEARED_MAX) cleared.delete(cleared.keys().next().value as string)
    changed = true
  }
  if (changed) schedule()
}

/** Write what is pending now (at quit). */
export function flushIndexingGaps(): void {
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
  marks.clear()
  cleared.clear()
  suspectBefore = null
  file = null
  dirty = false
}
