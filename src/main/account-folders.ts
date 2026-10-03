// A provider account's own folders, as main shows them (WP2 PR 4, P4.4, rows
// 55 and 56): its log folders, opened from Settings, General, Debug Logging,
// and its memories folder, listed on the Memory page (account-memories.ts).
//
// Where the folders come from: the accounts service, which locates each live
// account's realm exactly as a launch does and holds its home to the launch's
// canonical-home check (no junction or link at the home itself), then names
// three paths in it. Main asks it again for every request; nothing a renderer
// sends is ever joined into a path. For Codex the three are the account
// folder's `log/` (where `codex-login.log` always lands, and `codex-tui.log`
// unless `log_dir` moves it), its `memories/`, and its `config.toml`, whose
// root-level `log_dir` may name a second log folder anywhere on the computer.
//
// The log-folder channel (debug:openAccountLogFolder) is keyed by account id
// and folder KIND. A folder is handed to `shell.openPath` -- which launches
// whatever it is given, a program included -- only when:
//   1. its FORM is a fully qualified local path (localPathFormProblem): a
//      relative `log_dir`, a UNC share and a device path are refused before
//      any file or shell call (`shell.openPath` on a share opens a network
//      connection);
//   2. it is a folder, not a link or junction, and its real path is its own
//      (no link anywhere on the way, which also refuses a mapped network drive,
//      whose real path is a share).
// What remains: the folder could be swapped between the check and the shell
// call by someone who can write beside it; the check is made immediately
// before the call, and the shell is given the checked real path.
import * as fs from 'fs'
import type { AccountLogFolderKind, AccountLogFolderOpenResult, AccountLogFolders, ProviderId } from '../shared/types'
import { localPathFormProblem, samePathForm } from './utils/path-validator'
import type { FolderCheckFs } from './utils/path-validator'

/** One live account's own folders: paths, main only, never sent to a
 *  renderer. */
export interface AccountFolderSet {
  providerId: ProviderId
  accountId: string
  /** The provider's own folder on this computer (Codex's folder in the user's home). */
  external: boolean
  logDir: string
  memoriesDir: string
  configFile: string
}

/** Asked afresh for every request. Null while the account list cannot be
 *  read yet. */
export type AccountFoldersSource = () => Promise<readonly AccountFolderSet[] | null>

