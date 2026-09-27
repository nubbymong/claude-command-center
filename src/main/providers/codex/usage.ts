/**
 * Codex per-account usage (usage track MP3; plan section 3): the package's
 * usage port.
 *
 * - `live(realm)`: the newest allowance an open session in the realm reported,
 *   recorded in memory by the session telemetry, keyed by the realm's sessions
 *   folder exactly as a launch names it. No file, no process.
 * - `lastSeen(realm)`: the last allowance in the realm's own session history.
 *   It opens only `rollout-*.jsonl` files under `sessions/YYYY/MM/DD`, newest
 *   day folder first and newest file name first in it, examines at most
 *   CODEX_USAGE_MAX_FILES of them, reads a bounded tail of each (256 KiB,
 *   once growing to 2 MiB), follows no link at any level, and never touches
 *   the sign-in file or anything else in the realm. No process.
 *
 * Both read only; the accounts service decides when they may run. The fresh
 * read of a closed account (ADR-022) is not here: it lands in MP8.
 */

import path from 'node:path'
import fs from 'node:fs'
import type { AllowanceReading } from '../../../shared/usage-types'
import { planLabelFor } from '../../../shared/usage-types'
import type { ProviderUsageOperations, RealmRef, UsageReading } from '../core'
import { normaliseCodexRateLimits, mergeAllowanceReadings, readingToBuckets } from './rate-limits'

/** The first tail read of a rollout. */
export const CODEX_USAGE_TAIL_BYTES = 256 * 1024
/** The one larger read when the first tail held no allowance. */
export const CODEX_USAGE_TAIL_MAX_BYTES = 2 * 1024 * 1024
/** Rollouts examined, newest first, before giving up. */
export const CODEX_USAGE_MAX_FILES = 8
/** Day folders listed, newest first, before giving up. */
const MAX_DAY_FOLDERS = 64
/** Realms kept in the live figure. */
const MAX_LIVE_REALMS = 64

const YEAR_RE = /^\d{4}$/
const MONTH_DAY_RE = /^\d{2}$/
const ROLLOUT_RE = /^rollout-[^\\/]+\.jsonl$/

/** The filesystem the last-seen reader uses. Main-process only. */
export interface CodexUsageFsPort {
  platform: NodeJS.Platform
  /** What the path itself is, without following a link. Throws when absent. */
  lstat(p: string): { kind: 'file' | 'dir' | 'link' | 'other' }
  readdir(dir: string): string[]
  /** The last `maxBytes` of a regular file (never through a link), and
   *  whether that is the whole file. Throws otherwise. */
  readTail(file: string, maxBytes: number): { text: string; whole: boolean }
}

/** The real filesystem: lstat, readdir, and a tail read of a regular file
 *  opened without following a link where the platform can say so. */
export function realCodexUsageFsPort(platform: NodeJS.Platform = process.platform): CodexUsageFsPort {
  const noFollow = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0
  return {
    platform,
    lstat: (p) => {
      const s = fs.lstatSync(p)
      return { kind: s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other' }
    },
    readdir: (dir) => fs.readdirSync(dir),
    readTail: (file, maxBytes) => {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow)
      try {
        const st = fs.fstatSync(fd)
        if (!st.isFile()) throw new Error('not a regular file')
        const len = Math.min(st.size, maxBytes)
        const buf = Buffer.alloc(len)
        let read = 0
        while (read < len) {
          const n = fs.readSync(fd, buf, read, len - read, st.size - len + read)
          if (n <= 0) break
          read += n
        }
        return { text: buf.subarray(0, read).toString('utf8'), whole: len === st.size }
      } finally {
        fs.closeSync(fd)
      }
    },
  }
}

const isDir = (port: CodexUsageFsPort, p: string): boolean => {
  try { return port.lstat(p).kind === 'dir' } catch { return false }
}
const names = (port: CodexUsageFsPort, dir: string, re: RegExp): string[] => {
  try { return port.readdir(dir).filter((n) => typeof n === 'string' && re.test(n)).sort().reverse() } catch { return [] }
}

/** The allowance in one tail of a rollout: every token_count that carries
 *  rate_limits (a pre-response one included), newest reading of each limit.
 *  The first line of a partial tail is cut and never read. */
function allowanceInTail(text: string, whole: boolean): AllowanceReading | null {
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
    readings.push(normaliseCodexRateLimits(payload.rate_limits, 'rollout', Number.isFinite(at) ? at : null))
  }
  const merged = mergeAllowanceReadings(readings)
  return merged && merged.limits.length > 0 ? merged : null
}

