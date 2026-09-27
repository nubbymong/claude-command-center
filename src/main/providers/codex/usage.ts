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
import { normaliseCodexRateLimits, mergeAllowanceReadings, readingToBuckets } from './rate-limits'
import { classifyCodexVersion } from './cli-contract'
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
 *  The first line of a partial tail is cut and never read. */
function allowanceInTail(text: string, whole: boolean, now: number): AllowanceReading | null {
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
    const at = Date.parse(String(e.timestamp ?? ''))
    readings.push(normaliseCodexRateLimits(payload.rate_limits, 'rollout', Number.isFinite(at) ? at : null, now))
  }
  const merged = mergeAllowanceReadings(readings)
  return merged && merged.limits.length > 0 ? merged : null
}

/** One rollout's allowance: a 256 KiB tail, then once a 2 MiB one.
 *  'unread' when it could not be read (busy, too many open files, changed or
 *  unverifiable): not the same as a rollout with no allowance in it. */
async function allowanceInRollout(port: CodexUsageFsPort, file: string, entry: CodexUsageEntry, now: number): Promise<AllowanceReading | null | 'unread'> {
  for (const max of [CODEX_USAGE_TAIL_BYTES, CODEX_USAGE_TAIL_MAX_BYTES]) {
    let tail: { text: string; whole: boolean }
    try { tail = await port.readTail(file, max, entry) } catch { return 'unread' }
    if (!tail || typeof tail.text !== 'string') return 'unread'
    const found = allowanceInTail(tail.text, tail.whole === true, now)
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
const fingerprintOf = (c: readonly Candidate[]): string =>
  JSON.stringify(c.map((x) => [x.file, x.entry.dev, x.entry.ino, x.entry.size, x.entry.mtimeMs]))

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
export async function lookupLastSeenAllowance(sessionsDir: string, port: CodexUsageFsPort, now: number = Date.now(), cache?: LastSeenCache): Promise<LastSeenLookup> {
  try {
    const walk = await newestRollouts(sessionsDir, port)
    if (walk.unverifiable) return { ok: false }
    const fingerprint = fingerprintOf(walk.candidates)
    const held = cache?.get(sessionsDir)
    if (held && held.fingerprint === fingerprint) return { ok: true, reading: held.reading }
    let best: AllowanceReading | null = null
    let unread = false
    for (const c of walk.candidates) {
      const r = await allowanceInRollout(port, c.file, c.entry, now)
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
export async function readLastSeenAllowance(sessionsDir: string, port: CodexUsageFsPort, now: number = Date.now(), cache?: LastSeenCache): Promise<AllowanceReading | null> {
  const r = await lookupLastSeenAllowance(sessionsDir, port, now, cache)
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

/** A reading as the port reports it: buckets, time, plan name; null when it
 *  has nothing to draw. Never throws. */
function toUsageReading(r: AllowanceReading | null): UsageReading | null {
  try {
    if (!r) return null
    const buckets = readingToBuckets(r)
    if (buckets.length === 0) return null
    return { buckets, readingAt: r.readingAt, planLabel: planLabelFor(r.planType) }
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
        const r = await lookupLastSeenAllowance(dir, deps.fs, now(), cache)
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
