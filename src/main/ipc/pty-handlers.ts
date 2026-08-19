import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { spawnPty, writePty, resizePty, killPty, getSshFlow, endSshRemote, SSHOptions } from '../pty-manager'
import { logUserInput, isDebugModeEnabled } from '../debug-capture'
import { logInfo } from '../debug-logger'
import { isVersionInstalled, installVersion } from '../legacy-version-manager'
import { isValidLegacyVersion } from '../../shared/legacy-version'
import { loadCredential } from '../credential-store'
import { IPC } from '../../shared/ipc-channels'
import { getPtyIntegrityMonitor } from '../services/pty-integrity-monitor'
import type { PtyIntegrityReport } from '../../shared/service-health'
import { noteSessionSpawnForCanvas } from '../canvas/canvas-session-link'

/** SSH options as received from the renderer (no passwords — only configId) */
interface RendererSSHOptions {
  host: string
  port: number
  username: string
  remotePath: string
  postCommand?: string
  /** #242 tier 5: true when this spawn respawns a session that had
   *  previously reached claude-running -- set by the renderer session
   *  store (Session.sshReachedClaudeRunning, never persisted). Forwarded
   *  verbatim into SSHOptions.reconnect; see its doc comment in
   *  pty-manager.ts for how it's consumed. */
  reconnect?: boolean
  /** SSH tmux enhancement (item 1): "Detachable" toggle. Only `false`
   *  disables the tmux-persistence ladder; undefined/true = ON. */
  detachable?: boolean
  /** SSH tmux enhancement (item 3): remote OS. 'windows' selects the Windows
   *  setup path; 'auto'/'unix'/undefined use POSIX unchanged. */
  remoteOs?: 'auto' | 'unix' | 'windows'
}

// host/username are fused into `${username}@${host}` and handed to ssh as
// argv[0]. ssh parses any argv entry beginning with `-` as an OPTION, so a
// leading dash (e.g. `-oProxyCommand=...`) is an argument-injection primitive.
// Charset-gate both here — reject a leading `-` and any whitespace — matching
// the remotePath precedent from #188; the ssh-args builder re-asserts the same
// as a sink-side backstop (#265). `[^-\s]` first char excludes a leading dash
// and whitespace; `\S*` keeps IPv6 (`[::1]`), internal `-`, and `DOMAIN\user`.
const sshFieldRe = /^[^-\s]\S*$/
const sshSchema = z.object({
  host: z.string().min(1).regex(sshFieldRe, 'host has invalid characters'),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).regex(sshFieldRe, 'username has invalid characters'),
  // Charset-gated at the IPC boundary (mirrors ssh-shim SAFE_REMOTE_PATH_RE):
  // the remote path is interpolated into the remote setup command, and the
  // shim's own assertSafeRemotePath throws from inside a setTimeout — which the
  // global handler re-throws, crashing main. Rejecting here means a bad stored
  // config fails the spawn cleanly instead of taking the process down
  // (adversarial review, #188).
  remotePath: z.string().min(1).regex(/^[~A-Za-z0-9_./-]+$/, 'remote path has invalid characters'),
  postCommand: z.string().optional(),
  reconnect: z.boolean().optional(),
  detachable: z.boolean().optional(),
  remoteOs: z.enum(['auto', 'unix', 'windows']).optional(),
}).optional()

