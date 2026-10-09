// P3.10 round 4 (P1, P2): make folders this user's and owner-only, and read
// each back before it is used, off the main thread.
//
// Given folders in order, each is taken in turn: one already there must be a
// real folder (never a link or a junction); a missing one is made inside its
// parent, and a parent that is an earlier folder of the same call must have
// passed and must still be a real folder (a parent outside the call is the
// caller's own choice and is not inspected). Each is then made this user's
// (owner the user; rights exactly the user and SYSTEM, full control, passed to
// what is inside; nothing inherited from above) and read back. A folder is
// used only when that read holds exactly that (the Administrators group is
// accepted beside the two); anything else, or any doubt, refuses it, and
// every folder below a refused one is refused too.
//
// A folder is never taken over from another account. Before its owner or
// rights are changed, its owner is read: anyone but this user or the
// Administrators group refuses it, and nothing is written to it. Windows
// checks rights when a handle is opened, so whoever owned a folder before
// its rights were rewritten could keep what it had opened; and only this
// user, or an administrator (who can take any folder anyway), can make a
// folder that this user or that group owns. A folder the call makes itself
// is read the same way once made, so one that another account put in its
// place meanwhile is refused too.
//
// Windows: ONE Windows PowerShell call for all the folders, started
// asynchronously (execFile, never the synchronous form) from the system folder
// by its full path, the folders passed through the environment (never inside
// the script's text), the owner and rights read back by SID. POSIX: 0700 and
// the user's own uid, with the same order.
//
// Where that call gives no read at all -- Windows PowerShell restricted to its
// Constrained Language Mode (AppLocker or WDAC script enforcement), which
// refuses the .NET calls the script makes -- the same rule is applied with
// Windows' own programs instead (secureFoldersNative): the user's SID from
// whoami.exe, the rights set with icacls.exe (/restore of exactly the user and
// SYSTEM, inheritance off) and the owner with icacls.exe /setowner, each on
// the folder itself, never a link's target (/L); then everything is read back
// with a script that uses only what that mode allows (Get-Item, Get-Acl and
// its SDDL, which names every account by SID or by a fixed abbreviation, in
// any language), and judged by the same verdict. Same order, same refusals;
// the owner a folder had before is read from the first read's SDDL, and the
// folder must still be that same folder when it is written.
//
// Every Windows PowerShell call gets Windows PowerShell's own modules folder
// as its module path (windowsPowerShellEnv), never the one this process
// inherited: PowerShell 7 puts its own modules first in the module path of
// every program it starts, and Windows PowerShell then cannot load the
// cmdlets the read uses (Get-Acl: "found in the module
// 'Microsoft.PowerShell.Security', but the module could not be loaded").
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface OwnerOnlyFolderResult {
  dir: string
  ok: boolean
  detail: string
  /** The call gave no read of this folder at all (it could not run or end,
   *  or its answer could not be read or does not match what was asked), as
   *  against a folder read and refused. Never set on a pass. */
  unread?: true
}

/** SYSTEM, and the Administrators group, by SID (names are localized). */
export const OWNER_ONLY_SYSTEM_SID = 'S-1-5-18'
export const OWNER_ONLY_ADMINISTRATORS_SID = 'S-1-5-32-544'
/** The variable that carries the folders, one a line, to the script. */
export const OWNER_ONLY_DIRS_ENV = 'CCC_OWNER_ONLY_DIRS'
/** A PowerShell start is slow on a cold machine; still bounded. */
const POWERSHELL_TIMEOUT_MS = 30_000
/** FileSystemRights.FullControl, and ContainerInherit | ObjectInherit. */
const FULL_CONTROL = 0x1f01ff
const CONTAINER_AND_OBJECT_INHERIT = 3

/** The system folder (System32) by its absolute path. */
function systemFolder(): string {
  const root = process.env.SystemRoot
  const base = typeof root === 'string' && /^[A-Za-z]:\\/.test(root) ? root : 'C:\\Windows'
  return path.win32.join(base, 'System32')
}

