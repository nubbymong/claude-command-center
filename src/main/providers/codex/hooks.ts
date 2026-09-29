/**
 * P3.10 (rows 43, 46, 47, 63): Codex's own hook events reach the app's Hooks
 * gateway, as Claude Code's do.
 *
 * Codex runs a hook as a COMMAND (its handler types are command, mcp_tool,
 * prompt and agent; there is no http handler), with the event's JSON on
 * stdin (P3.1 evidence, answer 4). So the app gives each Codex launch the
 * same small set of command hooks through `-c` (session flags: nothing is
 * written to the account's config.toml by the app), each running the app's
 * forwarder script, which posts the event to the loopback gateway with the
 * session's token, exactly as a Claude Code http hook does.
 *
 * Evidence (the P3.10 VM probe of the real 0.153.4 and 0.155.1 TUIs; the
 * P3.1 record's addendum 14):
 *  - hooks given by `-c` are "Session flags" hooks and need the user's
 *    review before they run: Codex's own "Hooks need review" screen, once;
 *    the trust it records (in the account folder's config.toml, keyed by the
 *    hook's event and position and a hash of the hook itself) lasts while the
 *    hook is unchanged. So the command is the SAME for every session of this
 *    install: nothing session-specific is on it. The session is named by the
 *    environment the hook inherits from Codex (CLAUDE_MULTI_SESSION_ID, and
 *    CCC_CODEX_HOOK_FILE, the path of a file only this user can read that
 *    holds the gateway port and the session's token); the token is never on
 *    a command line.
 *  - on Windows Codex runs the command through PowerShell; a bare path to a
 *    .cmd file runs, and so does a quoted script path;
 *  - `async = true` is accepted: Codex does not wait for the hook, and its
 *    output is not read, so a hook can never block a turn, decide an
 *    approval or add to the model's context;
 *  - SessionStart comes with a conversation's first turn (a new one, or one
 *    resumed in the TUI), with `transcript_path`, the exact rollout.
 *
 * `--dangerously-bypass-hook-trust` is never used: it would run every hook
 * unreviewed, a repository's own included, for the whole session.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { atomicWriteFileSync } from '../../atomic-write'
import { codexFolderIdentity } from './rollout-lookup'
import type { PickFolderIdentity } from '../types'

/** The Codex hook events the app listens to: the conversation's start (the
 *  exact claim), a prompt sent, a tool about to run and one that ran, an
 *  approval asked for, and a turn's end. */
export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop'] as const
export type CodexHookEvent = typeof CODEX_HOOK_EVENTS[number]

/** Seconds Codex gives one hook run before it stops it. */
export const CODEX_HOOK_TIMEOUT_SEC = 10
/** The forwarder, and its Windows wrapper, in `<resourcesDir>/scripts/`. */
export const CODEX_HOOK_SCRIPT = 'ccc-codex-hook.js'
export const CODEX_HOOK_WRAPPER = 'ccc-codex-hook.cmd'
/** The variable naming the session's hook file. */
export const CODEX_HOOK_FILE_ENV = 'CCC_CODEX_HOOK_FILE'
/** The per-launch folder holding the hook file, and the file's name. */
export const CODEX_HOOK_DIR_PREFIX = 'ccc-codex-hook-'
export const CODEX_HOOK_FILE_NAME = 'hook.json'
/** The header the forwarder sends so the gateway never holds a Codex
 *  request open (a Claude PermissionRequest is held for a decision; Codex's
 *  hook is async and its answer is never read). Lowers what a request may
 *  do; it grants nothing. */
export const CODEX_HOOK_CLIENT_HEADER = 'x-ccc-hook-client'
export const CODEX_HOOK_CLIENT = 'codex'

/** A session id as the gateway routes it (its URL pattern). */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
/** A gateway token as the gateway mints it (a UUID); the forwarder checks the same. */
const TOKEN_RE = /^[A-Za-z0-9-]{16,256}$/
/** A control character anywhere. */
const CONTROL_RE = /[\x00-\x1f\x7f]/
/** A quote PowerShell ends a single-quoted string at: the ASCII one and its
 *  four typographic look-alikes. */
