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
  /** Secret arguments of command BUTTONS visible to this config, keyed by
   *  command id, resolved from the keychain in main (collectCommandSecrets).
   *  Each becomes CCC_CMD_SECRET_<id> in a SHELL spawn's env; the button types
   *  the reference. Never accepted from the renderer. */
  commandSecrets?: Record<string, string>
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
  /** Ask Conductor: the user's question, launched as Claude's opening prompt so
   *  nobody has to paste it. Like {@link terminalSecret} this goes in the spawn
   *  ENV and the command text carries only a REFERENCE to the variable, so the
   *  question is never parsed by the shell — free text is exactly the input that
   *  would otherwise need quoting to be safe — and never reaches PSReadLine's
   *  on-disk history. Absent = no opening prompt (an ordinary session). */
  askPrompt?: string
  // Codex-specific (only present when provider === 'codex')
  codexOptions?: CodexOptions
  /** Codex (WP2, plan A10): the session's prepared launch in its account's
   *  realm -- the executable setup proved, the realm's environment (ambient
   *  credentials removed, CODEX_HOME set) and its transcript folder. A Codex
   *  spawn runs only from this. Set by main; never from the renderer. */
  realmLaunch?: { executable: string; env: Record<string, string>; sessionsDir: string }
  /** Codex (P3.5): the conversation to resume exactly -- the persisted
   *  target of a restored tab, or the tab's kept conversation on a Restart.
   *  The builder resumes it only when its rollout is in `realmLaunch`'s own
   *  sessions folder, and checks the id again before it reaches argv. Set by
   *  main only. */
  resume?: { uuid: string; cwd: string }
  /** Codex (P3.10): the session's hook file (its gateway port and token),
   *  when the Hooks gateway is on and listening. The builder gives the launch
   *  the app's hooks only with it, and only when their command can be given
   *  safely (`hooksInstalled`). Set by main only. */
  codexHooks?: { hookFile: string }
  /** Codex (P3.10 round 1, V2): the conversations other open tabs of this
   *  app are on (ids), for the resume picker to say one is open in another
   *  tab. Set by main only. */
  codexOpenElsewhere?: string[]
}

/** What a provider's builder hands the PTY. `commandLine` (Windows only): the
 *  whole command line after `cmd`, which node-pty passes VERBATIM -- a cmd.exe
 *  `/s /c` line cannot survive its per-argument quoting; when present it is
 *  what runs, and `args` is empty. Codex (P3.5): `cwd`, the directory the CLI
 *  must start in when it is not the configured one (an exact resume in the
 *  conversation's own directory); `resumeId`, the conversation it resumes;
 *  `pickFile`, where the resume picker records the conversation it opens. */
export interface ProviderSpawnCommand {
  cmd: string
  args: string[]
  env: Record<string, string>
  commandLine?: string
  cwd?: string
  resumeId?: string
  /** No rollout of the resumed conversation records the directory the
   *  session kept: it starts in the configured one (the caller says so). */
  resumeCwdMismatch?: boolean
  /** The rollout of the resumed conversation the builder chose. */
  resumePath?: string
  pickFile?: string
  /** The folder made for the pick file, as it was when made (fix round 3). */
  pickFolder?: PickFolderIdentity
  /** Codex (P3.10): the launch carries the app's hooks (see
   *  SpawnOptions.codexHooks). */
  hooksInstalled?: boolean
}

/** A folder as it was when made: what it is (its device and file id, exact)
 *  and where it really is (every link on the way resolved). The resume
 *  picker's pick folder is used only while it is still this folder. */
export interface PickFolderIdentity {
  id: string
  real: string
}

/** How a session's telemetry finds its transcript. `cwd`: the resolved
 *  working directory the PTY runs in, which Codex uses to claim a new
 *  rollout. `spawnTimestamp`: Date.now() captured immediately before
 *  pty.spawn(), the lower bound of that claim (ts >= spawn - 5s).
 *  `sessionsDir`: where the session's realm writes its transcripts (Codex).
 *  Codex (P3.5): `resumeId`, the conversation the launch resumes (claimed
 *  wherever it is); `pickFile`, where the resume picker records its pick;
 *  `onClaim`, told which conversation the session is on once claimed.
 *  Claude ignores all of it (its telemetry is the statusline file watcher). */
