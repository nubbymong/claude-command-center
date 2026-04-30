import * as os from 'os'
import { execSync } from 'child_process'
import { sandboxFor, approvalFor } from './permissions'
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

export function buildCodexSpawn(opts: SpawnOptions): { cmd: string; args: string[]; env: Record<string, string> } {
  const co = opts.codexOptions
  if (!co) throw new Error('codexOptions required for Codex spawn')

  const resolved = resolveCodexBinary()
  if (!resolved) {
    throw new Error('Codex CLI not found on PATH. Install with `npm i -g @openai/codex`.')
  }

  const args: string[] = []
  // Codex resume picker is a P4 feature -- requires a session UUID, not a bare 'resume' subcommand.
  // Until P4 wires the cross-provider history list, useResumePicker is a no-op for Codex.
  if (co.model) args.push('-m', co.model)
  if (co.reasoningEffort && co.reasoningEffort !== 'none') {
    args.push('-c', `model_reasoning_effort=${co.reasoningEffort}`)
  }
  args.push('--sandbox', sandboxFor(co.permissionsPreset))
  args.push('--ask-for-approval', approvalFor(co.permissionsPreset))

  // CLAUDE_MULTI_SESSION_ID identifies the spawning CCC session for downstream
  // hook / telemetry correlation in P3+. Codex CLI itself does not read it; it
  // is transparent pass-through and survives any future env-var hygiene pass.
  const env: Record<string, string> = {
    ...process.env,
    CLAUDE_MULTI_SESSION_ID: opts.sessionId,
  } as Record<string, string>

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved.cmd)) {
    // node-pty / ConPTY cannot directly invoke .cmd shims; route through cmd.exe.
    return { cmd: 'cmd.exe', args: ['/c', resolved.cmd, ...args], env }
  }
  return { cmd: resolved.cmd, args, env }
}
