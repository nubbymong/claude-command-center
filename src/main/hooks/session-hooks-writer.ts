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

// NOTE: this writer is NOT diff-aware. It rewrites the entire `hooks` key
// on every inject. Per-session settings files are ours to manage — if a
// user hand-edits hooks in one of them their edits are lost on next spawn.
export function injectHooks(a: InjectArgs): void {
  const settings = readJsonSafe(a.settingsPath)
  const endpoint = `http://localhost:${a.port}/hook/${a.sessionId}`
  const headers = { 'X-CCC-Hook-Token': a.secret }
  const hooks: Record<string, unknown[]> = {}
  for (const kind of MVP_EVENTS) {
    hooks[kind] = [{ type: 'http', url: endpoint, headers }]
  }
  settings.hooks = hooks
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

// NOT atomic on win32. fs.renameSync fails with EPERM/EEXIST when the
// destination is held open by another process. Claude Code only re-reads
// settings on /reload, so a partial read during rewrite is vanishingly
// unlikely — direct writeFileSync is the right tradeoff here.
function writeJson(file: string, data: unknown): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}
