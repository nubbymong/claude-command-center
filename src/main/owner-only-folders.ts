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
// accepted beside the two) and what is inside it does too (below); anything
// else, or any doubt, refuses it, and every folder below a folder whose own
// rights were refused is refused too.
//
// For the account sign-in folders (secureSignInFoldersWindows; every other
// caller gets the folders' own rights only), what is already inside a folder
// made owner-only in place is put right too, one level deep. The owner and
// the rights are written to the folder separately, the owner first, so that
// the write of the rights alone is what Windows passes on to what is inside
// it, whoever owns each entry. Below the entries directly inside, nothing is
// read or reset: an entry deeper down keeps the rights Windows gives it with
// that write (Windows rewrites the inherited part only where this user may
// change that entry's rights), and one with entries of its own, or with
// inheritance off, keeps them.
//
// Each entry directly inside the folder is then read (named in the form that
// has no 260-character limit, where Windows takes it), and no link is ever
// followed, gone into or changed by this read. The sign-in files the app
// writes (.credentials.json, .claude.json, by name in any letter case) are
// held to all of what follows: one that is a link or any other reparse point
// refuses the folder (a sign-in file read through one has the rights of what
// it points to), and so does one another account owns (it is never made this
// user's). Any other entry that is a link or any other reparse point (a cloud
// file's placeholder among them) has only its own owner read (a read of a
// link's owner by its name gives the link's own, never what it points to):
// never read through, gone into or changed, its own rights neither judged
// nor reset; one another account owns refuses the folder. Any other entry
// another account owns is made this user's first (the owner alone written,
// never a file with more than one name) and then put right as below; one
// that cannot be made so stays that account's and refuses the folder. A
// folder of the same call is left to its own turn (where a link, or a folder
// another account owns, is refused), and so is an entry the caller names as
// shared while it is a file with more than one name (the home mirror's links
// to the user's own files, whose rights are those of the user's real files;
// never a sign-in file). Every other entry is owned by this user, the
// Administrators group or SYSTEM, and must give rights to nobody but the
// user, SYSTEM and the Administrators group; one that does not loses every
// entry of its own and takes the folder's rights (inheritance on), and is
// read again -- unless it is a file with more than one name (it is never
// reset: another of its names can be outside the folder), which then refuses
// the folder. An entry gone since it was listed is passed over. Every entry
// read comes back with the answer and is judged by the same verdict
// (ownerOnlyInsideVerdict); the folder passes only when every one of them
// holds that, and the answer counts the entries made this user's
// (takenOver). An entry that cannot be read or made so refuses the folder.
//
// Before a folder's owner or rights are changed, its owner is read: anyone
// but this user or the Administrators group refuses it, and nothing is
// written to it (only this user, or an administrator, who can take any
// folder anyway, can make a folder that this user or that group owns). A
// folder the call makes itself is read the same way once made, so one that
// another account put in its place meanwhile is refused too.
//
// Windows: ONE Windows PowerShell call for all the folders, started
// asynchronously (execFile, never the synchronous form) from the system folder
// by its full path, the folders passed through the environment (never inside
// the script's text), the owner and rights read back by SID. POSIX: 0700 and
// the user's own uid, with the same order.
//
// Where that call gives no read at all -- Windows PowerShell restricted to its
// Constrained Language Mode (AppLocker or WDAC script enforcement), which
// refuses the .NET calls the script makes at once -- the same rule is applied with
// Windows' own programs instead (secureFoldersNative): the user's SID from
// whoami.exe, the rights set with icacls.exe (inheritance off, the user and
// SYSTEM granted, every other account's own entry removed: a write of rights
// alone, as above; never /restore, which needs a privilege only an elevated
// process has) and the owner with icacls.exe /setowner, each on the folder
// itself, never a link's target (/L); then everything is read back with
// scripts that use only what that mode allows (Get-Item, Get-ChildItem,
// Get-Acl and its SDDL, which names every account by SID or by a fixed
// abbreviation, in any language), and judged by the same verdicts. What is
// directly inside is read the same way and judged by the same rules, another
// account's entry to make this user's is given to the user with icacls.exe
// /setowner on that entry itself, an entry to put right is reset with
// icacls.exe /reset on that entry itself (/L each; never /T, which goes
// through a junction; never a file with more than one name, by its link
// count), and it is read again. Same order, same
// refusals; the owner a folder had before is read from the first read's
// SDDL, and the folder must still be that same folder when it is written. A
// script call that ran past its time limit is no read at all and is not
// followed by this route (a refusal of the script comes at once), and this
// route has one time limit of its own: a folder it has not reached by then
// is not read (unread).
//
// Every Windows PowerShell call gets Windows PowerShell's own modules folder
// as its module path (windowsPowerShellEnv), never the one this process
// inherited: PowerShell 7 puts its own modules first in the module path of
// every program it starts, and Windows PowerShell then cannot load the
// cmdlets the read uses (Get-Acl: "found in the module
// 'Microsoft.PowerShell.Security', but the module could not be loaded").
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface OwnerOnlyFolderResult {
  dir: string
  ok: boolean
  detail: string
  /** The call gave no read of this folder at all (it could not run or end,
   *  or its answer could not be read or does not match what was asked), as
   *  against a folder read and refused. Never set on a pass. */
  unread?: true
  /** On a pass of a folder whose inside was read: how many entries directly
   *  inside it, none of them a sign-in file, another account owned that were
   *  made this user's and put right; absent when none. */
  takenOver?: number
}

/** SYSTEM, and the Administrators group, by SID (names are localized). */
export const OWNER_ONLY_SYSTEM_SID = 'S-1-5-18'
export const OWNER_ONLY_ADMINISTRATORS_SID = 'S-1-5-32-544'
/** The variable that carries the folders, one a line, to the script. */
export const OWNER_ONLY_DIRS_ENV = 'CCC_OWNER_ONLY_DIRS'
/** The variable that carries, to the read of what is inside a folder, the
 *  folders of the whole call (one a line: each is left to its own turn). */
export const OWNER_ONLY_SKIP_ENV = 'CCC_OWNER_ONLY_SKIP'
/** The variable that asks the script to read what is inside each folder too
 *  ('1'; anything else: the folders' own rights only), and the one that
 *  carries the entries left out of that read (OwnerOnlyOptions.shared), one a
 *  line. */
export const OWNER_ONLY_INSIDE_ENV = 'CCC_OWNER_ONLY_INSIDE'
export const OWNER_ONLY_SHARED_ENV = 'CCC_OWNER_ONLY_SHARED'
/** The sign-in files the app writes: always read, never left out as shared,
 *  never passed over as a link, never made this user's when another account
 *  owns one. */