/** Windows PowerShell by its absolute path in the system folder. */
function powershellPath(): string {
  return path.win32.join(systemFolder(), 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** Windows PowerShell's own modules folder ($PSHOME\Modules), by its
 *  absolute path in the system folder. */
function windowsPowerShellModules(): string {
  return path.win32.join(systemFolder(), 'WindowsPowerShell', 'v1.0', 'Modules')
}

/** The environment a Windows PowerShell call gets: `base` with `extraEnv`
 *  added, and the module path Windows PowerShell's own modules folder only
 *  (see the file's header). Every spelling of its name is replaced: Windows
 *  names are case-insensitive, and a child handed two would keep either. */
export function windowsPowerShellEnv(base: Readonly<Record<string, string | undefined>>, extraEnv: Readonly<Record<string, string>>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries({ ...base, ...extraEnv })) {
    if (k.toUpperCase() !== 'PSMODULEPATH') env[k] = v
  }
  env.PSModulePath = windowsPowerShellModules()
  return env
}

/** Run one Windows PowerShell script, asynchronously, with `extraEnv` added
 *  to this process's environment and the module path Windows PowerShell's
 *  own (windowsPowerShellEnv). Resolves its standard output. */
export function runWindowsPowerShell(script: string, extraEnv: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: 1024 * 1024,
      env: windowsPowerShellEnv(process.env, extraEnv),
    }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
}

/** The one script: for each folder in turn (see the file's header), make it
 *  when missing, set owner and rights, and read both back by SID. Prints one
 *  JSON object: the user's SID and, per folder, the read or the error. */
export const OWNER_ONLY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$user = [Security.Principal.WindowsIdentity]::GetCurrent().User',
  "$system = New-Object Security.Principal.SecurityIdentifier '" + OWNER_ONLY_SYSTEM_SID + "'",
  "$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
  "$none = [Security.AccessControl.PropagationFlags]'None'",
  "$allow = [Security.AccessControl.AccessControlType]'Allow'",
  "$full = [Security.AccessControl.FileSystemRights]'FullControl'",
  '$reparse = [IO.FileAttributes]::ReparsePoint',
  '$done = @{}',
  '$failed = @{}',
  '$out = @()',
  'foreach ($d in ($env:' + OWNER_ONLY_DIRS_ENV + " -split \"`n\")) {",
  '  if (-not $d) { continue }',
  '  $r = [ordered]@{ dir = $d; error = $null; owner = $null; protected = $false; rules = @() }',
  '  try {',
  '    $parent = [IO.Path]::GetDirectoryName($d)',
  "    if ($failed.ContainsKey($parent)) { throw 'its parent was refused' }",
  "    if ($done.ContainsKey($parent) -and (([IO.File]::GetAttributes($parent) -band $reparse) -ne 0)) { throw 'its parent is a link' }",
  '    $attr = $null',
  '    try { $attr = [IO.File]::GetAttributes($d) } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { $attr = $null }',
  '    if ($null -eq $attr) {',
  "      if (-not [IO.Directory]::Exists($parent)) { throw 'its parent is missing' }",
  '      [void][IO.Directory]::CreateDirectory($d)',
  '      $attr = [IO.File]::GetAttributes($d)',
  '    }',
  "    if (($attr -band $reparse) -ne 0) { throw 'a link' }",
  "    if (($attr -band [IO.FileAttributes]::Directory) -eq 0) { throw 'not a folder' }",
  // Never taken over from another account (see the file's header): the owner
  // it has now, read before anything is changed, also when the line above
  // made it (CreateDirectory takes a folder already there without a word).
  "    $was = [IO.Directory]::GetAccessControl($d, [Security.AccessControl.AccessControlSections]'Owner').GetOwner([Security.Principal.SecurityIdentifier]).Value",
  "    if ($was -ne $user.Value -and $was -ne '" + OWNER_ONLY_ADMINISTRATORS_SID + "') { throw 'its owner is not this user' }",
  '    $s = New-Object Security.AccessControl.DirectorySecurity',
  '    $s.SetOwner($user)',
  '    $s.SetAccessRuleProtection($true, $false)',
  '    $s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($user, $full, $inherit, $none, $allow)))',
  '    $s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, $full, $inherit, $none, $allow)))',
  '    [IO.Directory]::SetAccessControl($d, $s)',
  "    $a = [IO.Directory]::GetAccessControl($d, [Security.AccessControl.AccessControlSections]'Owner, Access')",
  '    $r.owner = $a.GetOwner([Security.Principal.SecurityIdentifier]).Value',
  '    $r.protected = $a.AreAccessRulesProtected',
  '    $r.rules = @(foreach ($x in $a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) { [ordered]@{ sid = $x.IdentityReference.Value; rights = [int]$x.FileSystemRights; allow = ($x.AccessControlType -eq $allow); inherited = $x.IsInherited; flags = [int]$x.InheritanceFlags } })',
  '    $done[$d] = $true',
  '  } catch {',
  '    $r.error = [string]$_.Exception.Message',
  '    $failed[$d] = $true',
  '  }',
  '  $out += [pscustomobject]$r',
  '}',
  '$json = [pscustomobject]@{ user = $user.Value; folders = @($out) } | ConvertTo-Json -Compress -Depth 6',
  // Round 5 (G1): the answer in ASCII only, every other character written as
  // a JSON escape, so no console encoding can change it on the way back.
  '$sb = New-Object Text.StringBuilder',
  "foreach ($c in $json.ToCharArray()) { $n = [int]$c; if ($n -gt 126) { [void]$sb.Append('\\u').Append($n.ToString('x4')) } else { [void]$sb.Append($c) } }",
  '$sb.ToString()',
].join('\n')

