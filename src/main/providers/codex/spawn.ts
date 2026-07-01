import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { sandboxFor, approvalFor } from './permissions'
import { getResourcesDirectory } from '../../ipc/setup-handlers'
import type { SpawnOptions } from '../types'
import { getConductorMcpPort, getConductorMcpSecret } from '../../conductor-mcp-server'
import { readConfig } from '../../config-manager'

export function resolveCodexBinary(): { cmd: string; args: string[] } | null {
  if (os.platform() !== 'win32') {
    try {
      execSync('which codex', { encoding: 'utf-8', timeout: 5000 })
      return { cmd: 'codex', args: [] }
    } catch { return null }
  }
  for (const bin of ['codex.exe', 'codex.cmd']) {
    try {
      // stdio pipe on stderr suppresses the "INFO: Could not find files for
      // the given pattern(s)." that `where` writes to stderr on a miss --
      // default execSync inherits stderr, so a normal "try next binary" probe
      // ends up polluting the parent process's stderr / terminal.
      const cmdPath = execSync(`where ${bin}`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim().split(/\r?\n/)[0].trim()
      if (cmdPath) return { cmd: cmdPath, args: [] }
    } catch { /* try next */ }
  }
  return null
}

/**
 * Resolve a full path to node.exe on Windows. Bare 'node' fails under
 * node-pty / ConPTY because Windows PTY spawn does NOT consult PATH the
 * same way child_process.spawn does -- it throws synchronously with
 * "File not found:" before any onExit/onData handler can fire (verified
 * empirically against the pinned node-pty version).
 *
 * On non-Windows, bare 'node' works fine -- PTY uses execvp which does
 * PATH lookup.
 *
 * Cached on first successful resolve. Returns bare 'node' as a fallback
 * if `where node` fails (rare; if node isn't on PATH the user has bigger
 * problems and our error message via the spawn failure is fine).
 */
let cachedNodeExe: string | null = null
export function resolveNodeExe(): string {
  if (os.platform() !== 'win32') return 'node'
  if (cachedNodeExe) return cachedNodeExe
  try {
    const resolved = execSync('where node', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split(/\r?\n/)[0].trim()
    if (resolved) {
      cachedNodeExe = resolved
      return resolved
    }
  } catch { /* fall through */ }
  return 'node'
}

/** Test-only: reset the node.exe resolution cache. */
export function __resetNodeExeCache(): void {
  cachedNodeExe = null
}

/**
 * Resolve the deployed `codex-resume-picker.js` path. Returns null when the
 * script is not deployed yet (first-boot race). Mirrors `getResumePickerPath`
 * in `src/main/pty-manager.ts`. Uses static import for `getResourcesDirectory`
 * matching the existing project convention (see `claude/statusline.ts`); unit
 * tests intercept via `vi.mock('../../ipc/setup-handlers', ...)`.
 */
export function getCodexResumePickerPath(): string | null {
  let resDir: string
  try {
    resDir = getResourcesDirectory()
  } catch { return null }
  if (!resDir) return null
  try {
    const scriptPath = path.join(resDir, 'scripts', 'codex-resume-picker.js')
    if (fs.existsSync(scriptPath)) return scriptPath
  } catch { /* ignore */ }
  return null
}

export function buildCodexSpawn(opts: SpawnOptions): { cmd: string; args: string[]; env: Record<string, string> } {
  const co = opts.codexOptions
  if (!co) throw new Error('codexOptions required for Codex spawn')

  const resolved = resolveCodexBinary()
  if (!resolved) {
    throw new Error('Codex CLI not found on PATH. Install with `npm i -g @openai/codex`.')
  }

  // Build the canonical Codex flag list once; both the picker and the direct
  // spawn paths forward the same flags.
  const flags: string[] = []
  if (co.model) flags.push('-m', co.model)
  if (co.reasoningEffort && co.reasoningEffort !== 'none') {
    flags.push('-c', `model_reasoning_effort=${co.reasoningEffort}`)
  }
  flags.push('--sandbox', sandboxFor(co.permissionsPreset))
  flags.push('--ask-for-approval', approvalFor(co.permissionsPreset))

  // U6: deliver the conductor MCP config PER-SPAWN via `-c` overrides -- nothing
  // is written to the user's global ~/.codex/config.toml, so plain `codex` outside
  // CCC never tries the dead endpoint. The token rides a bearer header via the
  // CONDUCTOR_MCP_TOKEN env var (Codex sends `Authorization: Bearer <value>`, which
  // the conductor server accepts), so the URL carries only `?source=codex` -- no
  // `&`, which keeps it intact through the cmd.exe .cmd-shim spawn path. The
  // `source=codex` marker keeps codex_review hidden from Codex (no self-review).
  // Built-in tools master (onboarding p6 / Settings): off = no conductor MCP
  // flags at all, so Codex launches without the built-in tools. Read fresh
  // per spawn; port 0 (server unbound) behaves identically.
  const conductorOn = readConfig<{ conductorToolsEnabled?: boolean }>('settings')?.conductorToolsEnabled !== false
  const mcpPort = conductorOn ? getConductorMcpPort() : 0
  if (mcpPort > 0) {
    flags.push('-c', `mcp_servers.conductor.url=http://localhost:${mcpPort}/mcp?source=codex`)
    flags.push('-c', 'mcp_servers.conductor.enabled=true')
    flags.push('-c', 'mcp_servers.conductor.bearer_token_env_var=CONDUCTOR_MCP_TOKEN')
  }

  // CLAUDE_MULTI_SESSION_ID identifies the spawning CCC session for downstream
  // hook / telemetry correlation in P3+. Codex CLI itself does not read it; it
  // is transparent pass-through and survives any future env-var hygiene pass.
  const env: Record<string, string> = {
    ...process.env,
    CLAUDE_MULTI_SESSION_ID: opts.sessionId,
  } as Record<string, string>
  // U6: bearer token for the per-spawn conductor MCP entry above.
  if (mcpPort > 0) {
    env.CONDUCTOR_MCP_TOKEN = getConductorMcpSecret()
  }

  // Picker swap: when useResumePicker is true and the picker script is
  // deployed, run `node <picker> <flags>` instead of `codex <flags>`. The
  // picker forwards the flags to `codex resume <uuid>` on pick or to fresh
  // `codex` on N. When the picker is not yet deployed (first-boot race on
  // slow disks / SMB resourcesDir), fall back to direct codex spawn so the
  // session still launches. Mirrors Claude's pty-manager.ts:890-895 fallback.
  if (opts.useResumePicker) {
    const pickerScript = getCodexResumePickerPath()
    if (pickerScript) {
      // Bare 'node' fails under node-pty/ConPTY on Windows (no PATH lookup).
      // Resolve to the full node.exe path via `where node`. See resolveNodeExe.
      return { cmd: resolveNodeExe(), args: [pickerScript, ...flags], env }
    }
    // Fallthrough: picker missing, spawn codex directly.
  }

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved.cmd)) {
    // node-pty / ConPTY cannot directly invoke .cmd shims; route through cmd.exe.
    return { cmd: 'cmd.exe', args: ['/c', resolved.cmd, ...flags], env }
  }
  return { cmd: resolved.cmd, args: flags, env }
}
