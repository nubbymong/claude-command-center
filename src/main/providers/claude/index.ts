import type { SshCapableProvider, SpawnOptions, TelemetrySource, HistorySession } from '../types'
import type { LegacyVersion, StatuslineData } from '../../../shared/types'
import { resolveClaudeBinary, buildClaudeLocalSpawn } from './spawn'
import { getRemoteSetupCommand, remoteSessionSettingsPath } from './ssh-shim'
import { detectClaudeUi } from './ui-detection'
import { deployClaudeStatuslineScript } from './statusline'
import { watchClaudeStatuslineFile, listClaudeResumableSessions } from './telemetry'

export class ClaudeProvider implements SshCapableProvider {
  readonly id = 'claude' as const
  readonly displayName = 'Claude Code'

  resolveBinary(legacyVersion?: LegacyVersion): { cmd: string; args: string[] } | null {
    return resolveClaudeBinary(legacyVersion)
  }

  // Filled in subsequent tasks (P0.5, P0.6, P0.8)
  buildSpawnCommand(opts: SpawnOptions): { cmd: string; args: string[]; env: Record<string, string> } {
    if (opts.ssh) throw new Error('SSH spawn handled by configureRemoteSettings -- see P0.5')
    return buildClaudeLocalSpawn(opts)
  }
  detectUiRunning(data: string): boolean {
    return detectClaudeUi(data, true)  // post-spawn convenience: assume claudeSent
  }
  ingestSessionTelemetry(sessionId: string, onUpdate: (data: StatuslineData) => void): TelemetrySource {
    return watchClaudeStatuslineFile(sessionId, onUpdate)
  }
  async listHistorySessions(): Promise<HistorySession[]> {
    return listClaudeResumableSessions()
  }
  resumeCommand(sessionId: string): { cmd: string; args: string[] } {
    const { cmd } = resolveClaudeBinary()
    return { cmd, args: ['--resume', sessionId] }
  }
  async configureMcpServer(_cfg: { name: string; url: string }): Promise<void> {
    // MCP injection currently flows through vision-manager.startConductorMcpServer,
    // which calls injectMcpSettings internally at boot time. This method exists for
    // future provider parity (e.g. Codex MCP injection) but has no active callers yet.
  }
  getSshSettingsPath(sessionId: string): string {
    return remoteSessionSettingsPath(sessionId)
  }
  configureRemoteSettings(sessionId: string, remotePath: string, hooksConfig: { port: number; secret: string } | null): string {
    return getRemoteSetupCommand(sessionId, remotePath, hooksConfig)
  }
  async deployStatuslineScript(resourcesDir: string): Promise<void> {
    return deployClaudeStatuslineScript(resourcesDir)
  }
}
