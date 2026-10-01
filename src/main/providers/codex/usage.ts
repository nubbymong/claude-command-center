/**
 * Codex per-account usage (usage track MP3; plan section 3): the package's
 * usage port.
 *
 * - `live(realm)`: the newest allowance an open session in the realm reported,
 *   recorded in memory by the session telemetry, keyed by the realm's sessions
 *   folder exactly as a launch names it, and forgotten when the realm's last
 *   session stops. No file, no process.
 * - `lastSeen(realm)`: the last allowance in the realm's own session history.
 *   It opens only `rollout-*.jsonl` files under `sessions/YYYY/MM/DD`, newest
 *   day folder first and newest file name first in it, examines at most
 *   CODEX_USAGE_MAX_FILES of them and takes the one whose allowance was
 *   reported last, reads a bounded tail of each (256 KiB, once growing to
 *   2 MiB), and keeps the walk inside one budget of folder visits and
 *   entries (and at most CODEX_USAGE_MAX_DAYS day folders). A day folder is
 *   listed to its end (up to CODEX_USAGE_DAY_ENTRIES entries) keeping only
 *   its newest names, so a crowded day still yields its newest rollouts. A
 *   reading is kept while the rollouts it came from are unchanged and every
 *   one of them could be read; concurrent requests for one realm share one
 *   read, and no caller waits for it longer than CODEX_USAGE_READ_TIMEOUT_MS.
 *   No process.
 *
 * Links. Both first locate the realm exactly as a launch does AND hold it to
 * the launch's canonical-home check (the realm's home must be a real folder
 * at exactly its path, no junction or link on the way), so nothing a launch
 * would refuse is read. Below the home, the sessions folder and every year,
 * month and day folder are checked with lstat before they are listed and
 * again, by device and inode, after; every rollout is checked with lstat and
 * read only when, after opening, it is still that same regular file with a
 * single link. An identity of inode 0 proves nothing, so it refuses the read
 * (the account shows as unavailable).
 *
 * What that does not promise. Node has no openat: every open and listing
 * names a full path, resolved again by the system. A folder swapped for a
 * link after its check is still followed by the next path under it, and the
 * checks then compare the far side with itself. They narrow the window; they
 * do not close it. What always holds is what is read: a regular, singly
 * linked file named rollout-*.jsonl, a bounded tail of it, and only its
 * token_count allowance lines. On macOS and Linux a rollout is opened with
 * O_NOFOLLOW and O_NONBLOCK (a link or a FIFO in its own place never follows
 * or blocks). Windows has neither flag: there the identity comparison after
 * opening is the check for the file itself, and a named pipe does not live in
 * the file tree. The threat this bounds is another process of the same user
 * changing the tree while it is read; that process can already write every
 * file here.
 *
 * Both read only; the accounts service decides when they may run.
 *
 * - `read(realm)` (usage track MP8; ADR-022): a fresh reading of a closed
 *   managed account through the auth operations' one short-lived
 *   `codex app-server` helper (readUsage, which holds every other bound).
 *   Tried only for a CLI discovery proved whose version is `supported`
 *   (classifyCodexVersion: never too-new, too-old or unknown). A CLI that
 *   answered `unsupported` (only an answer about its version or protocol:
 *   method not found, an invalid request, a schema mismatch; a wrong
 *   `codexHome` is transient) is not asked again until the executable
 *   changes: the verdict is kept in memory keyed by the executable's
 *   identity (path, size, times, file id) and version. A transient failure
 *   is not kept. The accounts service decides when it may run.
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import type { AllowanceReading } from '../../../shared/usage-types'
import { planLabelFor } from '../../../shared/usage-types'
import type { ProviderUsageOperations, RealmRef, UsageLookup, UsageReading, UsageReadResult, UsageReadOptions } from '../core'
import { normaliseCodexRateLimits, mergeAllowanceReadings, readingToBuckets, zonedTimeMs } from './rate-limits'
import { classifyCodexVersion } from './cli-contract'
import { findCodexRollout } from './rollout-lookup'
import type { CodexUsageRead, CodexUsageReadOptions } from './auth-operations'

/** The first tail read of a rollout. */
export const CODEX_USAGE_TAIL_BYTES = 256 * 1024
/** The one larger read when the first tail held no allowance. */
export const CODEX_USAGE_TAIL_MAX_BYTES = 2 * 1024 * 1024
/** Rollouts examined, newest name first. */
export const CODEX_USAGE_MAX_FILES = 8
/** Day folders listed, newest first. */
export const CODEX_USAGE_MAX_DAYS = 64
/** Folder visits plus entries listed, across the whole walk. A day folder
 *  being listed is finished (up to CODEX_USAGE_DAY_ENTRIES) even past it. */
export const CODEX_USAGE_WALK_BUDGET = 1024
/** Entries listed in one day folder; past them its listing stops. */
export const CODEX_USAGE_DAY_ENTRIES = 4096
/** The longest any caller waits for one realm's reading. */
export const CODEX_USAGE_READ_TIMEOUT_MS = 10_000
/** Realms kept in the live figure and in the last-seen cache. */
const MAX_REALMS = 64
/** Executables whose `unsupported` verdict is kept (MP8). */
const MAX_VERDICTS = 8

const YEAR_RE = /^\d{4}$/
const MONTH_DAY_RE = /^\d{2}$/
const ROLLOUT_RE = /^rollout-[^\\/]+\.jsonl$/

/** What lstat says about one path: its kind (a link is never followed), its
 *  identity (device and inode, or the file index on Windows), its links, size
 *  and last write. */
export interface CodexUsageEntry {
  kind: 'file' | 'dir' | 'link' | 'other'
  dev: string
  ino: string
  nlink: number
  size: number
  mtimeMs: number
}

/** The filesystem the last-seen reader uses. Main-process only. */
export interface CodexUsageFsPort {
  platform: NodeJS.Platform
  /** The path itself, without following a link. Rejects when absent. */
  lstat(p: string): Promise<CodexUsageEntry>
  /** Hands the folder's names to `visit` one at a time, until there are none
   *  left or `visit` returns false; the folder is closed either way. Only
   *  what `visit` keeps is held. */
  readdir(dir: string, visit: (name: string) => boolean): Promise<void>
  /** The last `maxBytes` of the file, and whether that is all of it. Rejects
   *  unless, once open, it is still the regular, singly linked file
   *  `expected` describes (same device and inode). */
  readTail(file: string, maxBytes: number, expected: CodexUsageEntry): Promise<{ text: string; whole: boolean }>
}

