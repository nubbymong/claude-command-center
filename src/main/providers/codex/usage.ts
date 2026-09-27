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
 *   2 MiB), and keeps the whole walk inside one budget of folder visits and
 *   entries (and at most CODEX_USAGE_MAX_DAYS day folders). A reading is kept
 *   while the rollouts it came from are unchanged, and concurrent requests
 *   for one realm share one read. No process.
 *
 * Links. Both first locate the realm exactly as a launch does AND hold it to
 * the launch's canonical-home check (the realm's home must be a real folder
 * at exactly its path, no junction or link on the way), so nothing a launch
 * would refuse is read. Below the home, the sessions folder and every year,
 * month and day folder are checked with lstat before they are listed and
 * again, by device and inode, after; every rollout is checked with lstat and
 * opened only when, after opening, it is still that same regular file with a
 * single link. On macOS and Linux it is opened with O_NOFOLLOW and O_NONBLOCK
 * (a link or a FIFO swapped in never follows or blocks). Windows has neither
 * flag: there the identity comparison after opening is the check (a link
 * swapped in opens its target, whose identity differs), and a named pipe does
 * not live in the file tree. The threat this bounds is another process of the
 * same user changing the tree while it is read; that process can already
 * write every file here.
 *
 * Both read only; the accounts service decides when they may run. The fresh
 * read of a closed account (ADR-022) is not here: it lands in MP8.
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import type { AllowanceReading } from '../../../shared/usage-types'
import { planLabelFor } from '../../../shared/usage-types'
import type { ProviderUsageOperations, RealmRef, UsageLookup, UsageReading } from '../core'
import { normaliseCodexRateLimits, mergeAllowanceReadings, readingToBuckets } from './rate-limits'

/** The first tail read of a rollout. */
export const CODEX_USAGE_TAIL_BYTES = 256 * 1024
/** The one larger read when the first tail held no allowance. */
export const CODEX_USAGE_TAIL_MAX_BYTES = 2 * 1024 * 1024
/** Rollouts examined, newest name first. */
export const CODEX_USAGE_MAX_FILES = 8
/** Day folders listed, newest first. */
export const CODEX_USAGE_MAX_DAYS = 64
/** Folder visits plus entries listed, across the whole walk. */
export const CODEX_USAGE_WALK_BUDGET = 1024
/** Realms kept in the live figure and in the last-seen cache. */
const MAX_REALMS = 64

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
  /** Up to `limit` names in the folder, and whether it holds more. */
  readdir(dir: string, limit: number): Promise<{ names: string[]; more: boolean }>
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

/** The real filesystem, asynchronous throughout. See the module comment for
 *  what each platform can and cannot promise. */
