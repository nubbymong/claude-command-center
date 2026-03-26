/**
 * Tokenomics Manager — scans JSONL transcripts, aggregates token usage and cost.
 * Stores persistent data in CONFIG/tokenomics.json.
 */

import { BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import { getConfigDir, ensureConfigDir } from './config-manager'
import { logInfo, logError } from './debug-logger'
import type { TokenomicsData, TokenomicsSessionRecord, TokenomicsDailyAggregate, TokenomicsSyncProgress } from '../shared/types'
import { IPC } from '../shared/ipc-channels'

// ── Model Pricing (per 1M tokens) ──

interface ModelPricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 },
}

function getPricing(model: string): ModelPricing {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model]
  // Prefix matching for future versions
  for (const key of Object.keys(MODEL_PRICING)) {
    const base = key.replace(/-\d+-\d+$/, '')
    if (model.startsWith(base)) return MODEL_PRICING[key]
  }
  // Default to sonnet pricing for unknown models
  return MODEL_PRICING['claude-sonnet-4-6']
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

function loadData(): TokenomicsData {
  try {
    const filePath = getTokenomicsPath()
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
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

interface ParsedMessage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  timestamp: string
  sessionId: string
}

async function parseTranscriptFile(filePath: string): Promise<ParsedMessage[]> {
  const messages: ParsedMessage[] = []
  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    for await (const line of rl) {
      // Quick string check before JSON.parse
      if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) continue

      try {
        const entry = JSON.parse(line)
        if (entry.type !== 'assistant') continue

        const usage = entry.message?.usage
        if (!usage) continue

        const model = entry.message?.model || 'unknown'
        messages.push({
          model,
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheReadTokens: usage.cache_read_input_tokens || 0,
          cacheWriteTokens: usage.cache_creation_input_tokens || 0,
          timestamp: entry.timestamp || '',
          sessionId: entry.sessionId || '',
        })
      } catch { /* skip malformed lines */ }
    }
  } catch (err) {
    // File read error — skip silently
  }
  return messages
}

// ── Aggregation Helpers ──

function updateSessionRecord(
  data: TokenomicsData,
  sessionId: string,
  projectDir: string,
  messages: ParsedMessage[]
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
        byModel: {},
      }
      data.dailyAggregates[date] = agg
    }

    agg.totalCostUsd += record.totalCostUsd
    agg.totalTokens += record.totalInputTokens + record.totalOutputTokens +
      record.totalCacheReadTokens + record.totalCacheWriteTokens
    agg.messageCount += record.messageCount
    agg.sessionCount++

    const modelKey = record.model || 'unknown'
    if (!agg.byModel[modelKey]) {
      agg.byModel[modelKey] = { costUsd: 0, inputTokens: 0, outputTokens: 0 }
    }
    agg.byModel[modelKey].costUsd += record.totalCostUsd
    agg.byModel[modelKey].inputTokens += record.totalInputTokens + record.totalCacheReadTokens + record.totalCacheWriteTokens
    agg.byModel[modelKey].outputTokens += record.totalOutputTokens
  }
}

// ── JSONL File Discovery ──

function findJsonlFiles(): Array<{ path: string; mtime: number; projectDir: string }> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects')
  const files: Array<{ path: string; mtime: number; projectDir: string }> = []

  try {
    if (!fs.existsSync(claudeDir)) return files

    const projects = fs.readdirSync(claudeDir)
    for (const project of projects) {
      const projectPath = path.join(claudeDir, project)
      try {
        const stat = fs.statSync(projectPath)
        if (!stat.isDirectory()) continue

        const entries = fs.readdirSync(projectPath)
        for (const entry of entries) {
          if (!entry.endsWith('.jsonl')) continue
          const filePath = path.join(projectPath, entry)
          try {
            const fstat = fs.statSync(filePath)
            files.push({
              path: filePath,
              mtime: fstat.mtimeMs,
              projectDir: project,
            })
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    logError(`[tokenomics] Failed to enumerate JSONL files: ${err}`)
  }

  return files
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
    const files = findJsonlFiles()
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
        const messages = await parseTranscriptFile(file.path)
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

  const files = findJsonlFiles()
  // Only files modified since last sync
  const newFiles = files.filter(f => f.mtime > data.lastSyncTimestamp)
  if (newFiles.length === 0) return data

  logInfo(`[tokenomics] Syncing ${newFiles.length} new/modified files...`)

  for (const file of newFiles) {
    const sessionId = path.basename(file.path, '.jsonl')
    const messages = await parseTranscriptFile(file.path)
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
