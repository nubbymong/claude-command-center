import { mkdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { logError } from './debug-logger'
import { atomicWriteFileSync } from './atomic-write'
import { getResourcesDirectory } from './ipc/setup-handlers'
import type {
  CodexReviewUsageRecord,
  CodexReviewRateLimitWindow,
  CodexReviewDailyShard,
} from '../shared/types'

type Listener = (sessionId: string, record: CodexReviewUsageRecord) => void
const listeners = new Set<Listener>()

export function onUsageRecorded(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

interface RecordPayload {
  inputTokens: number
  outputTokens: number
  rateLimit: CodexReviewRateLimitWindow | null
}

const inMemory = new Map<string, CodexReviewUsageRecord>()
let shard: CodexReviewDailyShard | null = null

function shardPath(): string {
  return join(getResourcesDirectory(), 'tokenomics', 'codex-review-by-day.json')
}

function loadShard(): CodexReviewDailyShard {
  if (shard) return shard
  const p = shardPath()
  if (existsSync(p)) {
    try {
      shard = JSON.parse(readFileSync(p, 'utf-8'))
      if (shard && typeof shard.byDay === 'object') return shard
    } catch (err: any) {
      logError('[codex-review-usage] shard parse failed:', err?.message)
    }
  }
  shard = { byDay: {}, lastUpdated: Date.now() }
  return shard
}

function saveShard(): void {
  if (!shard) return
  try {
    const dir = join(getResourcesDirectory(), 'tokenomics')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    shard.lastUpdated = Date.now()
    // Atomic-replace: tmp file + renameSync. fs.renameSync is atomic on
    // POSIX (rename(2)) and on Windows via MoveFileExW with REPLACE_EXISTING,
    // regardless of whether the destination exists. A crash mid-write leaves
    // the previous shard intact, never a partially-written one.
    //
    // P7.7.16: the earlier existsSync/copyFileSync branch was NOT atomic --
    // copyFileSync truncates the destination in-place. Copilot caught this
    // on the P7.7.14 review.
    const filePath = shardPath()
    try {
      atomicWriteFileSync(filePath, JSON.stringify(shard, null, 2))
    } catch (writeErr: any) {
      // Distinguish the stages so the log still says which half failed, as it
      // did before the staging moved into the shared helper (#233).
      const stage = writeErr?.atomicWriteStage === 'rename' ? 'rename' : 'write'
      logError(`[codex-review-usage] shard ${stage} failed:`, writeErr?.message)
    }
  } catch (err: any) {
    logError('[codex-review-usage] shard write failed:', err?.message)
  }
}

function todayLocalIso(): string {
  // YYYY-MM-DD in LOCAL time -- matches existing tokenomics dailyAggregates keying.
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function recordReview(sessionId: string, payload: RecordPayload): void {
  const prev = inMemory.get(sessionId)
  const record: CodexReviewUsageRecord = {
    sessionId,
    reviewCount: (prev?.reviewCount ?? 0) + 1,
    totalInputTokens: (prev?.totalInputTokens ?? 0) + payload.inputTokens,
    totalOutputTokens: (prev?.totalOutputTokens ?? 0) + payload.outputTokens,
    lastRateLimitWindow: payload.rateLimit,
    lastReviewAt: Date.now(),
  }
  inMemory.set(sessionId, record)

  const s = loadShard()
  const day = todayLocalIso()
  const cell = s.byDay[day] ?? { reviewCount: 0, totalInputTokens: 0, totalOutputTokens: 0 }
  cell.reviewCount += 1
  cell.totalInputTokens += payload.inputTokens
  cell.totalOutputTokens += payload.outputTokens
  s.byDay[day] = cell
  saveShard()

  for (const l of listeners) {
    try { l(sessionId, record) } catch { /* never let listener errors crash recording */ }
  }
}

export function getUsage(sessionId: string): CodexReviewUsageRecord | null {
  return inMemory.get(sessionId) ?? null
}

export function disposeSession(sessionId: string): void {
  inMemory.delete(sessionId)
  // Disk shard intentionally preserved -- daily roll-up survives session disposal.
}

/** Test-only: clear in-memory map AND lazy shard cache so the next recordReview
 *  re-reads the disk shard from a clean slate. Disk file itself untouched. */
export function __resetForTests(): void {
  inMemory.clear()
  shard = null
}
