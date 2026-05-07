/**
 * Statusline Watcher (generic dispatcher)
 *
 * After the P0.7 lift this module is provider-agnostic plumbing:
 *
 * 1. The Claude statusline bridge script (deployed by
 *    providers/claude/statusline.ts → deployClaudeStatuslineScript) writes
 *    one JSON file per session to <resourcesDir>/status/<sessionId>.json.
 * 2. startStatuslineWatcher() runs an fs.watch + poll-fallback over that
 *    directory and on each change:
 *      a. sends `statusline:update` to the renderer
 *      b. feeds tokenomics-manager
 *      c. fans out to per-session subscribers registered via the Claude
 *         provider's ingestSessionTelemetry()
 *
 * SSH sessions can't write status files locally, so a remote shim emits OSC
 * sentinels through the PTY stream (see pty-manager.ts:extractSshOscSentinels).
 * Those parsed payloads are dispatched here via dispatchSSHStatuslineUpdate(),
 * which uses the same fan-out pipeline.
 *
 * Provider-specific deploy/configure logic lives in providers/claude/statusline.ts.
 * The legacy deployStatuslineScript() / configureClaudeSettings() symbols are
 * re-exported below for backward compatibility, but new code should go through
 * the provider: getProvider('claude').deployStatuslineScript?.(resourcesDir).
 */
import { BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

import { getResourcesDirectory } from './ipc/setup-handlers'
import { handleStatuslineUpdate } from './tokenomics-manager'
import { notifyClaudeTelemetry } from './providers/claude/telemetry'

// Re-export from shared types for backward compatibility
export type { StatuslineData } from '../shared/types'
import type { StatuslineData } from '../shared/types'

// Backwards-compatible re-exports of the lifted Claude-specific helpers.
// New callers should use getProvider('claude').deployStatuslineScript?.(...).
export { deployClaudeStatuslineScript as deployStatuslineScript, configureClaudeSettings } from './providers/claude/statusline'

// Lazy-initialized: can't call getResourcesDirectory() at module load time
let STATUS_DIR: string | null = null
function getStatusDir(): string {
  if (!STATUS_DIR) {
    STATUS_DIR = path.join(getResourcesDirectory(), 'status')
  }
  return STATUS_DIR
}

// SSH statusline dispatch — receives parsed status data from pty-manager's
// OSC sentinel parser and feeds it through the same pipeline as the file watcher.
let sshDispatchWindow: (() => BrowserWindow | null) | null = null

/**
 * Common fan-out for any parsed StatuslineData payload — used by both the
 * file watcher and the SSH OSC sentinel dispatch path. Sends to the renderer,
 * tokenomics, and per-session telemetry subscribers.
 */
function fanOutStatusline(data: StatuslineData, getWindow: (() => BrowserWindow | null) | null): void {
  if (getWindow) {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('statusline:update', data)
    }
  }
  handleStatuslineUpdate(data)
  notifyClaudeTelemetry(data)
}

/**
 * Dispatch a parsed SSH statusline payload to the renderer + tokenomics.
 * Called from pty-manager when an OSC sentinel is extracted from an SSH PTY stream.
 */
export function dispatchSSHStatuslineUpdate(json: string): void {
  if (!sshDispatchWindow) return
  try {
    const data: StatuslineData = JSON.parse(json)
    fanOutStatusline(data, sshDispatchWindow)
  } catch { /* ignore malformed sentinel payloads */ }
}

/**
 * Watch the status directory for updates and send to the renderer.
 * Uses fs.watch for instant local notifications, plus a polling fallback
 * for remote/SMB writes that don't trigger ReadDirectoryChangesW on Windows.
 */
export function startStatuslineWatcher(getWindow: () => BrowserWindow | null): () => void {
  // Register the same window getter for SSH dispatch so OSC sentinels feed the renderer
  sshDispatchWindow = getWindow

  const statusDir = getStatusDir()
  if (!fs.existsSync(statusDir)) {
    fs.mkdirSync(statusDir, { recursive: true })
  }

  // Track last-seen mtime per file to avoid redundant sends
  const lastMtime = new Map<string, number>()

  function processFile(filename: string): void {
    const win = getWindow()
    if (!win || win.isDestroyed()) return

    const filePath = path.join(statusDir, filename)
    try {
      const stat = fs.statSync(filePath)
      const mtime = stat.mtimeMs
      if (lastMtime.get(filename) === mtime) return
      lastMtime.set(filename, mtime)

      const content = fs.readFileSync(filePath, 'utf-8')
      const data: StatuslineData = JSON.parse(content)
      fanOutStatusline(data, getWindow)
    } catch { /* ignore read errors during writes */ }
  }

  // fs.watch: instant for local writes
  const watcher = fs.watch(statusDir, (_eventType, filename) => {
    if (!filename || !filename.endsWith('.json')) return
    processFile(filename)
  })

  // Polling fallback: catches remote/SMB writes that fs.watch misses
  const POLL_INTERVAL = 3000
  const pollTimer = setInterval(() => {
    try {
      const files = fs.readdirSync(statusDir).filter(f => f.endsWith('.json'))
      for (const file of files) {
        processFile(file)
      }
    } catch { /* ignore */ }
  }, POLL_INTERVAL)

  return () => {
    watcher.close()
    clearInterval(pollTimer)
  }
}

/**
 * Clean up status files for a given session.
 */
export function cleanupStatusFile(sessionId: string): void {
  const filePath = path.join(getStatusDir(), `${sessionId}.json`)
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch { /* ignore */ }
}