export interface AccountFileHandle {
  stat(opts: { bigint: true }): Promise<fs.BigIntStats>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

/** The file calls the account folders need (fs.promises' own; a test passes
 *  its own). */
export interface AccountFileFs extends FolderCheckFs {
  readdir(p: string): Promise<string[]>
  open(p: string, flags: number): Promise<AccountFileHandle>
  unlink(p: string): Promise<void>
  readonly constants: { O_RDONLY: number; O_NOFOLLOW?: number; O_NONBLOCK?: number }
}

export const realAccountFileFs: AccountFileFs = {
  lstat: (p, opts) => fs.promises.lstat(p, opts),
  realpath: (p) => fs.promises.realpath(p),
  readdir: (p) => fs.promises.readdir(p),
  open: (p, flags) => fs.promises.open(p, flags),
  unlink: (p) => fs.promises.unlink(p),
  get constants() { return fs.constants },
}

/** A file read refused, or too large. */
export class CheckedReadRefused extends Error {
  constructor(reason: string) {
    super(`Refused: ${reason}`)
    this.name = 'CheckedReadRefused'
  }
}

/**
 * Read a file main has just checked (with lstat: a plain file), without
 * following a link where the platform can (O_NOFOLLOW; O_NONBLOCK so a FIFO
 * put in its place never blocks), and only when what was opened is that same
 * file: the device and file id the check saw (`expect`). More than `max`
 * bytes: refused (`whole`) or cut at `max`.
 */
export async function readCheckedFile(
  p: string,
  max: number,
  files: AccountFileFs,
  opts: { expect: { dev: bigint; ino: bigint }; whole?: boolean },
): Promise<string> {
  const c = files.constants
  const flags = (c?.O_RDONLY ?? 0) | (c?.O_NOFOLLOW ?? 0) | (c?.O_NONBLOCK ?? 0)
  const h = await files.open(p, flags)
  try {
    const st = await h.stat({ bigint: true })
    if (st.dev !== opts.expect.dev || st.ino !== opts.expect.ino) throw new CheckedReadRefused('the file changed')
    if (opts.whole && st.size > BigInt(max)) throw new CheckedReadRefused('too large')
    const len = Number(st.size < BigInt(max) ? st.size : BigInt(max))
    const buf = Buffer.alloc(len)
    let got = 0
    while (got < len) {
      const { bytesRead } = await h.read(buf, got, len - got, got)
      if (bytesRead <= 0) break
      got += bytesRead
    }
    return buf.subarray(0, got).toString('utf8')
  } finally {
    await h.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// config.toml's `log_dir`
// ---------------------------------------------------------------------------

export type LogDirSetting = { kind: 'unset' } | { kind: 'set'; value: string } | { kind: 'invalid' }

/** The settings file is small; anything larger is not read. */
export const CONFIG_MAX_BYTES = 256 * 1024

/**
 * The root-level `log_dir` of a TOML settings file, or none. Read the way a
 * TOML parser reads it -- strings of all four kinds, arrays and inline tables
 * skipped whole, comments, quoted and dotted keys -- and only up to the first
 * table header, since a key below one is not the root's. Anything this cannot
 * read for certain is `invalid`, never a guess: a malformed line, a second
 * `log_dir`, a `log_dir` that is not a single-line string, or one made a
 * table by a dotted key.
 */
export function parseLogDirSetting(src: string): LogDirSetting {
  const INVALID: LogDirSetting = { kind: 'invalid' }
  const n = src.length
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0
  let found: string | null = null

  const isWs = (ch: string | undefined) => ch === ' ' || ch === '\t'
  const skipWs = (j: number): number => { while (j < n && isWs(src[j])) j++; return j }
  const atEol = (j: number): boolean => j >= n || src[j] === '\n' || (src[j] === '\r' && src[j + 1] === '\n')
  const skipToEol = (j: number): number => { while (j < n && src[j] !== '\n') j++; return j }

  /** A basic string's escapes; null when one is not valid TOML. */
  function readBasic(j: number): { end: number; value: string } | null {
    let out = ''
    j++ // the opening quote
    while (j < n) {
      const ch = src[j]
      if (ch === '"') return { end: j + 1, value: out }
      if (ch === '\n' || ch === '\r') return null
      if (ch === '\\') {
        const e = src[j + 1]
        const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\u001b', '"': '"', '\\': '\\' }
        if (e !== undefined && Object.hasOwn(simple, e)) { out += simple[e]; j += 2; continue }
        const width = e === 'u' ? 4 : e === 'U' ? 8 : e === 'x' ? 2 : 0
        if (!width) return null
        const hex = src.slice(j + 2, j + 2 + width)
        if (hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) return null
        const cp = parseInt(hex, 16)
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null
        out += String.fromCodePoint(cp)
        j += 2 + width
        continue
      }
      out += ch
      j++
    }
    return null
  }
  function readLiteral(j: number): { end: number; value: string } | null {
    const close = src.indexOf("'", j + 1)
    if (close < 0) return null
    const value = src.slice(j + 1, close)
    if (/[\r\n]/.test(value)) return null
    return { end: close + 1, value }
  }
  /** A multi-line string, skipped whole (its value is never a path here). */
  function skipMultiline(j: number, delim: '"""' | "'''"): number | null {
    let k = j + 3
    while (k < n) {
      if (delim === '"""' && src[k] === '\\') { k += 2; continue }
      if (src.startsWith(delim, k)) {
        // Up to two quotes of the same kind may close it (`""""` ends with one inside).
        let end = k + 3
        while (end < n && src[end] === delim[0] && end - k < 5) end++
        return end
      }
      k++
    }
    return null
  }
  /** Any string, by its opening; value only for the single-line kinds. */
  function readString(j: number): { end: number; value?: string } | null {
    if (src.startsWith('"""', j)) { const e = skipMultiline(j, '"""'); return e === null ? null : { end: e } }
    if (src.startsWith("'''", j)) { const e = skipMultiline(j, "'''"); return e === null ? null : { end: e } }
    if (src[j] === '"') return readBasic(j)
    if (src[j] === "'") return readLiteral(j)
    return null
  }
  /** An array or inline table, skipped whole: brackets counted, strings and
   *  comments stepped over. */
  function skipNested(j: number): number | null {
    const stack: string[] = []
    let k = j
    while (k < n) {
      const ch = src[k]
      if (ch === '"' || ch === "'") { const s = readString(k); if (!s) return null; k = s.end; continue }
      if (ch === '#') { k = skipToEol(k); continue }
      if (ch === '[' || ch === '{') { stack.push(ch === '[' ? ']' : '}'); k++; continue }
      if (ch === ']' || ch === '}') {
        if (stack.pop() !== ch) return null
        k++
        if (stack.length === 0) return k
        continue
      }
      k++
    }
    return null
  }
  /** A key, dotted or not; its parts decoded. */
  function readKey(j: number): { end: number; parts: string[] } | null {
    const parts: string[] = []
    let k = j
    for (;;) {
      k = skipWs(k)
      if (src[k] === '"' || src[k] === "'") {
        if (src.startsWith('"""', k) || src.startsWith("'''", k)) return null
        const s = src[k] === '"' ? readBasic(k) : readLiteral(k)
        if (!s) return null
        parts.push(s.value)
        k = s.end
      } else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(k, k + 256))
        if (!m) return null
        parts.push(m[0])
        k += m[0].length
      }
      k = skipWs(k)
      if (src[k] === '.') { k++; continue }
      return { end: k, parts }
    }
  }

  while (i < n) {
    i = skipWs(i)
    if (i >= n) break
    if (src[i] === '\n') { i++; continue }
    if (src[i] === '\r' && src[i + 1] === '\n') { i += 2; continue }
    if (src[i] === '#') { i = skipToEol(i); continue }
    if (src[i] === '[') break // a table header: the root table ends here
    const key = readKey(i)
    if (!key) return INVALID
    i = key.end
    if (src[i] !== '=') return INVALID
    i = skipWs(i + 1)
    let end: number
    let value: string | undefined
    if (src[i] === '"' || src[i] === "'") {
      const s = readString(i)
      if (!s) return INVALID
      end = s.end
      value = s.value
    } else if (src[i] === '[' || src[i] === '{') {
      const e = skipNested(i)
      if (e === null) return INVALID
      end = e
    } else {
      // A number, a boolean or a date: up to a comment or the line's end.
      let k = i
      while (k < n && src[k] !== '#' && src[k] !== '\n' && !(src[k] === '\r' && src[k + 1] === '\n')) k++
      if (src.slice(i, k).trim() === '') return INVALID
      end = k
    }
    if (key.parts[0] === 'log_dir') {
      if (key.parts.length !== 1 || found !== null || value === undefined) return INVALID
      found = value
    }
    i = skipWs(end)
    if (src[i] === '#') i = skipToEol(i)
    if (!atEol(i)) return INVALID
  }
  return found === null ? { kind: 'unset' } : { kind: 'set', value: found }
}

/** The account's `log_dir`, from its settings file, checked as a file: a
 *  missing file sets none; a link (lstat: not a plain file), a non-file, an
 *  over-large or unreadable file is `invalid`. */
export async function readLogDirSetting(configFile: string, files: AccountFileFs, platform: NodeJS.Platform): Promise<LogDirSetting> {
  if (localPathFormProblem(configFile, platform)) return { kind: 'invalid' }
  let st: fs.BigIntStats
  try {
    st = await files.lstat(configFile, { bigint: true })
  } catch (e) {
    return (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? { kind: 'unset' } : { kind: 'invalid' }
  }
  if (!st.isFile()) return { kind: 'invalid' }
  let text: string
  try {
    text = await readCheckedFile(configFile, CONFIG_MAX_BYTES, files, { expect: { dev: st.dev, ino: st.ino }, whole: true })
  } catch {
    return { kind: 'invalid' }
  }
  return parseLogDirSetting(text)
}

// ---------------------------------------------------------------------------
// The two log-folder channels
// ---------------------------------------------------------------------------

export interface LogFolderDeps {
  fs: AccountFileFs
  /** shell.openPath: '' on success, else an error text. */
  openPath(p: string): Promise<string>
  platform: NodeJS.Platform
  log?(message: string): void
}

const KINDS: readonly AccountLogFolderKind[] = ['log', 'log-dir']

async function foldersNow(source: AccountFoldersSource): Promise<readonly AccountFolderSet[]> {
  try {
    const sets = await source()
    return Array.isArray(sets) ? sets : []
  } catch {
    return []
  }
}

/** debug:accountLogFolders: each account's log folders by KIND, never a
 *  path. `log` always (the sign-in log lands there); `log-dir` when its
 *  settings set one. */
export async function listAccountLogFolders(source: AccountFoldersSource, deps: LogFolderDeps): Promise<AccountLogFolders[]> {
  const out: AccountLogFolders[] = []
  for (const set of await foldersNow(source)) {
    if (!set || typeof set.accountId !== 'string' || out.some((o) => o.accountId === set.accountId)) continue
    const folders: AccountLogFolderKind[] = ['log']
    let setting: LogDirSetting = { kind: 'unset' }
    try { setting = await readLogDirSetting(set.configFile, deps.fs, deps.platform) } catch { setting = { kind: 'invalid' } }
    if (setting.kind === 'set') folders.push('log-dir')
    out.push({ accountId: set.accountId, folders })
  }
  return out
}

const refused = (code: Exclude<AccountLogFolderOpenResult, { ok: true }>['code']): AccountLogFolderOpenResult => ({ ok: false, code })

/** debug:openAccountLogFolder: `{ accountId, folder }`, nothing else. The
 *  folder is resolved here from the account id; see the module comment for
 *  what it must pass before the shell sees it. */
export async function openAccountLogFolder(input: unknown, source: AccountFoldersSource, deps: LogFolderDeps): Promise<AccountLogFolderOpenResult> {
  const log = (m: string) => { try { deps.log?.(`[account-logs] ${m}`) } catch { /* logging never fails the call */ } }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refused('refused')
  const keys = Object.keys(input)
  if (keys.length !== 2 || !keys.includes('accountId') || !keys.includes('folder')) return refused('refused')
  const { accountId, folder } = input as { accountId: unknown; folder: unknown }
  if (typeof accountId !== 'string' || accountId.length === 0 || accountId.length > 200) return refused('unknown-account')
  if (typeof folder !== 'string' || !KINDS.includes(folder as AccountLogFolderKind)) return refused('refused')

  const set = (await foldersNow(source)).find((s) => s && s.accountId === accountId)
  if (!set) return refused('unknown-account')

  let target: string
  if (folder === 'log') {
    target = set.logDir
  } else {
    let setting: LogDirSetting
    try { setting = await readLogDirSetting(set.configFile, deps.fs, deps.platform) } catch { setting = { kind: 'invalid' } }
    if (setting.kind === 'unset') return refused('not-set')
    if (setting.kind === 'invalid') { log('log_dir could not be read for certain'); return refused('refused') }
    target = setting.value
  }

  // 1. The form alone, before any file or shell call.
  const form = localPathFormProblem(target, deps.platform)
  if (form) { log(`${folder} refused by its form (${form})`); return refused('refused') }

  // 2. A folder, not a link, at its own real path.
  let st: fs.BigIntStats
  try {
    st = await deps.fs.lstat(target, { bigint: true })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code
    return refused(code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'refused')
  }
  // lstat looks at the last name itself: a link or junction there is not a folder.
  if (!st.isDirectory()) { log(`${folder} refused: ${st.isSymbolicLink() ? 'a link or junction' : 'not a folder'}`); return refused('refused') }
  let real: string
  try {
    real = await deps.fs.realpath(target)
  } catch {
    return refused('refused')
  }
  // Its real path is its own: no link on the way (a mapped network drive's
  // real path is a share, so it is refused here too).
  if (!samePathForm(real, target, deps.platform)) {
    log(`${folder} refused: reached through a link`)
    return refused('refused')
  }

  let err: string
  try {
    err = await deps.openPath(real)
  } catch {
    err = 'failed'
  }
  if (typeof err === 'string' && err !== '') { log(`${folder} could not be opened`); return refused('refused') }
  return { ok: true }
}