/** One folder's read, as the script prints it. */
export interface FolderAclRead {
  dir?: unknown
  error?: unknown
  owner?: unknown
  protected?: unknown
  rules?: unknown
}

interface AclRule { sid: string; rights: number; allow: boolean; inherited: boolean; flags: number }

function asRule(x: unknown): AclRule | null {
  if (!x || typeof x !== 'object') return null
  const r = x as Record<string, unknown>
  if (typeof r.sid !== 'string' || typeof r.rights !== 'number' || typeof r.allow !== 'boolean' || typeof r.inherited !== 'boolean' || typeof r.flags !== 'number') return null
  return { sid: r.sid, rights: r.rights, allow: r.allow, inherited: r.inherited, flags: r.flags }
}

/** Whether a folder's read is owner-only: no error; the owner the user;
 *  inheritance from above off; every entry an allow entry of its own for the
 *  user, SYSTEM or the Administrators group; the user with full control
 *  passed to what is inside; SYSTEM present. */
export function ownerOnlyVerdict(read: FolderAclRead | undefined, userSid: string): { ok: boolean; detail: string } {
  if (!read || typeof read !== 'object') return { ok: false, detail: 'no answer' }
  if (read.error) return { ok: false, detail: String(read.error) }
  if (typeof userSid !== 'string' || !userSid.startsWith('S-1-')) return { ok: false, detail: 'the user could not be named' }
  if (read.owner !== userSid) return { ok: false, detail: 'its owner is not this user' }
  if (read.protected !== true) return { ok: false, detail: 'it inherits rights from above' }
  const raw = read.rules == null ? [] : Array.isArray(read.rules) ? read.rules : [read.rules]
  const rules: AclRule[] = []
  for (const x of raw) {
    const r = asRule(x)
    if (!r) return { ok: false, detail: 'an entry could not be read' }
    rules.push(r)
  }
  for (const r of rules) {
    if (r.inherited) return { ok: false, detail: 'an inherited entry' }
    if (!r.allow) return { ok: false, detail: 'a deny entry' }
    if (r.sid !== userSid && r.sid !== OWNER_ONLY_SYSTEM_SID && r.sid !== OWNER_ONLY_ADMINISTRATORS_SID) return { ok: false, detail: `an entry for ${r.sid}` }
  }
  const userFull = rules.some((r) => r.sid === userSid && (r.rights & FULL_CONTROL) === FULL_CONTROL && (r.flags & CONTAINER_AND_OBJECT_INHERIT) === CONTAINER_AND_OBJECT_INHERIT)
  if (!userFull) return { ok: false, detail: 'this user lacks full control over it and what is inside' }
  if (!rules.some((r) => r.sid === OWNER_ONLY_SYSTEM_SID)) return { ok: false, detail: 'SYSTEM is missing' }
  return { ok: true, detail: 'owner-only' }
}

/** A drive or a share, never `\x`, `\\?\` or `\\.\` (as cli-runner). */
const WIN_ABSOLUTE_RE = /^([A-Za-z]:\\|\\\\[^\\?.][^\\]*\\[^\\]+\\)/

/** Why a folder may not be given to the script, or null when it may: it must
 *  be absolute (a drive or a share), one line with no control character, and
 *  (round 5, G2) no name in its path may end in a dot or a space, which
 *  Windows drops, so the rule would act on another folder. */
