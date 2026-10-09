// P3.10 round 4 (P2): the real rights secureFoldersWindows leaves. In a temp
// folder whose rights let Everyone in (inherited by what is made inside it),
// a folder already there and a folder made by the call itself both end with
// exactly the user and SYSTEM, full control, inherited by what is inside,
// inheritance from above off, the user the owner (read with icacls /save,
// every entry's SID in full as Windows parses the SDDL, which writes some
// accounts as an abbreviation such as LA, and with Windows PowerShell). A
// link is refused and its target left as it was; a folder below a refused
// one is not made. Round 5 (G1, G2): folders
// with any Unicode name make the same round trip; a name ending in a dot is
// refused and nothing is made for it. Under Constrained Language Mode, where
// the script gives no read, the rule's fallback with Windows' own programs
// leaves the same rights, and refuses a link the same way -- also when the
// module path this process has names, first, a Microsoft.PowerShell.Security
// Windows PowerShell cannot load (as PowerShell 7 leaves it for every program
// it starts, CI's test step included). By either route, a folder already
// there that another account owns (SYSTEM stands in for one: only an
// administrator's elevated process can give a folder away, so those cases
// skip without one) is refused and left exactly as it was, while one the
// Administrators group owns (what an elevated process makes) is taken in place.
//
// HOST QUARANTINE: this suite writes a temp directory, changes rights on it
// and starts processes (Windows PowerShell and icacls). It runs in CI and on
// the VM, never on the owner's workstation.
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  secureFoldersWindows, secureSignInFoldersWindows, secureOwnerOnlyFolders, runWindowsPowerShell, nativeOwnerOnlyTools,
  OWNER_ONLY_INSIDE_SCRIPT, OWNER_ONLY_DIRS_ENV, OWNER_ONLY_SKIP_ENV, OWNER_ONLY_SHARED_ENV, OWNER_ONLY_USER_ENV,
} from '../../../src/main/owner-only-folders'
import type { PowerShellRunner } from '../../../src/main/owner-only-folders'

const IS_WIN = process.platform === 'win32'
const PREFIX = 'ccc-owner-only-real-'
const SYSROOT = process.env.SystemRoot || 'C:\\Windows'
const ICACLS = path.join(SYSROOT, 'System32', 'icacls.exe')
const made: string[] = []
const links: string[] = []

