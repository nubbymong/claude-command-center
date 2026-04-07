/**
 * Service status poller — fetches multiple Claude component statuses from
 * Anthropic's public Statuspage API every 5 minutes and pushes a structured
 * payload to the renderer for the title bar status display.
 *
 * Tracks: Claude Code (the CLI/IDE product), claude.ai (web app), and the
 * Claude API (api.anthropic.com — both code and web depend on it).
 */
import * as https from 'https'
import { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { logInfo } from './debug-logger'

const STATUS_URL = 'https://status.claude.com/api/v2/components.json'
const POLL_INTERVAL = 5 * 60 * 1000 // 5 minutes
const REQUEST_TIMEOUT = 8000

// Component IDs from https://status.claude.com/api/v2/components.json
const COMPONENT_CLAUDE_CODE = 'yyzkbfz2thpt'
const COMPONENT_CLAUDE_AI = 'rwppv331jlwc'
const COMPONENT_API = 'k8w3r06qmzrp'

export interface ServiceComponentStatus {
  /** Anthropic component ID */
  id: string
  /** Display name for the title bar (short) */
  label: string
  /** "operational" | "degraded_performance" | "partial_outage" | "major_outage" | "under_maintenance" | "unknown" */
  status: string
  /** Full component name from the API */
  name: string
}

export interface ServiceStatusPayload {
  /** ISO timestamp the data was last fetched */
  fetchedAt: string
  /** Claude Code component (most relevant — what this app drives) */
  claudeCode: ServiceComponentStatus | null
  /** Claude.ai web app */
  claudeAi: ServiceComponentStatus | null
  /** Claude API — both Code and .ai depend on it */
  api: ServiceComponentStatus | null
  /** Convenience: highest-severity status across all tracked components */
  worst: string
}

const SEVERITY: Record<string, number> = {
  operational: 0,
  under_maintenance: 1,
  degraded_performance: 2,
  partial_outage: 3,
  major_outage: 4,
}

function worstStatus(...statuses: (string | undefined)[]): string {
  let max = 'operational'
  let maxRank = 0
  for (const s of statuses) {
    if (!s) continue
    const r = SEVERITY[s] ?? 0
    if (r > maxRank) {
      maxRank = r
      max = s
    }
  }
  return max
}

function fetchAllComponents(): Promise<ServiceStatusPayload | null> {
  return new Promise((resolve) => {
    const req = https.get(STATUS_URL, { timeout: REQUEST_TIMEOUT }, (res) => {
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk })
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const components: any[] = json.components || []
          const find = (id: string): ServiceComponentStatus | null => {
            const c = components.find((x) => x.id === id)
            if (!c) return null
            return { id, name: c.name, label: c.name, status: c.status }
          }
          const claudeCode = find(COMPONENT_CLAUDE_CODE)
          if (claudeCode) claudeCode.label = 'Claude Code'
          const claudeAi = find(COMPONENT_CLAUDE_AI)
          if (claudeAi) claudeAi.label = 'Claude.ai'
          const api = find(COMPONENT_API)
          if (api) api.label = 'API'

          resolve({
            fetchedAt: new Date().toISOString(),
            claudeCode,
            claudeAi,
            api,
            worst: worstStatus(claudeCode?.status, claudeAi?.status, api?.status),
          })
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

let timer: ReturnType<typeof setInterval> | null = null

export function startServiceStatusPoller(
  getWindow: () => BrowserWindow | null
): void {
  async function poll(): Promise<void> {
    const result = await fetchAllComponents()
    if (result) {
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.SERVICE_STATUS, result)
      }
    }
  }

  logInfo('[service-status] Starting poller (5 min interval, tracking Claude Code + Claude.ai + API)')
  poll() // fetch immediately
  timer = setInterval(poll, POLL_INTERVAL)
}

export function stopServiceStatusPoller(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