function unnameable(dir: unknown): string | null {
  if (typeof dir !== 'string' || !WIN_ABSOLUTE_RE.test(dir) || [...dir].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return 'the folder cannot be named safely'
  const names = dir.replace(/^([A-Za-z]:[\\/]|\\\\)/, '').split(/[\\/]/)
  if (names.some((n) => /[. ]$/.test(n))) return 'a name in its path ends in a dot or a space'
  return null
}

export type PowerShellRunner = (script: string, extraEnv: Record<string, string>) => Promise<string>

/** Windows: the folders made this user's and owner-only in ONE PowerShell
 *  call, and read back. Each answer is matched to its folder by its place in
 *  the call (round 5, G1), never by the text that comes back. Never throws: a
 *  folder that cannot be named, an answer that does not match what was asked,
 *  or any failure of the call, is refused; the last two say `unread`.
 *
 *  When the call gives no read at all, the same rule is applied with Windows'
 *  own programs (secureFoldersNative, `native`), and its answer is used when
 *  it gives one. `native` is the app's own unless a test brings one; a test
 *  that brings its own PowerShell runner gets none unless it brings that too. */
export async function secureFoldersWindows(
  dirs: readonly string[],
  run: PowerShellRunner = runWindowsPowerShell,
  native: NativeOwnerOnlyTools | null = run === runWindowsPowerShell ? nativeOwnerOnlyTools : null,
): Promise<OwnerOnlyFolderResult[]> {
  const sent = dirs.filter((d) => unnameable(d) === null)
  if (sent.length === 0) return dirs.map((dir) => ({ dir, ok: false, detail: unnameable(dir) ?? 'the folder cannot be named safely' }))
  let parsed: { user?: unknown; folders?: unknown } | null = null
  let failure = ''
  try {
    const out = await run(OWNER_ONLY_SCRIPT, { [OWNER_ONLY_DIRS_ENV]: sent.join('\n') })
    const v = JSON.parse(String(out).trim()) as unknown
    parsed = v && typeof v === 'object' ? v as { user?: unknown; folders?: unknown } : null
    if (!parsed) failure = 'the answer could not be read'
  } catch (err) {
    failure = `the rights could not be set or read (${(err as Error)?.message ?? err})`
  }
  const user = typeof parsed?.user === 'string' ? parsed.user : ''
  const reads = parsed?.folders == null ? [] : Array.isArray(parsed.folders) ? parsed.folders as FolderAclRead[] : [parsed.folders as FolderAclRead]
  if (native && (!parsed || reads.length !== sent.length)) {
    let answer: OwnerOnlyFolderResult[] | null = null
    try { answer = await secureFoldersNative(sent, native, run) } catch { answer = null }
    if (answer && answer.length === sent.length) {
      let at = 0
      return dirs.map((dir) => {
        const why = unnameable(dir)
        return why ? { dir, ok: false, detail: why } : answer![at++]
      })
    }
  }
  let place = 0
  return dirs.map((dir) => {
    const why = unnameable(dir)
    if (why) return { dir, ok: false, detail: why }
    const read = reads[place++]
    if (!parsed) return { dir, ok: false, detail: failure, unread: true }
    if (reads.length !== sent.length) return { dir, ok: false, detail: 'the answer does not match what was asked', unread: true }
    return { dir, ...ownerOnlyVerdict(read, user) }
  })
}

// ── The same rule with Windows' own programs ────────────────────────────────

/** What the rule runs where Windows PowerShell gives no read (see the file's
 *  header). The app's own (nativeOwnerOnlyTools) starts whoami.exe and
 *  icacls.exe from the system folder by their full paths, with no shell, and
 *  works on the real file system; a test brings its own. */
export interface NativeOwnerOnlyTools {
  /** Run whoami.exe or icacls.exe; resolves its exit code (null when it did
   *  not start or end) and what it wrote. Never rejects. */
  run(program: 'whoami' | 'icacls', args: readonly string[]): Promise<{ code: number | null; stdout: string }>
  /** The entry itself, never a link's target: null when nothing is there;
   *  throws on any other failure. `id` is its file identity (volume and
   *  file index), null when the file system gives none. */
  lstat(p: string): { link: boolean; folder: boolean; id?: string | null } | null
  /** Whether `p` is a folder (a link followed, as making a folder in it does). */
  isFolder(p: string): boolean
  /** Make one folder inside its existing parent; throws when it cannot. */
  mkdir(p: string): void
  /** Write `text` (UTF-16, as icacls reads its lists) to a new file in a new
   *  folder of its own, run `use` with that file, then remove both; throws
   *  when the file cannot be written. */
  withListFile<T>(text: string, use: (file: string) => Promise<T>): Promise<T>
}

/** whoami and icacls start quickly; still bounded. */
const NATIVE_TIMEOUT_MS = 30_000

export const nativeOwnerOnlyTools: NativeOwnerOnlyTools = {
  run: (program, args) => new Promise((resolve) => {
    execFile(path.win32.join(systemFolder(), `${program}.exe`), [...args], {
      encoding: 'utf8', windowsHide: true, timeout: NATIVE_TIMEOUT_MS, maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      const code = !err ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null
      resolve({ code, stdout: String(stdout ?? '') })
    })
  }),
  lstat: (p) => {
    let st: fs.BigIntStats
    try { st = fs.lstatSync(p, { bigint: true }) } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw e
    }
    return { link: st.isSymbolicLink(), folder: st.isDirectory(), id: st.ino ? `${st.dev}:${st.ino}` : null }
  },
  isFolder: (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } },
  mkdir: (p) => { fs.mkdirSync(p) },
  withListFile: async (text, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-owner-only-'))
    try {
      const file = path.join(dir, 'rights.txt')
      fs.writeFileSync(file, Buffer.from(text, 'utf16le'), { flag: 'wx' })
      return await use(file)
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* left in the temp folder */ }
    }
  },
}