const SIGN_IN_FILE_NAMES: readonly string[] = ['.claude.json', '.credentials.json']
/** Whether a name is one of the sign-in files', in any letter case (compared
 *  upper-cased, as NTFS compares names, so no language's casing rule can
 *  tell them apart). */
function isSignInFileName(name: string): boolean {
  const up = name.toUpperCase()
  return SIGN_IN_FILE_NAMES.some((n) => n.toUpperCase() === up)
}
/** The scripts' table of the sign-in files' names, upper-cased (each entry's
 *  name is looked up upper-cased, the invariant way). */
const SIGN_IN_TABLE = '$signIn = @{ ' + SIGN_IN_FILE_NAMES.map((n) => "'" + n.toUpperCase() + "' = $true").join('; ') + ' }'
/** A PowerShell start is slow on a cold machine; still bounded. */
const POWERSHELL_TIMEOUT_MS = 30_000
/** The answer lists every entry directly inside a folder: room for it. */
const POWERSHELL_MAX_BUFFER = 32 * 1024 * 1024
/** Entries directly inside one folder that may come back not owner-only
 *  before the read stops (the folder is refused either way). */
const INSIDE_MAX_REFUSED = 50
/** Why what is inside a folder refuses it, in fixed words (never a path). */
const INSIDE_NOT_READ = 'what is inside it was not read'
const INSIDE_NOT_MADE = 'what is inside it could not be made owner-only'
const INSIDE_SIGN_IN_LINK = 'a sign-in file inside it is a link'
const INSIDE_OTHER_OWNER = "a sign-in file inside it is another account's"
const INSIDE_ENTRY_OTHER_OWNER = "an entry inside it is another account's"
const INSIDE_NOT_OWNER_ONLY = 'an entry inside it is not owner-only'
/** Every reason ownerOnlyInsideVerdict and the native rule give for what is inside. */
export const OWNER_ONLY_INSIDE_REASONS: readonly string[] = [INSIDE_NOT_READ, INSIDE_NOT_MADE, INSIDE_SIGN_IN_LINK, INSIDE_OTHER_OWNER, INSIDE_ENTRY_OTHER_OWNER, INSIDE_NOT_OWNER_ONLY]
/** The reasons that say the read of what is inside failed (an entry gone
 *  while it was read can do that), as against an entry read and judged: a
 *  caller may ask once more before it acts on one. */
export const OWNER_ONLY_INSIDE_FAILED_REASONS: readonly string[] = [INSIDE_NOT_READ, INSIDE_NOT_MADE]
/** FileSystemRights.FullControl, and ContainerInherit | ObjectInherit. */
const FULL_CONTROL = 0x1f01ff
const CONTAINER_AND_OBJECT_INHERIT = 3

/** What the rule does beyond each folder's own rights. */
export interface OwnerOnlyOptions {
  /** Read what is directly inside each folder too, put right what may be,
   *  and pass a folder only when that holds (see the file's header). Only
   *  the account sign-in folders ask for it (secureSignInFoldersWindows);
   *  off, the rule writes and reads the folders' own rights alone. */
  inside?: boolean
  /** Entries inside a folder (full paths) that the read of what is inside
   *  leaves out while each is a file with more than one name: the home
   *  mirror's links to the user's own files. A sign-in file is never left
   *  out. Read only with `inside`. */
  shared?: readonly string[]
}

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
      encoding: 'utf8', windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: POWERSHELL_MAX_BUFFER,
      env: windowsPowerShellEnv(process.env, extraEnv),
    }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
}

/** The one script: for each folder in turn (see the file's header), make it
 *  when missing, set owner and rights, read both back by SID, then read what
 *  is inside it (putting right what may be). Prints one JSON object: the
 *  user's SID and, per folder, the read or the error, with what is inside. */