type BigStat = { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; dev: bigint; ino: bigint; nlink: bigint; size: bigint; mtimeMs: bigint }

/** The node fs calls the real port makes: an injection point for tests. */
export interface CodexUsageFsApi {
  constants: { O_RDONLY: number; O_NOFOLLOW?: number; O_NONBLOCK?: number }
  lstat(p: string): Promise<BigStat>
  opendir(p: string): Promise<{ read(): Promise<{ name: string } | null>; close(): Promise<void> }>
  open(p: string, flags: number): Promise<{
    stat(): Promise<BigStat>
    read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
    close(): Promise<void>
  }>
}

const nodeFsApi: CodexUsageFsApi = {
  constants: fs.constants,
  lstat: (p) => fsp.lstat(p, { bigint: true }),
  opendir: (p) => fsp.opendir(p),
  open: async (p, flags) => {
    const fh = await fsp.open(p, flags)
    return {
      stat: () => fh.stat({ bigint: true }),
      read: (buffer, offset, length, position) => fh.read(buffer, offset, length, position),
      close: () => fh.close(),
    }
  },
}

const entryOf = (s: BigStat): CodexUsageEntry => ({
  kind: s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other',
  dev: String(s.dev),
  ino: String(s.ino),
  nlink: Number(s.nlink),
  size: Number(s.size),
  mtimeMs: Number(s.mtimeMs),
})

/** Whether an identity can tell two things apart: inode 0 (some network and
 *  FAT volumes) or none at all cannot. */
const verifiable = (e: CodexUsageEntry): boolean => typeof e.ino === 'string' && e.ino !== '' && e.ino !== '0'

/** The real filesystem, asynchronous throughout. See the module comment for
 *  what each platform can and cannot promise. */
export function realCodexUsageFsPort(platform: NodeJS.Platform = process.platform, api: CodexUsageFsApi = nodeFsApi): CodexUsageFsPort {
  const flags = api.constants.O_RDONLY | (api.constants.O_NOFOLLOW ?? 0) | (api.constants.O_NONBLOCK ?? 0)
  return {
    platform,
    lstat: async (p) => entryOf(await api.lstat(p)),
    readdir: async (dir, visit) => {
      const d = await api.opendir(dir)
      try {
        for (;;) {
          const e = await d.read()
          if (!e || visit(e.name) === false) break
        }
      } finally {
        await d.close()
      }
    },
    readTail: async (file, maxBytes, expected) => {
      if (!verifiable(expected)) throw new Error('an identity that proves nothing')
      const fh = await api.open(file, flags)
      try {
        const now = entryOf(await fh.stat())
        if (now.kind !== 'file' || now.dev !== expected.dev || now.ino !== expected.ino || now.nlink !== 1) throw new Error('not the file that was checked')
        const len = Math.min(now.size, maxBytes)
        const buf = Buffer.alloc(len)
        let read = 0
        while (read < len) {
          const { bytesRead } = await fh.read(buf, read, len - read, now.size - len + read)
          if (bytesRead <= 0) break
          read += bytesRead
        }
        return { text: buf.subarray(0, read).toString('utf8'), whole: len === now.size }
      } finally {
        await fh.close()
      }
    },
  }
}

/** The allowance in one tail of a rollout: every token_count that carries
 *  rate_limits (a pre-response one included), newest reading of each limit.
 *  The first line of a partial tail is cut and never read. `after` (a carried
 *  conversation's mark: ADR-023) keeps only the events dated after it; an event
 *  with no zoned time is then no event. */
function allowanceInTail(text: string, whole: boolean, now: number, after: number | null = null): AllowanceReading | null {
  let body = text
  if (!whole) {
    const nl = body.indexOf('\n')
    body = nl < 0 ? '' : body.slice(nl + 1)
  }
  const readings: (AllowanceReading | null)[] = []
  for (const raw of body.split('\n')) {
    // Cheap test first: most lines are not token_count events.
    if (!raw.includes('"token_count"') || !raw.includes('"rate_limits"')) continue
    let evt: unknown
    try { evt = JSON.parse(raw) } catch { continue }
    if (!evt || typeof evt !== 'object') continue
    const e = evt as Record<string, unknown>
    const payload = e.payload as Record<string, unknown> | undefined
    if (e.type !== 'event_msg' || !payload || typeof payload !== 'object' || payload.type !== 'token_count' || payload.rate_limits == null) continue
    let at = Date.parse(String(e.timestamp ?? ''))
    if (after !== null) {
      const zoned = zonedTimeMs(e.timestamp)
      if (zoned === null || zoned <= after) continue
      at = zoned
    }
    readings.push(normaliseCodexRateLimits(payload.rate_limits, 'rollout', Number.isFinite(at) ? at : null, now))
  }
  const merged = mergeAllowanceReadings(readings)
  return merged && merged.limits.length > 0 ? merged : null
}

/** One rollout's allowance: a 256 KiB tail, then once a 2 MiB one.
 *  'unread' when it could not be read (busy, too many open files, changed or
 *  unverifiable): not the same as a rollout with no allowance in it. */
async function allowanceInRollout(port: CodexUsageFsPort, file: string, entry: CodexUsageEntry, now: number, after: number | null = null): Promise<AllowanceReading | null | 'unread'> {
  for (const max of [CODEX_USAGE_TAIL_BYTES, CODEX_USAGE_TAIL_MAX_BYTES]) {
    let tail: { text: string; whole: boolean }
    try { tail = await port.readTail(file, max, entry) } catch { return 'unread' }
    if (!tail || typeof tail.text !== 'string') return 'unread'
    const found = allowanceInTail(tail.text, tail.whole === true, now, after)
    if (found || tail.whole === true) return found
  }
  return null
}

interface Candidate { file: string; entry: CodexUsageEntry }

