import fs from 'node:fs'
import path from 'node:path'
import type { HookEventKind } from '../../shared/hook-types'

// MVP injects these five. Adding the remaining four (PreCompact,
// SubagentStart, SubagentStop, StopFailure) is a one-line change once
// the renderer consumes them.
export const MVP_EVENTS: HookEventKind[] = [
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'SessionStart',
  'Stop',
]

export interface InjectArgs {
  sessionId: string
  settingsPath: string
  port: number
  secret: string
}

export interface RemoveArgs {
  settingsPath: string
}

/**
 * Build the `hooks` block for a Claude Code settings file. Returns the
 * object literal shape that goes under the `hooks` key of settings.json —
 * one array entry per MVP event kind, each pointing at the session's
 * gateway endpoint with the per-session secret in an X-CCC-Hook-Token
 * header.
 *
 * Exported so the SSH path can embed the same shape in its remote setup
 * script literal without re-implementing the endpoint/headers format.
 */
export function buildHooksBlock(
  sessionId: string,
  port: number,
  secret: string,
): Record<string, unknown[]> {
  const endpoint = `http://localhost:${port}/hook/${sessionId}`
  const headers = { 'X-CCC-Hook-Token': secret }
  const hooks: Record<string, unknown[]> = {}
  // Claude Code's hooks schema requires a matcher-wrapped entry:
  //   hooks.<Event> = [{ matcher: "<tool-name-regex-or-empty>", hooks: [<entry>] }]
  // Empty matcher matches every tool for the event. A flat
  // `[{ type, url, headers }]` was the earlier schema and is rejected by
  // newer Claude Code builds with "hooks: Expected array, but received undefined".
  for (const kind of MVP_EVENTS) {
    hooks[kind] = [
      {
        matcher: '',
        hooks: [{ type: 'http', url: endpoint, headers }],
      },
    ]
  }
  return hooks
}

// NOTE: this writer is NOT diff-aware. It rewrites the entire `hooks` key
// on every inject. Per-session settings files are ours to manage — if a
// user hand-edits hooks in one of them their edits are lost on next spawn.
export function injectHooks(a: InjectArgs): void {
  const settings = readJsonSafe(a.settingsPath)
  settings.hooks = buildHooksBlock(a.sessionId, a.port, a.secret)
  writeJson(a.settingsPath, settings)
}

export function removeHooks(a: RemoveArgs): void {
  if (!fs.existsSync(a.settingsPath)) return
  const settings = readJsonSafe(a.settingsPath)
  if (!('hooks' in settings)) return
  delete settings.hooks
  writeJson(a.settingsPath, settings)
}

function readJsonSafe(file: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(file)) return {}
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

// Write via a per-pid temp file + rename so a crash mid-write cannot leave
// the settings file truncated (which Claude Code would then fail to parse
// on /reload). renameSync within the same directory is atomic on every
// platform Node supports, and the destination-held-open EPERM the prior
// comment warned about was a theoretical concern from the SSH setup script
// — in practice Claude Code only opens settings to read, releases the
// handle, and uses /reload to refresh, so rename-over a just-released
// handle is safe. Using a `.tmp.<pid>` suffix keeps concurrent callers
// (different Electron processes in dev) from colliding on the tmp path.
function writeJson(file: string, data: unknown): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    // Best-effort cleanup; fall back to direct write so caller isn't
    // blocked by a Windows rename quirk. This matches the prior
    // behaviour; only the success path gets the atomicity upgrade.
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
    void err
  }
}