export const OWNER_ONLY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$user = [Security.Principal.WindowsIdentity]::GetCurrent().User',
  "$system = New-Object Security.Principal.SecurityIdentifier '" + OWNER_ONLY_SYSTEM_SID + "'",
  "$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
  "$none = [Security.AccessControl.PropagationFlags]'None'",
  "$allow = [Security.AccessControl.AccessControlType]'Allow'",
  "$full = [Security.AccessControl.FileSystemRights]'FullControl'",
  '$reparse = [IO.FileAttributes]::ReparsePoint',
  '$folderAttr = [IO.FileAttributes]::Directory',
  '$sidType = [Security.Principal.SecurityIdentifier]',
  "$both = [Security.AccessControl.AccessControlSections]'Owner, Access'",
  "$rightsOnly = [Security.AccessControl.AccessControlSections]'Access'",
  "$ownerOnly = [Security.AccessControl.AccessControlSections]'Owner'",
  // Whether what is inside each folder is read too (see the file's header).
  "$walk = $env:" + OWNER_ONLY_INSIDE_ENV + " -eq '1'",
  // Who may own an entry inside, and who may have rights to it (by SID).
  "$okOwner = @{ ($user.Value) = $true; '" + OWNER_ONLY_SYSTEM_SID + "' = $true; '" + OWNER_ONLY_ADMINISTRATORS_SID + "' = $true }",
  "$okSid = @{ ($user.Value) = $true; '" + OWNER_ONLY_SYSTEM_SID + "' = $true; '" + OWNER_ONLY_ADMINISTRATORS_SID + "' = $true }",
  // A path in the form that has no length limit (\\?\, or \\?\UNC\ for a
  // share): what is inside a folder can be deeper than 260 characters. The
  // backslashes are characters (92), so the script's text names no path.
  '$bs = [string][char]92',
  "function Long([string]$x) { if ($x.StartsWith($bs + $bs)) { $bs + $bs + '?' + $bs + 'UNC' + $bs + $x.Substring(2) } else { $bs + $bs + '?' + $bs + $x } }",
  // Whether an entry is there at all (a failure on one gone since it was
  // listed passes it over; on any other, it refuses the folder).
  'function There([string]$x) { [IO.File]::Exists($x) -or [IO.Directory]::Exists($x) }',
  // Whether a file has exactly one name, by fsutil from the system folder
  // (Windows PowerShell's own link type misses a link when it cannot open the
  // file); a file with more than one, or no answer, is never reset.
  "$fsutil = [IO.Path]::Combine([Environment]::SystemDirectory, 'fsutil.exe')",
  "function OneName([string]$x) { $ErrorActionPreference = 'Continue'; $o = @(& $fsutil hardlink list $x 2>$null); ($LASTEXITCODE -eq 0) -and ($o.Count -eq 1) }",
  // Whether a read holds the owner-only rights inside (owner and every entry,
  // by SID), and its entries for the answer.
  'function Clean($a) { if (-not $okOwner.ContainsKey($a.GetOwner($sidType).Value)) { return $false }; foreach ($x in $a.GetAccessRules($true, $true, $sidType)) { if ($x.AccessControlType -ne $allow -or -not $okSid.ContainsKey($x.IdentityReference.Value)) { return $false } }; return $true }',
  'function Rules($a) { ,@(foreach ($x in $a.GetAccessRules($true, $true, $sidType)) { [ordered]@{ sid = $x.IdentityReference.Value; rights = [int]$x.FileSystemRights; allow = ($x.AccessControlType -eq $allow); inherited = $x.IsInherited; flags = [int]$x.InheritanceFlags } }) }',
  '$asked = @{}',
  'foreach ($x in ($env:' + OWNER_ONLY_DIRS_ENV + " -split \"`n\")) { if ($x) { $asked[$x] = $true; $asked[(Long $x)] = $true } }",
  // The entries left out while each is a file with more than one name (never a sign-in file).
  '$shared = @{}',
  'foreach ($x in ($env:' + OWNER_ONLY_SHARED_ENV + " -split \"`n\")) { if ($x) { $shared[$x] = $true; $shared[(Long $x)] = $true } }",
  SIGN_IN_TABLE,
  '$done = @{}',
  '$failed = @{}',
  '$out = @()',
  'foreach ($d in ($env:' + OWNER_ONLY_DIRS_ENV + " -split \"`n\")) {",
  '  if (-not $d) { continue }',
  '  $r = [ordered]@{ dir = $d; error = $null; owner = $null; protected = $false; rules = @(); inside = $null; insideError = $null }',
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
  // Another account's folder is refused (see the file's header): the owner
  // it has now, read before anything is changed, also when the line above
  // made it (CreateDirectory takes a folder already there without a word).
  "    $was = [IO.Directory]::GetAccessControl($d, [Security.AccessControl.AccessControlSections]'Owner').GetOwner([Security.Principal.SecurityIdentifier]).Value",
  "    if ($was -ne $user.Value -and $was -ne '" + OWNER_ONLY_ADMINISTRATORS_SID + "') { throw 'its owner is not this user' }",
  // The owner alone, then the rights alone (see the file's header): a write
  // of rights alone reaches what is inside, whoever owns it.
  '    $o = New-Object Security.AccessControl.DirectorySecurity',
  '    $o.SetOwner($user)',
  '    [IO.Directory]::SetAccessControl($d, $o)',
  '    $s = New-Object Security.AccessControl.DirectorySecurity',
  '    $s.SetAccessRuleProtection($true, $false)',
  '    $s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($user, $full, $inherit, $none, $allow)))',
  '    $s.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, $full, $inherit, $none, $allow)))',
  '    [IO.Directory]::SetAccessControl($d, $s)',
  "    $a = [IO.Directory]::GetAccessControl($d, [Security.AccessControl.AccessControlSections]'Owner, Access')",
  '    $r.owner = $a.GetOwner([Security.Principal.SecurityIdentifier]).Value',
  '    $r.protected = $a.AreAccessRulesProtected',
  '    $r.rules = @(foreach ($x in $a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) { [ordered]@{ sid = $x.IdentityReference.Value; rights = [int]$x.FileSystemRights; allow = ($x.AccessControlType -eq $allow); inherited = $x.IsInherited; flags = [int]$x.InheritanceFlags } })',
  '    $done[$d] = $true',
  // What is inside (see the file's header), when asked: the entries
  // directly inside the folder only, never deeper and never through a link.
  // A folder of this call is left to its own turn, and so is a shared entry
  // while it is a file with more than one name. A sign-in file is held to
  // all of it; any other link (any reparse point) has only its own owner
  // read, and any other entry another account owns is made this user's
  // where it may be. Every entry read comes back; a failure here refuses
  // this folder, not the folders below it.
  '    if ($walk) {',
  '    $inside = New-Object Collections.Generic.List[object]',
  '    $r.inside = $inside',
  '    try {',
  '      $refused = 0',
  // Listed in the long form where this Windows takes it, else as named.
  '      $root = ([IO.DirectoryInfo]$d).FullName.TrimEnd([char]92)',
  '      try { $long = Long $root; $null = ([IO.DirectoryInfo]$long).Attributes; $root = $long } catch { }',
  '      foreach ($e in @(([IO.DirectoryInfo]$root).EnumerateFileSystemInfos())) {',
  '        $p = $e.FullName',
  '        if ($asked.ContainsKey($p)) { continue }',
  '        $isDir = ($e.Attributes -band $folderAttr) -ne 0',
  '        $isLink = ($e.Attributes -band $reparse) -ne 0',
  '        $cred = $signIn.ContainsKey($e.Name.ToUpperInvariant())',
  "        if (-not $isDir -and -not $isLink -and -not $cred -and $shared.ContainsKey($p) -and [string]$e.LinkType -eq 'HardLink') { continue }",
  // A sign-in file that is a link is never read through: it refuses the folder.
  '        if ($isLink -and $cred) { $inside.Add([ordered]@{ name = $e.Name; link = $true; folder = $isDir; linkType = [string]$e.LinkType }); $refused++; continue }',
  // Any other link or reparse point (a cloud file's placeholder too): its
  // own owner only (a read of a link's owner by its name gives the link's
  // own), never read through, gone into or changed; the verdict refuses one
  // another account owns.
  '        if ($isLink) {',
  '          try { $lk = if ($isDir) { [IO.Directory]::GetAccessControl($p, $ownerOnly) } else { [IO.File]::GetAccessControl($p, $ownerOnly) }; $lo = $lk.GetOwner($sidType).Value }',
  '          catch { if (There $p) { throw }; continue }',
  '          $inside.Add([ordered]@{ name = $e.Name; link = $true; folder = $isDir; linkType = [string]$e.LinkType; owner = $lo })',
  "          if (-not $okOwner.ContainsKey($lo)) { $refused++; if ($refused -ge " + INSIDE_MAX_REFUSED + ") { throw 'too many' } }",
  '          continue',
  '        }',
  '        try { $a = if ($isDir) { [IO.Directory]::GetAccessControl($p, $both) } else { [IO.File]::GetAccessControl($p, $both) } }',
  '        catch { if (There $p) { throw }; continue }',
  '        $ok = Clean $a',
  '        $own = $a.GetOwner($sidType).Value',
  // Another account's entry, never a sign-in file and never a file with
  // more than one name: made this user's first, the owner alone written,
  // and read again (then put right below). One that cannot be made so stays
  // that account's, and the verdict refuses it.
  '        $taken = $false',
  '        if (-not $okOwner.ContainsKey($own) -and -not $cred -and ($isDir -or (OneName $p))) {',
  '          try {',
  '            $w = if ($isDir) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }',
  '            $w.SetOwner($user)',
  '            if ($isDir) { [IO.Directory]::SetAccessControl($p, $w) } else { [IO.File]::SetAccessControl($p, $w) }',
  '            $a = if ($isDir) { [IO.Directory]::GetAccessControl($p, $both) } else { [IO.File]::GetAccessControl($p, $both) }',
  '            $ok = Clean $a',
  '            $own = $a.GetOwner($sidType).Value',
  '            $taken = $own -eq $user.Value',
  '          } catch { if (-not (There $p)) { continue } }',
  '        }',
  // One this user, the Administrators group or SYSTEM owns (one just made
  // this user's among them) that lets anyone else in: its own entries go and
  // it takes the folder's rights (inheritance on, the rights alone
  // written), and it is read again -- never a file with more than one name.
  '        if (-not $ok -and $okOwner.ContainsKey($own) -and ($isDir -or $taken -or (OneName $p))) {',
  '          try {',
  '            $t = if ($isDir) { [IO.Directory]::GetAccessControl($p, $rightsOnly) } else { [IO.File]::GetAccessControl($p, $rightsOnly) }',
  '            foreach ($x in @($t.GetAccessRules($true, $false, $sidType))) { [void]$t.RemoveAccessRuleSpecific($x) }',
  '            $t.SetAccessRuleProtection($false, $false)',
  '            if ($isDir) { [IO.Directory]::SetAccessControl($p, $t) } else { [IO.File]::SetAccessControl($p, $t) }',
  '            $a = if ($isDir) { [IO.Directory]::GetAccessControl($p, $both) } else { [IO.File]::GetAccessControl($p, $both) }',
  '          } catch { if (There $p) { throw }; continue }',
  '          $ok = Clean $a',
  '          $own = $a.GetOwner($sidType).Value',
  '        }',
  '        $inside.Add([ordered]@{ name = $e.Name; link = $false; folder = $isDir; owner = $own; rules = (Rules $a); takenOver = $taken })',
  "        if (-not $ok) { $refused++; if ($refused -ge " + INSIDE_MAX_REFUSED + ") { throw 'too many' } }",
  '      }',
  '    } catch {',
  "      $r.insideError = '" + INSIDE_NOT_MADE + "'",
  '    }',
  '    }',
  '  } catch {',
  '    $r.error = [string]$_.Exception.Message',
  '    $failed[$d] = $true',
  '  }',
  '  $out += [pscustomobject]$r',
  '}',
  '$json = [pscustomobject]@{ user = $user.Value; folders = @($out) } | ConvertTo-Json -Compress -Depth 10',
  // Round 5 (G1): the answer in ASCII only, every other character written as
  // a JSON escape, so no console encoding can change it on the way back.
  '$sb = New-Object Text.StringBuilder',
  "foreach ($c in $json.ToCharArray()) { $n = [int]$c; if ($n -gt 126) { [void]$sb.Append('\\u').Append($n.ToString('x4')) } else { [void]$sb.Append($c) } }",
  '$sb.ToString()',
].join('\n')

