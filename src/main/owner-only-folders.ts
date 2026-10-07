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
// Windows: ONE Windows PowerShell call for all the folders, started
// asynchronously (execFile, never the synchronous form) from the system folder
// by its full path, the folders passed through the environment (never inside
// the script's text), the owner and rights read back by SID. POSIX: 0700 and
// the user's own uid, with the same order.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface OwnerOnlyFolderResult {
  dir: string
  ok: boolean
  detail: string
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

/** Windows PowerShell by its absolute path in the system folder. */
function powershellPath(): string {
  const root = process.env.SystemRoot
  const base = typeof root === 'string' && /^[A-Za-z]:\\/.test(root) ? root : 'C:\\Windows'
  return path.win32.join(base, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** Run one Windows PowerShell script, asynchronously, with `extraEnv` added
 *  to this process's environment. Resolves its standard output. */
export function runWindowsPowerShell(script: string, extraEnv: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: 1024 * 1024,
      env: { ...process.env, ...extraEnv },
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
  '    if ($null -ne $attr) {',
  "      if (($attr -band $reparse) -ne 0) { throw 'a link' }",
  "      if (($attr -band [IO.FileAttributes]::Directory) -eq 0) { throw 'not a folder' }",
  '    } else {',
  "      if (-not [IO.Directory]::Exists($parent)) { throw 'its parent is missing' }",
  '      [void][IO.Directory]::CreateDirectory($d)',
  '    }',
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
 *  or any failure of the call, is refused. */
export async function secureFoldersWindows(dirs: readonly string[], run: PowerShellRunner = runWindowsPowerShell): Promise<OwnerOnlyFolderResult[]> {
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
  let place = 0
  return dirs.map((dir) => {
    const why = unnameable(dir)
    if (why) return { dir, ok: false, detail: why }
    const read = reads[place++]
    if (!parsed) return { dir, ok: false, detail: failure }
    if (reads.length !== sent.length) return { dir, ok: false, detail: 'the answer does not match what was asked' }
    return { dir, ...ownerOnlyVerdict(read, user) }
  })
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
