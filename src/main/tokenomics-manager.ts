/**
 * Tokenomics Manager — scans JSONL transcripts, aggregates token usage and cost.
 * Stores persistent data in CONFIG/tokenomics.json.
 */

import { BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { getConfigDir, ensureConfigDir } from './config-manager'
import { logInfo, logError } from './debug-logger'
import type { TokenomicsData, TokenomicsSessionRecord, TokenomicsDailyAggregate, TokenomicsSyncProgress } from '../shared/types'
import { IPC } from '../shared/ipc-channels'
import {
  findClaudeHistoryFiles,
  parseClaudeTranscriptFile,
  type ClaudeParsedMessage,
} from './providers/claude/telemetry'

// ── Model Pricing (per 1M tokens) ──

interface ModelPricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

// Hardcoded fallback pricing (per 1M tokens)
const FALLBACK_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 },
}

// Dynamic pricing from LiteLLM (static JSON of model prices, cached 24h)
let livePricing: Record<string, ModelPricing> | null = null

/** Fetch Claude model pricing from LiteLLM's open pricing dataset (static JSON only). */
export async function fetchModelPricing(): Promise<void> {
  // Check disk cache first (24h TTL)
  try {
    const cachePath = path.join(getConfigDir(), 'model-pricing.json')
    if (fs.existsSync(cachePath)) {
      const stat = fs.statSync(cachePath)
      if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) {
        livePricing = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
        logInfo(`[tokenomics] Loaded cached model pricing (${Object.keys(livePricing!).length} models)`)
        return
      }
    }
  } catch { /* cache miss */ }

  try {
    const https = await import('https')
    const body: string = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'raw.githubusercontent.com',
        path: '/BerriAI/litellm/main/model_prices_and_context_window.json',
        method: 'GET',
        timeout: 10000
      }, (res) => {
        let d = ''
        res.on('data', (c: string) => { d += c })
        res.on('end', () => resolve(d))
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
      req.end()
    })

    const allModels = JSON.parse(body)
    const pricing: Record<string, ModelPricing> = {}

    for (const [key, val] of Object.entries(allModels) as [string, any][]) {
      if (!key.includes('claude')) continue
      const modelName = key.replace(/^[^/]+\//, '') // strip provider prefix
      if (pricing[modelName]) continue

      const inp = (val.input_cost_per_token || 0) * 1_000_000
      const out = (val.output_cost_per_token || 0) * 1_000_000
      const cr = (val.cache_read_input_token_cost || 0) * 1_000_000
      const cw = (val.cache_creation_input_token_cost || 0) * 1_000_000

      if (inp > 0 || out > 0) {
        pricing[modelName] = {
          input: inp, output: out,
          cacheRead: cr || inp * 0.1,
          cacheWrite: cw || inp * 1.25,
        }
      }
    }

    if (Object.keys(pricing).length > 0) {
      livePricing = pricing
      try {
        ensureConfigDir()
        fs.writeFileSync(path.join(getConfigDir(), 'model-pricing.json'), JSON.stringify(pricing, null, 2))
      } catch { /* ignore */ }
      logInfo(`[tokenomics] Fetched pricing for ${Object.keys(pricing).length} Claude models`)
    }
  } catch (err: any) {
    logInfo(`[tokenomics] Pricing fetch failed (using hardcoded): ${err?.message}`)
  }
}

function getPricing(model: string): ModelPricing {
  const sources = livePricing ? [livePricing, FALLBACK_PRICING] : [FALLBACK_PRICING]
  for (const db of sources) {
    if (db[model]) return db[model]
    for (const key of Object.keys(db)) {
      const base = key.replace(/-\d+[-\d]*$/, '')
      if (model.startsWith(base)) return db[key]
    }
  }
  return FALLBACK_PRICING['claude-sonnet-4-6']
}

function calculateCost(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  model: string
): number {
  const p = getPricing(model)
  return (
    (inputTokens * p.input +
      outputTokens * p.output +
      cacheReadTokens * p.cacheRead +
      cacheWriteTokens * p.cacheWrite) / 1_000_000
  )
}