/** The read the native rule makes, before and after: per folder whether it
 *  is there, its attributes, and its owner and rights as SDDL. Only what
 *  Constrained Language Mode allows: cmdlets (Test-Path, Get-Item, Get-Acl),
 *  plain hashtables and ConvertTo-Json. Every value it prints is ASCII (an
 *  SDDL string, a number or a flag), so no console encoding can change it.
 *  The folders come through the environment, one a line, never the text.
 *  The cmdlets' modules are loaded first, outside every folder's own try: a
 *  module that cannot be loaded stops the whole read, which is then no read
 *  at all (its folders unread), never a read of each folder that failed (its
 *  folders refused). */
export const OWNER_ONLY_READ_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Import-Module -Name Microsoft.PowerShell.Management, Microsoft.PowerShell.Security, Microsoft.PowerShell.Utility',
  '$out = @()',
  'foreach ($d in ($env:' + OWNER_ONLY_DIRS_ENV + " -split \"`n\")) {",
  '  if (-not $d) { continue }',
  '  $r = @{ missing = $false; attributes = $null; sddl = $null; error = $false }',
  '  try {',
  '    if (-not (Test-Path -LiteralPath $d)) { $r.missing = $true }',
  '    else {',
  '      $r.attributes = [int](Get-Item -LiteralPath $d -Force).Attributes',
  '      $r.sddl = [string](Get-Acl -LiteralPath $d).Sddl',
  '    }',
  '  } catch { $r.error = $true }',
  '  $out += $r',
  '}',
  'ConvertTo-Json -Compress -Depth 3 -InputObject @($out)',
].join('\n')

const FILE_ATTRIBUTE_DIRECTORY = 0x10
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400

interface NativeRead { missing: boolean; attributes: number | null; sddl: string | null; error: boolean }

/** One read of `dirs`, matched by place; null when the call gave no answer
 *  that matches what was asked. */
async function readNative(dirs: readonly string[], read: PowerShellRunner): Promise<NativeRead[] | null> {
  if (dirs.length === 0) return []
  let v: unknown
  try { v = JSON.parse(String(await read(OWNER_ONLY_READ_SCRIPT, { [OWNER_ONLY_DIRS_ENV]: dirs.join('\n') })).trim()) } catch { return null }
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : null
  if (!list || list.length !== dirs.length) return null
  return list.map((x) => {
    const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    return {
      missing: r.missing === true,
      attributes: typeof r.attributes === 'number' && Number.isInteger(r.attributes) ? r.attributes : null,
      sddl: typeof r.sddl === 'string' ? r.sddl : null,
      // Anything but a plain "no error" counts as one.
      error: r.error !== false,
    }
  })
}

