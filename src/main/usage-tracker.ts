import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

interface UsageEntry {
  timestamp: string
  model?: string
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
  cacheRead?: number
  cacheWrite?: number
  sessionId?: string
  projectPath?: string
}

interface UsageSummary {
  totalCost: number
  totalInputTokens: number
  totalOutputTokens: number
  byModel: Record<string, { cost: number; inputTokens: number; outputTokens: number }>
  byHour: { hour: string; cost: number }[]
}

const MODEL_COSTS: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-20250514': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-haiku-3-20250414': { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
}

function getClaudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects')
}

function parseJSONLFile(filepath: string): UsageEntry[] {
  const entries: UsageEntry[] = []
  try {
    const content = readFileSync(filepath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const obj = JSON.parse(trimmed)
        if (obj.type === 'result' || obj.costUsd || obj.cost_usd) {
          entries.push({
            timestamp: obj.timestamp || new Date().toISOString(),
            model: obj.model,
            costUsd: obj.costUsd ?? obj.cost_usd ?? 0,
            inputTokens: obj.inputTokens ?? obj.input_tokens ?? 0,
            outputTokens: obj.outputTokens ?? obj.output_tokens ?? 0,
            cacheRead: obj.cacheReadTokens ?? obj.cache_read_input_tokens ?? 0,
            cacheWrite: obj.cacheWriteTokens ?? obj.cache_creation_input_tokens ?? 0,
            sessionId: obj.sessionId ?? obj.session_id,
            projectPath: obj.projectPath
          })
        }
      } catch { /* skip invalid lines */ }
    }
  } catch { /* file read error */ }
  return entries
}

export function getUsageSummary(hours: number = 5): UsageSummary {
  const projectsDir = getClaudeProjectsDir()
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)
  const allEntries: UsageEntry[] = []

  if (existsSync(projectsDir)) {
    scanDirectory(projectsDir, allEntries, cutoff)
  }

  const summary: UsageSummary = {
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    byModel: {},
    byHour: []
  }

  const hourBuckets: Record<string, number> = {}

  for (const entry of allEntries) {
    const cost = entry.costUsd ?? 0
    summary.totalCost += cost
    summary.totalInputTokens += entry.inputTokens ?? 0
    summary.totalOutputTokens += entry.outputTokens ?? 0

    if (entry.model) {
      if (!summary.byModel[entry.model]) {
        summary.byModel[entry.model] = { cost: 0, inputTokens: 0, outputTokens: 0 }
      }
      summary.byModel[entry.model].cost += cost
      summary.byModel[entry.model].inputTokens += entry.inputTokens ?? 0
      summary.byModel[entry.model].outputTokens += entry.outputTokens ?? 0
    }

    const hourKey = entry.timestamp?.slice(0, 13) || 'unknown'
    hourBuckets[hourKey] = (hourBuckets[hourKey] || 0) + cost
  }

  summary.byHour = Object.entries(hourBuckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, cost]) => ({ hour, cost }))

  return summary
}

function scanDirectory(dir: string, entries: UsageEntry[], cutoff: Date): void {
  try {
    const items = readdirSync(dir)
    for (const item of items) {
      const fullPath = join(dir, item)
      try {
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          scanDirectory(fullPath, entries, cutoff)
        } else if (item.endsWith('.jsonl') && stat.mtime >= cutoff) {
          entries.push(...parseJSONLFile(fullPath))
        }
      } catch { /* skip inaccessible */ }
    }
  } catch { /* skip inaccessible dirs */ }
}

export function getSessionUsage(sessionId: string): { cost: number; inputTokens: number; outputTokens: number } {
  const projectsDir = getClaudeProjectsDir()
  const entries: UsageEntry[] = []

  if (existsSync(projectsDir)) {
    scanDirectory(projectsDir, entries, new Date(0))
  }

  const sessionEntries = entries.filter(e => e.sessionId === sessionId)
  return {
    cost: sessionEntries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0),
    inputTokens: sessionEntries.reduce((sum, e) => sum + (e.inputTokens ?? 0), 0),
    outputTokens: sessionEntries.reduce((sum, e) => sum + (e.outputTokens ?? 0), 0)
  }
}
