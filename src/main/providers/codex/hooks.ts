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
import * as path from 'path'
import { createHash } from 'crypto'
import { atomicWriteFileSync } from '../../atomic-write'
import { codexFolderIdentity } from './rollout-lookup'
import { CMD_UNSAFE_PATH_RE } from './cli-runner'
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
/** P3.10 round 1 (A5): the folder inside the app's own data folder that
 *  holds the per-launch hook folders: `<data>/codex-hooks/ccc-codex-hook-*`.
 *  The data folder is this install's own (a dev build, the installed app and
 *  a test run each have theirs); not the resources folder (it may sit inside
 *  a project folder). The forwarder
 *  checks the same layout (scripts/ccc-codex-hook.js ROOT_NAME). */
export const CODEX_HOOK_ROOT_NAME = 'codex-hooks'
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
/** P3.10 round 1 (A2): the characters PowerShell reads as a wildcard in the
 *  path of `& '<path>'`. Windows PowerShell 5.1 resolves the call through
 *  them, so `res[1]` runs a wrapper in a sibling `res1` folder. */
const PS_WILDCARD_RE = /[[\]*?]/
/** P3.10 round 1 (A3): PowerShell hands the .cmd wrapper to cmd.exe, which
 *  expands `%` inside the quoted path (CMD_UNSAFE_PATH_RE, as the npm shim's
 *  route refuses it), and `!` where the user's registry turns delayed
 *  expansion on (that call carries no /v:off). */
const CMD_DELAYED_RE = /!/
/** A Windows path that cmd.exe and PowerShell both take as one plain word:
 *  a drive, then letters, digits and `_ . - \` only (no space, no quote, no
 *  character either shell gives a meaning). */
const PLAIN_WIN_PATH_RE = /^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/

function isPlainWinPath(p: string): boolean {
  return PLAIN_WIN_PATH_RE.test(p) && !p.split('\\').includes('..')
}

/**
 * The command every Codex hook of this install runs, or null when none can
 * be given safely (then the launch gets no hooks, and says so in the log).
 *  - Windows: the wrapper by its bare path when that is a plain word (the
 *    only form a launch through the npm .cmd shim can carry: cmd.exe refuses
 *    a quote or a space in an argument, `codexCmdExeTarget`); otherwise,
 *    on a direct launch only, PowerShell's call of the single-quoted path,
 *    never for a path PowerShell would read as a wildcard or cmd.exe would
 *    expand (P3.10 round 1: A2, A3);
 *  - elsewhere: node with the single-quoted script path.
 * A path holding a quote or a control character gets no command.
 */