// ── Storage ──

const TOKENOMICS_FILE = 'tokenomics.json'

function getTokenomicsPath(): string {
  return path.join(getConfigDir(), TOKENOMICS_FILE)
}

/**
 * Mutates `data.sessions` in place, setting `provider: 'claude'` on any
 * record missing it. Returns true if any record was modified.
 *
 * v1.5 migration: pre-Codex tokenomics.json contains only Claude sessions; this
 * tags them so future Codex ingestion can co-exist without ambiguity.
 */
export function backfillTokenomicsProvider(data: TokenomicsData): boolean {
  let mutated = false
  for (const session of Object.values(data.sessions)) {
    if (session.provider === undefined) {
      session.provider = 'claude'
      mutated = true
    }
  }
  return mutated
}

function loadData(): TokenomicsData {
  try {
    const filePath = getTokenomicsPath()
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TokenomicsData
      // v1.5: back-fill provider on legacy records. Persist back only if mutated.
      if (backfillTokenomicsProvider(data)) {
        try {
          saveData(data)
          logInfo('[tokenomics] Back-filled provider=claude on legacy session records')
        } catch (err) {
          logError(`[tokenomics] Failed to persist provider back-fill: ${err}`)
        }
      }
      return data
    }
  } catch (err) {
    logError(`[tokenomics] Failed to load data: ${err}`)
  }
  return {
    sessions: {},
    dailyAggregates: {},
    lastSyncTimestamp: 0,
    totalCostUsd: 0,
    seedComplete: false,
  }
}

function saveData(data: TokenomicsData): void {
  try {
    ensureConfigDir()
    const filePath = getTokenomicsPath()
    const tmpPath = filePath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8')
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(tmpPath, filePath)
      try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    } else {
      fs.renameSync(tmpPath, filePath)
    }
  } catch (err) {
    logError(`[tokenomics] Failed to save data: ${err}`)
  }
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null

function saveDataDebounced(data: TokenomicsData): void {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => saveData(data), 5000)
}

// ── JSONL Parsing ──
// NOTE (P0.8): findJsonlFiles + parseTranscriptFile lifted into
// providers/claude/telemetry.ts as findClaudeHistoryFiles +
// parseClaudeTranscriptFile (verbatim). This module imports them above and
// continues to drive ingestion/aggregation.

// ── Aggregation Helpers ──

function updateSessionRecord(
  data: TokenomicsData,
  sessionId: string,
  projectDir: string,
  messages: ClaudeParsedMessage[]
): void {
  if (messages.length === 0) return

  let record = data.sessions[sessionId]
  if (!record) {
    record = {
      sessionId,
      projectDir,
      model: messages[0].model,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalCostUsd: 0,
      messageCount: 0,
      firstTimestamp: messages[0].timestamp,
      lastTimestamp: messages[0].timestamp,
    }
    data.sessions[sessionId] = record
  }

  // Reset counts for re-parse (idempotent)
  record.totalInputTokens = 0
  record.totalOutputTokens = 0
  record.totalCacheReadTokens = 0
  record.totalCacheWriteTokens = 0
  record.totalCostUsd = 0
  record.messageCount = 0
  record.firstTimestamp = messages[0].timestamp
  record.lastTimestamp = messages[messages.length - 1].timestamp
  record.model = messages[0].model

  for (const msg of messages) {
    record.totalInputTokens += msg.inputTokens
    record.totalOutputTokens += msg.outputTokens
    record.totalCacheReadTokens += msg.cacheReadTokens
    record.totalCacheWriteTokens += msg.cacheWriteTokens
    record.messageCount++
  }

  record.totalCostUsd = calculateCost(
    record.totalInputTokens,
    record.totalOutputTokens,
    record.totalCacheReadTokens,
    record.totalCacheWriteTokens,
    record.model
  )

  // Calculate burn rate
  if (record.firstTimestamp && record.lastTimestamp) {
    const start = new Date(record.firstTimestamp).getTime()
    const end = new Date(record.lastTimestamp).getTime()
    record.durationMs = Math.max(end - start, 0)
    if (record.durationMs > 60000) { // Only calculate if session lasted > 1 minute
      const totalTokens = record.totalInputTokens + record.totalOutputTokens +
        record.totalCacheReadTokens + record.totalCacheWriteTokens
      record.costPerHour = (record.totalCostUsd / record.durationMs) * 3_600_000
      record.tokensPerMinute = (totalTokens / record.durationMs) * 60_000
    }
  }
}

