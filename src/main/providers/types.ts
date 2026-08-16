import type { CodexOptions, LegacyVersion, ProviderId, SshConfig, StatuslineData } from '../../shared/types'

export interface SpawnOptions {
  sessionId: string
  /** Provider discriminator. Defaults to 'claude' if unspecified. */
  provider?: ProviderId
  cwd?: string
  cols?: number
  rows?: number
  ssh?: SshConfig
  shellOnly?: boolean
  elevated?: boolean
  /** Terminal-only secret argument, resolved from the OS keychain in main. Placed
   *  in the spawn ENV (never interpolated into the command text) so it cannot land
   *  in the shell's on-disk history. See buildSpawnCommand + the shell-only write. */
  terminalSecret?: string
  configLabel?: string
  useResumePicker?: boolean
  legacyVersion?: LegacyVersion
  agentsConfig?: Array<{ name: string; description: string; prompt: string; model?: string; tools?: string[] }>
  // Widened to string — the IPC schema's charset guard is the real contract.
  effortLevel?: string
  disableAutoMemory?: boolean
  model?: string
  /** v1.5.32: when true (or undefined = default), sets CLAUDE_CODE_DISABLE_MOUSE=1
   *  in the spawn env so xterm owns the mouse (classic selection, right-click
   *  copy/paste). When false, CC's mouse mode is preserved. Applies to shell-only
   *  sessions too: the var is inert for the shell itself but governs any `claude`
   *  the user starts by hand (the re-auth flow does exactly that), so exempting
   *  them left that claude in mouse mode where right-click pasted — and at a
   *  shell prompt executed — the clipboard. */
  classicTerminalCopyPaste?: boolean
  /** v2.0: CC >= 2.1.195 renders question options as CLICKABLE targets, which
   *  misfire inside xterm.js. False (or undefined = CCC default) stamps
   *  CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1 so answers stay keyboard-driven (wheel
   *  scroll unaffected). True preserves CC's clickable prompts. */
  clickableQuestions?: boolean
  /** v2.0.0-beta.3: a stray Ctrl+B (or /bg) detaches the session into a Claude
   *  Code background agent and strands the conversation (a beta tester hit this
   *  twice in two days). Absent or true stamps CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
   *  so no keystroke can background a session; false restores CC's background feature. */
  disableBackgroundTasks?: boolean
  /** Host (CCC) effective light/dark scheme, stamped into COLORFGBG so Claude
   *  Code's startup theme auto-detection matches the terminal. Resolved by the
   *  caller from AppSettings.theme + the OS preference. Absent = no COLORFGBG. */
  hostColorScheme?: 'light' | 'dark'
  // Codex-specific (only present when provider === 'codex')
  codexOptions?: CodexOptions
}

export interface TelemetrySource {
  /** Stop the underlying watcher / tail when the session ends. */
  stop(): void
}

export interface HistorySession {
  provider: ProviderId
  sessionId: string
  cwd: string
  label: string
  model?: string
  lastModified: number
}

export interface SessionProvider {
  readonly id: ProviderId
  readonly displayName: string

  resolveBinary(legacyVersion?: LegacyVersion): { cmd: string; args: string[] } | null
  buildSpawnCommand(opts: SpawnOptions): { cmd: string; args: string[]; env: Record<string, string> }
  detectUiRunning(data: string): boolean

  /** Optional -- Claude only; Codex has no statusline shim. */
  deployStatuslineScript?(resourcesDir: string): Promise<void>
  /**
   * Optional -- copy the provider's resume-picker script into
   * `<resourcesDir>/scripts/`. Both providers implement this in P4. The
   * Claude version copies `scripts/resume-picker.js`; the Codex version
   * copies `scripts/codex-resume-picker.js`.
   */
  deployResumePickerScript?(resourcesDir: string): Promise<void>
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
  /**
   * Path to the per-session MCP config file on the remote, passed via
   * `claude --mcp-config <path>`. Mirrors getSshSettingsPath but for the
   * canonical mcpServers registry (since Claude CLI ignores mcpServers in
   * --settings files).
   */
  getSshMcpConfigPath(sessionId: string): string
  /** Returns shell command to write settings + statusline shim on remote.
   *  opts mirror the renderer master switches (absent = on):
   *  includeStatusLine=false omits the statusLine stanza; includeConductorMcp=false
   *  writes an empty remote mcpServers (no built-in tools). */
  configureRemoteSettings(
    sessionId: string,
    remotePath: string,
    hooksConfig: { port: number; secret: string } | null,
    opts?: { includeStatusLine?: boolean; includeConductorMcp?: boolean },
  ): string
}

/** Type guard. */
export function isSshCapable(p: SessionProvider): p is SshCapableProvider {
  return 'getSshSettingsPath' in p && 'getSshMcpConfigPath' in p && 'configureRemoteSettings' in p
}