/** One folder's read, as the script prints it, with what is inside it
 *  (`inside`: InsideEntryRead each; `insideError`: what is inside could not
 *  be read or made owner-only). */
export interface FolderAclRead {
  dir?: unknown
  error?: unknown
  owner?: unknown
  protected?: unknown
  rules?: unknown
  inside?: unknown
  insideError?: unknown
}

/** One entry directly inside a folder, as a read gives it: its name;
 *  whether it is a link (any reparse point, never followed) and whether it
 *  is a folder; for a link its kind as Windows PowerShell names it (only
 *  noted: a sign-in file that is a link is refused whatever its kind) and,
 *  unless it is a sign-in file, the link's own owner by SID (its rights are
 *  not read); for any entry but a link its own owner and rights by SID (as
 *  a folder's), or `error` when they could not be read; `takenOver` when
 *  the read made another account's entry this user's before reading it. */
export interface InsideEntryRead {
  name?: unknown
  link?: unknown
  folder?: unknown
  linkType?: unknown
  owner?: unknown
  rules?: unknown
  error?: unknown
  takenOver?: unknown
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

/** A verdict on a folder: whether it passes and why not; on a pass of one
 *  whose inside was read, how many entries directly inside it another
 *  account owned were made this user's (none of them a sign-in file). */
export interface OwnerOnlyVerdict { ok: boolean; detail: string; takenOver?: number }

/** Whether an entry is held to the whole rule as a sign-in file: one of
 *  their names, in any letter case, or a name that cannot be read or is not
 *  a plain name (a read gives only the entries directly inside a folder). */
function heldAsSignInFile(name: unknown): boolean {
  return typeof name !== 'string' || name === '' || /[\\/]/.test(name) || isSignInFileName(name)
}

/** Whether what is directly inside a folder, as its read gives it, holds
 *  the folder's owner-only rights (see the file's header): the read is there
 *  and gave no error; a sign-in file (heldAsSignInFile) is no link (any
 *  reparse point); every entry, a link among them, is owned by this user,
 *  the Administrators group or SYSTEM (a sign-in file another account owns
 *  and any other such entry each refuse it in their own words); a link's
 *  own rights are not judged (it is never read through); every other entry
 *  gives rights only to the user, SYSTEM and the Administrators group (allow
 *  entries, its own or inherited). Anything else, or anything that cannot
 *  be read, refuses the folder. A pass counts the entries the read made
 *  this user's (takenOver). */
export function ownerOnlyInsideVerdict(read: Pick<FolderAclRead, 'inside' | 'insideError'> | undefined, userSid: string): OwnerOnlyVerdict {
  if (!read || typeof read !== 'object') return { ok: false, detail: INSIDE_NOT_READ }
  if (read.insideError) return { ok: false, detail: INSIDE_NOT_MADE }
  if (read.inside == null) return { ok: false, detail: INSIDE_NOT_READ }
  if (typeof userSid !== 'string' || !userSid.startsWith('S-1-')) return { ok: false, detail: 'the user could not be named' }
  const entries = Array.isArray(read.inside) ? read.inside : [read.inside]
  let takenOver = 0
  for (const x of entries) {
    if (!x || typeof x !== 'object') return { ok: false, detail: INSIDE_NOT_READ }
    const e = x as InsideEntryRead
    if (e.error) return { ok: false, detail: INSIDE_NOT_READ }
    if (e.link !== true && e.link !== false) return { ok: false, detail: INSIDE_NOT_READ }
    const signIn = heldAsSignInFile(e.name)
    // A sign-in file that is a link (any reparse point) is never read through.
    if (e.link === true && signIn) return { ok: false, detail: INSIDE_SIGN_IN_LINK }
    if (e.owner !== userSid && e.owner !== OWNER_ONLY_ADMINISTRATORS_SID && e.owner !== OWNER_ONLY_SYSTEM_SID) {
      if (typeof e.owner !== 'string' || !e.owner) return { ok: false, detail: INSIDE_NOT_READ }
      return { ok: false, detail: signIn ? INSIDE_OTHER_OWNER : INSIDE_ENTRY_OTHER_OWNER }
    }
    // Any other link: its own owner is all that is read.
    if (e.link === true) continue
    const raw = e.rules == null ? [] : Array.isArray(e.rules) ? e.rules : [e.rules]
    for (const y of raw) {
      const r = asRule(y)
      if (!r) return { ok: false, detail: INSIDE_NOT_READ }
      if (!r.allow || (r.sid !== userSid && r.sid !== OWNER_ONLY_SYSTEM_SID && r.sid !== OWNER_ONLY_ADMINISTRATORS_SID)) return { ok: false, detail: INSIDE_NOT_OWNER_ONLY }
    }
    if (e.takenOver === true) takenOver++
  }
  return takenOver > 0 ? { ok: true, detail: 'owner-only', takenOver } : { ok: true, detail: 'owner-only' }
}

/** A folder's whole verdict: its own read (ownerOnlyVerdict), then what is
 *  inside it (ownerOnlyInsideVerdict). */
export function ownerOnlyFolderVerdict(read: FolderAclRead | undefined, userSid: string): OwnerOnlyVerdict {
  const own = ownerOnlyVerdict(read, userSid)
  return own.ok ? ownerOnlyInsideVerdict(read, userSid) : own
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

/** The shared entries a call may leave out (OwnerOnlyOptions.shared): each
 *  one that can be named, never a sign-in file. */
function sharedEntries(shared: readonly string[] | undefined): string[] {
  return (shared ?? []).filter((p) => typeof p === 'string' && unnameable(p) === null && !isSignInFileName(path.win32.basename(p)))
}

/** Windows: the folders made this user's and owner-only in ONE PowerShell
 *  call, and read back. Each answer is matched to its folder by its place in
 *  the call (round 5, G1), never by the text that comes back. Never throws: a
 *  folder that cannot be named, an answer that does not match what was asked,
 *  or any failure of the call, is refused; the last two say `unread`.
 *
 *  With `opts.inside` (the account sign-in folders only), what is directly
 *  inside each folder is read and put right too, and a folder passes only
 *  when that holds (see the file's header); without it, the rule writes and
 *  judges the folders' own rights alone, and the call says so
 *  (OWNER_ONLY_INSIDE_ENV '0'), whatever this process's environment holds.
 *
 *  When the call gives no read at all, the same rule is applied with Windows'
 *  own programs (secureFoldersNative, `native`), and its answer is used when
 *  it gives one -- unless the call ran past its time limit: that route is for
 *  a refusal of the script, which comes at once, and a folder too large for
 *  the script's time is no quicker there. `native` is the app's own unless a
 *  test brings one; a test that brings its own PowerShell runner gets none
 *  unless it brings that too. */
export async function secureFoldersWindows(
  dirs: readonly string[],
  run: PowerShellRunner = runWindowsPowerShell,
  native: NativeOwnerOnlyTools | null = run === runWindowsPowerShell ? nativeOwnerOnlyTools : null,
  opts: OwnerOnlyOptions = {},
): Promise<OwnerOnlyFolderResult[]> {
  const sent = dirs.filter((d) => unnameable(d) === null)
  if (sent.length === 0) return dirs.map((dir) => ({ dir, ok: false, detail: unnameable(dir) ?? 'the folder cannot be named safely' }))
  const inside = opts.inside === true
  const shared = inside ? sharedEntries(opts.shared) : []
  let parsed: { user?: unknown; folders?: unknown } | null = null
  let failure = ''
  let timedOut = false
  try {
    const out = await run(OWNER_ONLY_SCRIPT, { [OWNER_ONLY_DIRS_ENV]: sent.join('\n'), [OWNER_ONLY_INSIDE_ENV]: inside ? '1' : '0', [OWNER_ONLY_SHARED_ENV]: shared.join('\n') })
    const v = JSON.parse(String(out).trim()) as unknown
    parsed = v && typeof v === 'object' ? v as { user?: unknown; folders?: unknown } : null
    if (!parsed) failure = 'the answer could not be read'
  } catch (err) {
    failure = `the rights could not be set or read (${(err as Error)?.message ?? err})`
    timedOut = (err as { killed?: unknown } | null)?.killed === true
  }
  const user = typeof parsed?.user === 'string' ? parsed.user : ''
  const reads = parsed?.folders == null ? [] : Array.isArray(parsed.folders) ? parsed.folders as FolderAclRead[] : [parsed.folders as FolderAclRead]
  if (native && !timedOut && (!parsed || reads.length !== sent.length)) {
    let answer: OwnerOnlyFolderResult[] | null = null
    try { answer = await secureFoldersNative(sent, native, run, { inside, shared }) } catch { answer = null }
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
    return { dir, ...(inside ? ownerOnlyFolderVerdict(read, user) : ownerOnlyVerdict(read, user)) }
  })
}

/** The account sign-in folders' rule (Windows): secureFoldersWindows with
 *  what is directly inside each folder read and put right too, `shared` (the home
 *  mirror's links to the user's own files) left out of that read while each
 *  is a file with more than one name. Every other caller of the rule gets
 *  the folders' own rights only (secureOwnerOnlyFolders). */
export function secureSignInFoldersWindows(dirs: readonly string[], shared: readonly string[] = []): Promise<OwnerOnlyFolderResult[]> {
  return secureFoldersWindows(dirs, runWindowsPowerShell, nativeOwnerOnlyTools, { inside: true, shared })
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
   *  file index), null when the file system gives none; `names` its number
   *  of names (hard links), null when the file system gives none. */
  lstat(p: string): { link: boolean; folder: boolean; id?: string | null; names?: number | null } | null
  /** Whether `p` is a folder (a link followed, as making a folder in it does). */
  isFolder(p: string): boolean
  /** Make one folder inside its existing parent; throws when it cannot. */
  mkdir(p: string): void
}

