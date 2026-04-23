import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Path to the local-session settings file. Mirrors the SSH remote layout
 * (~/.claude/settings-<sid>.json) so boot-cleanup can purge stale entries
 * from one place regardless of session type.
 */
export function getLocalSessionSettingsPath(sessionId: string): string {
  const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(os.homedir(), '.claude', `settings-${safeSid}.json`)
}

/**
 * Seed a local-session settings file with the user's statusLine and
 * mcpServers entries copied from the shared ~/.claude/settings.json.
 *
 * Claude Code's `--settings` flag OVERRIDES user settings entirely, so
 * any config we want Claude to see (statusline, MCP vision, hooks) must
 * be present in the per-session file. Hooks get layered on afterwards by
 * `injectHooks` — this function only handles the statusline + MCP copy
 * so the hooks injection can reuse the same read-merge-write path.
 */
export function writeLocalSessionSettings(sessionId: string): string {
  const claudeDir = path.join(os.homedir(), '.claude')
  try {
    fs.mkdirSync(claudeDir, { recursive: true })
  } catch {
    /* directory may already exist */
  }

  let shared: Record<string, unknown> = {}
  try {
    const sharedPath = path.join(claudeDir, 'settings.json')
    const raw = fs.readFileSync(sharedPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') {
      shared = parsed as Record<string, unknown>
    }
  } catch {
    /* shared settings may not exist yet (fresh install) — start empty */
  }

  const sesCfg: Record<string, unknown> = {}
  if (shared.statusLine) sesCfg.statusLine = shared.statusLine
  if (shared.mcpServers) sesCfg.mcpServers = shared.mcpServers

  const sesPath = getLocalSessionSettingsPath(sessionId)
  // Atomic write — tmp + rename so a crash mid-write can't leave the
  // per-session file truncated. Claude Code re-reads settings on /reload,
  // so rename-over-just-released-handle is fine in practice.
  const tmp = `${sesPath}.tmp.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(sesCfg, null, 2), 'utf-8')
  try {
    fs.renameSync(tmp, sesPath)
  } catch {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    fs.writeFileSync(sesPath, JSON.stringify(sesCfg, null, 2), 'utf-8')
  }
  return sesPath
}

export function removeLocalSessionSettings(sessionId: string): void {
  try {
    fs.unlinkSync(getLocalSessionSettingsPath(sessionId))
  } catch {
    /* file may already be gone or never written (hooks off) */
  }
}
