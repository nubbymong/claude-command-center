import type { CodexOptions, LegacyVersion, ProviderId, SshConfig, SshRuntime, StatuslineData, SubmitTextResult } from '../../shared/types'

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
  /** Codex (WP2 PR 4, P4.3): this launch is an Ask Conductor session in the
   *  app's help folder; the byte bound of the AGENTS.md written there
   *  (help-workspace.ts askConductorProjectDocMaxBytes). The builder passes
   *  `-c project_doc_max_bytes=<n>` and `-c project_root_markers=[]`, so
   *  Codex reads that file whole and no parent folder's joins it. Set by main
   *  only. */
  askProjectDocMaxBytes?: number
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
  /** Codex (WP2 PR 4, P4.1): the launch line as the app's log may hold it,
   *  built by the builder, which knows which values are long or private and
   *  names them by length. Absent: main logs no argument. */
  logLine?: string
  /** Codex (WP2 PR 4, P4.3): the launch carries `askPrompt` as its prompt on
   *  argv, after `--` (the direct route's fresh launch, PB4). Otherwise main
   *  holds the question and types it through the run's pane at the first
   *  ready, empty composer. */
  askPromptOnArgv?: boolean
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
  /** Whether `data` shows the provider's UI running. `commandSent`: whether
   *  the launch command has been written yet (Claude reads more of the screen
   *  as its UI once it has; absent = it has). */
  detectUiRunning(data: string, commandSent?: boolean): boolean

  /** Optional -- Claude only; Codex has no statusline shim. */
  deployStatuslineScript?(resourcesDir: string): Promise<void>
  /** Optional -- Claude only (WP2 PR 4: offered here so no module outside the
   *  package imports its statusline code). Strip the global statusLine stanza
   *  and planted script an older build left in the user's own settings; the
   *  boot heal, best-effort. */
  healGlobalStatusline?(): void
  /** Optional -- Claude only: hand one parsed statusline payload to the
   *  session's telemetry subscribers (ingestSessionTelemetry). The app's
   *  statusline dispatcher calls it for every payload. */
  deliverStatusline?(data: StatuslineData): void
  /** Optional -- Claude only: the `statusLine` value of a local session's
   *  settings file, running the bundled bridge script with the session id and
   *  the path of its status-URL file. */
  statuslineSetting?(resourcesDir: string, sessionId?: string, statusUrlFile?: string): { type: 'command'; command: string }
  /** Optional -- Claude only: the session's statusline POST URL on the
   *  conductor MCP server ('' while the server is not bound or the MCP is off;
   *  throws rather than build a URL that fails its charset guard). */
  statusPostUrl?(sessionId: string, remoteMcpPort: number | undefined, mcpPort: number, includeConductorMcp: boolean): string
  /** Optional -- Codex: remove the conductor block an older build wrote into
   *  the user's own provider config; the MCP server asks at start and stop. */
  removeLegacyMcpServerConfig?(): void
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
  /** Optional -- Codex (P4.1): the skills folder of the provider home a
   *  launch runs in when the app stages its skills there per launch (a
   *  managed account's own folder, by path), else null (this computer's own
   *  sign-in, whose copies the app keeps through its own record instead,
   *  src/main/canvas/codex-user-skills.ts). Path arithmetic only. */
  stagedSkillsDir?(home: string, resourcesDir: string): string | null
  /** Optional -- Codex (P4.1, PB9): main's own reading of each run's screen
   *  and the submit primitive that types into its composer. */
  readonly runScreen?: SessionRunScreen
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

/** WP2 PR 4, P4.1: main's own pane of a session's run (bounded, headless, fed
 *  the run's output from its first byte) and the submit primitive, the one
 *  door through which main types a text into the session's composer. Every
 *  method is keyed by the app's session id; a respawn opens a new pane. */
