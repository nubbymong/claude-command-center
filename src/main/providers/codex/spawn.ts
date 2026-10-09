import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { sandboxFor, approvalFor } from './permissions'
import { getResourcesDirectory, getDataDirectory } from '../../ipc/setup-handlers'
import type { SpawnOptions, ProviderSpawnCommand, PickFolderIdentity } from '../types'
import { getConductorMcpPort, issueMcpSessionToken } from '../../conductor-mcp-server'
import { CODEX_CONDUCTOR_TOOLS, type ConductorToolSwitches } from './conductor-tools'
import { getConfigDir } from '../../config-manager'
import { readConductorToolSwitches } from '../../conductor-tools-switch'
import { colorFgBgValue } from '../host-color-scheme'
import { windowsFolderAsRun, windowsPathFolderIsFullyQualified } from '../windows-path-names'
import { codexShellEnv, CMD_UNSAFE_PATH_RE } from './cli-runner'
import { CODEX_CONVERSATION_ID_RE, codexFolderIdentity, resolveCodexResume } from './rollout-lookup'
import { codexHookCommand, codexHookConfigArgs, codexPlainWrapperDir, codexLocalAppData, verifyPlainCodexHookWrapper, CODEX_HOOK_FILE_ENV, CODEX_HOOK_SCRIPT, CODEX_HOOK_WRAPPER } from './hooks'
import { codexExtraArgsProblem, codexExtraArgWords } from '../../../shared/extra-args'
import { logWarn } from '../../debug-logger'

/** The two forms a Codex install puts on PATH on Windows: `listed`, the ones
 *  PATHEXT lists, in its order (Windows' own default when it is unset), as a
 *  terminal tries them within one folder; `unlisted`, the rest, looked for
 *  only once no PATH folder held a listed one (review B-S2), so an install a
 *  custom PATHEXT leaves out is still found, and never wins over a listed
 *  form later in PATH. */
export function codexWindowsForms(pathExt: string | undefined): { listed: string[]; unlisted: string[] } {
  const exts = (pathExt ?? '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC')
    .split(';').map((e) => e.trim().toLowerCase())
  const forms = ['.exe', '.cmd']
  const known = exts.filter((e, i) => forms.includes(e) && exts.indexOf(e) === i)
  return {
    listed: known.map((ext) => `codex${ext}`),
    unlisted: forms.filter((f) => !known.includes(f)).map((ext) => `codex${ext}`),
  }
}

/** A folder named as Windows names it when it starts a program from it
 *  (review B-S11): in a path that goes on below it, a name that ends in one
 *  dot after another character loses that dot (`C:\tools.` and
 *  `C:\tools.\bin` are `C:\tools` and `C:\tools\bin`), while a name ending in
 *  a space, or in two dots, is kept as it is spelled; a share's own two names
 *  are kept. `.` and `..` steps are folded when the candidate is joined
 *  (path.win32). Node reads every name as it is spelled, so without this the
 *  lookup would read another folder than the one a terminal runs from. */
export const codexWindowsFolderAsRun: (dir: string) => string = windowsFolderAsRun

/** PATH's folders as the lookup reads them: `;`-separated, a quoted entry
 *  without its quotes, and only fully qualified PATH folders (a drive or a
 *  share, as a terminal reads them; windowsPathFolderIsFullyQualified, review
 *  B-S10) are read, each named as Windows names it (codexWindowsFolderAsRun).
 *  A folder that does not answer (a share
 *  that is offline) is asked nothing more in a lookup once it has failed
 *  (resolveCodexBinary). */
export function codexWindowsPathFolders(pathVar: string | undefined): string[] {
  const out: string[] = []
  for (const raw of (pathVar ?? '').split(';')) {
    let dir = raw.trim()
    if (dir.length >= 2 && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1).trim()
    if (windowsPathFolderIsFullyQualified(dir)) out.push(codexWindowsFolderAsRun(dir))
  }
  return out
}

/** A variable from an environment, by Windows's case-insensitive names. */
function winEnvValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name)
  return key ? env[key] : undefined
}

/** What one look at a candidate found: a regular file, nothing there, or a
 *  folder that could not be read (asked nothing more in that lookup). */
