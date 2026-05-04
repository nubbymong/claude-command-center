import type { LegacyVersion, SshConfig, StatuslineData } from '../../shared/types'

export interface SpawnOptions {
  sessionId: string
  /** Provider discriminator. Defaults to 'claude' if unspecified. */
  provider?: 'claude' | 'codex'
  cwd?: string
  cols?: number
  rows?: number
  ssh?: SshConfig
  shellOnly?: boolean
  elevated?: boolean
  configLabel?: string
  useResumePicker?: boolean
  legacyVersion?: LegacyVersion
  agentsConfig?: Array<{ name: string; description: string; prompt: string; model?: string; tools?: string[] }>
  effortLevel?: 'low' | 'medium' | 'high'
  disableAutoMemory?: boolean
  model?: string
  // Codex-specific (only present when provider === 'codex')
  codexOptions?: {
    model?: string
    reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    permissionsPreset: 'read-only' | 'standard' | 'auto' | 'unrestricted'
  }
}

export interface TelemetrySource {
  /** Stop the underlying watcher / tail when the session ends. */
  stop(): void
}

export interface HistorySession {
  provider: 'claude' | 'codex'
  sessionId: string
  cwd: string
  label: string
  model?: string
  lastModified: number
}

export interface SessionProvider {
  readonly id: 'claude' | 'codex'
  readonly displayName: string

  resolveBinary(legacyVersion?: LegacyVersion): { cmd: string; args: string[] } | null
  buildSpawnCommand(opts: SpawnOptions): { cmd: string; args: string[]; env: Record<string, string> }
  detectUiRunning(data: string): boolean

  /** Optional — Claude only; Codex has no statusline shim. */
  deployStatuslineScript?(resourcesDir: string): Promise<void>
  /**
   * Subscribe to live telemetry for a spawned session.
   *
   * opts.cwd            -- resolved working directory passed to the PTY spawn.
   *                        Used by the Codex provider to claim the correct rollout file.
   * opts.spawnTimestamp -- Date.now() captured immediately before pty.spawn().
   *                        Used as the lower-bound for the rollout claim window (ts >= spawn - 5s).
   * Claude provider ignores opts (its telemetry comes from the statusline file watcher).
   */
  ingestSessionTelemetry(
    sessionId: string,
    opts: { cwd: string; spawnTimestamp: number },
    onUpdate: (data: StatuslineData) => void,
  ): TelemetrySource
  listHistorySessions(): Promise<HistorySession[]>
  resumeCommand(sessionId: string): { cmd: string; args: string[] }
  configureMcpServer(serverConfig: { name: string; url: string }): Promise<void>
}

export interface SshCapableProvider extends SessionProvider {
  getSshSettingsPath(sessionId: string): string
  /** Returns shell command to write settings + statusline shim on remote. */
  configureRemoteSettings(sessionId: string, remotePath: string, hooksConfig: { port: number; secret: string } | null): string
}

/** Type guard. */
export function isSshCapable(p: SessionProvider): p is SshCapableProvider {
  return 'getSshSettingsPath' in p && 'configureRemoteSettings' in p
}