/** The user's SID from `whoami /user /fo csv /nh` (one line: the name, then
 *  the SID, each quoted); '' when that is not what came back. */
export function sidFromWhoami(stdout: string): string {
  const lines = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length !== 1) return ''
  const m = /^"[^"]*","(S-1-\d+(?:-\d+)+)"$/.exec(lines[0])
  return m ? m[1] : ''
}

const SDDL_ACCOUNT = 'S-1-\\d+(?:-\\d+)+|[A-Z]{2}'
/** The owner, at the start of an SDDL string. */
const SDDL_OWNER_RE = new RegExp(`^O:(${SDDL_ACCOUNT})(?=G:|D:|S:|$)`)
/** Owner, group (if any), then the access list: its flags, then its entries,
 *  each in parentheses with none inside (a conditional entry has them:
 *  refused). */
const SDDL_RE = new RegExp(`^O:(${SDDL_ACCOUNT})(?:G:(?:${SDDL_ACCOUNT}))?D:([A-Z]*)((?:\\([^()]*\\))*)$`)
/** The file rights SDDL abbreviates (FA is FileSystemRights.FullControl). A
 *  generic or unknown one makes the entry read as no rights at all. */
const SDDL_FILE_RIGHTS: Readonly<Record<string, number>> = {
  FA: 0x1f01ff, FR: 0x120089, FW: 0x120116, FX: 0x1200a0,
  CC: 0x1, DC: 0x2, LC: 0x4, SW: 0x8, RP: 0x10, WP: 0x20, DT: 0x40, LO: 0x80, CR: 0x100,
  SD: 0x10000, RC: 0x20000, WD: 0x40000, WO: 0x80000,
}

/** The SID an SDDL account stands for: a SID as written; SYSTEM's and the
 *  Administrators group's fixed abbreviations as their SIDs; LA (the
 *  computer's built-in Administrator, which SDDL writes for that account) as
 *  the user only when the user is the account with that relative id (500);
 *  any other abbreviation as itself, another account, which the verdict
 *  refuses. */
function sddlAccount(token: string, userSid: string): string {
  if (token.startsWith('S-1-')) return token
  if (token === 'SY') return OWNER_ONLY_SYSTEM_SID
  if (token === 'BA') return OWNER_ONLY_ADMINISTRATORS_SID
  if (token === 'LA' && /^S-1-5-21-\d+-\d+-\d+-500$/.test(userSid)) return userSid
  return token
}

function sddlRights(text: string): number {
  if (/^0x[0-9a-f]{1,8}$/i.test(text)) return parseInt(text, 16)
  if (text.length === 0 || text.length % 2 !== 0) return 0
  let mask = 0
  for (let i = 0; i < text.length; i += 2) {
    const bits = SDDL_FILE_RIGHTS[text.slice(i, i + 2)]
    if (bits === undefined) return 0
    mask |= bits
  }
  return mask
}

/** The owner an SDDL string names, as the verdict names accounts (a SID, or
 *  SYSTEM's, the Administrators group's or LA's abbreviation as sddlAccount
 *  reads it); '' when it names none. Only the owner: the rights are what the
 *  rule replaces. */
export function ownerFromSddl(sddl: string, userSid: string): string {
  const m = SDDL_OWNER_RE.exec(String(sddl))
  return m ? sddlAccount(m[1], userSid) : ''
}

/** A folder's SDDL as the verdict reads it (owner, inheritance off, every
 *  entry by SID); an error when it is not the shape a folder's has. */
export function folderReadFromSddl(sddl: string, userSid: string): FolderAclRead {
  const m = SDDL_RE.exec(String(sddl))
  if (!m) return { error: 'its rights could not be read' }
  const rules: AclRule[] = []
  for (const ace of m[3].match(/\(([^()]*)\)/g) ?? []) {
    const f = ace.slice(1, -1).split(';')
    if (f.length !== 6 || f[3] !== '' || f[4] !== '' || !new RegExp(`^(?:${SDDL_ACCOUNT})$`).test(f[5]) || !/^(?:[A-Z]{2})*$/.test(f[1])) return { error: 'an entry could not be read' }
    const flags: string[] = f[1].match(/[A-Z]{2}/g) ?? []
    rules.push({
      sid: sddlAccount(f[5], userSid),
      rights: sddlRights(f[2]),
      allow: f[0] === 'A',
      inherited: flags.includes('ID'),
      flags: (flags.includes('CI') ? 1 : 0) | (flags.includes('OI') ? 2 : 0),
    })
  }
  return { error: null, owner: sddlAccount(m[1], userSid), protected: m[2].includes('P'), rules }
}