export type CodexCandidateStat = 'file' | 'none' | 'unreachable'

export interface CodexBinaryLookup {
  /** Default: this machine's. */
  platform?: NodeJS.Platform
  /** Default: this process's environment (Windows: its PATH and PATHEXT). */
  env?: Readonly<Record<string, string | undefined>>
  /** Whether a regular file is there (links followed as a terminal follows
   *  them). Default: statFile. */
  isFile?: (p: string) => boolean
  /** The same, telling a folder that could not be read from one that holds
   *  nothing (default: the disk). */
  statFile?: (p: string) => CodexCandidateStat
}

/** `none` for an answer that says the file is not there (or is not a file);
 *  `unreachable` for anything else -- a drive that did not answer, a denied
 *  folder -- so the walk asks that folder nothing more (the precedent:
 *  claude-cli-version.ts findClaudeOnWindowsPath). */
const diskStat = (p: string): CodexCandidateStat => {
  try {
    return fs.statSync(p).isFile() ? 'file' : 'none'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'none' : 'unreachable'
  }
}

export function resolveCodexBinary(lookup: CodexBinaryLookup = {}): { cmd: string; args: string[] } | null {
  if ((lookup.platform ?? os.platform()) !== 'win32') {
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
  // Windows (owner, 2026-10-04): PATH order wins, as a terminal finds it.
  // The first PATH folder holding codex.exe or codex.cmd gives it, and within
  // one folder PATHEXT's order decides; a form PATHEXT does not list is looked
  // for in a second pass, once no folder held a listed one. Read in this
  // process with no shell and no process started, from the folders
  // codexWindowsPathFolders reads, each asked nothing more in this lookup
  // once it could not be read.
  const env = lookup.env ?? process.env
  const isFile = lookup.isFile
  const stat: (p: string) => CodexCandidateStat = lookup.statFile ?? (isFile ? (p) => (isFile(p) ? 'file' : 'none') : diskStat)
  const { listed, unlisted } = codexWindowsForms(winEnvValue(env, 'PATHEXT'))
  const folders = codexWindowsPathFolders(winEnvValue(env, 'PATH'))
  const unreachable = new Set<string>()
  for (const forms of [listed, unlisted]) {
    for (const dir of folders) {
      if (unreachable.has(dir)) continue
      for (const name of forms) {
        const candidate = path.win32.join(dir, name)
        const found = stat(candidate)
        if (found === 'file') return { cmd: candidate, args: [] }
        if (found === 'unreachable') {
          unreachable.add(dir)
          break
        }
      }
    }
  }
  return null
}

/** Where the resume picker's node is looked for (tests pass their own). */
export interface NodeExeLookup {
  /** Default: this machine's. */
  platform?: NodeJS.Platform
  /** Default: this process's environment (Windows: its PATH). */
  env?: Readonly<Record<string, string | undefined>>
  /** What one look at a candidate found (default: the disk). */
  statFile?: (p: string) => CodexCandidateStat
}

/**
 * The node the resume picker runs on, by full path. Bare 'node' fails under
 * node-pty / ConPTY because Windows PTY spawn does NOT consult PATH the
 * same way child_process.spawn does -- it throws synchronously with
 * "File not found:" before any onExit/onData handler can fire (verified
 * empirically against the pinned node-pty version).
 *
 * Windows: the first of PATH's fully qualified folders holding node.exe, in
 * PATH's order (codexWindowsPathFolders: a relative entry, and so the
 * current folder, is never searched), read in this process with no shell and
 * no process started; a folder that does not answer is asked nothing more in
 * that lookup (as resolveCodexBinary). Kept for later lookups under the same
 * PATH. None found: null, never the bare name, which would be looked up
 * outside the folders PATH names in full; the launch refuses with
 * PICKER_NODE_NOT_ON_PATH.
 *
 * macOS and Linux: bare 'node' works under a PTY (execvp looks PATH up), but
 * an app started from Finder or the Dock has launchd's minimal PATH, so the
 * absolute path comes from a login shell; cached on the first that answers.
 */
let cachedNodeExe: string | null = null
let cachedWindowsNodeExe: { pathVar: string; exe: string } | null = null
export function resolveNodeExe(lookup: NodeExeLookup = {}): string | null {
  if ((lookup.platform ?? os.platform()) !== 'win32') {
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
  const pathVar = winEnvValue(lookup.env ?? process.env, 'PATH') ?? ''
  if (cachedWindowsNodeExe && cachedWindowsNodeExe.pathVar === pathVar) return cachedWindowsNodeExe.exe
  const stat = lookup.statFile ?? diskStat
  const unreachable = new Set<string>()
  for (const dir of codexWindowsPathFolders(pathVar)) {
    if (unreachable.has(dir)) continue
    const candidate = path.win32.join(dir, 'node.exe')
    const found = stat(candidate)
    if (found === 'file') {
      cachedWindowsNodeExe = { pathVar, exe: candidate }
      return candidate
    }
    if (found === 'unreachable') unreachable.add(dir)
  }
  return null
}

/** What a launch through the resume list says on Windows when no node.exe is
 *  in a folder PATH names in full: it starts nothing. */
export const PICKER_NODE_NOT_ON_PATH = 'The resume list needs node, which was not found in a folder PATH names (node.exe)'

/** Test-only: reset the node.exe resolution cache. */
export function __resetNodeExeCache(): void {
  cachedNodeExe = null
  cachedWindowsNodeExe = null
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

/** A folder cmd.exe cannot start in: a share or a device path (two leading
 *  slashes of either kind). The npm launcher is never started there. */
const CMD_EXE_NETWORK_FOLDER_RE = /^[\\/]{2}/
/** Why a launch through the npm launcher in such a folder is refused (the
 *  resume picker says the same, scripts/lib/codex-resume-picker-lib.js). */
export const CODEX_NETWORK_FOLDER_REFUSAL = 'Cannot start Codex in a network folder through its npm launcher: open the folder from a mapped drive letter, or install the standalone Codex.'

/** Refuses, with the reason, a launch that would start the npm launcher
 *  through cmd.exe in a folder cmd.exe cannot start in. */
function refuseCmdExeNetworkFolder(viaCmdExe: boolean, folder: string | undefined): void {
  if (viaCmdExe && typeof folder === 'string' && CMD_EXE_NETWORK_FOLDER_RE.test(folder)) throw new Error(CODEX_NETWORK_FOLDER_REFUSAL)
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
 *  offered; Auto ("Workspace writes, no prompts") with Claude's Auto, for
 *  which the app approves none of these tools (a Claude session's allow list
 *  is the same two in every mode; Claude Code's own auto mode decides each
 *  call), so Auto gets no key until OR4's check of a real Claude session in
 *  Auto mode: there Codex runs with `--ask-for-approval never`, cannot ask,
 *  and refuses these calls (the PR 4 VM checkpoint, both versions; the
 *  Feature Guide's known issues say so, with the workaround). Read Only,
 *  Standard and Plan keep Codex's prompt, as Claude's Ask, Accept edits and
 *  Plan mode ask. Nothing wider: never a server-wide default, never a session
 *  or always approval. */
export function codexPresetApprovedTools(preset: string, switches: ConductorToolSwitches): string[] {
  if (preset !== 'unrestricted') return []
  return CODEX_CONDUCTOR_TOOLS
    .filter((t) => t.offered(switches) && !CODEX_PREALLOWED_TOOLS.includes(t.name))
    .map((t) => t.name)
}

/** Set a variable main owns, removing every other spelling of it first: on
 *  Windows names are case-insensitive and a child reads the FIRST match in
 *  its environment block, so an inherited `conductor_mcp_token` would
 *  otherwise shadow the value set here. */
function setOwned(env: Record<string, string>, name: string, value: string, win32: boolean): void {
  if (win32) for (const k of Object.keys(env)) if (k !== name && k.toUpperCase() === name.toUpperCase()) delete env[k]
  env[name] = value
}

/** Remove a variable: every spelling of it on Windows (names are
 *  case-insensitive there), the one exact name elsewhere. */
function dropVariable(env: Record<string, string>, name: string, win32: boolean): void {
  for (const k of Object.keys(env)) if (win32 ? k.toUpperCase() === name.toUpperCase() : k === name) delete env[k]
}

/** The variables that name a repository for git, whatever folder it starts
 *  in. */
const GIT_REPOSITORY_VARS: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']

/** WP2 PR 4, P4.3: the most an Ask launch's `project_doc_max_bytes` may be
 *  (the help folder's AGENTS.md is the user guide and a preamble, far below). */
export const ASK_PROJECT_DOC_MAX_BYTES_CEILING = 16 * 1024 * 1024

/** Where git stops for an Ask launch: the help folder's parent, so git
 *  looks for a repository in the help folder itself and in no folder above
 *  it, wherever the resources folder sits. GIT_CEILING_DIRECTORIES is a list
 *  (`;` on Windows, `:` elsewhere), so a parent whose path holds that
 *  separator or a control character, or a help folder that is not an
 *  absolute path, cannot be bounded and refuses the launch, saying what to
 *  change. The parent is the resources folder (the help folder is its
 *  `help`, help-workspace.ts). */
export function askGitCeiling(helpFolder: string | undefined, win32: boolean): string {
  if (typeof helpFolder !== 'string' || !(win32 ? windowsPathFolderIsFullyQualified(helpFolder) : helpFolder.startsWith('/'))) {
    throw new Error('Cannot start Ask Conductor on Codex: its help folder is not an absolute path.')
  }
  const parent = (win32 ? path.win32 : path.posix).dirname(helpFolder)
  const separator = win32 ? ';' : ':'
  if (parent.includes(separator)) {
    throw new Error(`Cannot start Ask Conductor on Codex: the resources folder's path holds a '${separator}', which git reads as a list of folders: choose a resources folder whose path has none.`)
  }
  if (hasControl(parent)) {
    throw new Error('Cannot start Ask Conductor on Codex: the resources folder\'s path holds a control character: choose a resources folder whose path has none.')
  }
  return parent
}

/** The Ask question's bound (askConductor.ts MAX_QUESTION, the pty:spawn
 *  schema's askPrompt). */
const ASK_QUESTION_MAX = 8_000

/** WP2 PR 4, P4.3: whether an Ask question may ride argv. Argv keeps every
 *  character (PB4); a control character never rides it (the renderer's
 *  normaliseQuestion removes them; one that reaches main is typed through the
 *  pane instead, whose rule refuses it visibly). Nor does a lone surrogate
 *  (half of an emoji's pair, review RASK-3): argv on Windows would hand Codex
 *  text that is not Unicode, which it refuses as an argument; through the pane
 *  it is removed with the characters the prompt drops, and the dock told. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
function askQuestionForArgv(q: unknown): q is string {
  return typeof q === 'string' && q.trim().length > 0 && q.length <= ASK_QUESTION_MAX && !/[\u0000-\u001f\u007f-\u009f]/.test(q) && !LONE_SURROGATE_RE.test(q)
}

/** The Windows command line node-pty builds from a file and its arguments
 *  (its lib/windowsPtyAgent.js argsToCommandLine, node-pty 1.2.0-beta.15):
 *  an argument holding a space or a tab is quoted unless it already starts
 *  AND ends with a double quote, and every double quote is escaped. Mirrored
 *  here so a launch can check what the process will read; the tests pin it to
 *  node-pty's own function. */
export function nodePtyWindowsCommandLine(file: string, args: readonly string[]): string {
  return [file, ...args].map((arg) => {
    const opens = arg[0] === '"'
    const closes = arg[arg.length - 1] === '"'
    const quote = arg === '' || ((arg.includes(' ') || arg.includes('\t')) && arg.length > 1 && !(opens && closes))
    let out = quote ? '"' : ''
    let backslashes = 0
    for (const c of arg) {
      if (c === '\\') { backslashes++; continue }
      out += c === '"' ? '\\'.repeat(backslashes * 2 + 1) + '"' : '\\'.repeat(backslashes) + c
      backslashes = 0
    }
    return out + (quote ? '\\'.repeat(backslashes * 2) + '"' : '\\'.repeat(backslashes))
  }).join(' ')
}

/** A Windows command line split into arguments as a Microsoft C or Rust
 *  program splits it (the CommandLineToArgvW rules): the program name up to
 *  its closing quote or the first space or tab; after it, 2n backslashes and
 *  a quote are n backslashes and a quote that opens or closes, 2n+1 and a
 *  quote are n backslashes and a literal quote, other backslashes are
 *  literal. Two quotes inside a quoted part, which the parsers in use read
 *  differently, give null: the line cannot be vouched for. */
export function splitWindowsCommandLine(line: string): string[] | null {
  const out: string[] = []
  const blank = (c: string | undefined): boolean => c === ' ' || c === '\t'
  let i = 0
  let name = ''
  if (line[0] === '"') {
    const end = line.indexOf('"', 1)
    name = end < 0 ? line.slice(1) : line.slice(1, end)
    i = end < 0 ? line.length : end + 1
  } else {
    while (i < line.length && !blank(line[i])) name += line[i++]
  }
  out.push(name)
  let cur = ''
  let started = false
  let quoted = false
  while (i < line.length) {
    const c = line[i]
    if (blank(c) && !quoted) {
      if (started) out.push(cur)
      cur = ''
      started = false
      i++
      continue
    }
    started = true
    if (c === '\\') {
      let n = 0
      while (line[i] === '\\') { n++; i++ }
      if (line[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2))
        if (n % 2 === 1) { cur += '"'; i++ }
      } else {
        cur += '\\'.repeat(n)
      }
      continue
    }
    if (c === '"') {
      if (quoted && line[i + 1] === '"') return null
      quoted = !quoted
      i++
      continue
    }
    cur += c
    i++
  }
  if (started) out.push(cur)
  return out
}

/** Whether node-pty's Windows command line for `file` and `args` splits back
 *  into exactly those arguments. */
export function windowsArgvRoundTrips(file: string, args: readonly string[]): boolean {
  const split = splitWindowsCommandLine(nodePtyWindowsCommandLine(file, args))
  return split !== null && split.length === args.length + 1 && args.every((a, i) => split[i + 1] === a)
}

/** A file Windows runs through cmd.exe: a batch file, its name read as
 *  Windows reads it (trailing dots and spaces dropped). */
const WIN_BATCH_NAME_RE = /\.(bat|cmd)[. ]*$/i

/** ADR-009 round 1 (PR 4): whether the question survives the launch as ONE
 *  argument. Elsewhere node-pty hands the process its arguments as they are;
 *  on Windows it joins them into one command line that codex.exe splits again,
 *  so there the question rides argv only when it holds no double quote, the
 *  executable is started directly (never a batch file, which Windows hands to
 *  cmd.exe to read the line again), and the line splits back into exactly
 *  these arguments. A question that does not is typed through the pane
 *  instead, as one holding a control character is. */
function askArgvSurvives(executable: string, args: readonly string[], win32: boolean): boolean {
  if (!win32) return true
  const question = args[args.length - 1]
  if (typeof question !== 'string' || question.includes('"')) return false
  if (WIN_BATCH_NAME_RE.test(executable)) return false
  return windowsArgvRoundTrips(executable, args)
}

/** The Codex launch for `opts`, with the line the app's log may hold
 *  (`logLine`): an Ask question carried on argv named only by its length,
 *  never its words (P4.3, as Claude's route keeps the question off its logged
 *  line by environment reference). The PTY manager logs that line, never the
 *  arguments themselves. */
export function buildCodexSpawn(opts: SpawnOptions): ProviderSpawnCommand {
  const built = buildCodexSpawnCommand(opts)
  const q = opts.askPrompt
  let shown: string[] = built.args
  if (built.askPromptOnArgv) {
    const n = built.args.length
    // Always the last argument, right after `--` (built that way below).
    if (typeof q !== 'string' || n < 2 || built.args[n - 2] !== '--' || built.args[n - 1] !== q) {
      return { ...built, logLine: '(arguments not logged)' }
    }
    shown = [...built.args.slice(0, n - 1), `<question, ${[...q].length} characters>`]
  }
  return { ...built, logLine: built.commandLine ?? shown.join(' ') }
}

function buildCodexSpawnCommand(opts: SpawnOptions): ProviderSpawnCommand {
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
  // WP2 PR 4, P4.3 (row 53): an Ask Conductor session reads the app's own
  // AGENTS.md in the app's help folder whole (on Windows it carries the user
  // guide inline) and no parent folder's beside it, as the `analysis`
  // operation scopes its own (cli-runner.ts): the file's byte bound
  // (help-workspace.ts askConductorProjectDocMaxBytes) and no root markers.
  // Plain words, so both routes take them. They override what the user may
  // have set, for the Ask session only, and change no file.
  if (opts.askProjectDocMaxBytes !== undefined) {
    const n = opts.askProjectDocMaxBytes
    if (!Number.isSafeInteger(n) || n <= 0 || n > ASK_PROJECT_DOC_MAX_BYTES_CEILING) {
      throw new Error('Cannot start Ask Conductor on Codex: the size of its instruction file is not a byte count.')
    }
    flags.push('-c', `project_doc_max_bytes=${n}`, '-c', 'project_root_markers=[]')
  }

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
  // per spawn, the one checked way every reader reads them
  // (conductor-tools-switch.ts): settings that are there but cannot be read
  // keep the built-in tools off until they can. Port 0 (server unbound)
  // behaves identically.
  const tools = readConductorToolSwitches()
  const spawnSettings: ConductorToolSwitches = { conductorToolsEnabled: tools.master, conductorTools: tools.switches ?? {} }
  const conductorOn = tools.master
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
    // annotations under Read Only, Standard and Plan; under Auto
    // (`--ask-for-approval never`) it cannot ask and refuses such a call (the
    // PR 4 VM checkpoint). The two Claude pre-allows in every mode run without
    // asking on every preset; under a preset whose matching Claude mode asks
    // before nothing, every tool the connection is offered does too
    // (codexPresetApprovedTools). Per tool, never server-wide.
    for (const tool of CODEX_PREALLOWED_TOOLS) flags.push('-c', codexToolApprovalArg(tool))
    presetKeyArgs = codexPresetApprovedTools(co.permissionsPreset, spawnSettings).flatMap((tool) => ['-c', codexToolApprovalArg(tool)])
    presetKeysAt = flags.length
    flags.push(...presetKeyArgs)
    // The canvas and browser skills are not on this line: they are in the
    // account's own skills folder (section 10 question 5, answered C;
    // src/main/canvas/codex-guidance.ts), which Codex lists on every route.
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
  // NoDefaultCurrentDirectoryInExePath=1, so cmd.exe resolves a program name
  // from PATH.
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
  // alone are left off, with a log line, and the session still launches;
  // nothing else is dropped. Those keys exist only under Unrestricted, which
  // launches with no approval prompts, so without them those tools are
  // refused, not asked about (review RVMFIX-2); canvas_snapshot and
  // canvas_review keep theirs. `prefix`: what goes before the flags on that
  // line (an exact resume's `resume <id>`).
  const fitCmdLine = (prefix: string[]): string[] => {
    if (!viaCmdExe || presetKeyArgs.length === 0 || presetKeysAt < 0) return flags
    let line: string
    try { line = codexCmdExeTarget(executable, [...prefix, ...flags], env).commandLine } catch { return flags }
    if (line.length < CMD_EXE_LINE_MAX) return flags
    logWarn(`[codex-spawn] ${opts.sessionId}: the per-preset tool approvals are left off this launch: with them its cmd.exe line would be ${line.length} characters (cmd.exe takes under ${CMD_EXE_LINE_MAX}); its conductor tools other than canvas_snapshot and canvas_review are refused (this preset runs without approval prompts)`)
    return [...flags.slice(0, presetKeysAt), ...flags.slice(presetKeysAt + presetKeyArgs.length)]
  }

  // P3.5 (rows 34, 35): an exact resume, as Claude's `claude --resume <uuid>`
  // (resolveResumeLaunch): the conversation's rollout must be in THIS realm's
  // sessions folder, and the CLI starts in the directory the conversation ran
  // in when that still holds (resolveCodexResume). It bypasses the picker, as
  // Claude's exact resume does. A miss falls back to the picker or a fresh
  // start, never to another account's conversation.
  const resumed = opts.resume ? resolveCodexResume(opts.resume, { sessionsDir: launch.sessionsDir, configuredCwd: opts.cwd ?? '' }) : null
  // Ask's conversation list stays inside its help folder (every route: the
  // CLI, and the picker with the git it runs, inherit this environment):
  // git stops at the parent of the folder the launch starts in (askGitCeiling)
  // -- the help folder, or on an exact resume the conversation's own folder,
  // which an Ask launch holds to the help folder (pty-manager). Git finds a
  // repository only from where it starts: an Ask launch carries none of the
  // variables that name one, in any spelling.
  if (opts.askProjectDocMaxBytes !== undefined) {
    for (const name of GIT_REPOSITORY_VARS) dropVariable(env, name, win32)
    setOwned(env, 'GIT_CEILING_DIRECTORIES', askGitCeiling((resumed?.cwd || undefined) ?? opts.cwd, win32), win32)
  }
  if (resumed) {
    // The id goes into argv: only a conversation id ever does, whatever the
    // lookup answered (the spawn schema and the lookup check it first).
    if (!CODEX_CONVERSATION_ID_RE.test(resumed.resumeId)) {
      throw new Error('Cannot resume the Codex conversation: its id is not a conversation id.')
    }
    const args = ['resume', resumed.resumeId, ...fitCmdLine(['resume', resumed.resumeId])]
    const cwd = resumed.cwd || undefined
    // Where it starts: the conversation's folder, else the configured one.
    refuseCmdExeNetworkFolder(viaCmdExe, cwd ?? opts.cwd)
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
      // line may resume a conversation (`resume <id>` before the flags). The
      // picker itself (node) starts in any folder; where it would start the
      // npm launcher in a network folder, it refuses that with the reason.
      const pickerFlags = fitCmdLine(['resume', '00000000-0000-0000-0000-000000000000'])
      if (viaCmdExe) codexCmdExeTarget(executable, pickerFlags, env)
      // Bare 'node' fails under node-pty/ConPTY on Windows (no PATH lookup):
      // the full node.exe path, from the folders this session's own PATH
      // names (resolveNodeExe), looked up for the platform this launch is
      // built for. None there: nothing starts, before anything is made for it.
      const nodeExe = resolveNodeExe({ env, platform: process.platform })
      if (!nodeExe) throw new Error(PICKER_NODE_NOT_ON_PATH)
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
      return { cmd: nodeExe, args: [pickerScript, ...pickerFlags], env: pickerEnv, ...(pickFile && pickFolder ? { pickFile, pickFolder } : {}), hooksInstalled }
    }
    // Fallthrough: picker missing, spawn codex directly.
  }

  if (viaCmdExe) {
    // node-pty / ConPTY cannot directly invoke .cmd shims; route through cmd.exe.
    // P4.3: an Ask question never rides this line (it refuses whitespace and
    // every character cmd.exe interprets); main types it through the pane.
    // Never in a folder cmd.exe cannot start in (it would start elsewhere).
    refuseCmdExeNetworkFolder(viaCmdExe, opts.cwd)
    const target = codexCmdExeTarget(executable, fitCmdLine([]), env)
    return { cmd: target.cmd, args: [], commandLine: target.commandLine, env, hooksInstalled }
  }
  // WP2 PR 4, P4.3 (PB4): on the direct route an Ask question is the launch's
  // prompt, after `--`, so a question that starts with "-" is never read as a
  // flag, and as ONE argument, whole (8,000 characters, an emoji included,
  // arrived intact on both versions). Only on this fresh launch, the form PB4
  // ran: an exact resume or the picker gets it through the pane instead, and
  // so does a question the Windows command line would not keep as one
  // argument (askArgvSurvives).
  if (askQuestionForArgv(opts.askPrompt)) {
    const args = [...flags, '--', opts.askPrompt]
    if (askArgvSurvives(executable, args, win32)) return { cmd: executable, args, env, hooksInstalled, askPromptOnArgv: true }
  }
  return { cmd: executable, args: flags, env, hooksInstalled }
}