/** whoami and icacls start quickly; still bounded. */
const NATIVE_TIMEOUT_MS = 30_000
/** The whole of the rule with Windows' own programs (secureFoldersNative):
 *  no program or read starts after this, and what it has not reached is not
 *  read. */
const NATIVE_BUDGET_MS = 60_000
/** Why a folder the native rule had no time left for is not read. */
const NATIVE_LATE = 'it was not reached in time'

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
    return { link: st.isSymbolicLink(), folder: st.isDirectory(), id: st.ino ? `${st.dev}:${st.ino}` : null, names: st.nlink ? Number(st.nlink) : null }
  },
  isFolder: (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } },
  mkdir: (p) => { fs.mkdirSync(p) },
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

/** The native rule's read of what is directly inside each folder it is
 *  handed (see the file's header), with what Constrained Language Mode
 *  allows (Get-ChildItem, then Get-Acl's SDDL): never deeper and never
 *  through a link; the folders of the whole call left to their own turn,
 *  and so are the shared entries while each is a file with more than one
 *  name (never a sign-in file). A sign-in file that is a link (any reparse
 *  point) comes back unread; any other link comes back with its own SDDL
 *  (Get-Acl by the link's name gives the link's own, never what it points
 *  to), of which only the owner is read. Every entry comes back with its
 *  name as numbers (its characters' codes, so a name in any language comes
 *  back as ASCII), its attributes and its SDDL, and the verdict judges it
 *  (this read decides nothing else). An entry gone since it was listed is
 *  passed over; any other failure is that folder's error. The modules are
 *  loaded first, as the read above. */