function rebuildAggregates(data: TokenomicsData): void {
  data.dailyAggregates = {}
  data.totalCostUsd = 0

  for (const record of Object.values(data.sessions)) {
    data.totalCostUsd += record.totalCostUsd

    // Group by date of firstTimestamp
    const date = record.firstTimestamp
      ? record.firstTimestamp.slice(0, 10) // 'YYYY-MM-DD'
      : 'unknown'

    let agg = data.dailyAggregates[date]
    if (!agg) {
      agg = {
        date,
        totalCostUsd: 0,
        totalTokens: 0,
        messageCount: 0,
        sessionCount: 0,
        totalDurationMs: 0,
        avgCostPerHour: 0,
        byModel: {},
      }
      data.dailyAggregates[date] = agg
    }

    agg.totalCostUsd += record.totalCostUsd
    agg.totalTokens += record.totalInputTokens + record.totalOutputTokens +
      record.totalCacheReadTokens + record.totalCacheWriteTokens
    agg.messageCount += record.messageCount
    agg.sessionCount++
    agg.totalDurationMs += record.durationMs || 0

    const modelKey = record.model || 'unknown'
    if (!agg.byModel[modelKey]) {
      agg.byModel[modelKey] = { costUsd: 0, inputTokens: 0, outputTokens: 0 }
    }
    agg.byModel[modelKey].costUsd += record.totalCostUsd
    agg.byModel[modelKey].inputTokens += record.totalInputTokens + record.totalCacheReadTokens + record.totalCacheWriteTokens
    agg.byModel[modelKey].outputTokens += record.totalOutputTokens
  }

  // Calculate daily average burn rates
  for (const agg of Object.values(data.dailyAggregates)) {
    if (agg.totalDurationMs > 60000) {
      agg.avgCostPerHour = (agg.totalCostUsd / agg.totalDurationMs) * 3_600_000
    }
  }
}

// ── Seeding ──

let isSeeding = false

export async function seedTokenomics(
  getWindow: () => BrowserWindow | null
): Promise<TokenomicsData> {
  if (isSeeding) return loadData()
  isSeeding = true

  logInfo('[tokenomics] Starting seed...')
  const data = loadData()

  try {
    const files = findClaudeHistoryFiles()
    // Sort by mtime descending (newest first)
    files.sort((a, b) => b.mtime - a.mtime)

    const totalFiles = files.length
    let processedFiles = 0

    const sendProgress = (phase: TokenomicsSyncProgress['phase']) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.TOKENOMICS_PROGRESS, {
          phase,
          totalFiles,
          processedFiles,
        } satisfies TokenomicsSyncProgress)
      }
    }

    sendProgress('scanning')

    // Process in batches of 50
    const BATCH_SIZE = 50
    const CHECKPOINT_INTERVAL = 200

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE)

      for (const file of batch) {
        const sessionId = path.basename(file.path, '.jsonl')
        const messages = await parseClaudeTranscriptFile(file.path)
        if (messages.length > 0) {
          updateSessionRecord(data, sessionId, file.projectDir, messages)
        }
        processedFiles++
      }

      sendProgress('processing')

      // Checkpoint save
      if (processedFiles % CHECKPOINT_INTERVAL < BATCH_SIZE) {
        rebuildAggregates(data)
        saveData(data)
      }

      // Yield to event loop
      await new Promise(resolve => setImmediate(resolve))
    }

    data.seedComplete = true
    data.lastSyncTimestamp = Date.now()
    rebuildAggregates(data)
    saveData(data)

    sendProgress('complete')
    logInfo(`[tokenomics] Seed complete: ${processedFiles} files, $${data.totalCostUsd.toFixed(2)} total`)
  } catch (err) {
    logError(`[tokenomics] Seed failed: ${err}`)
  } finally {
    isSeeding = false
  }

  return data
}

