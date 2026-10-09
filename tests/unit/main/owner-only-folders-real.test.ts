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
import { secureFoldersWindows, runWindowsPowerShell, nativeOwnerOnlyTools } from '../../../src/main/owner-only-folders'
import type { PowerShellRunner } from '../../../src/main/owner-only-folders'

const IS_WIN = process.platform === 'win32'
const PREFIX = 'ccc-owner-only-real-'
const SYSROOT = process.env.SystemRoot || 'C:\\Windows'
const ICACLS = path.join(SYSROOT, 'System32', 'icacls.exe')
const made: string[] = []
const links: string[] = []

afterAll(() => {
  for (const l of links.splice(0)) { try { fs.rmdirSync(l) } catch { /* gone */ } }
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
