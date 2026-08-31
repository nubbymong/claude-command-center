import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { removeHooks } from './session-hooks-writer'

// Non-greedy before `.json` so `settings-foo.json.bak` does not match.
const SID_FROM_FILENAME = /^settings-([^.]+)\.json$/

/**
 * Scan ~/.claude/settings-*.json and remove hook entries from any file
 * that is not in the active session set. Called at gateway startup so
 * a crashed previous run can't leave stale hook entries pointing at our
 * (possibly new) port.
 *
 * Returns the number of files cleaned.
 */
export function cleanupStaleHookEntries(activeSessionIds: ReadonlySet<string>): number {
  const dir = path.join(os.homedir(), '.claude')
  if (!fs.existsSync(dir)) return 0
  const files = fs.readdirSync(dir)
  let cleaned = 0
  for (const name of files) {
    const m = SID_FROM_FILENAME.exec(name)
    if (!m) continue
    const sid = m[1]
    if (activeSessionIds.has(sid)) continue
    const full = path.join(dir, name)
    try {
      const raw = fs.readFileSync(full, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (!parsed.hooks) continue
      const s = JSON.stringify(parsed.hooks)
      if (!s.includes('/hook/')) continue
      removeHooks({ settingsPath: full })
      cleaned++
    } catch {
      /* skip unreadable / malformed */
    }
  }
  return cleaned
}

// Non-greedy before the extension so `mcp-foo.json.bak` does not match.
//
// Both token-bearing per-session sidecars are swept by one pass: the MCP config
// (`?token=` in its server URL) and the status-URL file (ADR-009 token custody
// — the same secret, moved off the statusLine command line and into a 0600
// file). A crash that leaves one behind leaves the other behind for the same
// reason, and neither should outlive its session.
const MCP_SID_FROM_FILENAME = /^mcp-([^.]+)\.json$/
const STATUS_URL_SID_FROM_FILENAME = /^ccc-status-([^.]+)\.url$/

/**
 * Sweep leaked per-session ~/.claude/mcp-<sid>.json and ccc-status-<sid>.url
 * sidecars. These are removed on normal session dispose
 * (removeLocalSessionMcpConfig / removeLocalSessionStatusUrl) but a crash leaves
 * them behind. Deletes any whose sid is not in the active set. Returns the count.
 */
export function cleanupStaleMcpConfigs(activeSessionIds: ReadonlySet<string>): number {
  const dir = path.join(os.homedir(), '.claude')
  if (!fs.existsSync(dir)) return 0
  const files = fs.readdirSync(dir)
  let cleaned = 0
  for (const name of files) {
    const m = MCP_SID_FROM_FILENAME.exec(name) ?? STATUS_URL_SID_FROM_FILENAME.exec(name)
    if (!m) continue
    if (activeSessionIds.has(m[1])) continue
    try {
      fs.unlinkSync(path.join(dir, name))
      cleaned++
    } catch {
      /* skip unreadable / already-gone */
    }
  }
  return cleaned
}