/** The newest rollouts under a sessions folder, at most CODEX_USAGE_MAX_FILES,
 *  each a regular, singly linked file as lstat saw it. The walk spends one
 *  budget on folder visits and entries; running out ends it with what it has.
 *  `unverifiable`: something on the way had an identity that proves nothing,
 *  so the walk stopped and nothing it found may be read. */
async function newestRollouts(sessionsDir: string, port: CodexUsageFsPort): Promise<{ candidates: Candidate[]; unverifiable: boolean }> {
  const p = port.platform === 'win32' ? path.win32 : path.posix
  let budget = CODEX_USAGE_WALK_BUDGET
  let days = 0
  let unverifiable = false
  const out: Candidate[] = []
  const same = (a: CodexUsageEntry, b: CodexUsageEntry) => a.dev === b.dev && a.ino === b.ino
  /** The folder's matching names, newest first; null to stop the walk (the
   *  budget ran out, or an identity proves nothing). An unusable folder (a
   *  link, not a folder, changed while listed) lists nothing. A day folder
   *  (`top` given) is listed to its end, up to CODEX_USAGE_DAY_ENTRIES
   *  entries, even past the budget, holding only its `top` newest names. */
  const list = async (dir: string, re: RegExp, top?: number): Promise<string[] | null> => {
    if (--budget < 0) return null
    let before: CodexUsageEntry
    try { before = await port.lstat(dir) } catch { return [] }
    if (before.kind !== 'dir') return []
    if (!verifiable(before)) { unverifiable = true; return null }
    const held: string[] = []
    let over = false
    let seen = 0
    try {
      await port.readdir(dir, (name) => {
        if (top === undefined) {
          if (budget <= 0) { over = true; return false }
        } else if (seen >= CODEX_USAGE_DAY_ENTRIES) {
          return false
        }
        seen++
        budget--
        if (typeof name !== 'string' || !re.test(name)) return true
        if (top === undefined || held.length < top) {
          held.push(name)
        } else {
          // Keep only the `top` greatest names: replace the least if this is greater.
          let least = 0
          for (let i = 1; i < held.length; i++) if (held[i] < held[least]) least = i
          if (name > held[least]) held[least] = name
        }
        return true
      })
    } catch { return [] }
    if (over) return null
    let after: CodexUsageEntry
    try { after = await port.lstat(dir) } catch { return [] }
    if (after.kind !== 'dir' || !same(before, after)) return []
    return held.sort().reverse()
  }
  const done = () => ({ candidates: unverifiable ? [] : out, unverifiable })
  const years = await list(sessionsDir, YEAR_RE)
  if (!years) return done()
  for (const year of years) {
    const months = await list(p.join(sessionsDir, year), MONTH_DAY_RE)
    if (!months) return done()
    for (const month of months) {
      const dayNames = await list(p.join(sessionsDir, year, month), MONTH_DAY_RE)
      if (!dayNames) return done()
      for (const d of dayNames) {
        if (++days > CODEX_USAGE_MAX_DAYS) return done()
        const dayDir = p.join(sessionsDir, year, month, d)
        const files = await list(dayDir, ROLLOUT_RE, CODEX_USAGE_MAX_FILES)
        if (!files) return done()
        for (const name of files) {
          const file = p.join(dayDir, name)
          let entry: CodexUsageEntry
          try { entry = await port.lstat(file) } catch { continue }
          if (entry.kind !== 'file' || entry.nlink !== 1) continue
          if (!verifiable(entry)) { unverifiable = true; return done() }
          out.push({ file, entry })
          if (out.length >= CODEX_USAGE_MAX_FILES) return done()
        }
      }
    }
  }
  return done()
}

/** What the reading of these rollouts depends on: their paths and, as lstat
 *  saw them, identity, size and last write. */
const fingerprintOf = (c: readonly Candidate[], cutoffs: readonly (number | null)[] = []): string =>
  JSON.stringify(c.map((x, i) => [x.file, x.entry.dev, x.entry.ino, x.entry.size, x.entry.mtimeMs, cutoffs[i] ?? null]))

/** A cache the reader may keep a result in, by sessions folder. */
export interface LastSeenCache {
  get(dir: string): { fingerprint: string; reading: AllowanceReading | null } | undefined
  set(dir: string, value: { fingerprint: string; reading: AllowanceReading | null }): void
}

/** A last-seen lookup: a reading or none, or `ok: false` when the history
 *  could not be read (the account shows as unavailable, not as having no
 *  session yet). */
export type LastSeenLookup = { ok: true; reading: AllowanceReading | null } | { ok: false }

/**
 * The last allowance recorded under a realm's sessions folder: of the newest
 * rollouts examined, the one reported last. Unavailable when an identity on
 * the way proves nothing, when nothing could be read and a rollout could
 * not be, or on any failure. A result is kept in `cache` only when every
 * rollout examined could be read. Never rejects. See the module comment for
 * exactly what it may open.
 */
export async function lookupLastSeenAllowance(sessionsDir: string, port: CodexUsageFsPort, now: number = Date.now(), cache?: LastSeenCache, marks?: CodexCarryMarks): Promise<LastSeenLookup> {
  try {
    const walk = await newestRollouts(sessionsDir, port)
    if (walk.unverifiable) return { ok: false }
    // A conversation carried into this realm (ADR-023): only the events written
    // after the carry count. The marks are part of what a cached reading was
    // read under.
    const cutoffs = walk.candidates.map((c) => (marks ? marks.cutoff(sessionsDir, codexRolloutIdFromName(c.file)) : null))
    const fingerprint = fingerprintOf(walk.candidates, cutoffs)
    const held = cache?.get(sessionsDir)
    if (held && held.fingerprint === fingerprint) return { ok: true, reading: held.reading }
    let best: AllowanceReading | null = null
    let unread = false
    for (const [i, c] of walk.candidates.entries()) {
      const r = await allowanceInRollout(port, c.file, c.entry, now, cutoffs[i])
      if (r === 'unread') { unread = true; continue }
      if (r && (best === null || (r.readingAt ?? -Infinity) > (best.readingAt ?? -Infinity))) best = r
    }
    // A rollout that could not be read may hold the newest figure: nothing
    // is kept, and with nothing found the answer is unavailable.
    if (unread) return best ? { ok: true, reading: best } : { ok: false }
    cache?.set(sessionsDir, { fingerprint, reading: best })
    return { ok: true, reading: best }
  } catch {
    return { ok: false }
  }
}