export const spawnOptionsSchema = z.object({
  cwd: z.string().optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  ssh: sshSchema,
  shellOnly: z.boolean().optional(),
  // Terminal-only launcher: a command the USER authored, typed into their own
  // shell on their own machine — running it IS the feature, so a charset guard
  // would be the wrong control (it is not a privilege boundary being crossed).
  // Bounds are defence-in-depth against an oversized payload. The secret VALUE
  // never appears here: only `hasSecretArg` crosses the IPC seam, and main
  // resolves the value from the OS keychain (see the spawn handler).
  terminalOptions: z.object({
    command: z.string().max(4096).optional(),
    args: z.string().max(4096).optional(),
    hasSecretArg: z.boolean().optional(),
    elevated: z.boolean().optional(),
  }).optional(),
  configId: z.string().optional(),
  configLabel: z.string().max(100).optional(),
  // Ask Conductor's opening question. Bounded, NOT charset-guarded, for the same
  // reason as agentsConfig below: this is a natural-language sentence the user
  // typed, so rejecting metacharacters would break the feature for anyone who
  // writes "what's the $ cost?" while stopping no attack.
  //
  // The real control is that the value never becomes command TEXT. It is placed
  // in the spawn env as CCC_ASK_PROMPT, and the launch line carries only
  // `$env:CCC_ASK_PROMPT` / `"$CCC_ASK_PROMPT"` (askPromptRef), which both shells
  // expand to exactly one argument AFTER tokenising — so there is no parse for
  // its contents to escape from. The bound is defence in depth against an
  // oversized payload, not the injection boundary.
  askPrompt: z.string().max(8000).optional(),
  // Task 9: per-config logging opt-out (DEFAULT-TRUE; only false disables).
  loggingEnabled: z.boolean().optional(),
  useResumePicker: z.boolean().optional(),
  legacyVersion: z.object({
    enabled: z.boolean(),
    version: z.string(),
  }).refine((lv) => !lv.enabled || isValidLegacyVersion(lv.version), {
    // P0.3: only a legacy-ENABLED session uses the version as a path/spawn
    // coordinate, so only then must it be strict semver. Disabled configs may
    // carry a stale/empty version that is never used — leave those alone.
    path: ['version'],
    message: 'legacyVersion.version must be valid semver when enabled',
  }).optional(),
  // Bounded, not charset-guarded. `prompt` and `description` are free-form
  // natural language -- a metacharacter charset here would break the feature
  // for anyone writing an ordinary English sentence, so it is the wrong control.
  //
  // The real control is that this value never reaches a shell as command TEXT:
  // it is JSON-stringified and single-quote-escaped for the launch shell, and
  // scripts/resume-picker.js re-spawns with shell:false so there is no second,
  // unescaped parse (see buildSpawnTarget there -- shell:true on Windows
  // concatenated argv into a cmd.exe command line, which made this field a
  // command-execution path). These bounds are defence in depth against an
  // oversized payload, not the injection boundary.
  agentsConfig: z.array(z.object({
    name: z.string().max(200),
    description: z.string().max(2000),
    prompt: z.string().max(100_000),
    model: z.string().max(64).optional(),
    tools: z.array(z.string().max(200)).max(200).optional(),
  })).max(200).optional(),
  // PERMISSIVE by design (spec 2026-06-11 §4): a registry-validated enum here
  // re-creates the restore crash — capping at low/medium/high made a restored
  // xhigh/max/ultracode session throw. Unknown levels flow through to the
  // Sentinel observe seam in effort-tracker instead of being rejected at spawn.
  // Charset guard = injection defense: value is shell-interpolated UNQUOTED at
  // spawn (pty-manager.ts:1137 local, :563 SSH) — mirrors the resume.uuid guard.
  effortLevel: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  // Shell-interpolated UNQUOTED at spawn. Constrained to the CLI's own --permission-mode
  // choices (+ 'default'/'' meaning "emit no flag") so an arbitrary string can never
  // reach the shell. 'default'/'' are accepted but not emitted.
  permissionMode: z.enum(['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions', 'manual']).optional().or(z.literal('')),
  // Advanced escape hatch, shell-interpolated UNQUOTED at spawn. Charset guard blocks
  // every shell metacharacter (; | & $ ` ( ) < > ' " * ? ~ ! % ^ newline), leaving only
  // characters that make up ordinary flags/paths. The refine rejects CCC-managed flags
  // so extraArgs can't clobber --model/--effort/--permission-mode/--settings/etc.
  //
  // The managed-flag refine runs on a BACKSLASH-COLLAPSED copy of the value, not
  // on the raw text. The value is emitted unquoted, and POSIX shells strip
  // unquoted backslashes at word expansion -- so a spelling like `--setting\s`
  // matched no literal flag, passed the refine, and arrived at the CLI as the
  // real `--settings`, substituting CCC's per-session settings file. A Claude
  // settings file carries `hooks`, i.e. arbitrary commands.
  //
  // Collapsing rather than banning the character: Windows users legitimately
  // pass backslash paths through this escape hatch (pinned by an existing test),
  // and on Windows the launch shell is PowerShell, where backslash is not an
  // escape character. So the character is harmless where it is needed and only
  // its shell-stripping behaviour has to be accounted for.
  //
  // BRACKETS ARE BANNED FROM THE CHARSET, not collapsed. The value is emitted
  // unquoted, so a POSIX shell pathname-expands an unquoted bracket group:
  // `--setting[s]` is a glob matching a file literally named `--settings`, and
  // if one exists in the session's cwd -- a cloned repo can ship one -- the
  // shell hands the CLI the real flag. That is the same substitution the
  // backslash collapse closes.
  //
  // Collapsing brackets the way backslashes are collapsed does NOT work, and
  // the difference matters: a backslash is an ESCAPE (deleting it reproduces
  // exactly what the shell yields), whereas a bracket group is a PATTERN, so
  // there is no single normalised string to match against. Verified in a real
  // shell with `--settings` present in cwd -- every one of these expands to
  // `--settings`, while stripping just the bracket characters leaves
  // `--settingr-t` / `--settinga-z` / `--setting!x`, none of which match:
  //     --setting[s]  --setting[r-t]  --setting[a-z]  --setting[!x]
  // Since the charset admits no other glob metacharacter (`*` and `?` are
  // already excluded), dropping `[` and `]` removes pathname expansion from
  // this hatch entirely. A literal bracket in a path is the cost; nothing in
  // an ordinary flag or path needs one.
  extraArgs: z.string().max(512).regex(/^[A-Za-z0-9 _\-=.\/\\:@,+]*$/).refine(
    // Collapse backslashes before matching -- see the note above. Also reject a
    // trailing backslash outright: it turns the SSH launch line into a shell
    // line continuation, which hangs the session on a `>` prompt waiting for
    // input that never comes.
    (v) => !v.endsWith('\\')
      && !/(^|\s)--(model|effort|permission-mode|settings|mcp-config|agents|resume)\b/
        .test(v.replace(/\\/g, '')),
    { message: 'extraArgs must not include a CCC-managed flag (--model/--effort/--permission-mode/--settings/--mcp-config/--agents/--resume), nor end in a backslash' },
  ).optional(),
  disableAutoMemory: z.boolean().optional(),
  enableCodexReview: z.boolean().optional(),
  // T8b (bug #5): app-relaunch exact-conversation resume target.
  // FIX 4: the uuid is interpolated UNQUOTED into the spawn shell command, so
  // constrain it to the canonical UUID format (not just a bounded string) as a
  // defense-in-depth guard against shell injection. cwd stays a bounded string.
  resume: z.object({
    uuid: z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/),
    cwd: z.string().min(1).max(4096),
  }).optional(),
  // Single-quoted at BOTH spawn sites via modelFlag() (#144); this charset is
  // defence-in-depth, not the primary control. Line numbers deliberately omitted --
  // the previous comment carried stale ones and said UNQUOTED, the opposite of the code.
  // Legit values: 'opus', 'opus[1m]', 'fable', 'sonnet', 'haiku', or versioned ids like 'claude-opus-4-8'.
  // '' is the DEFAULT for "no override" (sessionStore.model is non-optional; TerminalView
  // passes it verbatim) and must stay accepted — emission already skips empty (`if (options?.model)`).
  model: z.string().max(64).regex(/^[a-zA-Z0-9._[\]-]+$/).optional().or(z.literal('')),
  profileId: z.string().optional(),
  provider: z.enum(['claude', 'codex']).optional(),
  codexOptions: z.object({
    model: z.string().optional(),
    reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
    permissionsPreset: z.enum(['read-only', 'standard', 'auto', 'unrestricted']),
  }).optional(),
}).superRefine((opts, ctx) => {
  if (opts?.provider === 'codex' && !opts.codexOptions) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'codexOptions required when provider is "codex"',
      path: ['codexOptions'],
    })
  }
}).optional()