export interface SessionRunScreen {
  /** Open the pane for a session's new run, replacing any earlier one.
   *  `write`: one raw write into that run's process. `current`: whether that
   *  process is still the session's. `clamp`: what every chunk goes through
   *  before the pane parses it (the Watchdog's CSI clamp), with the pane's
   *  own state across chunks. */
  open(sessionId: string, opts: { cols: number; rows: number; write: (data: string) => void; current: () => boolean; clamp: (data: string, state: { residual: string }) => string }): void
  /** The run's output, as its terminal receives it. */
  feed(sessionId: string, data: string): void
  /** Keep the pane at the real pane's size. */
  resize(sessionId: string, cols: number, rows: number): void
  /** The run ended or the session went: a submission still waiting reports
   *  the session gone and types nothing more. */
  close(sessionId: string): void
  /** Whether main reads this session's screen now. */
  has(sessionId: string): boolean
  /** Type `text` into the composer and submit it, confirmed on screen, after
   *  anything already in flight for the run; waits up to `readyWaitMs` for
   *  the ready, empty composer. Never rejects. */
  submit(sessionId: string, text: string, opts: { readyWaitMs: number }): Promise<SubmitTextResult>
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
  /** configureRemoteSettings for a Windows remote (cmd.exe), same contract. */
  windowsRemoteSetupCommand(
    sessionId: string,
    opts: { includeStatusLine?: boolean; includeConductorMcp?: boolean; remoteMcpPort?: number } | undefined,
    nonce: string,
  ): string
  /** The launch line on a Windows remote, every variable set cmd.exe's way. */
  windowsLaunchCommand(input: { sessionId: string; envPrefixVars: string[]; extraFlags: string; continueFlag: string }): string
  /** The line written down a non-persistent session's own PTY at teardown
   *  that removes the per-session files it planted on the remote. */
  remoteSessionCleanupCommand(sessionId: string): string
  /** The line a persistent (tmux) session writes before its launch to point
   *  the remote statusline at the staged tmux binary. */
  tmuxBinPatchCommand(sessionId: string): string
  /** End remote: kills exactly this session's tmux session and removes its
   *  per-session files (run over its own ssh exec). */
  remoteTmuxKillCommand(sessionId: string): string
  /** End remote: the in-container kill for a container runtime, '' for none.
   *  `sudoProbeNonce`: printed in a sentinel when sudo cannot elevate. */
  containerKillCommand(sessionId: string, runtime: SshRuntime | undefined, opts?: { hasSudoPassword?: boolean; sudoProbeNonce?: string }): string
  /** End remote: whether `output` carries this End's sudo sentinel. */
  parseEndSudoSentinel(output: string, nonce: string): boolean
  /** The last line of `data`, escapes stripped, as a shell-prompt candidate;
   *  '' when it is too long to be one or is the provider's own composer. */
  lastPromptLine(data: string): string
  /** SessionProvider.detectUiRunning with `commandSent` REQUIRED on the SSH
   *  surface: before the launch command is written only the strict reading
   *  applies, so a remote shell prompt that draws the composer glyph or box
   *  characters is never read as the UI. A call that drops the argument does
   *  not compile here (WP2 PR 4 review, A1-Q1). */
  detectUiRunning(data: string, commandSent: boolean): boolean
  /** Whether the end of `data` is a bare shell prompt (the CLI has exited). */
  looksLikeShellPromptTail(data: string): boolean
}

/** Type guard. It tells the one SSH-capable provider (Claude) apart from the
 *  rest by three members only that provider has; it does not vouch for the
 *  others. Every member is enforced at compile time on the class that
 *  implements SshCapableProvider (ClaudeProvider), and a registered package's
 *  session surface is that class; test fakes that drive only the spawn branch
 *  carry these three. */
export function isSshCapable(p: SessionProvider): p is SshCapableProvider {
  return 'getSshSettingsPath' in p && 'getSshMcpConfigPath' in p && 'configureRemoteSettings' in p
}
