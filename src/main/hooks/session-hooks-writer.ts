import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { HookEventKind } from '../../shared/hook-types'

// Injected hook events. SubagentStart/SubagentStop bracket subagent and
// dynamic-workflow-agent execution so the status strip can pin its model +
// effort pills to the main window (see background-context.ts). PreCompact /
// StopFailure remain unused for now.
export const MVP_EVENTS: HookEventKind[] = [
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'SessionStart',
  'Stop',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
]

export interface InjectArgs {
  sessionId: string
  settingsPath: string
  port: number
  secret: string
  /** The directory Claude launches in. Used to resolve the user/project hooks
   *  Claude would otherwise apply, so they can be MERGED with CCC's hooks
   *  instead of shadowed by the --settings override (#137). */
  cwd: string
  /** Test-only override for the user-settings home dir. Defaults to
   *  os.homedir(); production callers omit it. */
  homeDir?: string
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

/**
 * Read the `hooks` object out of a settings JSON file, keeping only
 * array-valued events. FAIL-SAFE: missing/unparseable/odd-shaped → {}.
 */
function readHooksFrom(file: string): Record<string, unknown[]> {
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    const hooks = parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).hooks
      : undefined
    if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
      const out: Record<string, unknown[]> = {}
      for (const [event, arr] of Object.entries(hooks as Record<string, unknown>)) {
        if (Array.isArray(arr)) out[event] = arr.slice()
      }
      return out
    }
  } catch { /* missing / unparseable — contributes nothing */ }
  return {}
}

/**
 * Walk up from `cwd` to the nearest ancestor holding a `.claude/settings.json`
 * or `.claude/settings.local.json` — Claude's project-settings root. Returns
 * that `.claude` dir, or null. FAIL-SAFE.
 *
 * The walk STOPS at the home directory: `~/.claude` is the USER source (read
 * separately), never a "project", and we must not escape home into other users
 * or system dirs. `homeCeiling` defaults to os.homedir() (overridable for tests).
 */
function findProjectClaudeDir(cwd: string, homeCeiling: string = os.homedir()): string | null {
  try {
    const ceiling = path.resolve(homeCeiling)
    let dir = path.resolve(cwd)
    for (;;) {
      if (dir === ceiling) return null // reached home — user source covers it
      const claudeDir = path.join(dir, '.claude')
      if (fs.existsSync(path.join(claudeDir, 'settings.json')) ||
          fs.existsSync(path.join(claudeDir, 'settings.local.json'))) {
        return claudeDir
      }
      const parent = path.dirname(dir)
      if (parent === dir) return null // reached filesystem root
      dir = parent
    }
  } catch {
    return null
  }
}

/** Concatenate per-event hook arrays across maps (source order preserved),
 *  then drop byte-identical duplicate entries within each event — a guard so
 *  a hook can never double-fire if Claude's own resolution ever also merges. */
function concatHookMaps(...maps: Record<string, unknown[]>[]): Record<string, unknown[]> {
  const merged: Record<string, unknown[]> = {}
  for (const m of maps) {
    for (const [event, arr] of Object.entries(m)) {
      if (Array.isArray(arr)) merged[event] = (merged[event] || []).concat(arr)
    }
  }
  const out: Record<string, unknown[]> = {}
  for (const [event, arr] of Object.entries(merged)) {
    const seen = new Set<string>()
    const kept: unknown[] = []
    for (const entry of arr) {
      let key: string
      try { key = JSON.stringify(entry) } catch { key = String(entry) }
      if (seen.has(key)) continue
      seen.add(key)
      kept.push(entry)
    }
    out[event] = kept
  }
  return out
}

/**
 * Reproduce the hooks Claude Code would apply for a session launched in `cwd`,
 * so CCC can MERGE them with its own gateway hooks rather than shadow them.
 * Claude treats a --settings `hooks` key as an override (it is NOT a
 * concatenating array), so without this a project/user hook — e.g. a project
 * `carp-hook.ps1` — never fires in a CCC-launched session (#137).
 *
 * Sources, low→high precedence (all concatenated; all run):
 *   user     ~/.claude/settings.json
 *   project  <root>/.claude/settings.json
 *   local    <root>/.claude/settings.local.json
 * Enterprise "managed" settings outrank --settings regardless, so folding them
 * in would not change Claude's resolution — left to Claude. FAIL-SAFE.
 */
export function resolveInheritedHooks(cwd: string, homeDir: string = os.homedir()): Record<string, unknown[]> {
  const userClaude = path.join(homeDir, '.claude')
  const maps: Record<string, unknown[]>[] = [readHooksFrom(path.join(userClaude, 'settings.json'))]
  const projectClaude = findProjectClaudeDir(cwd, homeDir)
  // Guard: when cwd's project root IS the home dir, don't re-read user settings.
  if (projectClaude && path.resolve(projectClaude) !== path.resolve(userClaude)) {
    maps.push(readHooksFrom(path.join(projectClaude, 'settings.json')))
    maps.push(readHooksFrom(path.join(projectClaude, 'settings.local.json')))
  }
  return concatHookMaps(...maps)
}

// Rewrites the entire `hooks` key on every inject with the MERGE of the hooks
// Claude would inherit for this cwd (user + project + project-local) and CCC's
// own gateway hooks — so CCC sessions behave like a plain `claude` in the same
// folder, plus the CCC hooks (#137). Per-session settings files are ours to
// manage; a user hand-editing hooks in one is overwritten on next spawn.
export function injectHooks(a: InjectArgs): void {
  const settings = readJsonSafe(a.settingsPath)
  const inherited = resolveInheritedHooks(a.cwd, a.homeDir)
  const ccc = buildHooksBlock(a.sessionId, a.port, a.secret)
  // CCC hooks last so inherited hooks keep their natural order; CCC's http
  // entries are unique (per-session URL) so dedupe never drops them.
  settings.hooks = concatHookMaps(inherited, ccc)
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