// Charset-gate the session id (#265; independently reached by #242 F2). It is
// interpolated into the remote setup script (base64'd and piped to `node` on the
// remote), into filenames on the remote, and into ssh-shim's statusLine.command
// (a string Claude runs via `sh -c` on every statusline refresh). Real ids are
// CSPRNG hex (src/shared/id.ts), so this only ever rejects a caller that already
// controls the renderer or local config — a defence-in-depth gate, not an
// embargoed bug. ssh-shim re-sanitises via safeSid as a backstop. Exported so the
// boundary contract is unit-tested against the real schema.
export const sessionIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/, 'session id has invalid characters')

export function registerPtyHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('pty:spawn', async (_event, sessionId: string, options?: {
    cwd?: string
    cols?: number
    rows?: number
    ssh?: RendererSSHOptions
    shellOnly?: boolean
    terminalOptions?: { command?: string; args?: string; hasSecretArg?: boolean; elevated?: boolean }
    /** Main-process only — resolved from the OS keychain below and explicitly
     *  cleared from whatever the renderer sent. Never accepted from outside. */
    terminalSecret?: string
    configId?: string
    configLabel?: string
    /** Ask Conductor's opening question (see spawnOptionsSchema.askPrompt). */
    askPrompt?: string
    loggingEnabled?: boolean
    useResumePicker?: boolean
    legacyVersion?: { enabled: boolean; version: string }
    agentsConfig?: Array<{ name: string; description: string; prompt: string; model?: string; tools?: string[] }>
    // Widened to string — the Zod schema's charset guard is the real contract.
    effortLevel?: string
    permissionMode?: string
    extraArgs?: string
    disableAutoMemory?: boolean
    enableCodexReview?: boolean
    resume?: { uuid: string; cwd: string }
    model?: string
    profileId?: string
    provider?: 'claude' | 'codex'
    codexOptions?: {
      model?: string
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
      permissionsPreset: 'read-only' | 'standard' | 'auto' | 'unrestricted'
    }
  }) => {
    try {
      sessionIdSchema.parse(sessionId)
      spawnOptionsSchema.parse(options)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }

    const win = getWindow()
    if (!win) throw new Error('No window available')

    // Auto-install legacy version before spawn if needed
    if (options?.legacyVersion?.enabled && options.legacyVersion.version) {
      if (!isVersionInstalled(options.legacyVersion.version)) {
        logInfo(`[pty] Auto-installing legacy Claude CLI v${options.legacyVersion.version} before spawn`)
        const result = await installVersion(options.legacyVersion.version)
        if (!result.ok) {
          logInfo(`[pty] Legacy install failed, falling back to system claude: ${result.error}`)
        }
      }
    }

    // Resolve SSH credentials in the main process (never transit through renderer).
    // terminalSecret is stripped up front: this object is forwarded to spawnPty
    // verbatim (the zod parse result is intentionally discarded), so a field the
    // schema doesn't declare would otherwise flow straight through from the
    // renderer. Only the keychain lookup below may set it.
    let resolvedOptions: typeof options = options ? { ...options, terminalSecret: undefined } : options
    if (options?.ssh && options.configId) {
      const password = loadCredential(options.configId) ?? undefined
      const sudoPassword = loadCredential(options.configId + '_sudo') ?? undefined
      const sshWithCreds: SSHOptions = {
        ...options.ssh,
        password,
        sudoPassword,
      }
      resolvedOptions = { ...options, ssh: sshWithCreds }
    }

    // Terminal-only secret argument: resolved HERE, in main, straight from the OS
    // keychain — the value never transits the renderer and is never persisted to
    // the config file (same posture as the SSH credentials above).
    if (options?.shellOnly && options.configId && options.terminalOptions?.hasSecretArg) {
      const argSecret = loadCredential(options.configId + '_argsecret') ?? undefined
      if (argSecret) resolvedOptions = { ...resolvedOptions, terminalSecret: argSecret }
    }

    // Agent Canvas UAT roots are NOT registered here any more (adversarial
    // review, 2026-08-15 — BLOCKER 1). This site registered the RAW
    // `options.cwd` and `options.resume.cwd` strings, neither of which had been
    // through `resolveCwd` or `isHomeOrAncestor`, so a config whose
    // workingDirectory was '.', empty or stale allowlisted the home directory
    // and `~/.ssh`, `~/.claude`, `~/.aws` became servable. Worse,
    // `resume.cwd` is read verbatim out of a transcript JSONL
    // (transcript-discovery.getCwdFromTranscript), a file the agent can WRITE —
    // so the model named its own allowlist entry.
    //
    // Registration now happens in pty-manager, after the spawn, against
    // `resolveCwd(options.cwd)` — the session's CONFIGURED project directory —
    // with the same home-directory refusal codex_review has carried since #188.
    // Explicitly NOT the post-resume-override launch cwd: that value is
    // `target.cwd`, i.e. transcript content, so registering it would have
    // laundered the same model-chosen path through a different file (second
    // pass, 2026-08-15). Only the configured directory may become a served root.
    if (!options?.ssh) {
      // Canvas continuity: stamp this session's work identity and let it adopt
      // an orphaned canvas from a previous session of the same conversation /
      // project (the VM "repush" bug, 2026-08-14). LOCAL sessions only — an SSH
      // session's cwd names a path on the REMOTE machine. These stamps LABEL a
      // canvas (ordering, the reclaim list); they never authorize a read.
      noteSessionSpawnForCanvas(sessionId, {
        cwd: options?.resume?.cwd ?? options?.cwd,
        resumeUuid: options?.resume?.uuid,
        // Part of the adoption key: a canvas never crosses accounts.
        profileId: options?.profileId,
      })
    }

    spawnPty(win, sessionId, resolvedOptions)
  })

  ipcMain.on('pty:write', (_event, sessionId: string, data: string) => {
    if (isDebugModeEnabled()) {
      logUserInput(sessionId, data, 'inputBar')
    }
    writePty(sessionId, data)
  })

  ipcMain.on('pty:resize', (_event, sessionId: string, cols: number, rows: number) => {
    resizePty(sessionId, cols, rows)
  })

  ipcMain.on('pty:kill', (_event, sessionId: string) => {
    killPty(sessionId)
  })

  ipcMain.on(IPC.PTY_INTEGRITY_REPORT, (_event, report: PtyIntegrityReport) => {
    getPtyIntegrityMonitor()?.recordRendererReport(report)
  })

  // SSH manual-flow controller — renderer drives stage transitions.
  ipcMain.handle(IPC.SSH_FLOW_RUN_POSTCOMMAND, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    getSshFlow(sessionId)?.runPostCommand()
  })

  ipcMain.handle(IPC.SSH_FLOW_LAUNCH_CLAUDE, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    getSshFlow(sessionId)?.launchClaude()
  })

  ipcMain.handle(IPC.SSH_FLOW_SKIP, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    getSshFlow(sessionId)?.skip()
  })

  ipcMain.handle(IPC.SSH_FLOW_GET_STATE, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    return getSshFlow(sessionId)?.getState() ?? { state: 'connecting' }
  })

  // SSH tmux enhancement (item 4): deliberately END a persistent remote session
  // (tmux kill-session + sidecar cleanup over a SEPARATE ssh exec). The renderer
  // still tears down the local PTY itself (killSessionPty) after this resolves.
  ipcMain.handle(IPC.SSH_END_REMOTE, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    endSshRemote(sessionId)
  })
}