export interface TelemetryOptions {
  cwd: string
  spawnTimestamp: number
  sessionsDir?: string
  resumeId?: string
  /** The rollout the launch chose for `resumeId`: claimed without a walk
   *  when it is still that conversation's, in this realm. */
  resumePath?: string
  pickFile?: string
  /** The pick file's folder as it was made: no pick is read, and nothing
   *  there removed, unless it is still that folder. */
  pickFolder?: PickFolderIdentity
  /** `certain` (P3.6): false when the rollout could have been another
   *  launch's (two new sessions in one folder, P3.5's recorded limit).
   *  `exact` (P3.10): the conversation is known, not inferred: a resume by
   *  id, the one a picker named, or the one the session's own hook reported
   *  (`fromHook`). */
  onClaim?: (claim: { id: string; cwd: string; certain: boolean; exact?: boolean; fromHook?: boolean }) => void
  /** Told when a claim is let go (the picker decided again after it). */
  onRelease?: () => void
  /** P3.6 (VM finding V2): the conversation the session is on when another
   *  session holds its rollout (a resume by id, the one a picker named, or
   *  since P3.10 the one its own hook reported): the session's all the
   *  same. Since P3.10 its rollout is read here too, as the holder reads it,
   *  so both tabs show its figures. onRelease is told when a later decision
   *  takes it back. */
  onShared?: (conversation: { id: string; cwd: string; exact?: boolean; fromHook?: boolean }) => void
  /** P3.12: the rollout claimed (path, the realm's sessions folder, exact,
   *  shared), told with each onClaim or onShared, and null when a claim is
   *  let go. Checked by the watcher; nothing else supplies it. */
  onRollout?: (rollout: { path: string; sessionsDir: string; exact: boolean; shared: boolean; identity?: string } | null) => void
}

export interface TelemetrySource {
  /** Stop the underlying watcher / tail when the session ends. */
  stop(): void
  /** Codex (P3.10): the session's own hook reported `rolloutPath` as the
   *  conversation it is on. The watcher claims it exactly (it checks the
   *  path is a rollout inside its realm whose session_meta names the id in
   *  its name), or confirms the claim it has. Returns what it claimed, or
   *  null when the path is refused. */
  noteExactRollout?(rolloutPath: string): { id: string; cwd: string } | null
  /** Codex (P3.10): another session's hook proved `rolloutPath` is that
   *  session's conversation: a claim of it here that was only inferred is
   *  let go, and claiming goes on. True when a claim was let go. */
  refuteInferredClaim?(rolloutPath: string): boolean
  /** Codex (P3.12 round 1): a claim made beside another session's whose
   *  holder has let it go is this session's now: reported again. */
  recheckShared?(): boolean
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
  /** See ProviderSpawnCommand. */
  buildSpawnCommand(opts: SpawnOptions): ProviderSpawnCommand
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
  /** Optional -- Codex (P3.10 round 4): prepare the folders the provider's
   *  hooks use, asynchronously and only while the provider is on, with
   *  `secureFolders`, the app's owner-only folder rule (given folders in
   *  order, it makes each this user's alone and reads it back; on Windows in
   *  one PowerShell call). A no-op while they are still ready. Resolves
   *  whether the launch's hook folder is ready. Never throws. */
  prepareHookFolders?(resourcesDir: string, secureFolders: (dirs: readonly string[]) => Promise<ReadonlyArray<{ dir: string; ok: boolean; detail?: string }>>): Promise<boolean>
  /** Optional -- Codex (P3.10): write the session's hook file (the Hooks
   *  gateway's port, the session id and its token, owner-only, in a folder
   *  made for the launch inside the app's own data folder, P3.10 round 1)
   *  for `buildSpawnCommand`'s `codexHooks`, with the way to remove it when
   *  the session's resources go. Null when it cannot be written, or when the
   *  hook folders were not prepared (round 4, prepareHookFolders): nothing is
   *  started here. */
  prepareSessionHooks?(sessionId: string, port: number, secret: string): { hookFile: string; dispose(): void } | null
  /** Subscribe to live telemetry for a spawned session (see TelemetryOptions). */
  ingestSessionTelemetry(
    sessionId: string,
    opts: TelemetryOptions,
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
   *  writes an empty remote mcpServers (no built-in tools).
   *  `nonce` (#242 finding F1 (b)): host-generated per-session random token
   *  (randomId(), src/shared/id.ts) baked into the `setup ok` sentinel this
   *  command's script emits -- required, not optional, so a caller cannot
   *  silently regress to the pre-nonce sentinel shape. */
  configureRemoteSettings(
    sessionId: string,
    remotePath: string,
    hooksConfig: { port: number; secret: string } | null,
    opts: { includeStatusLine?: boolean; includeConductorMcp?: boolean; remoteMcpPort?: number } | undefined,
    nonce: string,
  ): string
}

/** Type guard. */
export function isSshCapable(p: SessionProvider): p is SshCapableProvider {
  return 'getSshSettingsPath' in p && 'getSshMcpConfigPath' in p && 'configureRemoteSettings' in p
}