const PS_QUOTE_RE = /['\u2018\u2019\u201a\u201b]/
/** A Windows path that cmd.exe and PowerShell both take as one plain word:
 *  a drive, then letters, digits and `_ . - \` only (no space, no quote, no
 *  character either shell gives a meaning). */
const PLAIN_WIN_PATH_RE = /^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/

/**
 * The command every Codex hook of this install runs, or null when none can
 * be given safely (then the launch gets no hooks, and says so in the log).
 *  - Windows: the wrapper by its bare path when that is a plain word (the
 *    only form a launch through the npm .cmd shim can carry: cmd.exe refuses
 *    a quote or a space in an argument, `codexCmdExeTarget`); otherwise,
 *    on a direct launch only, PowerShell's call of the single-quoted path;
 *  - elsewhere: node with the single-quoted script path.
 * A path holding a quote or a control character gets no command.
 */
export function codexHookCommand(scriptsDir: string, platform: NodeJS.Platform, viaCmdExe: boolean): string | null {
  if (typeof scriptsDir !== 'string' || !scriptsDir) return null
  if (platform === 'win32') {
    const wrapper = path.win32.join(scriptsDir, CODEX_HOOK_WRAPPER)
    if (!path.win32.isAbsolute(wrapper) || CONTROL_RE.test(wrapper)) return null
    if (PLAIN_WIN_PATH_RE.test(wrapper) && !wrapper.split('\\').includes('..')) return wrapper
    if (viaCmdExe || PS_QUOTE_RE.test(wrapper)) return null
    return `& '${wrapper}'`
  }
  const script = path.posix.join(scriptsDir, CODEX_HOOK_SCRIPT)
  if (!path.posix.isAbsolute(script) || script.includes("'") || CONTROL_RE.test(script)) return null
  return `node '${script}'`
}

/** A TOML string holding `s`: a literal string (no escapes, no double quote)
 *  when `s` holds no single quote, else a basic string with `\` and `"`
 *  escaped. */
function tomlString(s: string): string {
  if (!s.includes("'")) return `'${s}'`
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The `-c` overrides that give a launch the app's hooks: one per event,
 *  each the one command, asynchronous, with a bounded timeout. */
export function codexHookConfigArgs(command: string): string[] {
  const value = tomlString(command)
  const out: string[] = []
  for (const ev of CODEX_HOOK_EVENTS) {
    out.push('-c', `hooks.${ev}=[{hooks=[{type='command',command=${value},timeout=${CODEX_HOOK_TIMEOUT_SEC},async=true}]}]`)
  }
  return out
}

/** A launch's hook file: where it is, and its folder as made. */
export interface CodexHookFile {
  dir: string
  file: string
  folder: PickFolderIdentity
}

/**
 * Write the session's hook file: a folder of its own, made for this launch
 * with an unguessable name (owner-only where the platform keeps modes; the
 * user's own temp folder on Windows), holding `hook.json` written whole and
 * owner-only: the gateway's port, the session id and its token. Null when
 * any part is not what the gateway would route, or the write fails.
 */
export function writeCodexHookFile(sessionId: string, port: number, secret: string, tmpRoot: string = os.tmpdir()): CodexHookFile | null {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (typeof secret !== 'string' || !TOKEN_RE.test(secret)) return null
  let dir: string
  try {
    dir = fs.mkdtempSync(path.join(tmpRoot, CODEX_HOOK_DIR_PREFIX))
  } catch {
    return null
  }
  const folder = codexFolderIdentity(dir)
  if (!folder) {
    try { fs.rmdirSync(dir) } catch { /* left empty */ }
    return null
  }
  const file = path.join(dir, CODEX_HOOK_FILE_NAME)
  try {
    atomicWriteFileSync(file, JSON.stringify({ v: 1, port, sid: sessionId, token: secret }), { mode: 0o600 })
  } catch {
    removeCodexHookFile({ dir, file, folder })
    return null
  }
  return { dir, file, folder }
}

/** The staging names atomicWriteFileSync uses for `hook.json`. */
const STAGING_RE = new RegExp(`^${CODEX_HOOK_FILE_NAME.replace('.', '\\.')}\\.[0-9a-f-]{36}\\.tmp$`)

/** Empty the folder of what the app put there and remove it: only while it is
 *  still the folder made for the launch (the same device and file id, the
 *  same real path, not a link or junction), only the hook file and its
 *  staging leftovers, and never recursively: anything else keeps it. */
export function removeCodexHookFile(h: CodexHookFile): void {
  const now = codexFolderIdentity(h.dir)
  if (!now || now.id !== h.folder.id || now.real !== h.folder.real) return
  if (!path.basename(h.dir).startsWith(CODEX_HOOK_DIR_PREFIX)) return
  emptyHookFolder(h.dir)
  try { fs.rmdirSync(h.dir) } catch { /* not empty, or gone */ }
}

function emptyHookFolder(dir: string): void {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (!e.isFile()) continue
    if (e.name !== CODEX_HOOK_FILE_NAME && !STAGING_RE.test(e.name)) continue
    try { fs.unlinkSync(path.join(dir, e.name)) } catch { /* gone */ }
  }
}

/** How old a left-behind hook folder must be before a sweep removes it: a
 *  launch that crashed, or an app that quit without its exit handler. */
export const CODEX_HOOK_STALE_MS = 24 * 3600 * 1000

/** Remove hook folders a crash or a quit left behind in `tmpRoot`: its own
 *  prefix, real folders only (never a link or junction), older than
 *  CODEX_HOOK_STALE_MS, emptied as removeCodexHookFile does. Returns how
 *  many were removed. */
export function sweepStaleCodexHookFolders(tmpRoot: string = os.tmpdir(), now: number = Date.now(), maxAgeMs: number = CODEX_HOOK_STALE_MS): number {
  let removed = 0
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(tmpRoot, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(CODEX_HOOK_DIR_PREFIX)) continue
    const dir = path.join(tmpRoot, e.name)
    let st: fs.Stats
    try { st = fs.lstatSync(dir) } catch { continue }
    if (!st.isDirectory() || st.isSymbolicLink()) continue
    if (now - st.mtimeMs < maxAgeMs) continue
    emptyHookFolder(dir)
    try { fs.rmdirSync(dir); removed++ } catch { /* not empty, or gone */ }
  }
  return removed
}

/** Copy the forwarder and its Windows wrapper into `<resourcesDir>/scripts/`
 *  (packaged beside the resume picker; see resume-picker.ts for the source
 *  root). */
export async function deployCodexHookScripts(resourcesDir: string, sourceRoot?: string): Promise<void> {
  const scriptsDir = path.join(resourcesDir, 'scripts')
  if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir, { recursive: true })
  for (const name of [CODEX_HOOK_SCRIPT, CODEX_HOOK_WRAPPER]) {
    const src = sourceRoot ? path.join(sourceRoot, 'scripts', name) : path.join(__dirname, '../../scripts', name)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(scriptsDir, name))
  }
}
