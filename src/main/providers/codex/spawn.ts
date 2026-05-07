import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { sandboxFor, approvalFor } from './permissions'
import { getResourcesDirectory } from '../../ipc/setup-handlers'
import type { SpawnOptions } from '../types'

export function resolveCodexBinary(): { cmd: string; args: string[] } | null {
  if (os.platform() !== 'win32') {
    try {
      execSync('which codex', { encoding: 'utf-8', timeout: 5000 })
      return { cmd: 'codex', args: [] }
    } catch { return null }
  }
  for (const bin of ['codex.exe', 'codex.cmd']) {
    try {
      const cmdPath = execSync(`where ${bin}`, { encoding: 'utf-8', timeout: 5000 })
        .trim().split(/\r?\n/)[0].trim()
      if (cmdPath) return { cmd: cmdPath, args: [] }
    } catch { /* try next */ }
  }
  return null
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

  // CLAUDE_MULTI_SESSION_ID identifies the spawning CCC session for downstream
  // hook / telemetry correlation in P3+. Codex CLI itself does not read it; it
  // is transparent pass-through and survives any future env-var hygiene pass.
  const env: Record<string, string> = {
    ...process.env,
    CLAUDE_MULTI_SESSION_ID: opts.sessionId,
  } as Record<string, string>

  // Picker swap: when useResumePicker is true and the picker script is
  // deployed, run `node <picker> <flags>` instead of `codex <flags>`. The
  // picker forwards the flags to `codex resume <uuid>` on pick or to fresh
  // `codex` on N. When the picker is not yet deployed (first-boot race on
  // slow disks / SMB resourcesDir), fall back to direct codex spawn so the
  // session still launches. Mirrors Claude's pty-manager.ts:890-895 fallback.
  if (opts.useResumePicker) {
    const pickerScript = getCodexResumePickerPath()
    if (pickerScript) {
      // node has a `.exe` on Windows -- no shim, no cmd.exe wrap needed.
      return { cmd: 'node', args: [pickerScript, ...flags], env }
    }
    // Fallthrough: picker missing, spawn codex directly.
  }

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved.cmd)) {
    // node-pty / ConPTY cannot directly invoke .cmd shims; route through cmd.exe.
    return { cmd: 'cmd.exe', args: ['/c', resolved.cmd, ...flags], env }
  }
  return { cmd: resolved.cmd, args: flags, env }
}