export const OWNER_ONLY_INSIDE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Import-Module -Name Microsoft.PowerShell.Management, Microsoft.PowerShell.Security, Microsoft.PowerShell.Utility',
  // The form with no length limit, as the script above names it (the
  // backslashes are characters, 92, so the text names no path).
  '$bs = [string][char]92',
  "function Long($x) { if ($x -like ($bs + $bs + '*')) { $bs + $bs + '?' + $bs + 'UNC' + $bs + ($x -replace '^..', '') } else { $bs + $bs + '?' + $bs + $x } }",
  '$asked = @{}',
  'foreach ($x in ($env:' + OWNER_ONLY_SKIP_ENV + " -split \"`n\")) { if ($x) { $asked[$x] = $true; $asked[(Long $x)] = $true } }",
  '$shared = @{}',
  'foreach ($x in ($env:' + OWNER_ONLY_SHARED_ENV + " -split \"`n\")) { if ($x) { $shared[$x] = $true; $shared[(Long $x)] = $true } }",
  SIGN_IN_TABLE,
  '$out = @()',
  'foreach ($d in ($env:' + OWNER_ONLY_DIRS_ENV + " -split \"`n\")) {",
  '  if (-not $d) { continue }',
  '  $r = @{ inside = @(); error = $false }',
  '  try {',
  // Listed in the long form where this Windows takes it, else as named.
  '    $root = $d',
  '    try { $null = Get-Item -LiteralPath (Long $d) -Force; $root = Long $d } catch { }',
  '    foreach ($e in @(Get-ChildItem -LiteralPath $root -Force)) {',
  '      $p = $e.FullName',
  '      if ($asked[$p]) { continue }',
  '      $attributes = [int]$e.Attributes',
  '      $isLink = ($attributes -band 0x400) -ne 0',
  '      $isDir = ($attributes -band 0x10) -ne 0',
  '      $cred = [bool]$signIn[$e.Name.ToUpperInvariant()]',
  "      if (-not $isDir -and -not $isLink -and -not $cred -and $shared[$p] -and [string]$e.LinkType -eq 'HardLink') { continue }",
  '      if ($isLink -and $cred) { $r.inside += @{ name = [int[]][char[]]$e.Name; attributes = $attributes; sddl = $null; linkType = [string]$e.LinkType }; continue }',
  '      $sddl = $null',
  '      try { $sddl = [string](Get-Acl -LiteralPath $p).Sddl } catch { if (Test-Path -LiteralPath $p) { throw } else { continue } }',
  '      $x = @{ name = [int[]][char[]]$e.Name; attributes = $attributes; sddl = $sddl }',
  '      if ($isLink) { $x.linkType = [string]$e.LinkType }',
  '      $r.inside += $x',
  '    }',
  '  } catch { $r.error = $true }',
  '  $out += $r',
  '}',
  'ConvertTo-Json -Compress -Depth 6 -InputObject @($out)',
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

/** One read of what is directly inside `dir` (OWNER_ONLY_INSIDE_SCRIPT),
 *  each entry as the verdict reads it (with its name); `error` when the read
 *  of what is inside failed there, or when its answer says anything but a
 *  plain "no error"; null when the call gave no answer that matches what was
 *  asked. */