/** The reading lookupLastSeenAllowance finds, or null (none, or unavailable). */
export async function readLastSeenAllowance(sessionsDir: string, port: CodexUsageFsPort, now: number = Date.now(), cache?: LastSeenCache, marks?: CodexCarryMarks): Promise<AllowanceReading | null> {
  const r = await lookupLastSeenAllowance(sessionsDir, port, now, cache, marks)
  return r.ok ? r.reading : null
}

/** The newest allowance each realm's open sessions reported, in memory. */
export interface CodexLiveUsage {
  /** A session in this realm started reporting; the returned function says it
   *  stopped (once). The realm's figure is forgotten when its last one does. */
  open(sessionsDir: string): () => void
  record(sessionsDir: string, reading: AllowanceReading): void
  get(sessionsDir: string): AllowanceReading | null
}

const keyer = (platform: NodeJS.Platform) => {
  const caseless = platform === 'win32' || platform === 'darwin'
  return (dir: string) => {
    const s = String(dir).replace(/[\\/]+$/, '')
    return caseless ? s.toLowerCase() : s
  }
}

/** Keyed by the sessions folder as a launch names it; one spelling per folder
 *  on Windows and macOS (case-insensitive there). A reading older than the
 *  one held is ignored. Bounded: the oldest realm is dropped first. */
export function createCodexLiveUsage(platform: NodeJS.Platform = process.platform): CodexLiveUsage {
  const keyOf = keyer(platform)
  const byRealm = new Map<string, AllowanceReading>()
  const sources = new Map<string, number>()
  return {
    open(sessionsDir) {
      const key = keyOf(sessionsDir)
      sources.set(key, (sources.get(key) ?? 0) + 1)
      let done = false
      return () => {
        if (done) return
        done = true
        const left = (sources.get(key) ?? 1) - 1
        if (left > 0) { sources.set(key, left); return }
        sources.delete(key)
        byRealm.delete(key)
      }
    },
    record(sessionsDir, reading) {
      if (typeof sessionsDir !== 'string' || !sessionsDir || !reading || !Array.isArray(reading.limits)) return
      const key = keyOf(sessionsDir)
      const held = byRealm.get(key)
      if (held && held.readingAt !== null && reading.readingAt !== null && reading.readingAt < held.readingAt) return
      byRealm.delete(key)
      byRealm.set(key, reading)
      while (byRealm.size > MAX_REALMS) {
        const oldest = byRealm.keys().next().value
        if (oldest === undefined) break
        byRealm.delete(oldest)
      }
    },
    get(sessionsDir) {
      if (typeof sessionsDir !== 'string' || !sessionsDir) return null
      return byRealm.get(keyOf(sessionsDir)) ?? null
    },
  }
}

// ---------------------------------------------------------------------------
// Carry marks (P3.14 rounds 1 to 3; ADR-023)
// ---------------------------------------------------------------------------

/** Conversations kept in the marks: the newest, so the file stays small. A
 *  realm with more than its share evicts its own oldest, never another's. */
export const CODEX_CARRY_MARKS_MAX = 256
/** What the marks file may hold. A text over it is not one this code wrote. */
export const CODEX_CARRY_MARKS_FILE_MAX_CHARS = 1024 * 1024
const MARKS_REALM_RE = /^[A-Za-z0-9._-]{1,128}$/
const MARKS_DIR_MAX = 4096
const MARKS_MAX_MS = 8.64e15
/** What a mark that throws is taken for: a time no event is dated after, so
 *  nothing of that rollout counts. (The store itself never throws.) */
const MARKS_CLOSED = Number.MAX_SAFE_INTEGER
/** The first wait before the marks file is read again after it could not be, and the longest. */
const MARKS_RETRY_MS = 1000
const MARKS_RETRY_MAX_MS = 30_000
/** A realm dropped while the file could not be read is remembered, up to this many. */
const MARKS_DROPPED_MAX = 256
/** So are the adoptions (a Sign in again's history copy) made meanwhile. */
const MARKS_ADOPT_QUEUE_MAX = 64
const ROLLOUT_ID_RE = /(?:^|[\\/])rollout-[^\\/]*?-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/
const CONVERSATION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
/** How far past now a stamp may claim to be before it is taken for garbage. */
const NEWEST_STAMP_FUTURE_MS = 7 * 24 * 60 * 60 * 1000

/** The conversation id in a rollout's file name or path
 *  (`rollout-<time>-<id>.jsonl`), lower case, or null. */
export function codexRolloutIdFromName(file: unknown): string | null {
  if (typeof file !== 'string' || file.length > MARKS_DIR_MAX * 2) return null
  const m = ROLLOUT_ID_RE.exec(file)
  return m ? m[1].toLowerCase() : null
}

/** The newest zoned time any line of `text` carries (a tail of a rollout: its
 *  first line may be cut), or null. A stamp more than a week past `now` is
 *  taken for garbage and ignored. Never throws. */
export function newestStampInTail(text: string, now: number): number | null {
  if (typeof text !== 'string') return null
  const limit = now + NEWEST_STAMP_FUTURE_MS
  let newest: number | null = null
  for (const raw of text.split('\n')) {
    if (!raw.includes('"timestamp"')) continue
    let evt: unknown
    try { evt = JSON.parse(raw) } catch { continue }
    if (!evt || typeof evt !== 'object') continue
    const at = zonedTimeMs((evt as Record<string, unknown>).timestamp)
    if (at !== null && at <= limit && (newest === null || at > newest)) newest = at
  }
  return newest
}

/** The newest zoned time in the carried copy of conversation `id` under
 *  `sessionsDir`, read the way the last-seen reader reads a rollout: its last
 *  256 KiB and, when that holds no time and the copy is longer, once its last
 *  2 MiB (a final line past 256 KiB is not lost); or null when there is none,
 *  or the copy cannot be found or read. */