afterAll(() => {
  for (const l of links.splice(0)) { try { fs.rmdirSync(l) } catch { try { fs.unlinkSync(l) } catch { /* gone */ } } }
  // TEST CLEANUP GUARD: only this suite's own folders, by their prefix and parent.
  const tmpReal = fs.realpathSync.native(os.tmpdir())
  for (const d of made.splice(0)) {
    if (path.basename(d).startsWith(PREFIX) && path.dirname(d) === tmpReal) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
})

/** The DACL as SDDL, from icacls /save (SIDs, never localized names). */
function sddl(dir: string, scratch: string): string {
  const out = path.join(scratch, `acl-${Math.random().toString(16).slice(2)}.txt`)
  execFileSync(ICACLS, [dir, '/save', out], { stdio: 'ignore', windowsHide: true, timeout: 30_000 })
  const text = fs.readFileSync(out).toString('utf16le')
  fs.unlinkSync(out)
  return text.split(/\r?\n/)[1] ?? ''
}

/** Each entry of an SDDL DACL as `type|flags|mask|SID`, the SID in full.
 *  SDDL writes some accounts as a two-letter abbreviation (SY for SYSTEM; LA
 *  for the built-in Administrator, the account CI runs as), so Windows
 *  itself parses the SDDL (RawSecurityDescriptor) and each SID is compared
 *  whole, as the product compares them. Sorted. */
async function acesBySid(sddlText: string): Promise<string[]> {
  const out = await runWindowsPowerShell([
    "$ErrorActionPreference = 'Stop'",
    '$d = New-Object Security.AccessControl.RawSecurityDescriptor($env:CCC_T_SDDL)',
    "@($d.DiscretionaryAcl | ForEach-Object { '{0}|{1}|{2}|{3}' -f [int]$_.AceType, [int]$_.AceFlags, [int]$_.AccessMask, $_.SecurityIdentifier.Value }) -join ','",
  ].join('\n'), { CCC_T_SDDL: sddlText })
  return out.trim().split(',').filter(Boolean).sort()
}
/** An allow entry (type 0), inherited by folders and files inside (flags 3),
 *  full control (FA, 0x1F01FF), for `sid`. */
const fullFor = (sid: string) => `0|3|2032127|${sid}`
const SYSTEM_SID = 'S-1-5-18'
const ADMINISTRATORS_SID = 'S-1-5-32-544'

/** Gives `dir` to `sid` (icacls /setowner, which needs the right to restore
 *  files that an administrator's elevated process has); false when this
 *  process cannot. */
function giveTo(dir: string, sid: string): boolean {
  try {
    execFileSync(ICACLS, [dir, '/setowner', `*${sid}`], { stdio: 'ignore', windowsHide: true, timeout: 30_000 })
    return true
  } catch { return false }
}
/** A folder's owner by SID, read with Windows PowerShell. */
async function ownerOf(dir: string): Promise<string> {
  return (await runWindowsPowerShell('[IO.Directory]::GetAccessControl($env:CCC_T_DIR, [Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value', { CCC_T_DIR: dir })).trim()
}

/** A folder already there that SYSTEM owns, inside a temp folder that lets
 *  Everyone in (so the rule could take it over if it would), and one the
 *  Administrators group owns; null when this process cannot give a folder
 *  away. */
function foldersOwnedByOthers(): { top: string; scratch: string; theirs: string; admins: string } | null {
  const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  made.push(top)
  const scratch = path.join(top, 'scratch')
  fs.mkdirSync(scratch)
  execFileSync(ICACLS, [top, '/grant', '*S-1-1-0:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 })
  const theirs = path.join(top, 'theirs')
  const admins = path.join(top, 'admins')
  fs.mkdirSync(theirs)
  fs.mkdirSync(admins)
  if (!giveTo(theirs, SYSTEM_SID) || !giveTo(admins, ADMINISTRATORS_SID)) return null
  return { top, scratch, theirs, admins }
}
const NEEDS_ELEVATION = 'giving a folder to another account needs an administrator\'s elevated process'

/** By `route`: the SYSTEM folder refused and left exactly as it was, nothing
 *  made in it; the Administrators group's taken in place. */
async function refusesTheirsTakesAdmins(f: NonNullable<ReturnType<typeof foldersOwnedByOthers>>, route: (dirs: string[]) => ReturnType<typeof secureFoldersWindows>): Promise<void> {
  // Control: each folder is the account's it was given to.
  expect(await ownerOf(f.theirs)).toBe(SYSTEM_SID)
  expect(await ownerOf(f.admins)).toBe(ADMINISTRATORS_SID)
  const before = sddl(f.theirs, f.scratch)
  expect(before).toMatch(/S-1-1-0|WD/)
  const user = (await runWindowsPowerShell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value', {})).trim()
  const out = await route([f.theirs, path.join(f.theirs, 'inside')])
  expect(out.map((r) => [r.ok, r.detail, r.unread])).toEqual([[false, 'its owner is not this user', undefined], [false, 'its parent was refused', undefined]])
  expect(await ownerOf(f.theirs)).toBe(SYSTEM_SID)
  expect(sddl(f.theirs, f.scratch)).toBe(before)
  expect(fs.existsSync(path.join(f.theirs, 'inside'))).toBe(false)
  const taken = await route([f.admins])
  expect(taken.map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only']])
  expect(await ownerOf(f.admins)).toBe(user)
  expect(await acesBySid(sddl(f.admins, f.scratch))).toEqual([fullFor(user), fullFor(SYSTEM_SID)].sort())
}

describe.runIf(IS_WIN)('secureFoldersWindows: the real rights it leaves (P3.10 round 4)', () => {
  it('a folder already there and one it makes: exactly the user and SYSTEM, inheritance off, owned by the user', async () => {
    const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
    made.push(top)
    const scratch = path.join(top, 'scratch')
    fs.mkdirSync(scratch)
    // Everyone in, for everything made inside.
    execFileSync(ICACLS, [top, '/grant', '*S-1-1-0:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 })
    const existing = path.join(top, 'existing')
    fs.mkdirSync(existing)
    expect(sddl(existing, scratch)).toMatch(/S-1-1-0|WD/)
    const fresh = path.join(existing, 'fresh')
    const user = (await runWindowsPowerShell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value', {})).trim()
    expect(user).toMatch(/^S-1-/)

    const out = await secureFoldersWindows([existing, fresh])
    expect(out.map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only'], [true, 'owner-only']])
    expect(fs.existsSync(fresh)).toBe(true)
    for (const d of [existing, fresh]) {
      const s = sddl(d, scratch)
      expect(s.startsWith('D:P'), s).toBe(true)
      expect(await acesBySid(s), s).toEqual([fullFor(user), fullFor(SYSTEM_SID)].sort())
      const owner = (await runWindowsPowerShell('[IO.Directory]::GetAccessControl($env:CCC_T_DIR, [Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value', { CCC_T_DIR: d })).trim()
      expect(owner).toBe(user)
    }
  })

  it('a link is refused and its target left as it was; a folder below a refused one is not made', async () => {
    const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
    made.push(top)
    const scratch = path.join(top, 'scratch')
    fs.mkdirSync(scratch)
    execFileSync(ICACLS, [top, '/grant', '*S-1-1-0:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 })
    const target = path.join(top, 'target')
    fs.mkdirSync(target)
    const before = sddl(target, scratch)
    const link = path.join(top, 'link')
    fs.symlinkSync(target, link, 'junction')
    links.push(link)
    const out = await secureFoldersWindows([link, path.join(link, 'child')])
    expect(out.map((r) => r.ok)).toEqual([false, false])
    expect(sddl(target, scratch)).toBe(before)
    expect(fs.existsSync(path.join(target, 'child'))).toBe(false)
  })

  it('round 5: folders with any Unicode name come back exactly, owner-only; a name ending in a dot is refused and nothing is made', async () => {
    const U = (c: number) => String.fromCharCode(c)
    const names = [
      'caf' + U(0xe9), U(0x4e2d) + U(0x6587), String.fromCodePoint(0x1f600),
      U(0x2018) + 'x' + U(0x2019), U(0x201a) + 'x' + U(0x201b), U(0x201c) + 'x' + U(0x201d), U(0x201e) + 'x',
      'nel' + U(0x85) + 'next', 'ls' + U(0x2028) + 'next', "o'brien", 'a b  c', 'w[ab]{0}', 'p%x%#h~t!b',
      // Gate 3 (spec item 1, F1): the rest of the round-5 verifier's ASCII set,
      // each a literal name PowerShell would otherwise read as code.
      'sem;i', 'dollar$pwd$HOME', 'sub$(x)', 'tick`n', 'amp&(x)', "'+(x)+'", 'rng[a-z]x', 'at@(x)', '-Recurse',
    ]
    const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
    made.push(top)
    const scratch = path.join(top, 'scratch')
    fs.mkdirSync(scratch)
    const user = (await runWindowsPowerShell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value', {})).trim()
    const dirs = names.map((n) => path.join(top, n))
    const out = await secureFoldersWindows(dirs)
    expect(out.map((r) => [r.dir, r.ok, r.detail])).toEqual(dirs.map((d) => [d, true, 'owner-only']))
    for (const d of dirs) {
      expect(fs.statSync(d).isDirectory(), d).toBe(true)
      const s = sddl(d, scratch)
      expect(s.startsWith('D:P'), d).toBe(true)
      expect(await acesBySid(s), `${d}: ${s}`).toEqual([fullFor(user), fullFor(SYSTEM_SID)].sort())
    }
    const dotted = await secureFoldersWindows([path.join(top, 'sub.')])
    expect(dotted.map((r) => r.ok)).toEqual([false])
    expect(fs.existsSync(path.join(top, 'sub'))).toBe(false)
  })

  it('a folder already there that another account owns is refused and left exactly as it was, nothing made in it; one the Administrators group owns is taken in place', async (ctx) => {
    const f = foldersOwnedByOthers()
    if (!f) return ctx.skip(NEEDS_ELEVATION)
    await refusesTheirsTakesAdmins(f, (dirs) => secureFoldersWindows(dirs))
  })

  it('the SDDL read gives each account its full SID, the built-in Administrator\'s abbreviation (LA) included', async () => {
    const aces = await acesBySid('D:PAI(A;OICI;FA;;;LA)(A;OICI;FA;;;SY)')
    expect(aces).toHaveLength(2)
    expect(aces).toContain(fullFor(SYSTEM_SID))
    expect(aces.find((a) => a !== fullFor(SYSTEM_SID))).toMatch(/^0\|3\|2032127\|S-1-5-21-\d+-\d+-\d+-500$/)
  })
})

/** Windows PowerShell restricted to Constrained Language Mode, as AppLocker
 *  or WDAC script enforcement leaves it: what the rule's own calls get. */
const constrained: PowerShellRunner = (script, env) =>
  runWindowsPowerShell("$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n" + script, env)

describe.runIf(IS_WIN)('secureFoldersWindows under Constrained Language Mode: the same real rights, with Windows\' own programs', () => {
  it('the script alone gives no read there (what the rule falls back from)', async () => {
    const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
    made.push(top)
    const out = await secureFoldersWindows([path.join(top, 'x')], constrained, null)
    expect(out.map((r) => [r.ok, r.unread])).toEqual([[false, true]])
  })

  it('a folder already there (another account\'s entries, a deny, inherited rights) and one it makes: exactly the user and SYSTEM, inheritance off, owned by the user', async () => {
    const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
    made.push(top)
    const scratch = path.join(top, 'scratch')
    fs.mkdirSync(scratch)
    execFileSync(ICACLS, [top, '/grant', '*S-1-1-0:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 })
    const existing = path.join(top, 'existing')
    fs.mkdirSync(existing)
    execFileSync(ICACLS, [existing, '/grant', '*S-1-5-32-545:(R)', '/deny', '*S-1-5-32-546:(W)'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 })
    const fresh = path.join(existing, 'fresh')
    const user = (await runWindowsPowerShell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value', {})).trim()

    const out = await secureFoldersWindows([existing, fresh], constrained, nativeOwnerOnlyTools)
    expect(out.map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only'], [true, 'owner-only']])
    for (const d of [existing, fresh]) {
      const s = sddl(d, scratch)
      expect(s.startsWith('D:P'), s).toBe(true)
      expect(await acesBySid(s), s).toEqual([fullFor(user), fullFor(SYSTEM_SID)].sort())
      const owner = (await runWindowsPowerShell('[IO.Directory]::GetAccessControl($env:CCC_T_DIR, [Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value', { CCC_T_DIR: d })).trim()
      expect(owner).toBe(user)
    }
  })

  it('a folder already there that another account owns is refused and left exactly as it was, nothing made in it; one the Administrators group owns is taken in place', async (ctx) => {
    const f = foldersOwnedByOthers()
    if (!f) return ctx.skip(NEEDS_ELEVATION)
    await refusesTheirsTakesAdmins(f, (dirs) => secureFoldersWindows(dirs, constrained, nativeOwnerOnlyTools))
  })

  it('a link is refused and its target left as it was; a folder below it is not made', async () => {
    const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
    made.push(top)
    const scratch = path.join(top, 'scratch')
    fs.mkdirSync(scratch)
    const target = path.join(top, 'target')
    fs.mkdirSync(target)
    const before = sddl(target, scratch)
    const link = path.join(top, 'link')
    fs.symlinkSync(target, link, 'junction')
    links.push(link)
    const out = await secureFoldersWindows([link, path.join(link, 'child')], constrained, nativeOwnerOnlyTools)
    expect(out.map((r) => [r.ok, r.detail])).toEqual([[false, 'a link'], [false, 'its parent was refused']])
    expect(sddl(target, scratch)).toBe(before)
    expect(fs.existsSync(path.join(target, 'child'))).toBe(false)
  })

  it('with a Microsoft.PowerShell.Security that cannot load first in this process\'s module path: the same rights for a folder already there and one it makes, and a link refused', async () => {
    const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
    made.push(top)
    const scratch = path.join(top, 'scratch')
    fs.mkdirSync(scratch)
    // A module folder whose Microsoft.PowerShell.Security names a library that is not there.
    const modules = path.join(top, 'modules')
    fs.mkdirSync(path.join(modules, 'Microsoft.PowerShell.Security'), { recursive: true })
    fs.writeFileSync(path.join(modules, 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1'),
      "@{\r\n  ModuleVersion = '99.0.0'\r\n  RootModule = 'missing-on-purpose.dll'\r\n  CmdletsToExport = @('Get-Acl', 'Set-Acl')\r\n}\r\n")
    const saved = { modules: process.env.PSModulePath, cache: process.env.PSModuleAnalysisCachePath }
    const broken = `${modules};${saved.modules ?? ''}`
    // What Windows PowerShell learns of the modules it looks at stays in this folder.
    const cache = path.join(top, 'module-analysis-cache')
    // Control: a Windows PowerShell handed that module path itself cannot load
    // Get-Acl. Every spelling of the two names is replaced: a test worker's
    // environment can spell them otherwise (PSMODULEPATH), and a child handed
    // two keeps the first in sort order, which would be the inherited one.
    const controlEnv: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (!['PSMODULEPATH', 'PSMODULEANALYSISCACHEPATH'].includes(k.toUpperCase())) controlEnv[k] = v
    }
    controlEnv.PSModulePath = broken
    controlEnv.PSModuleAnalysisCachePath = cache
    let controlRefused = false
    try {
      execFileSync(path.join(SYSROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; $null = Get-Acl -LiteralPath $env:SystemRoot"],
        { stdio: 'ignore', windowsHide: true, timeout: 60_000, env: controlEnv })
    } catch { controlRefused = true }
    expect(controlRefused).toBe(true)

    const existing = path.join(top, 'existing')
    fs.mkdirSync(existing)
    execFileSync(ICACLS, [existing, '/grant', '*S-1-5-32-545:(R)'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 })
    const fresh = path.join(existing, 'fresh')
    const target = path.join(top, 'target')
    fs.mkdirSync(target)
    const before = sddl(target, scratch)
    const link = path.join(top, 'link')
    fs.symlinkSync(target, link, 'junction')
    links.push(link)
    const user = (await runWindowsPowerShell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value', {})).trim()

    process.env.PSModulePath = broken
    process.env.PSModuleAnalysisCachePath = cache
    let out: Awaited<ReturnType<typeof secureFoldersWindows>>
    let linked: Awaited<ReturnType<typeof secureFoldersWindows>>
    try {
      out = await secureFoldersWindows([existing, fresh], constrained, nativeOwnerOnlyTools)
      linked = await secureFoldersWindows([link, path.join(link, 'child')], constrained, nativeOwnerOnlyTools)
    } finally {
      if (saved.modules === undefined) delete process.env.PSModulePath
      else process.env.PSModulePath = saved.modules
      if (saved.cache === undefined) delete process.env.PSModuleAnalysisCachePath
      else process.env.PSModuleAnalysisCachePath = saved.cache
    }
    expect(out.map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only'], [true, 'owner-only']])
    for (const d of [existing, fresh]) {
      const s = sddl(d, scratch)
      expect(s.startsWith('D:P'), s).toBe(true)
      expect(await acesBySid(s), s).toEqual([fullFor(user), fullFor(SYSTEM_SID)].sort())
    }
    expect(linked.map((r) => [r.ok, r.detail])).toEqual([[false, 'a link'], [false, 'its parent was refused']])
    expect(sddl(target, scratch)).toBe(before)
    expect(fs.existsSync(path.join(target, 'child'))).toBe(false)
  })
})

// What is already inside an account sign-in folder made owner-only in place
// (secureSignInFoldersWindows, or the rule asked for what is inside) gets
// exactly the folder's rights, by either route: every file and folder below
// it, at any depth, is left with only the user's and SYSTEM's entries,
// inherited from the folder -- an entry of another account's own included, one
// with inheritance off, and one SYSTEM owns -- and the folder passes. A
// junction inside is not followed: what it points to keeps its rights. An
// entry another account owns (LOCAL SERVICE stands in for one) refuses the
// folder and keeps its own entries; a link to a file inside refuses it and
// what it points to keeps its rights. The home mirror's link to one of the
// user's own files (a file with two names) is never written: named as
// shared, it is left out and the user's file keeps its own entries. Every
// other caller of the rule (secureOwnerOnlyFolders) gets the folders' own
// rights only: what another folder inside holds keeps its rights exactly.
/** An inherited allow entry, full control, for `sid` (the inherited flag, 0x10, set; whether it is passed on to what
 *  is below -- 0x3, which icacls /reset leaves on a file's entries and Windows' own write does not -- not compared:
 *  a file has nothing below it). */
const inheritedFull = (sid: string) => `0|I|2032127|${sid}`
/** acesBySid's entries with their flags read as inherited (I) or not (-). */
const asInherited = (aces: string[]): string[] => aces.map((a) => { const [t, f, m, sid] = a.split('|'); return `${t}|${Number(f) & 16 ? 'I' : '-'}|${m}|${sid}` }).sort()
/** A file's or folder's owner by SID, read with Windows PowerShell. */
async function ownerOfEntry(p: string): Promise<string> {
  return (await runWindowsPowerShell("$s = if ([IO.Directory]::Exists($env:CCC_T_P)) { [IO.Directory]::GetAccessControl($env:CCC_T_P, 'Owner') } else { [IO.File]::GetAccessControl($env:CCC_T_P, 'Owner') }; $s.GetOwner([Security.Principal.SecurityIdentifier]).Value", { CCC_T_P: p })).trim()
}
const grant = (p: string, ...args: string[]) => execFileSync(ICACLS, [p, ...args], { stdio: 'ignore', windowsHide: true, timeout: 30_000 })

/** A folder (inside a temp folder that lets Everyone in) holding what an earlier run may have left: a file inheriting
 *  Everyone; one with an entry of its own for the Users group; one with inheritance off and its own entries (Everyone
 *  among them); a folder two deep with a file with an entry of its own; and a junction to a folder outside it. */
function folderWithInside() {
  const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  made.push(top)
  const scratch = path.join(top, 'scratch')
  fs.mkdirSync(scratch)
  grant(top, '/grant', '*S-1-1-0:(OI)(CI)F')
  const home = path.join(top, 'home')
  fs.mkdirSync(path.join(home, 'sub', 'deep'), { recursive: true })
  for (const f of ['a.json', 'b.json', 'c.json', path.join('sub', 'deep', 'd.json')]) fs.writeFileSync(path.join(home, f), '{}')
  grant(path.join(home, 'b.json'), '/grant', '*S-1-5-32-545:(R)')
  grant(path.join(home, 'c.json'), '/inheritance:d')
  grant(path.join(home, 'c.json'), '/grant', '*S-1-5-32-545:(R)')
  grant(path.join(home, 'sub', 'deep', 'd.json'), '/grant', '*S-1-5-32-545:(R)')
  const target = path.join(top, 'target')
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 't.json'), '{}')
  grant(path.join(target, 't.json'), '/grant', '*S-1-5-32-545:(R)')
  const link = path.join(home, 'link')
  fs.symlinkSync(target, link, 'junction')
  links.push(link)
  return { top, scratch, home, target }
}

async function insideTakesTheFolderRights(route: (dirs: string[]) => ReturnType<typeof secureFoldersWindows>): Promise<void> {
  const f = folderWithInside()
  const user = (await runWindowsPowerShell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value', {})).trim()
  // Control: each of them lets another account in before.
  for (const e of ['a.json', 'b.json', 'c.json', path.join('sub', 'deep', 'd.json')]) expect(sddl(path.join(f.home, e), f.scratch), e).toMatch(/S-1-1-0|WD|BU|S-1-5-32-545/)
  const before = [sddl(f.target, f.scratch), sddl(path.join(f.target, 't.json'), f.scratch)]
  const out = await route([f.home])
  expect(out.map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only']])
  for (const e of ['a.json', 'b.json', 'c.json', path.join('sub', 'deep', 'd.json')]) {
    const s = sddl(path.join(f.home, e), f.scratch)
    expect(s.startsWith('D:AI'), `${e}: ${s}`).toBe(true)
    expect(asInherited(await acesBySid(s)), `${e}: ${s}`).toEqual([inheritedFull(user), inheritedFull(SYSTEM_SID)].sort())
    expect([user, ADMINISTRATORS_SID], e).toContain(await ownerOfEntry(path.join(f.home, e)))
  }
  // A folder's entries are passed on to what is inside it too (0x13).
  for (const d of ['sub', path.join('sub', 'deep')]) expect(await acesBySid(sddl(path.join(f.home, d), f.scratch)), d).toEqual([`0|19|2032127|${user}`, `0|19|2032127|${SYSTEM_SID}`].sort())
  // The junction was not followed.
  expect([sddl(f.target, f.scratch), sddl(path.join(f.target, 't.json'), f.scratch)]).toEqual(before)
}

/** LOCAL SERVICE: an account this user is not, which an administrator's elevated process can give a file to. */
const LOCAL_SERVICE_SID = 'S-1-5-19'

async function refusesAnotherAccountsEntry(route: (dirs: string[]) => ReturnType<typeof secureFoldersWindows>, ctx: { skip: (note?: string) => void }): Promise<void> {
  const f = folderWithInside()
  const theirs = path.join(f.home, 'sub', 'theirs.json')
  fs.writeFileSync(theirs, '{}')
  grant(theirs, '/grant', '*S-1-5-32-545:(R)')
  if (!giveTo(theirs, LOCAL_SERVICE_SID)) return ctx.skip(NEEDS_ELEVATION)
  const out = await route([f.home])
  expect(out.map((r) => [r.ok, r.detail])).toEqual([[false, "an entry inside it is another account's"]])
  expect(await ownerOfEntry(theirs)).toBe(LOCAL_SERVICE_SID)
  // Not reset: its own entry for the Users group is still there.
  expect(sddl(theirs, f.scratch)).toMatch(/\(A;;(?:FR|0x120089);;;(?:BU|S-1-5-32-545)\)/)
}

async function putsRightAnEntrySystemOwns(route: (dirs: string[]) => ReturnType<typeof secureFoldersWindows>, ctx: { skip: (note?: string) => void }): Promise<void> {
  const f = folderWithInside()
  const user = (await runWindowsPowerShell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value', {})).trim()
  const sys = path.join(f.home, 'sub', 'system.json')
  fs.writeFileSync(sys, '{}')
  grant(sys, '/grant', '*S-1-5-32-545:(R)')
  if (!giveTo(sys, SYSTEM_SID)) return ctx.skip(NEEDS_ELEVATION)
  const out = await route([f.home])
  expect(out.map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only']])
  // Still SYSTEM's, its own entry for the Users group gone: the folder's rights alone.
  expect(await ownerOfEntry(sys)).toBe(SYSTEM_SID)
  expect(asInherited(await acesBySid(sddl(sys, f.scratch)))).toEqual([inheritedFull(user), inheritedFull(SYSTEM_SID)].sort())
}

/** The SDDL entries of `p` that are its own (not inherited), as written. */
const ownEntries = (p: string, scratch: string): string[] => (sddl(p, scratch).match(/\(([^()]*)\)/g) ?? []).filter((a) => !a.split(';')[1].includes('ID'))

/** A folder's owner as SDDL writes it (a SID, or an abbreviation such as LA), from Get-Acl. */
async function sddlOwnerOf(p: string): Promise<string> {
  const text = await runWindowsPowerShell('(Get-Acl -LiteralPath $env:CCC_T_P).Sddl', { CCC_T_P: p })
  return /^O:(S-1-[0-9-]+|[A-Z]{2})/.exec(text.trim())?.[1] ?? ''
}

/** A home holding a hard link (a second name) to a file of a "real home" beside it that has an entry of its own for
 *  the Users group, as the home mirror links the user's own dot-files. */
async function mirrorLinkKeepsItsRights(route: (dirs: string[], shared: string[]) => ReturnType<typeof secureFoldersWindows>): Promise<void> {
  const f = folderWithInside()
  const realHome = path.join(f.top, 'realhome')
  fs.mkdirSync(realHome)
  const real = path.join(realHome, '.gitconfig')
  fs.writeFileSync(real, '[user]')
  grant(real, '/grant', '*S-1-5-32-545:(R)')
  const link = path.join(f.home, '.gitconfig')
  fs.linkSync(real, link)
  expect(fs.statSync(link).nlink).toBe(2)
  const before = ownEntries(real, f.scratch)
  expect(before.join('')).toMatch(/;;;(?:BU|S-1-5-32-545)\)/)
  // Not named as shared: read, never written, and the home is refused.
  const refused = await route([f.home], [])
  expect(refused.map((r) => [r.ok, r.detail])).toEqual([[false, 'an entry inside it is not owner-only']])
  expect(ownEntries(real, f.scratch)).toEqual(before)
  // Named as shared: left out; the home passes, the user's file keeps its own entries exactly.
  const out = await route([f.home], [link])
  expect(out.map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only']])
  expect(ownEntries(real, f.scratch)).toEqual(before)
}

/** A root holding a folder an earlier call secured (owner-only, its own) whose sub-folder carries a read of its own
 *  for the Users group, passed on to a file inside it; the rule is then asked for the root and a new folder in it. */
async function leavesWhatIsInsideAlone(route: (dirs: string[]) => ReturnType<typeof secureFoldersWindows>): Promise<void> {
  const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  made.push(top)
  const scratch = path.join(top, 'scratch')
  fs.mkdirSync(scratch)
  grant(top, '/grant', '*S-1-1-0:(OI)(CI)F')
  const user = (await runWindowsPowerShell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value', {})).trim()
  const root = path.join(top, 'root')
  const earlier = path.join(root, 'a')
  const kept = path.join(earlier, 'bin')
  fs.mkdirSync(kept, { recursive: true })
  fs.writeFileSync(path.join(kept, 'runner.json'), '{}')
  grant(earlier, '/inheritance:r', '/grant:r', `*${user}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F')
  grant(kept, '/grant', '*S-1-5-32-545:(OI)(CI)(RX)')
  const before = [sddl(earlier, scratch), sddl(kept, scratch), sddl(path.join(kept, 'runner.json'), scratch)]
  expect(before[1]).toMatch(/;;;(?:BU|S-1-5-32-545)\)/)
  const out = await route([root, path.join(root, 'b')])
  expect(out.map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only'], [true, 'owner-only']])
  expect([sddl(earlier, scratch), sddl(kept, scratch), sddl(path.join(kept, 'runner.json'), scratch)]).toEqual(before)
}

async function refusesALinkToAFile(route: (dirs: string[]) => ReturnType<typeof secureFoldersWindows>, ctx: { skip: (note?: string) => void }): Promise<void> {
  const f = folderWithInside()
  const cred = path.join(f.home, '.credentials.json')
  try { fs.symlinkSync(path.join(f.target, 't.json'), cred, 'file') } catch { return ctx.skip('a symbolic link to a file needs the right to make one') }
  links.push(cred)
  const before = sddl(path.join(f.target, 't.json'), f.scratch)
  const out = await route([f.home])
  expect(out.map((r) => [r.ok, r.detail])).toEqual([[false, 'a link to a file is inside it']])
  expect(sddl(path.join(f.target, 't.json'), f.scratch)).toBe(before)
}

describe.runIf(IS_WIN)('secureFoldersWindows: what is already inside a folder made owner-only in place', () => {
  it('everything inside, at any depth, ends with the folder\'s rights alone; a junction inside is not followed', async () => {
    await insideTakesTheFolderRights((dirs) => secureSignInFoldersWindows(dirs))
  })
  it('the same under Constrained Language Mode, with Windows\' own programs', async () => {
    await insideTakesTheFolderRights((dirs) => secureFoldersWindows(dirs, constrained, nativeOwnerOnlyTools, { inside: true }))
  })
  it('an entry another account owns refuses the folder and keeps its own entries', async (ctx) => {
    await refusesAnotherAccountsEntry((dirs) => secureSignInFoldersWindows(dirs), ctx)
  })
  it('the same under Constrained Language Mode', async (ctx) => {
    await refusesAnotherAccountsEntry((dirs) => secureFoldersWindows(dirs, constrained, nativeOwnerOnlyTools, { inside: true }), ctx)
  })
  it('an entry SYSTEM owns that lets another group in is put right, and the folder passes', async (ctx) => {
    await putsRightAnEntrySystemOwns((dirs) => secureSignInFoldersWindows(dirs), ctx)
  })
  it('the same under Constrained Language Mode', async (ctx) => {
    await putsRightAnEntrySystemOwns((dirs) => secureFoldersWindows(dirs, constrained, nativeOwnerOnlyTools, { inside: true }), ctx)
  })
  it('a link to a file inside refuses the folder; what it points to keeps its rights', async (ctx) => {
    await refusesALinkToAFile((dirs) => secureSignInFoldersWindows(dirs), ctx)
  })
  it('the same under Constrained Language Mode', async (ctx) => {
    await refusesALinkToAFile((dirs) => secureFoldersWindows(dirs, constrained, nativeOwnerOnlyTools, { inside: true }), ctx)
  })
  it('the home mirror\'s link to one of the user\'s own files is never written: named as shared, the home passes and the user\'s file keeps its own entries; not named, it refuses the home, unwritten', async () => {
    await mirrorLinkKeepsItsRights((dirs, shared) => secureSignInFoldersWindows(dirs, shared))
  })
  it('the same under Constrained Language Mode', async () => {
    await mirrorLinkKeepsItsRights((dirs, shared) => secureFoldersWindows(dirs, constrained, nativeOwnerOnlyTools, { inside: true, shared }))
  })
})

describe.runIf(IS_WIN)('secureOwnerOnlyFolders: every caller but the account sign-in folders gets the folders\' own rights only', () => {
  it('a folder inside the root that an earlier call secured keeps every entry of its own, at any depth; both folders pass', async () => {
    await leavesWhatIsInsideAlone((dirs) => secureOwnerOnlyFolders(dirs))
  })
  it('the same under Constrained Language Mode, with Windows\' own programs', async () => {
    await leavesWhatIsInsideAlone((dirs) => secureFoldersWindows(dirs, constrained, nativeOwnerOnlyTools))
  })
})

describe.runIf(IS_WIN)('the read of what is inside under Constrained Language Mode: the built-in Administrator, whom SDDL names LA', () => {
  it('goes into a folder that account owns and comes back with a deeper entry that lets another group in', async (ctx) => {
    const user = (await runWindowsPowerShell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value', {})).trim()
    const m = /^(S-1-5-21-\d+-\d+-\d+)-\d+$/.exec(user)
    if (!m) return ctx.skip('this user is not an account of this computer')
    const admin = `${m[1]}-500`
    const f = folderWithInside()
    const sub = path.join(f.home, 'sub')
    if (!giveTo(sub, admin)) return ctx.skip(NEEDS_ELEVATION)
    // Control: SDDL names that owner LA.
    expect(await sddlOwnerOf(sub)).toBe('LA')
    const out = await constrained(OWNER_ONLY_INSIDE_SCRIPT, { [OWNER_ONLY_DIRS_ENV]: f.home, [OWNER_ONLY_SKIP_ENV]: f.home, [OWNER_ONLY_SHARED_ENV]: '', [OWNER_ONLY_USER_ENV]: admin })
    const read = JSON.parse(out.trim()) as unknown
    const folders = (Array.isArray(read) ? read : [read]) as Array<{ error: boolean; inside: Array<{ name: number[] | number }> | { name: number[] | number } }>
    expect(folders).toHaveLength(1)
    expect(folders[0].error).toBe(false)
    const names = (Array.isArray(folders[0].inside) ? folders[0].inside : [folders[0].inside]).map((e) => String.fromCharCode(...(Array.isArray(e.name) ? e.name : [e.name])))
    // What is in the folder that account owns came back (sub\deep lets Everyone in): the read went into it.
    expect(names).toContain(path.join('sub', 'deep'))
  })
})
