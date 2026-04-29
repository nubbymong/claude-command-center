import type { SshCapableProvider, SpawnOptions, TelemetrySource, HistorySession } from '../types'
import type { LegacyVersion, StatuslineData } from '../../../shared/types'
import { resolveClaudeBinary, buildClaudeLocalSpawn } from './spawn'
import { getRemoteSetupCommand, remoteSessionSettingsPath } from './ssh-shim'
import { detectClaudeUi } from './ui-detection'

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
  ingestSessionTelemetry(_sid: string, _cb: (d: StatuslineData) => void): TelemetrySource {
    throw new Error('not yet lifted -- see P0.8')
  }
  async listHistorySessions(): Promise<HistorySession[]> { throw new Error('not yet lifted -- see P0.9') }
  resumeCommand(_sid: string): { cmd: string; args: string[] } { throw new Error('not yet lifted -- see P0.9') }
  async configureMcpServer(_cfg: { name: string; url: string }): Promise<void> {
    throw new Error('not yet lifted -- see P0.9')
  }
  getSshSettingsPath(sessionId: string): string {
    return remoteSessionSettingsPath(sessionId)
  }
  configureRemoteSettings(sessionId: string, remotePath: string, hooksConfig: { port: number; secret: string } | null): string {
    return getRemoteSetupCommand(sessionId, remotePath, hooksConfig)
  }
  async deployStatuslineScript(_dir: string): Promise<void> {
    throw new Error('not yet lifted -- see P0.8')
  }
}
