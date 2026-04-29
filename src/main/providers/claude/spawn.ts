import * as os from 'os'
import { execSync } from 'child_process'
import { resolveVersionBinary } from '../../legacy-version-manager'
import { logInfo } from '../../debug-logger'
import type { LegacyVersion } from '../../../shared/types'
import type { SpawnOptions } from '../types'

export function resolveClaudeBinary(legacyVersion?: LegacyVersion): { cmd: string; args: string[] } {
  if (legacyVersion?.enabled && legacyVersion.version) {
    const legacyBin = resolveVersionBinary(legacyVersion.version)
    if (legacyBin) {
      logInfo(`[claude-provider] Using legacy Claude CLI v${legacyVersion.version}: ${legacyBin}`)
      return { cmd: legacyBin, args: [] }
    }
    logInfo(`[claude-provider] Legacy v${legacyVersion.version} binary not found, falling back to system claude`)
  }

  if (os.platform() !== 'win32') return { cmd: 'claude', args: [] }

  for (const bin of ['claude.exe', 'claude.cmd']) {
    try {
      const cmdPath = execSync(`where ${bin}`, { encoding: 'utf-8', timeout: 5000 })
        .trim().split('\n')[0].trim()
      return { cmd: cmdPath, args: [] }
    } catch { /* try next */ }
  }
  return { cmd: 'claude', args: [] }
}

/**
 * Build the bare shell + env for a local Claude (or shell-only) PTY spawn.
 *
 * Returns ONLY the shell binary, args, and env. The post-spawn shell-write
 * (cd + claude command + flags) is constructed and dispatched by pty-manager
 * because it depends on additional state (resume picker path, agents flag,
 * extra CLI flags) that is pty-manager's responsibility.
 */
export function buildClaudeLocalSpawn(opts: SpawnOptions): { cmd: string; args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = { ...process.env, CLAUDE_MULTI_SESSION_ID: opts.sessionId } as Record<string, string>
  if (opts.disableAutoMemory) env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'

  const shell = os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')

  if (opts.shellOnly && opts.elevated) {
    const cmd = os.platform() === 'win32' ? 'gsudo' : 'sudo'
    return { cmd, args: [shell], env }
  }

  if (opts.shellOnly) {
    return { cmd: shell, args: [], env }
  }

  // Claude session: spawn shell only; pty-manager writes the cd+claude command into the shell post-spawn.
  return { cmd: shell, args: [], env }
}