export function realCodexUsageFsPort(platform: NodeJS.Platform = process.platform, api: CodexUsageFsApi = nodeFsApi): CodexUsageFsPort {
  const flags = api.constants.O_RDONLY | (api.constants.O_NOFOLLOW ?? 0) | (api.constants.O_NONBLOCK ?? 0)
  return {
    platform,
    lstat: async (p) => entryOf(await api.lstat(p)),
    readdir: async (dir, limit) => {
      const d = await api.opendir(dir)
      const names: string[] = []
      let more = false
      try {
        for (;;) {
          const e = await d.read()
          if (!e) break
          if (names.length >= limit) { more = true; break }
          names.push(e.name)
        }
      } finally {
        await d.close()
      }
      return { names, more }
    },
    readTail: async (file, maxBytes, expected) => {
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

/** One rollout's allowance: a 256 KiB tail, then once a 2 MiB one. */
async function allowanceInRollout(port: CodexUsageFsPort, file: string, entry: CodexUsageEntry, now: number): Promise<AllowanceReading | null> {
  for (const max of [CODEX_USAGE_TAIL_BYTES, CODEX_USAGE_TAIL_MAX_BYTES]) {
    let tail: { text: string; whole: boolean }
    try { tail = await port.readTail(file, max, entry) } catch { return null }
    if (!tail || typeof tail.text !== 'string') return null
    const found = allowanceInTail(tail.text, tail.whole === true, now)
    if (found || tail.whole === true) return found
  }
  return null
}

interface Candidate { file: string; entry: CodexUsageEntry }

/** The newest rollouts under a sessions folder, at most CODEX_USAGE_MAX_FILES,
 *  each a regular, singly linked file as lstat saw it. The walk spends one
 *  budget on folder visits and entries; running out ends it with what it has. */
async function newestRollouts(sessionsDir: string, port: CodexUsageFsPort): Promise<Candidate[]> {
  const p = port.platform === 'win32' ? path.win32 : path.posix
  let budget = CODEX_USAGE_WALK_BUDGET
  let days = 0
  const out: Candidate[] = []
  const same = (a: CodexUsageEntry, b: CodexUsageEntry) => a.dev === b.dev && a.ino === b.ino
  /** The folder's matching names, newest first; null to stop the walk (the
   *  budget ran out). An unusable folder (a link, not a folder, changed while
   *  listed) lists nothing. */
  const list = async (dir: string, re: RegExp): Promise<string[] | null> => {
    if (--budget < 0) return null
    let before: CodexUsageEntry
    try { before = await port.lstat(dir) } catch { return [] }
    if (before.kind !== 'dir') return []
    let listed: { names: string[]; more: boolean }
    try { listed = await port.readdir(dir, Math.max(0, budget)) } catch { return [] }
    const names = Array.isArray(listed?.names) ? listed.names : []
    budget -= names.length
    if (listed.more === true || budget < 0) return null
    let after: CodexUsageEntry
    try { after = await port.lstat(dir) } catch { return [] }
    if (after.kind !== 'dir' || !same(before, after)) return []
    return names.filter((n) => typeof n === 'string' && re.test(n)).sort().reverse()
  }
  const years = await list(sessionsDir, YEAR_RE)
  if (!years) return out
  for (const year of years) {
    const months = await list(p.join(sessionsDir, year), MONTH_DAY_RE)
    if (!months) return out
    for (const month of months) {
      const dayNames = await list(p.join(sessionsDir, year, month), MONTH_DAY_RE)
      if (!dayNames) return out
      for (const d of dayNames) {
        if (++days > CODEX_USAGE_MAX_DAYS) return out
        const dayDir = p.join(sessionsDir, year, month, d)
        const files = await list(dayDir, ROLLOUT_RE)
        if (!files) return out
        for (const name of files) {
          const file = p.join(dayDir, name)
          let entry: CodexUsageEntry
          try { entry = await port.lstat(file) } catch { continue }
          if (entry.kind !== 'file' || entry.nlink !== 1) continue
          out.push({ file, entry })
          if (out.length >= CODEX_USAGE_MAX_FILES) return out
        }
      }
    }
  }
  return out
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

/**
 * The last allowance recorded under a realm's sessions folder, or null: of
 * the newest rollouts examined, the one reported last. Never rejects. See the
 * module comment for exactly what it may open.
 */
export async function readLastSeenAllowance(sessionsDir: string, port: CodexUsageFsPort, now: number = Date.now(), cache?: LastSeenCache): Promise<AllowanceReading | null> {
  try {
    const candidates = await newestRollouts(sessionsDir, port)
    const fingerprint = fingerprintOf(candidates)
    const held = cache?.get(sessionsDir)
    if (held && held.fingerprint === fingerprint) return held.reading
    let best: AllowanceReading | null = null
    for (const c of candidates) {
      const r = await allowanceInRollout(port, c.file, c.entry, now)
      if (r && (best === null || (r.readingAt ?? -Infinity) > (best.readingAt ?? -Infinity))) best = r
    }
    cache?.set(sessionsDir, { fingerprint, reading: best })
    return best
  } catch {
    return null
  }
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
}

export function createCodexUsageOperations(deps: CodexUsageDeps): ProviderUsageOperations {
  const now = () => { try { const n = deps.now ? deps.now() : Date.now(); return Number.isFinite(n) ? n : Date.now() } catch { return Date.now() } }
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
  const inFlight = new Map<string, Promise<UsageLookup>>()
  const locate = async (realm: RealmRef): Promise<string | null> => {
    try {
      const dir = await deps.sessionsDir(realm)
      return typeof dir === 'string' && dir ? dir : null
    } catch {
      return null
    }
  }
  const realmKey = (realm: RealmRef) => String((realm as { authRealmId?: unknown } | null)?.authRealmId ?? '')
  return {
    async live(realm) {
      const dir = await locate(realm)
      if (!dir) return { ok: false }
      return { ok: true, reading: toUsageReading(deps.live.get(dir)) }
    },
    lastSeen(realm) {
      const key = realmKey(realm)
      const running = inFlight.get(key)
      if (running) return running
      const run = (async (): Promise<UsageLookup> => {
        const dir = await locate(realm)
        if (!dir) return { ok: false }
        const r = await readLastSeenAllowance(dir, deps.fs, now(), cache)
        return { ok: true, reading: toUsageReading(r) }
      })().catch((): UsageLookup => ({ ok: true, reading: null }))
      inFlight.set(key, run)
      void run.finally(() => { if (inFlight.get(key) === run) inFlight.delete(key) })
      return run
    },
  }
}