export function newestCarriedStamp(sessionsDir: string, id: string, now: number = Date.now()): number | null {
  try {
    const found = findCodexRollout(sessionsDir, id)
    if (!found) return null
    const fd = fs.openSync(found.path, 'r')
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile()) return null
      for (const bound of [CODEX_USAGE_TAIL_BYTES, CODEX_USAGE_TAIL_MAX_BYTES]) {
        const len = Math.min(st.size, bound)
        const buf = Buffer.alloc(len)
        const got = fs.readSync(fd, buf, 0, len, st.size - len)
        const newest = newestStampInTail(buf.subarray(0, got).toString('utf8'), now)
        if (newest !== null || len >= st.size) return newest
      }
      return null
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Where the marks are kept between runs: the app's own configuration, next to
 *  the account registry (never a file in an account's folder). `unavailable`:
 *  it cannot be read now (asked again after a wait; a throw counts as that).
 *  `not-ready`: the resources folder is not known yet (asked again at once; no
 *  failed read). `corrupt`: it is there but is not a plain file within its size
 *  cap. */
export interface CodexCarryMarksPort {
  read(): { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'unavailable' } | { kind: 'not-ready' } | { kind: 'corrupt' }
  /** Replace the file. Throws on any failure. */
  write(text: string): void
  /** Move the file out of its place (renamed, the newest few kept) and put
   *  `replacement` in it, in one step; true when both were done, false with the
   *  file as it was otherwise. */
  setAside(replacement: string): boolean
}

/**
 * Which conversations Switch Account carried into which account's folder, and
 * when (ADR-023). A carried copy holds the earlier account's events, which are
 * not this account's allowance, plan or credits: a reader of that rollout
 * counts only the events dated after the carry (`cutoff`), and an event with no
 * zoned time then counts for nothing. The harm guarded against is a temporary
 * display of the other account's figures on the wrong card, so a marks file
 * that cannot be read or written never stops a carry or a Sign in again and
 * never blanks a card. Kept in memory and in the injected port:
 * - while the file cannot be read, marks, drops and adoptions are kept in
 *   memory and written once it can be; the first failed read is a floor for the
 *   folders carried into since (no event dated at or before it counts there);
 *   the read is asked again after a growing wait (not at all counted as failed
 *   while the resources folder is not known yet);
 * - a file that is not what this code wrote (not a plain file within its cap,
 *   not the expected shape in any field) is set aside and replaced in one step,
 *   never overwritten, with a floor at that moment: no rollout counts an event
 *   dated before it; if that cannot be done the file stays as it was;
 * - a mark that cannot be written is kept in memory and written when it can be;
 * - the file is trimmed at write time (oldest first) to fit what a read accepts.
 * Bounded to the newest CODEX_CARRY_MARKS_MAX, a realm over its share evicting
 * its own oldest; a realm's marks go with its account (`dropRealm`). Everything
 * read back is validated; nothing here ever throws.
 */
export interface CodexCarryMarks {
  /** Mark `conversationId` as carried into `realmId`'s `sessionsDir` at `at`
   *  (epoch ms). True when it is held (written, or kept in memory until the
   *  file can be); false only for arguments that are not a realm, a folder, a
   *  conversation or a time. */
  record(realmId: string, sessionsDir: string, conversationId: string, at: number): boolean
  /** The time of the mark itself; null for none; undefined while the file has
   *  not been read (a mark may be in it). */
  markOf(sessionsDir: string, conversationId: string | null): number | null | undefined
  /** Take a mark back (a copy that failed). */
  remove(sessionsDir: string, conversationId: string): void
  /** The time after which a rollout's events count: its mark, or the floor if
   *  later, or null for no mark and no floor. While the file has not been
   *  read: for a folder carried into since, the later of its mark and the
   *  first failed read. */
  cutoff(sessionsDir: string, conversationId: string | null): number | null
  /** Forget every mark of a realm (its account was removed). */
  dropRealm(realmId: string): void
  /** A realm's marks, kept for its replacement folder (a sign in again's
   *  history copy): each mark of `fromRealmId` is recorded for `toRealmId`'s
   *  `toSessionsDir`, the later time kept (those of a file not read yet follow
   *  when it is). False only for arguments that are not a realm or a folder. */
  adopt(fromRealmId: string, toRealmId: string, toSessionsDir: string): boolean
}

interface CarryMark { realm: string; dir: string; id: string; at: number }
interface CarryDoc { marks: CarryMark[]; floor: number | null }

const ownOf = (o: Record<string, unknown>, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)

/** The marks and floor a persisted text holds, or null for anything this code
 *  did not write: text too long or not JSON, another schema, a list that is not
 *  a list, or any field of any mark that is not what a mark's is. Own
 *  properties only. */
function parseCarryDoc(text: string): CarryDoc | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > CODEX_CARRY_MARKS_FILE_MAX_CHARS) return null
  let doc: unknown
  try { doc = JSON.parse(text) } catch { return null }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
  const d = doc as Record<string, unknown>
  const marks = ownOf(d, 'marks')
  if (ownOf(d, 'schema') !== 1 || !Array.isArray(marks) || marks.length > CODEX_CARRY_MARKS_MAX) return null
  const floorRaw = ownOf(d, 'floor')
  let floor: number | null = null
  if (floorRaw !== undefined) {
    if (typeof floorRaw !== 'number' || !Number.isFinite(floorRaw) || Math.abs(floorRaw) > MARKS_MAX_MS) return null
    floor = floorRaw
  }
  const out: CarryMark[] = []
  for (const raw of marks) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const m = raw as Record<string, unknown>
    const realm = ownOf(m, 'realm')
    const dir = ownOf(m, 'dir')
    const id = ownOf(m, 'id')
    const at = ownOf(m, 'at')
    if (typeof realm !== 'string' || !MARKS_REALM_RE.test(realm)) return null
    if (typeof dir !== 'string' || dir.length === 0 || dir.length > MARKS_DIR_MAX) return null
    if (typeof id !== 'string' || !CONVERSATION_ID_RE.test(id)) return null
    if (typeof at !== 'number' || !Number.isFinite(at) || Math.abs(at) > MARKS_MAX_MS) return null
    out.push({ realm, dir, id: id.toLowerCase(), at })
  }
  return { marks: out, floor }
}

