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
 * Seed a local-session settings file as a full clone of the user's
 * ~/.claude/settings.json. Claude Code's `--settings` flag may either
 * REPLACE user settings entirely or MERGE onto them — both assumptions
 * live in the tree's comments and Claude Code docs are ambiguous. Copying
 * every top-level key (not just the three CCC cares about) is safe under
 * both semantics: user-owned fields like `outputStyle`, `permissions`, or
 * future additions survive. The caller (pty-manager) overlays the fields
 * CCC must own (hooks via injectHooks, plus statusLine/mcpServers which
 * are already correct in the clone).
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

  // Clone every top-level key from shared. injectHooks will overlay the
  // `hooks` key afterwards. `statusLine` and `mcpServers` are already
  // copied verbatim, so the user's existing config is preserved exactly.
  const sesCfg: Record<string, unknown> = { ...shared }

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
