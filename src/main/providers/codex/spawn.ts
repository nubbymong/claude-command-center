import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { sandboxFor, approvalFor } from './permissions'
import { getResourcesDirectory, getDataDirectory } from '../../ipc/setup-handlers'
import type { SpawnOptions, ProviderSpawnCommand, PickFolderIdentity } from '../types'
import { getConductorMcpPort, issueMcpSessionToken } from '../../conductor-mcp-server'
import { CODEX_CONDUCTOR_TOOLS, type ConductorToolSwitches } from './conductor-tools'
import { readConfig, getConfigDir } from '../../config-manager'
import { colorFgBgValue } from '../host-color-scheme'
import { codexShellEnv, CMD_UNSAFE_PATH_RE } from './cli-runner'
import { CODEX_CONVERSATION_ID_RE, codexFolderIdentity, resolveCodexResume } from './rollout-lookup'
import { codexHookCommand, codexHookConfigArgs, codexPlainWrapperDir, codexLocalAppData, verifyPlainCodexHookWrapper, tomlString, CODEX_HOOK_FILE_ENV, CODEX_HOOK_SCRIPT, CODEX_HOOK_WRAPPER } from './hooks'
import { codexExtraArgsProblem, codexExtraArgWords } from '../../../shared/extra-args'
import { logWarn } from '../../debug-logger'