async function readInsideNative(dir: string, user: string, skip: readonly string[], shared: readonly string[], read: PowerShellRunner): Promise<{ error: boolean; inside: Array<InsideEntryRead & { name: string }> } | null> {
  let v: unknown
  try {
    v = JSON.parse(String(await read(OWNER_ONLY_INSIDE_SCRIPT, { [OWNER_ONLY_DIRS_ENV]: dir, [OWNER_ONLY_SKIP_ENV]: skip.join('\n'), [OWNER_ONLY_SHARED_ENV]: shared.join('\n') })).trim())
  } catch { return null }
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : null
  if (!list || list.length !== 1 || !list[0] || typeof list[0] !== 'object') return null
  const r = list[0] as Record<string, unknown>
  // Anything but a plain "no error" counts as one.
  if (r.error !== false) return { error: true, inside: [] }
  const raw = r.inside == null ? [] : Array.isArray(r.inside) ? r.inside : [r.inside]
  const inside = raw.map((x): InsideEntryRead & { name: string } => {
    const e = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    const codes = Array.isArray(e.name) ? e.name : typeof e.name === 'number' ? [e.name] : []
    const name = codes.every((c) => Number.isInteger(c) && (c as number) >= 0 && (c as number) <= 0xffff) ? String.fromCharCode(...(codes as number[])) : ''
    const attributes = typeof e.attributes === 'number' && Number.isInteger(e.attributes) ? e.attributes : null
    if (!name || attributes === null) return { name, error: 'it could not be read' }
    const folder = (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0
    const link = (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0
    const linkType = link ? (typeof e.linkType === 'string' ? e.linkType : '') : undefined
    // A link: its own owner only (the verdict refuses a sign-in file that is
    // one, and one whose owner was not read).
    if (link) {
      const owner = typeof e.sddl === 'string' ? ownerFromSddl(e.sddl, user) : ''
      return owner ? { name, link, folder, linkType, owner } : { name, link, folder, linkType }
    }
    if (typeof e.sddl !== 'string') return { name, error: 'it could not be read' }
    const f = folderReadFromSddl(e.sddl, user)
    if (f.error) {
      // Refused as unread (the verdict); its owner goes with it, so that
      // another account's entry may still be made this user's and reset.
      const owner = ownerFromSddl(e.sddl, user)
      return owner ? { name, link, folder, owner, error: f.error } : { name, error: f.error }
    }
    return { name, link, folder, owner: f.owner, rules: f.rules }
  })
  return { error: false, inside }
}

/** What is directly inside `dir` read; another account's entry, never a
 *  sign-in file, made this user's (icacls /setowner on the entry itself, /L;
 *  one that cannot be is left that account's, and the verdict refuses it);
 *  then that entry, and any entry this user, the Administrators group or
 *  SYSTEM owns that lets anyone else in, reset (icacls /reset on the entry
 *  itself, /L: its own entries go and it takes the folder's rights) --
 *  never a link, and never a file with more than one name (by its link
 *  count, which the file system gives without opening it; one it gives none
 *  for is not changed either) -- then read again when any was. Answers what
 *  is inside as the verdict reads it, an entry made this user's marked
 *  `takenOver`. Throws NoNativeAnswer when a read or a program gave no
 *  answer; an Error (the folder refused) when what is inside could not be
 *  read or reset, or when more entries need a change than a read may
 *  refuse. */
async function settleInsideNative(dir: string, user: string, skip: readonly string[], shared: readonly string[], tools: NativeOwnerOnlyTools, read: PowerShellRunner): Promise<InsideEntryRead[]> {
  const first = await readInsideNative(dir, user, skip, shared, read)
  if (!first) throw new NoNativeAnswer('what is inside it could not be read')
  if (first.error) throw new Error(INSIDE_NOT_READ)
  const ours = (owner: unknown): boolean => owner === user || owner === OWNER_ONLY_ADMINISTRATORS_SID || owner === OWNER_ONLY_SYSTEM_SID
  const oneName = (at: string): boolean => { try { return tools.lstat(at)?.names === 1 } catch { return false } }
  // A path past Windows' 260-character limit is handed over in the form that
  // has none (\\?\, or \\?\UNC\ for a share).
  const named = (e: { name: string }): string => {
    const at = path.win32.join(dir, e.name)
    return at.length < 260 ? at : at.startsWith('\\\\') ? `\\\\?\\UNC\\${at.slice(2)}` : `\\\\?\\${at}`
  }
  const take = first.inside.filter((e) => e.link === false && typeof e.owner === 'string' && e.owner !== '' && !ours(e.owner) && !heldAsSignInFile(e.name) && (e.folder === true || oneName(path.win32.join(dir, e.name))))
  const reset = first.inside.filter((e) => {
    if (e.link !== false || e.error || !ours(e.owner)) return false
    if (ownerOnlyInsideVerdict({ inside: [e] }, user).ok) return false
    return e.folder === true || oneName(path.win32.join(dir, e.name))
  })
  if (take.length === 0 && reset.length === 0) return first.inside
  if (take.length + reset.length >= INSIDE_MAX_REFUSED) throw new Error(INSIDE_NOT_MADE)
  const taken = new Set<string>()
  for (const e of take) {
    const done = await tools.run('icacls', [named(e), '/setowner', `*${user}`, '/L', '/Q'])
    if (done.code === null) throw new NoNativeAnswer('an entry inside it could not be made this user\'s: the program did not start or finish')
    if (done.code !== 0) continue
    taken.add(e.name)
    reset.push(e)
  }
  if (reset.length === 0) return first.inside
  for (const e of reset) {
    const done = await tools.run('icacls', [named(e), '/reset', '/L', '/Q'])
    if (done.code === null) throw new NoNativeAnswer('an entry inside it could not be reset: the program did not start or finish')
    if (done.code !== 0) throw new Error(INSIDE_NOT_MADE)
  }
  const again = await readInsideNative(dir, user, skip, shared, read)
  if (!again) throw new NoNativeAnswer('what is inside it could not be read back')
  if (again.error) throw new Error(INSIDE_NOT_READ)
  return again.inside.map((e) => (taken.has(e.name) ? { ...e, takenOver: true } : e))
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

/** The SIDs of the accounts SDDL writes as a fixed abbreviation, which icacls
 *  is handed by SID (`*S-1-...`). One not here (LA, LG: this computer's own
 *  accounts) cannot be named to it. */
const SDDL_WELL_KNOWN: Readonly<Record<string, string>> = {
  AN: 'S-1-5-7', AO: 'S-1-5-32-548', AU: 'S-1-5-11', BA: OWNER_ONLY_ADMINISTRATORS_SID, BG: 'S-1-5-32-546', BO: 'S-1-5-32-551',
  BU: 'S-1-5-32-545', CG: 'S-1-3-1', CO: 'S-1-3-0', ED: 'S-1-5-9', IU: 'S-1-5-4', LS: 'S-1-5-19', NO: 'S-1-5-32-556',
  NS: 'S-1-5-20', NU: 'S-1-5-2', OW: 'S-1-3-4', PO: 'S-1-5-32-550', PS: 'S-1-5-10', PU: 'S-1-5-32-547', RC: 'S-1-5-12',
  RD: 'S-1-5-32-555', RE: 'S-1-5-32-552', RU: 'S-1-5-32-554', SO: 'S-1-5-32-549', SU: 'S-1-5-6', SY: OWNER_ONLY_SYSTEM_SID,
  WD: 'S-1-1-0', WR: 'S-1-5-33', AC: 'S-1-15-2-1',
}

/**
 * The icacls arguments that give folder `d` the rights the script's
 * SetAccessControl writes -- exactly the user and SYSTEM, full control passed
 * to what is inside, nothing inherited from above -- as a write of rights
 * alone (see the file's header): inheritance off, the two granted (replacing
 * any entry of theirs), and every other account's own entry that `sddl` (the
 * folder's first read) names removed, by SID. On the folder itself (/L). An
 * entry this cannot name stays, and the read-back refuses the folder.
 */
export function nativeRightsArgs(d: string, userSid: string, sddl: string | null): string[] {
  const others = new Set<string>()
  const m = sddl === null ? null : SDDL_RE.exec(sddl)
  for (const ace of m ? m[3].match(/\(([^()]*)\)/g) ?? [] : []) {
    const f = ace.slice(1, -1).split(';')
    const flags: string[] = f[1].match(/[A-Z]{2}/g) ?? []
    if (f.length !== 6 || flags.includes('ID')) continue
    const sid = f[5].startsWith('S-1-') ? f[5] : SDDL_WELL_KNOWN[f[5]] ?? sddlAccount(f[5], userSid)
    if (/^S-1-\d+(?:-\d+)+$/.test(sid) && sid !== userSid && sid !== OWNER_ONLY_SYSTEM_SID) others.add(sid)
  }
  const remove = others.size > 0 ? ['/remove', ...[...others].map((s) => `*${s}`)] : []
  return [d, '/inheritance:r', '/grant:r', `*${userSid}:(OI)(CI)F`, `*${OWNER_ONLY_SYSTEM_SID}:(OI)(CI)F`, ...remove, '/L']
}

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
 *     (nativeRightsArgs: exactly the user and SYSTEM, full control passed to
 *     what is inside, inheritance off) and its owner (icacls /setowner), each
 *     on the folder itself, never a link's target (/L). A program that
 *     answers with a failure refuses the folder; one that did not start or
 *     finish is no answer: the folder, and what is below it, says `unread`.
 *  3. With `opts.inside` only: what is directly inside each folder set,
 *     read and put right where it may be (settleInsideNative): a read or a
 *     program that gave no answer leaves that folder `unread`; what could
 *     not be read or put right refuses it.
 *  4. One read of the folders set, matched by place, judged by the same
 *     verdicts as the script's read (ownerOnlyVerdict, then, with
 *     `opts.inside`, what is inside by ownerOnlyInsideVerdict), the
 *     attributes again (a link or not a folder now: refused, and what is
 *     below it). No read: those folders say `unread`.
 *
 * The whole route has one time limit (NATIVE_BUDGET_MS, from `clock`): no
 * program or read starts after it, and a folder it has not reached by then
 * says `unread`. Never throws.
 */
export async function secureFoldersNative(dirs: readonly string[], given: NativeOwnerOnlyTools, givenRead: PowerShellRunner, opts: OwnerOnlyOptions = {}, clock: () => number = Date.now): Promise<OwnerOnlyFolderResult[] | null> {
  const inside = opts.inside === true
  const shared = inside ? sharedEntries(opts.shared) : []
  // Every program and read goes through these: none starts once the time is up.
  const deadline = clock() + NATIVE_BUDGET_MS
  const late = () => clock() > deadline
  const tools: NativeOwnerOnlyTools = {
    ...given,
    run: (program, args) => (late() ? Promise.reject(new NoNativeAnswer(NATIVE_LATE)) : given.run(program, args)),
  }
  const read: PowerShellRunner = (script, env) => (late() ? Promise.reject(new NoNativeAnswer(NATIVE_LATE)) : givenRead(script, env))
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
        // Another account's folder is refused (see the file's header).
        if (pre.missing || pre.sddl === null) throw new Error('its owner could not be read')
        const was = ownerFromSddl(pre.sddl, user)
        if (!was) throw new Error('its owner could not be read')
        if (was !== user && was !== OWNER_ONLY_ADMINISTRATORS_SID) throw new Error('its owner is not this user')
        if ((st.id ?? null) !== ids[i]) throw new Error('it was replaced while it was checked')
      } else {
        if (!tools.isFolder(parent)) throw new Error('its parent is missing')
        tools.mkdir(d)
      }
      const rights = await tools.run('icacls', nativeRightsArgs(d, user, pre.missing ? null : pre.sddl))
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
  // What is inside each folder set (step 3, when asked), each left to its
  // own read: one folder with more inside than a call can read in time leaves
  // only itself unread. The folders of the whole call are left to their own turn.
  const within = new Map<number, InsideEntryRead[] | OwnerOnlyFolderResult>()
  for (const i of inside ? written : []) {
    const d = dirs[i]
    try {
      within.set(i, await settleInsideNative(d, user, dirs, shared, tools, read))
    } catch (err) {
      const detail = String((err as Error)?.message ?? err)
      within.set(i, err instanceof NoNativeAnswer ? { dir: d, ok: false, detail, unread: true } : { dir: d, ok: false, detail })
    }
  }
  const after = await readNative(written.map((i) => dirs[i]), read)
  const refusedAfter = new Set<string>()
  written.forEach((i, w) => {
    const d = dirs[i]
    if (!after) { results[i] = { dir: d, ok: false, detail: 'its rights could not be read back', unread: true }; return }
    const r = after[w]
    let verdict: OwnerOnlyVerdict
    if (refusedAfter.has(key(path.win32.dirname(d)))) verdict = { ok: false, detail: 'its parent was refused' }
    else if (r.error || r.missing || r.attributes === null || r.sddl === null) verdict = { ok: false, detail: 'its rights could not be read back' }
    else if ((r.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) verdict = { ok: false, detail: 'a link' }
    else if ((r.attributes & FILE_ATTRIBUTE_DIRECTORY) === 0) verdict = { ok: false, detail: 'not a folder' }
    else verdict = ownerOnlyVerdict(folderReadFromSddl(r.sddl, user), user)
    if (!verdict.ok && ['a link', 'not a folder', 'its parent was refused', 'its rights could not be read back'].includes(verdict.detail)) refusedAfter.add(key(d))
    if (verdict.ok && inside) {
      const what = within.get(i)
      if (!Array.isArray(what)) { results[i] = what ?? { dir: d, ok: false, detail: INSIDE_NOT_READ }; return }
      verdict = ownerOnlyInsideVerdict({ inside: what }, user)
    }
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

/** This platform's rule, for every caller but the account sign-in folders
 *  (secureSignInFoldersWindows): the folders' own rights only, never what is
 *  inside them. */
export function secureOwnerOnlyFolders(dirs: readonly string[]): Promise<OwnerOnlyFolderResult[]> {
  return process.platform === 'win32' ? secureFoldersWindows(dirs) : secureFoldersPosix(dirs)
}