/** One rollout's allowance: a 256 KiB tail, then once a 2 MiB one. */
function allowanceInRollout(port: CodexUsageFsPort, file: string): AllowanceReading | null {
  for (const max of [CODEX_USAGE_TAIL_BYTES, CODEX_USAGE_TAIL_MAX_BYTES]) {
    let tail: { text: string; whole: boolean }
    try { tail = port.readTail(file, max) } catch { return null }
    if (!tail || typeof tail.text !== 'string') return null
    const found = allowanceInTail(tail.text, tail.whole === true)
    if (found || tail.whole === true) return found
  }
  return null
}

/**
 * The last allowance recorded under a realm's sessions folder, or null. Never
 * throws. See the module comment for exactly what it may open.
 */
export function readLastSeenAllowance(sessionsDir: string, port: CodexUsageFsPort): AllowanceReading | null {
  try {
    const p = port.platform === 'win32' ? path.win32 : path.posix
    if (!isDir(port, sessionsDir)) return null
    let files = 0
    let days = 0
    for (const year of names(port, sessionsDir, YEAR_RE)) {
      const yearDir = p.join(sessionsDir, year)
      if (!isDir(port, yearDir)) continue
      for (const month of names(port, yearDir, MONTH_DAY_RE)) {
        const monthDir = p.join(yearDir, month)
        if (!isDir(port, monthDir)) continue
        for (const day of names(port, monthDir, MONTH_DAY_RE)) {
          if (++days > MAX_DAY_FOLDERS) return null
          const dayDir = p.join(monthDir, day)
          if (!isDir(port, dayDir)) continue
          for (const name of names(port, dayDir, ROLLOUT_RE)) {
            const file = p.join(dayDir, name)
            let kind: string
            try { kind = port.lstat(file).kind } catch { continue }
            if (kind !== 'file') continue
            if (++files > CODEX_USAGE_MAX_FILES) return null
            const found = allowanceInRollout(port, file)
            if (found) return found
          }
        }
      }
    }
    return null
  } catch {
    return null
  }
}

/** The newest allowance each realm's open sessions reported, in memory. */
export interface CodexLiveUsage {
  record(sessionsDir: string, reading: AllowanceReading): void
  get(sessionsDir: string): AllowanceReading | null
}

/** Keyed by the sessions folder as a launch names it; one spelling per folder
 *  on Windows and macOS (case-insensitive there). A reading older than the
 *  one held is ignored. Bounded: the oldest realm is dropped first. */
export function createCodexLiveUsage(platform: NodeJS.Platform = process.platform): CodexLiveUsage {
  const caseless = platform === 'win32' || platform === 'darwin'
  const keyOf = (dir: string) => {
    const s = String(dir).replace(/[\\/]+$/, '')
    return caseless ? s.toLowerCase() : s
  }
  const byRealm = new Map<string, AllowanceReading>()
  return {
    record(sessionsDir, reading) {
      if (typeof sessionsDir !== 'string' || !sessionsDir || !reading || !Array.isArray(reading.limits)) return
      const key = keyOf(sessionsDir)
      const held = byRealm.get(key)
      if (held && held.readingAt !== null && reading.readingAt !== null && reading.readingAt < held.readingAt) return
      byRealm.delete(key)
      byRealm.set(key, reading)
      while (byRealm.size > MAX_LIVE_REALMS) {
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
 *  has nothing to draw. */
function toUsageReading(r: AllowanceReading | null): UsageReading | null {
  if (!r) return null
  const buckets = readingToBuckets(r)
  if (buckets.length === 0) return null
  return { buckets, readingAt: r.readingAt, planLabel: planLabelFor(r.planType) }
}

export interface CodexUsageDeps {
  /** The realm's sessions folder, located exactly as a launch locates it;
   *  null when it cannot be located now. */
  sessionsDir(realm: RealmRef): Promise<string | null>
  fs: CodexUsageFsPort
  live: CodexLiveUsage
}

export function createCodexUsageOperations(deps: CodexUsageDeps): ProviderUsageOperations {
  const locate = async (realm: RealmRef): Promise<string | null> => {
    try {
      const dir = await deps.sessionsDir(realm)
      return typeof dir === 'string' && dir ? dir : null
    } catch {
      return null
    }
  }
  return {
    async live(realm) {
      const dir = await locate(realm)
      if (!dir) return null
      try { return toUsageReading(deps.live.get(dir)) } catch { return null }
    },
    async lastSeen(realm) {
      const dir = await locate(realm)
      if (!dir) return null
      return toUsageReading(readLastSeenAllowance(dir, deps.fs))
    },
  }
}