export function createCodexCarryMarks(opts: { port?: CodexCarryMarksPort; platform?: NodeJS.Platform; max?: number; now?: () => number } = {}): CodexCarryMarks {
  const keyOf = keyer(opts.platform ?? process.platform)
  const port = opts.port
  const max = typeof opts.max === 'number' && opts.max > 0 ? Math.floor(opts.max) : CODEX_CARRY_MARKS_MAX
  const clock = () => { try { const n = opts.now ? opts.now() : Date.now(); return Number.isFinite(n) ? n : Date.now() } catch { return Date.now() } }
  /** What the marks are now: once the file has been read, the file's and this
   *  run's; before, only this run's. */
  const marks = new Map<string, CarryMark>()
  /** The persisted marks have been read (or there is no port to read). */
  let loaded = !port
  /** The floor a file set aside left: no rollout counts an event dated at or before it. */
  let floor: number | null = null
  /** The first moment the file could not be read: for the folders carried into
   *  meanwhile, no event dated at or before it counts. Used only while the file
   *  is unread; once it is read, its own marks and floor rule. */
  let heldSince: number | null = null
  /** Failed reads in a row, and the time before which the file is not read again. */
  let failures = 0
  let retryAt = Number.NEGATIVE_INFINITY
  /** Something kept in memory that the file does not have yet, and the same
   *  wait before a write that failed is tried again. */
  let dirty = false
  let writeFailures = 0
  let writeRetryAt = Number.NEGATIVE_INFINITY
  /** Realms dropped, and adoptions made, while the file could not be read:
   *  applied to what it holds once it can be. */
  const dropped = new Set<string>()
  const adoptions: Array<{ from: string; to: string; dir: string }> = []
  const keyFor = (dir: string, id: string) => `${keyOf(dir)}|${id}`
  const validDir = (dir: unknown): dir is string => typeof dir === 'string' && dir.length > 0 && dir.length <= MARKS_DIR_MAX
  const validId = (id: unknown): id is string => typeof id === 'string' && CONVERSATION_ID_RE.test(id)
  const validAt = (at: unknown): at is number => typeof at === 'number' && Number.isFinite(at) && Math.abs(at) <= MARKS_MAX_MS
  const waitAfter = (n: number) => Math.min(MARKS_RETRY_MAX_MS, MARKS_RETRY_MS * 2 ** Math.min(n - 1, 10))
  /** Over the bound, the realm with the most marks gives up its oldest. */
  const evictFrom = (map: Map<string, CarryMark>) => {
    while (map.size > max) {
      const counts = new Map<string, number>()
      for (const m of map.values()) counts.set(m.realm, (counts.get(m.realm) ?? 0) + 1)
      let busiest = ''
      let most = -1
      for (const [realm, n] of counts) if (n > most) { busiest = realm; most = n }
      let victim: string | undefined
      for (const [k, m] of map) if (m.realm === busiest) { victim = k; break }
      if (victim === undefined) break
      map.delete(victim)
    }
  }
  const putInto = (map: Map<string, CarryMark>, m: CarryMark) => {
    const k = keyFor(m.dir, m.id)
    map.delete(k)
    map.set(k, m)
    evictFrom(map)
  }
  /** Each mark of `from` recorded for `to`'s folder, the later time kept; true when there was one. */
  const rekeyInto = (map: Map<string, CarryMark>, from: string, to: string, dir: string): boolean => {
    let any = false
    for (const m of [...map.values()]) {
      if (m.realm !== from) continue
      const there = map.get(keyFor(dir, m.id))
      putInto(map, { realm: to, dir, id: m.id, at: there ? Math.max(there.at, m.at) : m.at })
      any = true
    }
    return any
  }
  /** A folder this run carried into, or adopted a history into, while the file could not be read. */
  const isHeld = (dir: string): boolean => {
    const key = keyOf(dir)
    for (const m of marks.values()) if (keyOf(m.dir) === key) return true
    for (const a of adoptions) if (keyOf(a.dir) === key) return true
    return false
  }
  /** The file text for `map` and `floorAt`, the oldest marks left out until it fits what a read accepts. */
  const serialiseOf = (map: Map<string, CarryMark>, floorAt: number | null): { text: string; kept: Map<string, CarryMark> } => {
    const kept = new Map(map)
    const text = (list: CarryMark[]) => JSON.stringify({ schema: 1, ...(floorAt !== null ? { floor: floorAt } : {}), marks: list })
    let out = text([...kept.values()])
    while (out.length > CODEX_CARRY_MARKS_FILE_MAX_CHARS && kept.size > 0) {
      const oldest = kept.keys().next().value
      if (oldest === undefined) break
      kept.delete(oldest)
      out = text([...kept.values()])
    }
    return { text: out, kept }
  }
  /** Write what is held now; a failure leaves it held, to be tried again after a wait. */
  const writeNow = (): boolean => {
    if (!port || !loaded) return false
    try {
      const { text, kept } = serialiseOf(marks, floor)
      port.write(text)
      marks.clear()
      for (const [k, m] of kept) marks.set(k, m)
      dirty = false
      writeFailures = 0
      writeRetryAt = Number.NEGATIVE_INFINITY
      return true
    } catch {
      dirty = true
      writeFailures++
      writeRetryAt = clock() + waitAfter(writeFailures)
      return false
    }
  }
  /** Something changed: written now when the file is known, else when it is read. */
  const changed = () => {
    if (!port || !loaded) return
    dirty = true
    writeNow()
  }
  const holdSince = () => { if (heldSince === null) heldSince = clock() }
  const failRead = (): false => {
    failures++
    retryAt = clock() + waitAfter(failures)
    holdSince()
    return false
  }
  /** What the marks are once the file's are known: the file's (not those of a
   *  realm dropped meanwhile, and moved as adopted meanwhile), then this run's. */
  const mergedWith = (fileMarks: CarryMark[]): Map<string, CarryMark> => {
    const out = new Map<string, CarryMark>()
    for (const m of fileMarks) if (!dropped.has(m.realm)) putInto(out, m)
    for (const a of adoptions) rekeyInto(out, a.from, a.to, a.dir)
    for (const m of marks.values()) putInto(out, m)
    return out
  }
  /** The file is known: take what it holds, with this run's beside it. */
  const commitLoad = (merged: Map<string, CarryMark>, fileFloor: number | null, written: boolean, fileMarks: CarryMark[]) => {
    const pending = marks.size > 0
    const touched = pending
      || fileMarks.some((m) => dropped.has(m.realm))
      || (adoptions.length > 0 && fileMarks.some((m) => adoptions.some((a) => a.from === m.realm)))
    marks.clear()
    for (const [k, m] of merged) marks.set(k, m)
    if (fileFloor !== null) floor = fileFloor
    loaded = true
    failures = 0
    retryAt = Number.NEGATIVE_INFINITY
    dropped.clear()
    adoptions.length = 0
    if (written) { dirty = false; return }
    if (touched) { dirty = true; writeNow() }
  }
  /** Whether the marks are known: the file read (or none to read), asked again
   *  only after a wait while it cannot be (and not counted as failed while the
   *  resources folder is not known yet). A write that failed is tried again here. */
  const ensureLoaded = (): boolean => {
    if (loaded) {
      if (dirty && port && clock() >= writeRetryAt) writeNow()
      return true
    }
    if (!port) return true
    if (clock() < retryAt) return false
    let r: ReturnType<CodexCarryMarksPort['read']>
    try { r = port.read() } catch { return failRead() }
    if (!r) return failRead()
    if (r.kind === 'not-ready') { holdSince(); return false }
    if (r.kind === 'missing') { commitLoad(mergedWith([]), null, false, []); return true }
    if (r.kind === 'ok') {
      const parsed = parseCarryDoc(r.text)
      if (parsed) { commitLoad(mergedWith(parsed.marks), parsed.floor, false, parsed.marks); return true }
    } else if (r.kind !== 'corrupt') {
      return failRead()
    }
    // Not what this code wrote: put it aside, never over it, and in the same
    // step put a file in its place that holds the floor and what this run has
    // made. Nothing before this moment counts in any rollout from now on. If
    // that cannot be done the file stays where it was: it is found again.
    const at = clock()
    const merged = mergedWith([])
    const replacement = serialiseOf(merged, at)
    let aside = false
    try { aside = port.setAside(replacement.text) === true } catch { aside = false }
    if (!aside) return failRead()
    commitLoad(replacement.kept, at, true, [])
    return true
  }
  return {
    record(realmId, sessionsDir, conversationId, at) {
      try {
        if (typeof realmId !== 'string' || !MARKS_REALM_RE.test(realmId)) return false
        if (!validDir(sessionsDir) || !validId(conversationId) || !validAt(at)) return false
        ensureLoaded()
        const k = keyFor(sessionsDir, conversationId.toLowerCase())
        putInto(marks, { realm: realmId, dir: sessionsDir, id: conversationId.toLowerCase(), at })
        changed()
        return marks.has(k)
      } catch {
        return false
      }
    },
    markOf(sessionsDir, conversationId) {
      try {
        if (!validDir(sessionsDir) || !validId(conversationId)) return null
        ensureLoaded()
        const m = marks.get(keyFor(sessionsDir, conversationId.toLowerCase()))
        if (m) return m.at
        return loaded ? null : undefined
      } catch {
        return null
      }
    },
    remove(sessionsDir, conversationId) {
      try {
        if (!validDir(sessionsDir) || !validId(conversationId)) return
        ensureLoaded()
        if (marks.delete(keyFor(sessionsDir, conversationId.toLowerCase()))) changed()
      } catch { /* nothing to take back */ }
    },
    cutoff(sessionsDir, conversationId) {
      try {
        if (!validDir(sessionsDir) || !validId(conversationId)) return null
        const known = ensureLoaded()
        const mark = marks.get(keyFor(sessionsDir, conversationId.toLowerCase()))?.at ?? null
        if (known) {
          if (floor === null) return mark
          return mark === null ? floor : Math.max(mark, floor)
        }
        // The file has not been read: only a folder carried into since is held, to the first failed read.
        if (heldSince === null || !isHeld(sessionsDir)) return mark
        return mark === null ? heldSince : Math.max(mark, heldSince)
      } catch {
        return MARKS_CLOSED
      }
    },
    dropRealm(realmId) {
      try {
        if (typeof realmId !== 'string') return
        ensureLoaded()
        let any = false
        for (const [k, m] of [...marks.entries()]) if (m.realm === realmId) { marks.delete(k); any = true }
        if (!loaded) {
          // Not brought back by the file once it can be read.
          if (dropped.size < MARKS_DROPPED_MAX) dropped.add(realmId)
          return
        }
        if (any) changed()
      } catch { /* nothing to forget */ }
    },
    adopt(fromRealmId, toRealmId, toSessionsDir) {
      try {
        if (typeof fromRealmId !== 'string' || typeof toRealmId !== 'string' || !MARKS_REALM_RE.test(toRealmId) || !validDir(toSessionsDir)) return false
        ensureLoaded()
        const any = rekeyInto(marks, fromRealmId, toRealmId, toSessionsDir)
        if (loaded) {
          if (any) changed()
        } else if (adoptions.length < MARKS_ADOPT_QUEUE_MAX) {
          // The file's own marks of the old realm follow once it can be read.
          adoptions.push({ from: fromRealmId, to: toRealmId, dir: toSessionsDir })
        }
        return true
      } catch {
        return false
      }
    },
  }
}

