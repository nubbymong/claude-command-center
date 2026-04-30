import type { SessionProvider, SpawnOptions, TelemetrySource, HistorySession } from '../types'
import type { LegacyVersion, StatuslineData } from '../../../shared/types'
import { resolveCodexBinary, buildCodexSpawn } from './spawn'
import { detectCodexUi } from './ui-detection'

export class CodexProvider implements SessionProvider {
  readonly id = 'codex' as const
  readonly displayName = 'Codex'

  resolveBinary(_legacyVersion?: LegacyVersion): { cmd: string; args: string[] } | null {
    return resolveCodexBinary()
  }

  buildSpawnCommand(opts: SpawnOptions): { cmd: string; args: string[]; env: Record<string, string> } {
    return buildCodexSpawn(opts)
  }

  detectUiRunning(data: string): boolean {
    return detectCodexUi(data)
  }

  ingestSessionTelemetry(_sid: string, _cb: (d: StatuslineData) => void): TelemetrySource {
    // P3 wires real telemetry; P2 ships a no-op so callers can register without crashing
    return { stop: () => {} }
  }

  async listHistorySessions(): Promise<HistorySession[]> {
    // P4 implements resume picker
    return []
  }

  resumeCommand(sessionId: string): { cmd: string; args: string[] } {
    const r = resolveCodexBinary()
    if (!r) throw new Error('Codex CLI not found on PATH')
    return { cmd: r.cmd, args: ['resume', sessionId] }
  }

  async configureMcpServer(_cfg: { name: string; url: string }): Promise<void> {
    // P3 wires conductor-vision MCP injection into ~/.codex/config.toml
  }
}