export function resolveCodexBinary(): { cmd: string; args: string[] } | null {
  if (os.platform() !== 'win32') {
    // Probe through a LOGIN shell and keep the absolute path: a Finder/Dock
    // launched app inherits launchd's minimal PATH (no Homebrew/npm-global),
    // so both a bare `which codex` probe and a later bare-'codex' spawn fail
    // even though the user's terminal finds it. Matches cli:check's login-
    // shell approach for claude.
    try {
      const shell = process.env.SHELL || '/bin/bash'
      const out = execSync(`${shell} -l -c 'which codex'`, {
        encoding: 'utf-8',
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const resolved = out.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('/')).pop()
      if (resolved) return { cmd: resolved, args: [] }
      return null
    } catch { return null }
  }
  for (const bin of ['codex.exe', 'codex.cmd']) {
    try {
      // stdio pipe on stderr suppresses the "INFO: Could not find files for
      // the given pattern(s)." that `where` writes to stderr on a miss --
      // default execSync inherits stderr, so a normal "try next binary" probe
      // ends up polluting the parent process's stderr / terminal.
      const cmdPath = execSync(`where ${bin}`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim().split(/\r?\n/)[0].trim()
      if (cmdPath) return { cmd: cmdPath, args: [] }
    } catch { /* try next */ }
  }
  return null
}

/**
 * Resolve a full path to node.exe on Windows. Bare 'node' fails under
 * node-pty / ConPTY because Windows PTY spawn does NOT consult PATH the
 * same way child_process.spawn does -- it throws synchronously with
 * "File not found:" before any onExit/onData handler can fire (verified
 * empirically against the pinned node-pty version).
 *
 * On non-Windows, bare 'node' works fine -- PTY uses execvp which does
 * PATH lookup.
 *
 * Cached on first successful resolve. Returns bare 'node' as a fallback
 * if `where node` fails (rare; if node isn't on PATH the user has bigger
 * problems and our error message via the spawn failure is fine).
 */
let cachedNodeExe: string | null = null
export function resolveNodeExe(): string {
  if (os.platform() !== 'win32') {
    // Same launchd-minimal-PATH hazard as resolveCodexBinary: resolve the
    // absolute node path via a login shell so PTY execvp doesn't depend on
    // the GUI app's inherited PATH. Falls back to bare 'node'.
    if (cachedNodeExe) return cachedNodeExe
    try {
      const shell = process.env.SHELL || '/bin/bash'
      const out = execSync(`${shell} -l -c 'which node'`, {
        encoding: 'utf-8',
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const resolved = out.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('/')).pop()
      if (resolved) {
        cachedNodeExe = resolved
        return resolved
      }
    } catch { /* fall through */ }
    return 'node'
  }
  if (cachedNodeExe) return cachedNodeExe
  try {
    const resolved = execSync('where node', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split(/\r?\n/)[0].trim()
    if (resolved) {
      cachedNodeExe = resolved
      return resolved
    }
  } catch { /* fall through */ }
  return 'node'
}

/** Test-only: reset the node.exe resolution cache. */
export function __resetNodeExeCache(): void {
  cachedNodeExe = null
}

/**
 * Resolve the deployed `codex-resume-picker.js` path. Returns null when the
 * script is not deployed yet (first-boot race). Mirrors `getResumePickerPath`
 * in `src/main/pty-manager.ts`. Uses static import for `getResourcesDirectory`
 * matching the existing project convention (see `claude/statusline.ts`); unit
 * tests intercept via `vi.mock('../../ipc/setup-handlers', ...)`.
 */
export function getCodexResumePickerPath(): string | null {
  let resDir: string
  try {
    resDir = getResourcesDirectory()
  } catch { return null }
  if (!resDir) return null
  try {
    const scriptPath = path.join(resDir, 'scripts', 'codex-resume-picker.js')
    if (fs.existsSync(scriptPath)) return scriptPath
  } catch { /* ignore */ }
  return null
}

/** P3.10 round 1 (A5): the app's own data folder -- this install's (a dev
 *  build, the installed app and a test run each have their own) -- where the
 *  hook folders live (hooks.ts preparedCodexHookRoot); null when unknown. */
export function codexHookDataDir(): string | null {
  try { return getDataDirectory() || null } catch { return null }
}

/** P3.10 round 1 (V2): the picker's variable naming the conversations other
 *  open tabs of this app are on (comma-separated ids), and how many it
 *  carries at most. */
export const CODEX_OPEN_ELSEWHERE_ENV = 'CCC_CODEX_OPEN_ELSEWHERE'
export const CODEX_OPEN_ELSEWHERE_MAX = 64

/** A value that must reach cmd.exe exactly as written holds no control character. */
const hasControl = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
/** The shim's path is quoted on the line, but cmd.exe still expands `%` inside
 *  quotes and the npm shim re-reads its own path (`%~dp0`): the characters
 *  refused there are cli-runner's CMD_UNSAFE_PATH_RE (shared with the hook
 *  wrapper's route, P3.10 round 1). */
/** Arguments go unquoted (none needs quoting): any character cmd.exe gives a
 *  meaning, and any whitespace, is refused. */
const CMD_UNSAFE_ARG_RE = /["%&^|<>!()\s]/
/** A drive or a share, never `\x`, `\\?\` or `\\.\` (as cli-runner). */
const WIN_ABSOLUTE_RE = /^([A-Za-z]:\\|\\\\[^\\?.][^\\]*\\[^\\]+\\)/

/** How long a Codex session waits for one Conductor tool call: above the
 *  longest review a review tool allows (900 s) plus its diff, launch and
 *  kill-settle time. */
export const CONDUCTOR_TOOL_TIMEOUT_SEC = '1000.0'

/** A .cmd/.bat shim runs through cmd.exe named by ABSOLUTE path -- ComSpec or
 *  SystemRoot as the parent spells them (Windows names are case-insensitive),
 *  never a PATH lookup -- with AutoRun and delayed expansion off, in the `/s`
 *  form: cmd.exe strips exactly the outer pair of quotes and runs
 *  `"<shim>" <args>`, whatever the shim's path holds (spaces, parentheses).
 *  The line goes to node-pty VERBATIM: its per-argument quoting would escape
 *  the inner quotes. Throws when the path or an argument cannot pass through
 *  unchanged. The same line cli-runner's `codexCommandLine` builds for
 *  discovery and sign-in; mirrored by `launchTarget` in
 *  scripts/lib/codex-resume-picker-lib.js. */
export function codexCmdExeTarget(shim: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>): { cmd: string; commandLine: string } {
  const shell = codexShellEnv(env, 'win32')
  const usable = (p: string | undefined): p is string =>
    typeof p === 'string' && WIN_ABSOLUTE_RE.test(p) && /[\\/]cmd\.exe$/i.test(p) && !CMD_UNSAFE_PATH_RE.test(p) && !hasControl(p)
  const system32 = shell.SystemRoot ? path.win32.join(shell.SystemRoot, 'System32', 'cmd.exe') : undefined
  const cmd = usable(shell.ComSpec) ? shell.ComSpec : usable(system32) ? system32 : null
  if (!cmd) {
    throw new Error('Cannot start Codex: the Windows folder (SystemRoot) is not set to an absolute path.')
  }
  if (!WIN_ABSOLUTE_RE.test(shim) || /[. ]$/.test(shim) || CMD_UNSAFE_PATH_RE.test(shim) || hasControl(shim)
      || args.some((a) => a === '' || CMD_UNSAFE_ARG_RE.test(a) || hasControl(a))) {
    throw new Error('Cannot start Codex: its path or launch options contain characters cmd.exe would reinterpret.')
  }
  return { cmd, commandLine: `/d /v:off /s /c "${[`"${shim}"`, ...args].join(' ')}"` }
}

/** cmd.exe takes a command line under this many characters (its documented
 *  limit is 8,191 including the terminator). */
export const CMD_EXE_LINE_MAX = 8_191

/** WP2 PR 4, P4.1 (PB2): the app's tools a Codex session runs without
 *  asking, on every preset, as a Claude session's two are pre-allowed in every
 *  mode (hooks/per-session-settings.ts CANVAS_TOOL_PERMISSIONS): neither takes
 *  a path or anything that widens what it can touch. `canvas_render` is NOT
 *  one of them (it reads a model-chosen file). */
export const CODEX_PREALLOWED_TOOLS: readonly string[] = ['canvas_snapshot', 'canvas_review']

/** The `-c` key that lets one conductor tool run without Codex's prompt
 *  (PB2: `approve` lifts it per tool on both supported versions; `auto` does
 *  not). Tool names are plain words, so the value rides the .cmd route. */
export function codexToolApprovalArg(tool: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool)) throw new Error(`not a conductor tool name: ${tool}`)
  return `mcp_servers.conductor.tools.${tool}.approval_mode=approve`
}

/** WP2 PR 4, P4.1 (by parity per preset): the further tools a Codex preset
 *  runs without asking -- exactly the tools the matching Claude mode does not
 *  ask before. Matched by the presets' own words: Unrestricted ("Full
 *  machine access") with Claude's Bypass ("Skip every permission prompt"),
 *  which asks before nothing, so every conductor tool the connection is
 *  offered; Auto ("Workspace writes, no prompts") with Claude's Auto, whose
 *  handling of these tools waits on OR4's check of a real Claude session,
 *  so Auto keeps asking as today; Read Only, Standard and Plan keep Codex's
 *  prompt, as Claude's Ask, Accept edits and Plan mode ask. Nothing wider:
 *  never a server-wide default, never a session or always approval. */
export function codexPresetApprovedTools(preset: string, switches: ConductorToolSwitches): string[] {
  if (preset !== 'unrestricted') return []
  return CODEX_CONDUCTOR_TOOLS
    .filter((t) => t.offered(switches) && !CODEX_PREALLOWED_TOOLS.includes(t.name))
    .map((t) => t.name)
}

/** The launch route a Codex executable takes: the npm `.cmd` shim runs
 *  through cmd.exe (no argument may hold whitespace there), anything else is
 *  started directly. */
export function codexLaunchRoute(executable: string, platform: NodeJS.Platform = process.platform): 'direct' | 'cmd' {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(executable) ? 'cmd' : 'direct'
}

/** A Codex launch line as the log may hold it: the developer instructions
 *  (the app's own guidance, thousands of characters) named by their length
 *  only. */
export function codexLaunchLineForLog(line: string): string {
  return line.replace(/developer_instructions=("(?:[^"\\]|\\.)*"|'[^']*')/g, (_m, value: string) => `developer_instructions=<${value.length} characters>`)
}

/** WP2 PR 4, P4.1: what main adds to a Codex launch beyond SpawnOptions. */
export interface CodexSpawnExtras {
  /** The app's canvas and browser guidance as Codex developer instructions
   *  (section 10 question 5, default A): main decides whether this launch
   *  carries it (src/main/canvas/codex-guidance.ts); the builder passes it on
   *  the direct route only, never through cmd.exe. */
  developerInstructions?: string
}
export type CodexSpawnOptions = SpawnOptions & CodexSpawnExtras

/** Set a variable main owns, removing every other spelling of it first: on
 *  Windows names are case-insensitive and a child reads the FIRST match in
 *  its environment block, so an inherited `conductor_mcp_token` would
 *  otherwise shadow the value set here. */
function setOwned(env: Record<string, string>, name: string, value: string, win32: boolean): void {
  if (win32) for (const k of Object.keys(env)) if (k !== name && k.toUpperCase() === name.toUpperCase()) delete env[k]
  env[name] = value
}

export function buildCodexSpawn(opts: CodexSpawnOptions): ProviderSpawnCommand {
  const co = opts.codexOptions
  if (!co) throw new Error('codexOptions required for Codex spawn')

  // WP2 (plan A10): a Codex session runs only from its prepared launch in its
  // account's realm -- the executable setup proved (never a second lookup)
  // and the realm's environment (ambient credentials removed, CODEX_HOME set).
  const launch = opts.realmLaunch
  if (!launch) {
    throw new Error('A Codex session needs its account: choose a Codex account for this session.')
  }
  const executable = launch.executable
  const win32 = process.platform === 'win32'

  // Build the canonical Codex flag list once; both the picker and the direct
  // spawn paths forward the same flags.
  const flags: string[] = []
  if (co.model) flags.push('-m', co.model)
  if (co.reasoningEffort && co.reasoningEffort !== 'none') {
    flags.push('-c', `model_reasoning_effort=${co.reasoningEffort}`)
  }
  flags.push('--sandbox', sandboxFor(co.permissionsPreset))
  flags.push('--ask-for-approval', approvalFor(co.permissionsPreset))

  // U6: deliver the conductor MCP config PER-SPAWN via `-c` overrides -- nothing
  // is written to the user's global ~/.codex/config.toml, so plain `codex` outside
  // CCC never tries the dead endpoint. The token rides a bearer header via the
  // CONDUCTOR_MCP_TOKEN env var (Codex sends `Authorization: Bearer <value>`, which
  // the conductor server accepts), so the URL carries only the session id -- no
  // `&`, which keeps it intact through the cmd.exe .cmd-shim spawn path. The
  // token is issued as a Codex one, which keeps codex_review hidden from Codex
  // (no self-review).
  // Built-in tools master (onboarding p6 / Settings): off = no conductor MCP
  // flags at all, so Codex launches without the built-in tools. Read fresh
  // per spawn; port 0 (server unbound) behaves identically.
  const spawnSettings = readConfig<{ conductorToolsEnabled?: boolean } & ConductorToolSwitches>('settings')
  const conductorOn = spawnSettings?.conductorToolsEnabled !== false
  const mcpPort = conductorOn ? getConductorMcpPort() : 0
  const viaCmdExe = win32 && /\.(cmd|bat)$/i.test(executable)
  // WP2 PR 4, P4.1: where the per-preset approvals sit in `flags`, so a
  // cmd.exe line that would be too long can drop them (and only them).
  let presetKeysAt = -1
  let presetKeyArgs: string[] = []
  if (mcpPort > 0) {
    // cccSessionId is the ONLY query param, so the URL stays free of `&` — a
    // second param would be a cmd.exe command separator on the win32 .cmd-shim
    // spawn path. The /mcp route is Codex-only and serves the Codex tool set,
    // so no provider marker need ride the URL. The per-session
    // HMAC token (below, via the bearer header) commits to this session id, so
    // the gate verifies the binding the same way a Claude session's is
    // (GHSA-q83v-phcc-hgv4); Codex's tools are install-global, but the token
    // still cannot claim another session's id.
    flags.push('-c', `mcp_servers.conductor.url=http://localhost:${mcpPort}/mcp?cccSessionId=${encodeURIComponent(opts.sessionId)}`)
    flags.push('-c', 'mcp_servers.conductor.enabled=true')
    flags.push('-c', 'mcp_servers.conductor.bearer_token_env_var=CONDUCTOR_MCP_TOKEN')
    // WP2 5b: a claude_review call runs for as long as its timeoutSeconds
    // (up to 900 s) plus the diff, the launch and the kill's settle bound.
    // The pinned Codex waits 300 s for a tool by default (DEFAULT_TOOL_TIMEOUT,
    // codex-rs/codex-mcp/src/rmcp_client.rs, rust-v0.155.1) and would give up
    // on a longer review first; seconds, read as a float.
    flags.push('-c', `mcp_servers.conductor.tool_timeout_sec=${CONDUCTOR_TOOL_TIMEOUT_SEC}`)
    // WP2 PR 4, P4.1 (PB2): Codex asks before every call of a tool without
    // annotations, under every preset probed, Auto's `--ask-for-approval
    // never` included. The two Claude pre-allows in every mode run without
    // asking on every preset; under a preset whose matching Claude mode asks
    // before nothing, every tool the connection is offered does too
    // (codexPresetApprovedTools). Per tool, never server-wide.
    for (const tool of CODEX_PREALLOWED_TOOLS) flags.push('-c', codexToolApprovalArg(tool))
    presetKeyArgs = codexPresetApprovedTools(co.permissionsPreset, spawnSettings ?? {}).flatMap((tool) => ['-c', codexToolApprovalArg(tool)])
    presetKeysAt = flags.length
    flags.push(...presetKeyArgs)
    // WP2 PR 4, P4.1 (section 10 question 5, default A): the app's canvas and
    // browser guidance as Codex's developer instructions, decided by main for
    // this launch (src/main/canvas/codex-guidance.ts), encoded as a TOML
    // string. Never through cmd.exe: the npm .cmd route refuses an argument
    // holding a space (codexCmdExeTarget).
    if (typeof opts.developerInstructions === 'string' && opts.developerInstructions && !viaCmdExe) {
      flags.push('-c', `developer_instructions=${tomlString(opts.developerInstructions)}`)
    }
  }

  // CLAUDE_MULTI_SESSION_ID identifies the spawning CCC session for downstream
  // hook / telemetry correlation in P3+. Codex CLI itself does not read it; it
  // is transparent pass-through and survives any future env-var hygiene pass.
  // Built on the REALM's environment; nothing set below names a realm or a
  // credential, so CODEX_HOME stays the one the launch set.
  const env: Record<string, string> = { ...launch.env }
  setOwned(env, 'CLAUDE_MULTI_SESSION_ID', opts.sessionId, win32)
  // U6: bearer token for the per-spawn conductor MCP entry above. Per-session
  // HMAC, matched to the cccSessionId baked into the URL (GHSA-q83v-phcc-hgv4).
  if (mcpPort > 0) {
    setOwned(env, 'CONDUCTOR_MCP_TOKEN', issueMcpSessionToken(opts.sessionId, 'codex'), win32)
  }
  // The host's light/dark scheme, the same way the local Claude spawn gets it
  // (book item 34: Codex sessions never did, so a light-mode Codex TUI came up
  // dark). Harmless to a TUI that does not read it.
  if (opts.hostColorScheme) {
    setOwned(env, 'COLORFGBG', colorFgBgValue(opts.hostColorScheme), win32)
  }
  // The working directory stays the PROJECT (a departure from the design's
  // "shim folder as cwd": Codex's workspace IS its cwd, so any other folder
  // would point it at the wrong files). What that protects against -- a
  // program name resolved from the project folder -- is closed instead by
  // telling cmd.exe not to search the current directory.
  if (win32) setOwned(env, 'NoDefaultCurrentDirectoryInExePath', '1', win32)

  // P3.10 (rows 43, 46, 47, 63): the app's hooks, as a Claude session gets
  // its http hooks through its settings file: the same command for every
  // session (Codex asks the user to review a hook once, and keeps the trust
  // while it is unchanged), the session named by the environment the hook
  // inherits (its id above, and the file holding the gateway's port and
  // token). None when the Hooks gateway is off or not listening (no hook
  // file), the forwarder is not deployed yet, or its path cannot be given
  // safely on this launch's route (codexHookCommand).
  // P3.10 round 1 (V3): a launch through the npm .cmd shim can carry the
  // command only as a plain word; when the resources folder's path is not
  // one (the default has a space), it runs the app's plain-path copy of the
  // wrapper under the user's local app data folder, checked again here
  // before it is used (hooks.ts verifyPlainCodexHookWrapper).
  let hooksInstalled = false
  const hookFile = opts.codexHooks?.hookFile
  if (typeof hookFile === 'string' && hookFile && path.isAbsolute(hookFile) && !hasControl(hookFile)) {
    let resDir: string | null = null
    try { resDir = getResourcesDirectory() || null } catch { resDir = null }
    const scriptsDir = resDir ? path.join(resDir, 'scripts') : null
    let command = scriptsDir ? codexHookCommand(scriptsDir, process.platform, viaCmdExe) : null
    let target = scriptsDir ? path.join(scriptsDir, win32 ? CODEX_HOOK_WRAPPER : CODEX_HOOK_SCRIPT) : null
    if (!command && win32 && viaCmdExe && resDir && scriptsDir) {
      const plainDir = codexPlainWrapperDir(codexLocalAppData(), resDir)
      if (plainDir && verifyPlainCodexHookWrapper(scriptsDir, plainDir)) {
        command = codexHookCommand(plainDir, 'win32', true)
        target = path.join(plainDir, CODEX_HOOK_WRAPPER)
      }
    }
    let deployed = false
    try { deployed = !!target && fs.statSync(target).isFile() } catch { deployed = false }
    if (command && deployed) {
      flags.push(...codexHookConfigArgs(command))
      setOwned(env, CODEX_HOOK_FILE_ENV, hookFile, win32)
      hooksInstalled = true
    }
  }

  // P3.11 (row 62): the user's extra CLI arguments, after every flag the app
  // sets (so none of the app's arguments can become the value of one of
  // them), each word one argument, on every route below (the picker forwards
  // them). No shell reads them. pty:spawn drops a value codexExtraArgsProblem
  // refuses before the launch (its restore sanitizer runs on every spawn);
  // checked again here, one that reaches the builder refused ends the launch.
  if (co.extraArgs !== undefined) {
    const problem = codexExtraArgsProblem(co.extraArgs)
    if (problem) throw new Error(`Cannot start Codex: its extra CLI arguments are refused: ${problem}.`)
    flags.push(...codexExtraArgWords(co.extraArgs))
  }

  // WP2 PR 4, P4.1: cmd.exe takes a line under CMD_EXE_LINE_MAX characters.
  // Were the per-preset approvals to take this launch's line past it, they
  // alone are left off, with a log line, and the session still launches (its
  // tools then ask, as before); nothing else is dropped. `prefix`: what goes
  // before the flags on that line (an exact resume's `resume <id>`).
  const fitCmdLine = (prefix: string[]): string[] => {
    if (!viaCmdExe || presetKeyArgs.length === 0 || presetKeysAt < 0) return flags
    let line: string
    try { line = codexCmdExeTarget(executable, [...prefix, ...flags], env).commandLine } catch { return flags }
    if (line.length < CMD_EXE_LINE_MAX) return flags
    logWarn(`[codex-spawn] ${opts.sessionId}: the per-preset tool approvals are left off this launch: with them its cmd.exe line would be ${line.length} characters (cmd.exe takes under ${CMD_EXE_LINE_MAX}); its conductor tools ask before each call`)
    return [...flags.slice(0, presetKeysAt), ...flags.slice(presetKeysAt + presetKeyArgs.length)]
  }

  // P3.5 (rows 34, 35): an exact resume, as Claude's `claude --resume <uuid>`
  // (resolveResumeLaunch): the conversation's rollout must be in THIS realm's
  // sessions folder, and the CLI starts in the directory the conversation ran
  // in when that still holds (resolveCodexResume). It bypasses the picker, as
  // Claude's exact resume does. A miss falls back to the picker or a fresh
  // start, never to another account's conversation.
  const resumed = opts.resume ? resolveCodexResume(opts.resume, { sessionsDir: launch.sessionsDir, configuredCwd: opts.cwd ?? '' }) : null
  if (resumed) {
    // The id goes into argv: only a conversation id ever does, whatever the
    // lookup answered (the spawn schema and the lookup check it first).
    if (!CODEX_CONVERSATION_ID_RE.test(resumed.resumeId)) {
      throw new Error('Cannot resume the Codex conversation: its id is not a conversation id.')
    }
    const args = ['resume', resumed.resumeId, ...fitCmdLine(['resume', resumed.resumeId])]
    const cwd = resumed.cwd || undefined
    const resumeCwdMismatch = resumed.cwdMismatch
    // The rollout chosen here, so the status line claims it without a second walk.
    const resumePath = resumed.path
    if (viaCmdExe) {
      const target = codexCmdExeTarget(executable, args, env)
      return { cmd: target.cmd, args: [], commandLine: target.commandLine, env, resumeId: resumed.resumeId, cwd, resumeCwdMismatch, resumePath, hooksInstalled }
    }
    return { cmd: executable, args, env, resumeId: resumed.resumeId, cwd, resumeCwdMismatch, resumePath, hooksInstalled }
  }

  // Picker swap: when useResumePicker is true and the picker script is
  // deployed, run `node <picker> <flags>` instead of `codex <flags>`. The
  // picker forwards the flags to `codex resume <uuid>` on pick or to fresh
  // `codex` on N. When the picker is not yet deployed (first-boot race on
  // slow disks / SMB resourcesDir), fall back to direct codex spawn so the
  // session still launches. Mirrors Claude's pty-manager.ts:890-895 fallback.
  if (opts.useResumePicker) {
    const pickerScript = getCodexResumePickerPath()
    if (pickerScript) {
      // The picker starts the same proven executable (never its own lookup),
      // through cmd.exe under the same rules; refuse here what it would. Its
      // line may resume a conversation (`resume <id>` before the flags).
      const pickerFlags = fitCmdLine(['resume', '00000000-0000-0000-0000-000000000000'])
      if (viaCmdExe) codexCmdExeTarget(executable, pickerFlags, env)
      const pickerEnv = { ...env }
      setOwned(pickerEnv, 'CCC_CODEX_EXECUTABLE', executable, win32)
      // P3.5 (rows 32, 38): where the picker records each decision it makes,
      // so the status line and the tab follow what the session runs: a file
      // in a folder of its own, made for this launch with an unguessable
      // name (owner-only where the platform keeps modes, so no other user
      // can put a file there first), written by the picker only and read and
      // removed, with its folder, by the watcher. The folder's identity is
      // recorded as made (fix round 3): the watcher and the picker use it
      // only while it is still that folder, never one put in its place.
      let pickFile: string | undefined
      let pickFolder: PickFolderIdentity | null = null
      try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-codex-pick-'))
        pickFolder = codexFolderIdentity(dir)
        if (pickFolder) pickFile = path.join(dir, 'pick.json')
        else { try { fs.rmdirSync(dir) } catch { /* left empty */ } }
      } catch {
        pickFile = undefined
        pickFolder = null
      }
      if (pickFile && pickFolder) {
        setOwned(pickerEnv, 'CCC_CODEX_PICK_FILE', pickFile, win32)
        setOwned(pickerEnv, 'CCC_CODEX_PICK_DIR_ID', pickFolder.id, win32)
      }
      // The app's config folder, so the picker can name each conversation
      // with its tab's name (session-state.json), as Claude's picker does.
      // Read-only, best-effort.
      try { setOwned(pickerEnv, 'CCC_CONFIG_DIR', getConfigDir(), win32) } catch { /* no names */ }
      // P3.10 round 1 (V2): the conversations other open tabs of this app are
      // on (main's own record, ids only), so the picker can say one is open in
      // another tab -- Codex lets one tab at a time write a conversation --
      // rather than that it is no longer available. Codex never gets it.
      const openElsewhere = (opts.codexOpenElsewhere ?? []).filter((id) => typeof id === 'string' && CODEX_CONVERSATION_ID_RE.test(id)).slice(0, CODEX_OPEN_ELSEWHERE_MAX)
      if (openElsewhere.length > 0) setOwned(pickerEnv, CODEX_OPEN_ELSEWHERE_ENV, openElsewhere.join(','), win32)
      // Bare 'node' fails under node-pty/ConPTY on Windows (no PATH lookup).
      // Resolve to the full node.exe path via `where node`. See resolveNodeExe.
      return { cmd: resolveNodeExe(), args: [pickerScript, ...pickerFlags], env: pickerEnv, ...(pickFile && pickFolder ? { pickFile, pickFolder } : {}), hooksInstalled }
    }
    // Fallthrough: picker missing, spawn codex directly.
  }

  if (viaCmdExe) {
    // node-pty / ConPTY cannot directly invoke .cmd shims; route through cmd.exe.
    const target = codexCmdExeTarget(executable, fitCmdLine([]), env)
    return { cmd: target.cmd, args: [], commandLine: target.commandLine, env, hooksInstalled }
  }
  return { cmd: executable, args: flags, env, hooksInstalled }
}