/** A reading as the port reports it: buckets, time, plan name and, when the
 *  reading carries them, the credits count (ADR-023; the key is omitted
 *  otherwise); null when it has nothing to draw. Never throws. */
function toUsageReading(r: AllowanceReading | null): UsageReading | null {
  try {
    if (!r) return null
    const buckets = readingToBuckets(r)
    if (buckets.length === 0) return null
    const out: UsageReading = { buckets, readingAt: r.readingAt, planLabel: planLabelFor(r.planType) }
    if (r.credits) out.credits = r.credits
    return out
  } catch {
    return null
  }
}

export interface CodexUsageDeps {
  /** The realm's sessions folder, located exactly as a launch locates it and
   *  held to the launch's canonical-home check; null when refused. */
  sessionsDir(realm: RealmRef): Promise<string | null>
  fs: CodexUsageFsPort
  live: CodexLiveUsage
  now?: () => number
  /** Conversations carried into a realm by Switch Account (ADR-023): the
   *  last-seen reading counts only the events written after the carry. */
  marks?: CodexCarryMarks
  /** The longest a caller waits (tests shorten it). */
  timeoutMs?: number
  /** Usage track MP8: the auth operations' one helper read. Absent: the
   *  port has no `read`. */
  readUsage?(realm: RealmRef, opts: CodexUsageReadOptions): Promise<CodexUsageRead>
  /** The executable discovery proved, now: a key naming its identity and
   *  version, and the version. Null when none is proved. */
  executable?(): { key: string; version: string | null } | null
}

