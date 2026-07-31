import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { spawnPty, writePty, resizePty, killPty, getSshFlow, SSHOptions } from '../pty-manager'
import { logUserInput, isDebugModeEnabled } from '../debug-capture'
import { logInfo } from '../debug-logger'
import { isVersionInstalled, installVersion } from '../legacy-version-manager'
import { isValidLegacyVersion } from '../../shared/legacy-version'
import { loadCredential } from '../credential-store'
import { IPC } from '../../shared/ipc-channels'
import { getPtyIntegrityMonitor } from '../services/pty-integrity-monitor'
import type { PtyIntegrityReport } from '../../shared/service-health'

/** SSH options as received from the renderer (no passwords — only configId) */
interface RendererSSHOptions {
  host: string
  port: number
  username: string
  remotePath: string
  postCommand?: string
}

const sshSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  remotePath: z.string().min(1),
  postCommand: z.string().optional(),
}).optional()

export const spawnOptionsSchema = z.object({
  cwd: z.string().optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  ssh: sshSchema,
  shellOnly: z.boolean().optional(),
  configId: z.string().optional(),
  configLabel: z.string().max(100).optional(),
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
  extraArgs: z.string().max(512).regex(/^[A-Za-z0-9 _\-=.\/\\:@,+[\]]*$/).refine(
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

const sessionIdSchema = z.string().min(1).max(200)

export function registerPtyHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('pty:spawn', async (_event, sessionId: string, options?: {
    cwd?: string
    cols?: number
    rows?: number
    ssh?: RendererSSHOptions
    shellOnly?: boolean
    configId?: string
    configLabel?: string
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

    // Resolve SSH credentials in the main process (never transit through renderer)
    let resolvedOptions = options
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
}