/** A step of the native rule that gave no answer at all (see
 *  secureFoldersNative): its folder is unread, never refused. */
class NoNativeAnswer extends Error {}

/** The rights each folder is given: exactly the user and SYSTEM, full control
 *  passed to what is inside, nothing inherited from above (what the script's
 *  SetAccessControl writes). */
const ownerOnlySddl = (userSid: string): string => `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${userSid})`

/**
 * The owner-only rule with Windows' own programs, for `dirs` in order (each
 * one that may be named): the same steps as the script, in the same order,
 * with the same refusals.
 *
 *  1. The user's SID (whoami), and a read of every folder (what is there,
 *     its attributes): without either (a read whose cmdlets could not be
 *     loaded included), nothing is changed and the answer is null (no read).
 *  2. Each folder in turn: below a refused folder, refused; below a folder
 *     of this call that is now a link, refused; one already there must be a
 *     real folder (never a link, a junction or any reparse point), owned by
 *     this user or the Administrators group by the first read's SDDL (see
 *     the file's header; no owner read, as for one there now that the read
 *     found missing, is a refusal too), and still the folder it was before
 *     that read (its file identity); a missing one is made inside its
 *     existing parent, failing if anything is there by then. Then its rights are set
 *     (icacls /restore: exactly the user and SYSTEM, full control passed to
 *     what is inside, inheritance off) and its owner (icacls /setowner), each
 *     on the folder itself, never a link's target (/L). A program that
 *     answers with a failure refuses the folder; one that did not start or
 *     finish, or a rights list that could not be written, is no answer: the
 *     folder, and what is below it, says `unread`.
 *  3. One read of the folders set, matched by place, judged by the same
 *     verdict as the script's read (ownerOnlyVerdict), the attributes again
 *     (a link or not a folder now: refused, and what is below it). No read:
 *     those folders say `unread`.
 *
 * Never throws.
 */
