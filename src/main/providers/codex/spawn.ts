import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { sandboxFor, approvalFor } from './permissions'
import { getResourcesDirectory } from '../../ipc/setup-handlers'
import type { SpawnOptions } from '../types'
import { getConductorMcpPort, issueMcpSessionToken } from '../../conductor-mcp-server'
import { readConfig } from '../../config-manager'
import { colorFgBgValue } from '../host-color-scheme'
import { codexShellEnv } from './cli-runner'

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

/** A value that must reach cmd.exe exactly as written holds no control character. */
const hasControl = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
/** The shim's path is quoted on the line, but cmd.exe still expands `%` inside
 *  quotes and the npm shim re-reads its own path (`%~dp0`): the characters
 *  discovery's own cmd.exe route refuses (cli-runner `codexCommandLine`). */
const CMD_UNSAFE_PATH_RE = /["%&^]/
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

/** Set a variable main owns, removing every other spelling of it first: on
 *  Windows names are case-insensitive and a child reads the FIRST match in
 *  its environment block, so an inherited `conductor_mcp_token` would
 *  otherwise shadow the value set here. */
function setOwned(env: Record<string, string>, name: string, value: string, win32: boolean): void {
  if (win32) for (const k of Object.keys(env)) if (k !== name && k.toUpperCase() === name.toUpperCase()) delete env[k]
  env[name] = value
}

export function buildCodexSpawn(opts: SpawnOptions): { cmd: string; args: string[]; env: Record<string, string>; commandLine?: string } {
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
  const conductorOn = readConfig<{ conductorToolsEnabled?: boolean }>('settings')?.conductorToolsEnabled !== false
  const mcpPort = conductorOn ? getConductorMcpPort() : 0
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
  const viaCmdExe = win32 && /\.(cmd|bat)$/i.test(executable)

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
      // through cmd.exe under the same rules; refuse here what it would.
      if (viaCmdExe) codexCmdExeTarget(executable, flags, env)
      const pickerEnv = { ...env }
      setOwned(pickerEnv, 'CCC_CODEX_EXECUTABLE', executable, win32)
      // Bare 'node' fails under node-pty/ConPTY on Windows (no PATH lookup).
      // Resolve to the full node.exe path via `where node`. See resolveNodeExe.
      return { cmd: resolveNodeExe(), args: [pickerScript, ...flags], env: pickerEnv }
    }
    // Fallthrough: picker missing, spawn codex directly.
  }

  if (viaCmdExe) {
    // node-pty / ConPTY cannot directly invoke .cmd shims; route through cmd.exe.
    const target = codexCmdExeTarget(executable, flags, env)
    return { cmd: target.cmd, args: [], commandLine: target.commandLine, env }
  }
  return { cmd: executable, args: flags, env }
}