export function codexHookCommand(scriptsDir: string, platform: NodeJS.Platform, viaCmdExe: boolean): string | null {
  if (typeof scriptsDir !== 'string' || !scriptsDir) return null
  if (platform === 'win32') {
    const wrapper = path.win32.join(scriptsDir, CODEX_HOOK_WRAPPER)
    if (!path.win32.isAbsolute(wrapper) || CONTROL_RE.test(wrapper)) return null
    if (isPlainWinPath(wrapper)) return wrapper
    if (viaCmdExe || PS_QUOTE_RE.test(wrapper) || PS_WILDCARD_RE.test(wrapper) || CMD_UNSAFE_PATH_RE.test(wrapper) || CMD_DELAYED_RE.test(wrapper)) return null
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

/** Paths compared as the platform's file system compares them. */
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin'
function samePathText(a: string, b: string): boolean {
  return FOLD_CASE ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Every folder below `top` down to `dir` is a real folder: none is a link or
 * a junction, and each one's real path is its parent's real path and its own
 * name. `top` itself (a folder the user or the system chose, which may be
 * reached through a link) is not inspected. False on any doubt.
 */
export function realFolderChainBelow(top: string, dir: string): boolean {
  const rel = path.relative(top, dir)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
  let parentReal: string
  try { parentReal = fs.realpathSync.native(top) } catch { return false }
  let at = top
  for (const part of rel.split(path.sep)) {
    at = path.join(at, part)
    let st: fs.Stats
    try { st = fs.lstatSync(at) } catch { return false }
    if (!st.isDirectory() || st.isSymbolicLink()) return false
    let real: string
    try { real = fs.realpathSync.native(at) } catch { return false }
    if (!samePathText(real, path.join(parentReal, part))) return false
    parentReal = real
  }
  return true
}

/** Round 4 (P1, P2): the app's owner-only rule for the hook folders
 *  (injected; src/main/owner-only-folders.ts secureOwnerOnlyFolders). Given
 *  folders in order it makes each missing one inside its parent, makes each
 *  this user's and owner-only, reads each back, and says per folder whether
 *  it now is exactly that (the user and SYSTEM, the Administrators group
 *  accepted; owned by the user; nothing inherited from above). Asynchronous:
 *  on Windows one Windows PowerShell call for every folder, never on the main
 *  thread's path; never at a launch (see preparedCodexHookRoot). */
export type SecureHookFolders = (dirs: readonly string[]) => Promise<ReadonlyArray<{ dir: string; ok: boolean; detail?: string }>>

/** What a preparation works on: the app's data folder (for `codex-hooks`),
 *  the resources folder's scripts (the source of the plain copies) and, when
 *  this install's launch route needs one, the plain-copy folder. */
export interface CodexHookFolderPlan {
  dataDir: string
  scriptsDir: string
  plainDir: string | null
}

/** A preparation's outcome: the hook root ready or not; the plain copy
 *  staged, not, or not asked for (null); `ran`, whether the rule was asked
 *  (false: still ready from before); `detail`, the rule's reasons. */
export interface CodexHookFolderOutcome {
  root: boolean
  plain: boolean | null
  ran: boolean
  detail: string[]
}

/** A folder's identity (its volume and file index), or null when the file
 *  system gives none (round 3, F4). */
function folderIdentity(dir: string): string | null {
  try {
    const st = fs.lstatSync(dir, { bigint: true })
    return st.ino ? `${st.dev}:${st.ino}` : null
  } catch {
    return null
  }
}

/** On POSIX: the folder is this user's and no one else's (0700). */
function ownerOnlyPosix(dir: string): boolean {
  if (process.platform === 'win32') return true
  try {
    fs.chmodSync(dir, 0o700)
    const st = fs.lstatSync(dir)
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false
    return (st.mode & 0o077) === 0
  } catch {
    return false
  }
}

/** Whether something is at `p` (a link counts, and is not followed). */
function presentNoFollow(p: string): boolean {
  try { fs.lstatSync(p); return true } catch { return false }
}

/** Round 5 (G3): how long a preparation that left no hook root is the answer
 *  for the same folders before the rule is asked again (other folders asked
 *  for are prepared at once). Every launch and every change the accounts
 *  service announces asks; meanwhile they get the answer at once. */
export const CODEX_HOOK_FOLDERS_RETRY_MS = 5 * 60_000

/** Round 4: what this run prepared: the plan's key, the hook root with the
 *  identity of the folder the rule secured, and the plain copy's outcome;
 *  round 5 (G3): when a preparation left no root, when it ended. */
interface Prepared { key: string; root: string | null; rootId: string | null; plainDir: string | null; plainOk: boolean | null; failedAt: number | null }
let prepared: Prepared | null = null
/** The preparation running now (one at a time). */
let inFlight: { key: string; promise: Promise<CodexHookFolderOutcome> } | null = null

/** Test seam: forget what was prepared, and which plain copies staged. */
export function __resetCodexHookFoldersForTests(): void {
  prepared = null
  inFlight = null
  stagedPlainDirs.clear()
}

function planKey(plan: CodexHookFolderPlan): string {
  return JSON.stringify([plan.dataDir, plan.scriptsDir, plan.plainDir])
}

/**
 * P3.10 round 1 (A5): the folder holding the per-launch hook folders,
 * `<dataDir>/codex-hooks`: a real folder inside the app's own data folder
 * (never a link or a junction; the data folder itself is the user's choice
 * and is not inspected), this user's alone. Round 4 (P1): only one this run
 * prepared (prepareCodexHookFolders) and still the same folder (its identity,
 * so one removed and made again, or replaced, is not used until prepared
 * again, round 3 F4); the chain is checked, and on POSIX 0700 applied again.
 * Cheap and synchronous (no process), for a launch; null means the launch
 * gets no hooks.
 */
export function preparedCodexHookRoot(dataDir: string): string | null {
  const p = prepared
  if (!p || !p.root || p.rootId === null || typeof dataDir !== 'string' || !dataDir) return null
  const root = path.join(dataDir, CODEX_HOOK_ROOT_NAME)
  if (root !== p.root) return null
  if (!realFolderChainBelow(dataDir, root) || !ownerOnlyPosix(root)) return null
  return folderIdentity(root) === p.rootId ? root : null
}

/** Still ready for this plan: the root as prepared, and the plain copy either
 *  not asked for, refused this run (not asked again until the next start),
 *  or still whole (one changed since is prepared again). */
function stillPrepared(plan: CodexHookFolderPlan, key: string): boolean {
  const p = prepared
  if (!p || p.key !== key || preparedCodexHookRoot(plan.dataDir) === null) return false
  if (plan.plainDir === null || p.plainOk === false) return true
  return verifyPlainCodexHookWrapper(plan.scriptsDir, plan.plainDir)
}

/** The answer without asking the rule: still ready, or (round 5, G3) the
 *  same folders' preparation left no root less than CODEX_HOOK_FOLDERS_RETRY_MS
 *  ago; null when the rule is to be asked. */
function quickAnswer(plan: CodexHookFolderPlan, key: string): CodexHookFolderOutcome | null {
  if (stillPrepared(plan, key)) return { root: true, plain: plan.plainDir === null ? null : prepared?.plainOk ?? null, ran: false, detail: [] }
  const p = prepared
  if (!p || p.key !== key || p.root !== null || p.failedAt === null) return null
  const since = Date.now() - p.failedAt
  if (since < 0 || since >= CODEX_HOOK_FOLDERS_RETRY_MS) return null
  return { root: false, plain: plan.plainDir === null ? null : p.plainOk ?? false, ran: false, detail: [] }
}

/**
 * Round 4 (P1, P2): prepare this run's hook folders, asynchronously and one
 * preparation at a time; a no-op while they are still ready. The hook root
 * and, when the plan names one, the plain-copy folder and its base go to the
 * owner-only rule in ONE call, in that order (the rule makes a missing folder
 * inside its parent only once that parent passed); a folder already there is
 * handed to it only while it is a real folder in its chain. After the rule:
 * each folder it passed is checked again (still a real folder in its chain,
 * so nothing is made or written through a link), and only then are the two
 * files written into the plain-copy folder; verifyPlainCodexHookWrapper
 * checks them before each use. Left-behind hook folders are swept once the
 * root is ready. Never throws.
 */
export function prepareCodexHookFolders(plan: CodexHookFolderPlan, secure: SecureHookFolders): Promise<CodexHookFolderOutcome> {
  const key = planKey(plan)
  if (inFlight && inFlight.key === key) return inFlight.promise
  const quick = inFlight ? null : quickAnswer(plan, key)
  if (quick) return Promise.resolve(quick)
  const before = inFlight?.promise
  const promise = (async (): Promise<CodexHookFolderOutcome> => {
    if (before) await before
    const answer = quickAnswer(plan, key)
    if (answer) return answer
    try {
      return await runPreparation(plan, secure, key)
    } catch (err) {
      prepared = { key, root: null, rootId: null, plainDir: plan.plainDir, plainOk: plan.plainDir === null ? null : false, failedAt: Date.now() }
      return { root: false, plain: plan.plainDir === null ? null : false, ran: true, detail: [String((err as Error)?.message ?? err)] }
    }
  })()
  const entry = { key, promise }
  inFlight = entry
  void promise.then(() => { if (inFlight === entry) inFlight = null })
  return promise
}

async function runPreparation(plan: CodexHookFolderPlan, secure: SecureHookFolders, key: string): Promise<CodexHookFolderOutcome> {
  const { dataDir, scriptsDir, plainDir } = plan
  prepared = null
  if (plainDir) stagedPlainDirs.delete(plainDir)
  const detail: string[] = []
  if (typeof dataDir !== 'string' || !dataDir || !path.isAbsolute(dataDir) || CONTROL_RE.test(dataDir)) {
    prepared = { key, root: null, rootId: null, plainDir, plainOk: plainDir === null ? null : false, failedAt: Date.now() }
    return { root: false, plain: plainDir === null ? null : false, ran: false, detail: ['the data folder is not an absolute path'] }
  }
  const root = path.join(dataDir, CODEX_HOOK_ROOT_NAME)
  const dirs: string[] = []
  // A folder already there goes to the rule only while it is a real folder in its chain.
  if (presentNoFollow(root) && !realFolderChainBelow(dataDir, root)) detail.push(`${root}: not a real folder`)
  else dirs.push(root)
  let base: string | null = null
  let top: string | null = null
  if (plainDir) {
    base = path.dirname(plainDir)
    top = path.dirname(base)
    const real = (d: string): boolean => !presentNoFollow(d) || realFolderChainBelow(top as string, d)
    if (real(base) && real(plainDir)) dirs.push(base, plainDir)
    else detail.push(`${plainDir}: not a real folder`)
  }
  let results: ReadonlyArray<{ dir: string; ok: boolean; detail?: string }> = []
  if (dirs.length > 0) {
    try {
      const r = await secure(dirs)
      results = Array.isArray(r) ? r : []
    } catch (err) {
      detail.push(`the owner-only rule failed: ${(err as Error)?.message ?? err}`)
      results = []
    }
  }
  const passed = (d: string): boolean => dirs.includes(d) && results.some((r) => r && r.dir === d && r.ok === true)
  for (const r of results) if (r && r.ok !== true) detail.push(`${r.dir}: ${r.detail ?? 'refused'}`)
  // The root: passed, and after the rule still a real folder in its chain.
  const rootOk = passed(root) && realFolderChainBelow(dataDir, root) && ownerOnlyPosix(root)
  // The plain copy: both levels passed and are still real folders; only then the files.
  let plainOk: boolean | null = null
  if (plainDir && base && top) {
    plainOk = passed(base) && passed(plainDir) && realFolderChainBelow(top, plainDir) && writePlainCopies(scriptsDir, plainDir)
  }
  prepared = { key, root: rootOk ? root : null, rootId: rootOk ? folderIdentity(root) : null, plainDir, plainOk, failedAt: rootOk ? null : Date.now() }
  if (rootOk) {
    try { sweepStaleCodexHookFolders(root) } catch { /* best-effort */ }
  }
  return { root: rootOk, plain: plainOk, ran: true, detail }
}

/** A launch's hook file: where it is, and its folder as made. */
export interface CodexHookFile {
  dir: string
  file: string
  folder: PickFolderIdentity
}

/**
 * Write the session's hook file: a folder of its own inside `root` (see
 * preparedCodexHookRoot), made for this launch with an unguessable name,
 * holding `hook.json` written whole and owner-only: the gateway's port, the
 * session id and its token. Null when any part is not what the gateway would
 * route, or the write fails.
 */
export function writeCodexHookFile(sessionId: string, port: number, secret: string, root: string): CodexHookFile | null {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (typeof secret !== 'string' || !TOKEN_RE.test(secret)) return null
  if (typeof root !== 'string' || !root || !path.isAbsolute(root)) return null
  let dir: string
  try {
    dir = fs.mkdtempSync(path.join(root, CODEX_HOOK_DIR_PREFIX))
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

/** Remove hook folders a crash or a quit left behind in `root` (this install's
 *  own hook root, preparedCodexHookRoot, and nowhere else): its own prefix,
 *  real folders only (never a link or junction), older than
 *  CODEX_HOOK_STALE_MS, emptied as removeCodexHookFile does. Returns how
 *  many were removed. */
export function sweepStaleCodexHookFolders(root: string, now: number = Date.now(), maxAgeMs: number = CODEX_HOOK_STALE_MS): number {
  let removed = 0
  if (typeof root !== 'string' || !root || path.basename(root) !== CODEX_HOOK_ROOT_NAME) return 0
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(CODEX_HOOK_DIR_PREFIX)) continue
    const dir = path.join(root, e.name)
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

// -- P3.10 round 1 (V3): a plain path for the npm shim route --------------
//
// A launch through the npm `.cmd` shim runs under cmd.exe, which can carry
// the hook command only as a plain word (no space). The default resources
// folder has a space in its path, so with it such a launch had no hooks.
// Then the forwarder and its wrapper are also copied to a folder of the app's
// own under the user's local app data folder, whose path is a plain word:
//  - named for this install (a hash of its resources folder, which a dev
//    build, the installed app and a test run each have their own of), so a
//    dev build never overwrites the installed app's copy, and an update keeps
//    the same path, and so the same command, which Codex keeps trusted;
//  - made by the app, a real folder at both levels (never a link or a
//    junction), and both levels this user's only (the app's owner-only folder
//    rule, which replaces every other grant; round 2, R4: the base folder
//    too, since Codex runs the wrapper from there during the session, so the
//    folders' own rights, not only the check before a launch, keep it);
//  - staged this run (round 4: by prepareCodexHookFolders, the files written
//    only after both levels passed the rule) and checked again before each
//    launch uses it: still real folders, and each file a plain file whose
//    bytes are the resources folder's copy.
// When that path is not a plain word either (a user name with a space), the
// shim route gets no hooks, as before.

/** The folder, under the user's local app data folder, of the plain copies. */
export const CODEX_HOOK_PLAIN_BASE = 'ai-code-conductor'

let localAppDataOverride: string | undefined | null = null
/** Test seam: the local app data folder the plain copies go under (null: the
 *  real one). */
export function __setCodexLocalAppDataForTests(dir: string | undefined | null): void {
  localAppDataOverride = dir
}
/** The user's local app data folder (Windows), or undefined. */
export function codexLocalAppData(): string | undefined {
  return localAppDataOverride !== null ? localAppDataOverride : process.env.LOCALAPPDATA
}

/** This install's plain copy folder, `<localAppData>\ai-code-conductor\
 *  codex-hooks-<tag>`, or null when its wrapper's path would not be a plain
 *  word. `tag`: the first 12 hex digits of the SHA-256 of the resources
 *  folder's path (lower case). */
export function codexPlainWrapperDir(localAppData: string | undefined, resourcesDir: string): string | null {
  if (typeof localAppData !== 'string' || !localAppData || typeof resourcesDir !== 'string' || !resourcesDir) return null
  if (!path.win32.isAbsolute(localAppData) || CONTROL_RE.test(localAppData)) return null
  const tag = createHash('sha256').update(path.win32.resolve(resourcesDir).toLowerCase()).digest('hex').slice(0, 12)
  const dir = path.win32.join(localAppData, CODEX_HOOK_PLAIN_BASE, `codex-hooks-${tag}`)
  return isPlainWinPath(path.win32.join(dir, CODEX_HOOK_WRAPPER)) ? dir : null
}

/** Round 2 (R4): the plain-copy folders staged this run, both levels made
 *  owner-only (round 4: prepareCodexHookFolders). */
const stagedPlainDirs = new Set<string>()

/** The plain copies are what a launch may run: staged this run (both folders
 *  owner-only, round 2), both folders real (below the local app data folder),
 *  and each file a plain file (not a link, one name only) whose bytes are the
 *  resources folder's copy. */
export function verifyPlainCodexHookWrapper(scriptsDir: string, plainDir: string): boolean {
  if (!stagedPlainDirs.has(plainDir)) return false
  if (!realFolderChainBelow(path.dirname(path.dirname(plainDir)), plainDir)) return false
  for (const name of [CODEX_HOOK_SCRIPT, CODEX_HOOK_WRAPPER]) {
    const copy = path.join(plainDir, name)
    let st: fs.Stats
    try { st = fs.lstatSync(copy) } catch { return false }
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) return false
    let mine: Buffer
    let theirs: Buffer
    try {
      mine = fs.readFileSync(copy)
      theirs = fs.readFileSync(path.join(scriptsDir, name))
    } catch {
      return false
    }
    if (!mine.equals(theirs)) return false
  }
  return true
}

/** Round 4: write the forwarder and its wrapper from `scriptsDir` into the
 *  plain-copy folder a preparation has just made owner-only and checked (see
 *  prepareCodexHookFolders); each copy is written whole and replaces the last
 *  (never through a link). True when the copies then pass
 *  verifyPlainCodexHookWrapper. */
function writePlainCopies(scriptsDir: string, plainDir: string): boolean {
  for (const name of [CODEX_HOOK_SCRIPT, CODEX_HOOK_WRAPPER]) {
    let bytes: Buffer
    try { bytes = fs.readFileSync(path.join(scriptsDir, name)) } catch { return false }
    const copy = path.join(plainDir, name)
    try {
      const st = fs.lstatSync(copy)
      if (!st.isFile() || st.isSymbolicLink()) return false
    } catch { /* not there yet */ }
    try { atomicWriteFileSync(copy, bytes, { mode: 0o600 }) } catch { return false }
  }
  stagedPlainDirs.add(plainDir)
  if (verifyPlainCodexHookWrapper(scriptsDir, plainDir)) return true
  stagedPlainDirs.delete(plainDir)
  return false
}
