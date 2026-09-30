// P3.10 round 4 (P2): the real rights secureFoldersWindows leaves. In a temp
// folder whose rights let Everyone in (inherited by what is made inside it),
// a folder already there and a folder made by the call itself both end with
// exactly the user and SYSTEM, full control, inherited by what is inside,
// inheritance from above off, the user the owner (read with icacls /save, by
// SID, and with Windows PowerShell). A link is refused and its target left as
// it was; a folder below a refused one is not made. Round 5 (G1, G2): folders
// with any Unicode name make the same round trip; a name ending in a dot is
// refused and nothing is made for it.
//
// HOST QUARANTINE: this suite writes a temp directory, changes rights on it
// and starts processes (Windows PowerShell and icacls). It runs in CI and on
// the VM, never on the owner's workstation.
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { secureFoldersWindows, runWindowsPowerShell } from '../../../src/main/owner-only-folders'

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
      const aces = s.slice(s.indexOf('(')).match(/\([^)]*\)/g) ?? []
      expect(aces.sort(), s).toEqual([`(A;OICI;FA;;;${user})`, '(A;OICI;FA;;;SY)'].sort())
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
      const aces = s.slice(s.indexOf('(')).match(/\([^)]*\)/g) ?? []
      expect(s.startsWith('D:P'), d).toBe(true)
      expect(aces.sort(), d).toEqual([`(A;OICI;FA;;;${user})`, '(A;OICI;FA;;;SY)'].sort())
    }
    const dotted = await secureFoldersWindows([path.join(top, 'sub.')])
    expect(dotted.map((r) => r.ok)).toEqual([false])
    expect(fs.existsSync(path.join(top, 'sub'))).toBe(false)
  })
})