export async function secureFoldersNative(dirs: readonly string[], tools: NativeOwnerOnlyTools, read: PowerShellRunner): Promise<OwnerOnlyFolderResult[] | null> {
  const who = await tools.run('whoami', ['/user', '/fo', 'csv', '/nh'])
  const user = who.code === 0 ? sidFromWhoami(who.stdout) : ''
  if (!user) return null
  // Each folder's identity before the read: the folder written must be the
  // one whose owner was read.
  const ids = dirs.map((d) => { try { return tools.lstat(d)?.id ?? null } catch { return null } })
  const before = await readNative(dirs, read)
  if (!before) return null
  // Folders are named as Windows compares them: in any letter case.
  const key = (d: string) => d.toLowerCase()
  const failed = new Set<string>()
  const unanswered = new Set<string>()
  const done = new Set<string>()
  const results: Array<OwnerOnlyFolderResult | null> = dirs.map(() => null)
  const written: number[] = []
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i]
    try {
      const parent = path.win32.dirname(d)
      if (unanswered.has(key(parent))) throw new NoNativeAnswer('its parent could not be checked')
      if (failed.has(key(parent))) throw new Error('its parent was refused')
      if (done.has(key(parent))) {
        const p = tools.lstat(parent)
        if (!p || p.link || !p.folder) throw new Error('its parent is a link')
      }
      const pre = before[i]
      if (pre.error) throw new Error('it could not be read')
      if (!pre.missing) {
        if (pre.attributes === null || (pre.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) throw new Error('a link')
        if ((pre.attributes & FILE_ATTRIBUTE_DIRECTORY) === 0) throw new Error('not a folder')
      }
      const st = tools.lstat(d)
      if (st) {
        if (st.link) throw new Error('a link')
        if (!st.folder) throw new Error('not a folder')
        // Never taken over from another account (see the file's header).
        if (pre.missing || pre.sddl === null) throw new Error('its owner could not be read')
        const was = ownerFromSddl(pre.sddl, user)
        if (!was) throw new Error('its owner could not be read')
        if (was !== user && was !== OWNER_ONLY_ADMINISTRATORS_SID) throw new Error('its owner is not this user')
        if ((st.id ?? null) !== ids[i]) throw new Error('it was replaced while it was checked')
      } else {
        if (!tools.isFolder(parent)) throw new Error('its parent is missing')
        tools.mkdir(d)
      }
      const list = `${path.win32.basename(d)}\r\n${ownerOnlySddl(user)}\r\n`
      let rights: { code: number | null; stdout: string }
      try {
        rights = await tools.withListFile(list, (file) => tools.run('icacls', [parent, '/restore', file, '/L']))
      } catch {
        throw new NoNativeAnswer('its rights list could not be written')
      }
      if (rights.code === null) throw new NoNativeAnswer('its rights could not be set: the program did not start or finish')
      if (rights.code !== 0) throw new Error('its rights could not be set')
      const owner = await tools.run('icacls', [d, '/setowner', `*${user}`, '/L'])
      if (owner.code === null) throw new NoNativeAnswer('its owner could not be set: the program did not start or finish')
      if (owner.code !== 0) throw new Error('its owner could not be set')
      done.add(key(d))
      written.push(i)
    } catch (err) {
      const detail = String((err as Error)?.message ?? err)
      if (err instanceof NoNativeAnswer) {
        unanswered.add(key(d))
        results[i] = { dir: d, ok: false, detail, unread: true }
      } else {
        failed.add(key(d))
        results[i] = { dir: d, ok: false, detail }
      }
    }
  }
  const after = await readNative(written.map((i) => dirs[i]), read)
  const refusedAfter = new Set<string>()
  written.forEach((i, w) => {
    const d = dirs[i]
    if (!after) { results[i] = { dir: d, ok: false, detail: 'its rights could not be read back', unread: true }; return }
    const r = after[w]
    let verdict: { ok: boolean; detail: string }
    if (refusedAfter.has(key(path.win32.dirname(d)))) verdict = { ok: false, detail: 'its parent was refused' }
    else if (r.error || r.missing || r.attributes === null || r.sddl === null) verdict = { ok: false, detail: 'its rights could not be read back' }
    else if ((r.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) verdict = { ok: false, detail: 'a link' }
    else if ((r.attributes & FILE_ATTRIBUTE_DIRECTORY) === 0) verdict = { ok: false, detail: 'not a folder' }
    else verdict = ownerOnlyVerdict(folderReadFromSddl(r.sddl, user), user)
    if (!verdict.ok && ['a link', 'not a folder', 'its parent was refused', 'its rights could not be read back'].includes(verdict.detail)) refusedAfter.add(key(d))
    results[i] = { dir: d, ...verdict }
  })
  return results.map((r, i) => r ?? { dir: dirs[i], ok: false, detail: 'no answer' })
}

/** POSIX: each folder in turn made when missing (inside its parent), a real
 *  folder, this user's, 0700. Never throws. */
export async function secureFoldersPosix(dirs: readonly string[]): Promise<OwnerOnlyFolderResult[]> {
  const refused = new Set<string>()
  const done = new Set<string>()
  return dirs.map((dir) => {
    const refuse = (detail: string): OwnerOnlyFolderResult => { refused.add(dir); return { dir, ok: false, detail } }
    try {
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) return refuse('the folder cannot be named safely')
      const parent = path.dirname(dir)
      if (refused.has(parent)) return refuse('its parent was refused')
      if (done.has(parent) && fs.lstatSync(parent).isSymbolicLink()) return refuse('its parent is a link')
      let st: fs.Stats | null = null
      try { st = fs.lstatSync(dir) } catch { st = null }
      if (!st) {
        fs.mkdirSync(dir, { mode: 0o700 })
        st = fs.lstatSync(dir)
      }
      if (st.isSymbolicLink() || !st.isDirectory()) return refuse('a link or not a folder')
      fs.chmodSync(dir, 0o700)
      st = fs.lstatSync(dir)
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return refuse('its owner is not this user')
      if ((st.mode & 0o077) !== 0) return refuse('others have rights over it')
      done.add(dir)
      return { dir, ok: true, detail: 'owner-only' }
    } catch (err) {
      return refuse(String((err as Error)?.message ?? err))
    }
  })
}

/** This platform's rule. */
export function secureOwnerOnlyFolders(dirs: readonly string[]): Promise<OwnerOnlyFolderResult[]> {
  return process.platform === 'win32' ? secureFoldersWindows(dirs) : secureFoldersPosix(dirs)
}
