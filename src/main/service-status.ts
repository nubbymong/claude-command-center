/**
 * Service status poller — fetches Claude Code component status from Anthropic's
 * public Statuspage API every 5 minutes and pushes updates to the renderer.
 */
import * as https from 'https'
import { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { logInfo, logError } from './debug-logger'

const STATUS_URL = 'https://status.anthropic.com/api/v2/components.json'
const COMPONENT_ID = 'yyzkbfz2thpt' // Claude Code
const POLL_INTERVAL = 5 * 60 * 1000 // 5 minutes
const REQUEST_TIMEOUT = 8000

interface StatusResult {
  status: string
  description: string
}

function fetchStatus(): Promise<StatusResult | null> {
  return new Promise((resolve) => {
    const req = https.get(STATUS_URL, { timeout: REQUEST_TIMEOUT }, (res) => {
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk })
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const component = json.components?.find(
            (c: { id: string }) => c.id === COMPONENT_ID
          )
          if (!component) {
            resolve(null)
            return
          }
          resolve({
            status: component.status,
            description: component.name || 'Claude Code',
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
    const result = await fetchStatus()
    if (result) {
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.SERVICE_STATUS, result)
      }
    }
  }

  logInfo('[service-status] Starting poller (5 min interval)')
  poll() // fetch immediately
  timer = setInterval(poll, POLL_INTERVAL)
}

export function stopServiceStatusPoller(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
