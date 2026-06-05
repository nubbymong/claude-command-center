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
import { handleStatuslineUpdate, decorateStatuslineWithColour } from './tokenomics-manager'
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
  // Copilot review on PR #31 (p9.17): decorate with accountColour HERE,
  // at the renderer-send site. The previous code decorated only inside
  // handleStatuslineUpdate (on a local copy), so the renderer received
  // the raw payload and the ContextBar never saw accountColour. Decorate
  // once and forward the enriched object to every consumer.
  const decorated = decorateStatuslineWithColour(data)
  if (getWindow) {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('statusline:update', decorated)
    }
  }
  handleStatuslineUpdate(decorated)
  notifyClaudeTelemetry(decorated)
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

  // Async so the per-tick stat + read never block the main thread. The
  // statusline bridge rewrites these files frequently (≈1-3/s per session) and
  // fs.watch fired this synchronously on every write -- a sync readFileSync +
  // JSON.parse on the hot path, multiplied by N sessions. The mtime guard stays
  // race-safe: the check+set sits in one synchronous block immediately after the
  // awaited stat (no await between), so two concurrent calls for the same file
  // can't both pass the guard -- the first sets the mtime, the second is deduped.
  async function processFile(filename: string): Promise<void> {
    const win = getWindow()
    if (!win || win.isDestroyed()) return

    const filePath = path.join(statusDir, filename)
    try {
      const mtime = (await fs.promises.stat(filePath)).mtimeMs
      if (lastMtime.get(filename) === mtime) return
      lastMtime.set(filename, mtime)

      const content = await fs.promises.readFile(filePath, 'utf-8')
      const data: StatuslineData = JSON.parse(content)
      fanOutStatusline(data, getWindow)
    } catch { /* ignore read errors during writes */ }
  }

  // fs.watch: instant for local writes (fire-and-forget; errors swallowed inside)
  const watcher = fs.watch(statusDir, (_eventType, filename) => {
    if (!filename || !filename.endsWith('.json')) return
    void processFile(filename)
  })

  // Polling fallback: catches remote/SMB writes that fs.watch misses. Local
  // writes are caught instantly by fs.watch above, so this only needs to be a
  // slow safety net -- 5s (was 3s) cuts the periodic readdir + stat fan-out.
  const POLL_INTERVAL = 5000
  const pollTimer = setInterval(() => {
    void (async () => {
      try {
        const files = (await fs.promises.readdir(statusDir)).filter(f => f.endsWith('.json'))
        await Promise.all(files.map(f => processFile(f)))
      } catch { /* ignore */ }
    })()
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
