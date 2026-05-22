import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, copyFileSync } from 'fs'
import { join } from 'path'
import { logError } from './debug-logger'
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
    // Atomic write: tmp file + copyFileSync/renameSync. Mirrors the
    // tokenomics-manager saveData pattern -- a crash mid-write must not leave
    // the shard truncated and break Tokenomics' best-effort load path.
    const filePath = shardPath()
    const tmpPath = `${filePath}.tmp.${process.pid}`
    writeFileSync(tmpPath, JSON.stringify(shard, null, 2), 'utf-8')
    try {
      if (existsSync(filePath)) {
        copyFileSync(tmpPath, filePath)
        try { unlinkSync(tmpPath) } catch { /* ignore */ }
      } else {
        renameSync(tmpPath, filePath)
      }
    } catch (renameErr: any) {
      try { unlinkSync(tmpPath) } catch { /* ignore */ }
      logError('[codex-review-usage] shard rename failed:', renameErr?.message)
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