// ── Incremental Sync ──

export async function syncTokenomics(
  getWindow: () => BrowserWindow | null
): Promise<TokenomicsData> {
  if (isSeeding) return loadData()

  const data = loadData()
  if (!data.seedComplete) return data

  const files = findClaudeHistoryFiles()
  // Only files modified since last sync
  const newFiles = files.filter(f => f.mtime > data.lastSyncTimestamp)
  if (newFiles.length === 0) return data

  logInfo(`[tokenomics] Syncing ${newFiles.length} new/modified files...`)

  for (const file of newFiles) {
    const sessionId = path.basename(file.path, '.jsonl')
    const messages = await parseClaudeTranscriptFile(file.path)
    if (messages.length > 0) {
      updateSessionRecord(data, sessionId, file.projectDir, messages)
    }
  }

  data.lastSyncTimestamp = Date.now()
  rebuildAggregates(data)
  saveData(data)

  logInfo(`[tokenomics] Sync complete: ${newFiles.length} files processed`)
  return data
}

// ── Real-time Statusline Updates ──

let cachedData: TokenomicsData | null = null

export function handleStatuslineUpdate(statuslineData: {
  sessionId: string
  model?: string
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
  rateLimitCurrent?: number
  rateLimitWeekly?: number
  rateLimitExtra?: { enabled: boolean; utilization: number; usedUsd: number; limitUsd: number }
}): void {
  if (!statuslineData.costUsd && !statuslineData.inputTokens && !statuslineData.rateLimitExtra && !statuslineData.rateLimitCurrent) return

  if (!cachedData) {
    cachedData = loadData()
  }
  if (!cachedData.seedComplete) return

  // Capture extra spend data from the API
  if (statuslineData.rateLimitExtra?.enabled) {
    cachedData.extraSpend = {
      enabled: true,
      usedUsd: statuslineData.rateLimitExtra.usedUsd,
      limitUsd: statuslineData.rateLimitExtra.limitUsd,
      lastUpdated: Date.now(),
    }
  }

  // Capture rate limit percentages
  if (statuslineData.rateLimitCurrent != null || statuslineData.rateLimitWeekly != null) {
    cachedData.rateLimits = {
      fiveHour: statuslineData.rateLimitCurrent ?? cachedData.rateLimits?.fiveHour,
      sevenDay: statuslineData.rateLimitWeekly ?? cachedData.rateLimits?.sevenDay,
      lastUpdated: Date.now(),
    }
  }

  const { sessionId, model, costUsd } = statuslineData
  if (!sessionId) {
    // Extra spend only update — no session data
    if (statuslineData.rateLimitExtra) saveDataDebounced(cachedData)
    return
  }
  let record = cachedData.sessions[sessionId]

  if (!record) {
    record = {
      sessionId,
      projectDir: '',
      model: model || 'unknown',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalCostUsd: 0,
      messageCount: 0,
      firstTimestamp: new Date().toISOString(),
      lastTimestamp: new Date().toISOString(),
    }
    cachedData.sessions[sessionId] = record
  }

  // Statusline provides cumulative costUsd per session
  if (costUsd != null) {
    record.totalCostUsd = costUsd
  }
  if (model) record.model = model
  record.lastTimestamp = new Date().toISOString()

  rebuildAggregates(cachedData)
  saveDataDebounced(cachedData)
}

// ── Public API ──

export function getTokenomicsData(): TokenomicsData {
  return loadData()
}