/** `p`, or `late` once `ms` have passed or when it rejects. */
function within<T>(p: Promise<T>, ms: number, late: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(late), ms)
    ;(timer as { unref?: () => void }).unref?.()
    p.then((v) => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(late) })
  })
}

export function createCodexUsageOperations(deps: CodexUsageDeps): ProviderUsageOperations {
  const now = () => { try { const n = deps.now ? deps.now() : Date.now(); return Number.isFinite(n) ? n : Date.now() } catch { return Date.now() } }
  const timeoutMs = typeof deps.timeoutMs === 'number' && deps.timeoutMs > 0 ? deps.timeoutMs : CODEX_USAGE_READ_TIMEOUT_MS
  const keyOf = keyer(deps.fs.platform)
  const held = new Map<string, { fingerprint: string; reading: AllowanceReading | null }>()
  const cache: LastSeenCache = {
    get: (dir) => held.get(keyOf(dir)),
    set: (dir, value) => {
      const key = keyOf(dir)
      held.delete(key)
      held.set(key, value)
      while (held.size > MAX_REALMS) {
        const oldest = held.keys().next().value
        if (oldest === undefined) break
        held.delete(oldest)
      }
    },
  }
  /**
   * One run per realm at a time, shared by every caller, none of whom waits
   * for it longer than `timeoutMs` (then it is `late`). A run that never
   * settles (a hung network share) is not started again beside itself: each
   * would hold one of the few threads the main process has for file work.
   * Once it settles, the next call starts a fresh one.
   */
  const shared = <T>(runs: Map<string, Promise<T>>, key: string, start: () => Promise<T>, late: T): Promise<T> => {
    let run = runs.get(key)
    if (!run) {
      const p = Promise.resolve().then(start).catch(() => late)
      runs.set(key, p)
      void p.finally(() => { if (runs.get(key) === p) runs.delete(key) })
      run = p
    }
    return within(run, timeoutMs, late)
  }
  const locating = new Map<string, Promise<string | null>>()
  const reading = new Map<string, Promise<UsageLookup>>()
  const locate = async (realm: RealmRef): Promise<string | null> => {
    const dir = await deps.sessionsDir(realm)
    return typeof dir === 'string' && dir ? dir : null
  }
  const realmKey = (realm: RealmRef) => String((realm as { authRealmId?: unknown } | null)?.authRealmId ?? '')
  // MP8: executables that answered `unsupported`, oldest dropped first.
  const unsupported = new Set<string>()
  const executable = (): { key: string; version: string | null } | null => {
    try {
      const e = deps.executable?.()
      return e && typeof e.key === 'string' && e.key ? { key: e.key, version: typeof e.version === 'string' ? e.version : null } : null
    } catch {
      return null
    }
  }
  const settledNow: Promise<void> = Promise.resolve()
  const readUsage = deps.readUsage
  return {
    // Memory only, but locating the realm checks its home on disk: that goes
    // through the same guard.
    async live(realm) {
      const dir = await shared(locating, realmKey(realm), () => locate(realm), null)
      if (!dir) return { ok: false }
      return { ok: true, reading: toUsageReading(deps.live.get(dir)) }
    },
    lastSeen(realm) {
      return shared(reading, realmKey(realm), async (): Promise<UsageLookup> => {
        const dir = await locate(realm)
        if (!dir) return { ok: false }
        const r = await lookupLastSeenAllowance(dir, deps.fs, now(), cache, deps.marks)
        return r.ok ? { ok: true, reading: toUsageReading(r.reading) } : { ok: false }
      }, { ok: false })
    },
    // MP8: present only when the helper read is wired (absent, the port has
    // no fresh read at all). Never rejects; `ended` is the helper's own end
    // when one started.
    ...(readUsage ? { read: async (realm: RealmRef, opts: UsageReadOptions = {}): Promise<UsageReadResult> => {
      let ended: Promise<void> = settledNow
      const answer = (outcome: UsageReadResult['outcome']): UsageReadResult => ({ outcome, ended })
      try {
        const exe = executable()
        if (!exe || classifyCodexVersion(exe.version) !== 'supported') return answer({ ok: false, failure: 'refused' })
        if (unsupported.has(exe.key)) return answer({ ok: false, failure: 'unsupported' })
        const v = await readUsage(realm, {
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.mayStart ? { mayStart: opts.mayStart } : {}),
          onEnded: (p) => { ended = Promise.resolve(p).then(() => undefined, () => undefined) },
        })
        if (v && v.ok === true) return answer({ ok: true, reading: toUsageReading(v.reading) })
        const kind = v && v.ok === false ? v.kind : 'refused'
        if (kind === 'unsupported') {
          // Kept only for the executable that answered: one replaced
          // meanwhile is asked afresh.
          if (executable()?.key === exe.key) {
            unsupported.add(exe.key)
            while (unsupported.size > MAX_VERDICTS) {
              const oldest = unsupported.values().next().value
              if (oldest === undefined) break
              unsupported.delete(oldest)
            }
          }
          return answer({ ok: false, failure: 'unsupported' })
        }
        return answer({ ok: false, failure: kind === 'transient' ? 'transient' : 'refused' })
      } catch {
        return answer({ ok: false, failure: 'refused' })
      }
    } } : {}),
  }
}
