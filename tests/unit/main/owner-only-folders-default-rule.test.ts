// The app's own owner-only folder rule -- what the account sign-in folders
// get (secureFoldersWindows with no runner of a test's own) and what every
// managed folder of the other assistant gets (secureOwnerOnlyFolders) --
// answers on a Windows whose PowerShell runs in Constrained Language Mode:
// the script's call fails there, and the rule falls back to Windows' own
// programs and a read that mode allows (owner-only-folders-native.test.ts
// has the rule itself; owner-only-folders-real.test.ts the real round trip).
//
// Host-safe: every program start is faked (execFile answers as Windows would
// under that mode, from an in-memory record of each folder's owner and
// rights); the folders are real, in this worker's temp folder, and no link
// is made.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const win = vi.hoisted(() => ({
  /** Each folder's owner and rights as SDDL, by its path in lower case. */
  acl: new Map<string, { owner: string; dacl: string }>(),
  started: [] as string[],
  /** The rule's read script and the variable its folders come through (set below, once the module is loaded). */
  readScript: '',
  dirsEnv: '',
}))

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const fsm = await import('node:fs')
  const k = (p: string) => p.toLowerCase()
  const aclOf = (p: string) => win.acl.get(k(p)) ?? { owner: 'S-1-5-32-544', dacl: 'D:AI(A;OICIID;FA;;;WD)(A;OICIID;FA;;;SY)' }
  type Cb = (err: (Error & { code?: number }) | null, stdout: string, stderr: string) => void
  const execFile = vi.fn((file: string, args: string[], opts: { env?: Record<string, string> }, cb: Cb) => {
    const name = String(file).split('\\').pop()!.toLowerCase()
    win.started.push(name)
    if (name === 'powershell.exe') {
      const script = args[args.length - 1]
      if (script !== win.readScript) {
        cb(Object.assign(new Error('Cannot invoke method. Method invocation is supported only on core types in this language mode.'), { code: 1 }), '', '')
        return
      }
      const dirs = String(opts.env?.[win.dirsEnv] ?? '').split('\n').filter(Boolean)
      const out = dirs.map((d) => {
        let st: import('node:fs').Stats | null = null
        try { st = fsm.lstatSync(d) } catch { st = null }
        if (!st) return { missing: true, attributes: null, sddl: null, error: false }
        const a = aclOf(d)
        return { missing: false, attributes: st.isSymbolicLink() ? 0x410 : st.isDirectory() ? 0x10 : 0x20, sddl: `O:${a.owner}${a.dacl}`, error: false }
      })
      cb(null, JSON.stringify(out), '')
      return
    }
    if (name === 'whoami.exe') { cb(null, `"box\\person","${USER}"\r\n`, ''); return }
    if (name === 'icacls.exe') {
      if (args[1] === '/restore') {
        const [entry, dacl] = fsm.readFileSync(args[2]).toString('utf16le').split('\r\n')
        const target = `${args[0].replace(/\\$/, '')}\\${entry}`
        win.acl.set(k(target), { ...aclOf(target), dacl })
      } else if (args[1] === '/setowner') {
        win.acl.set(k(args[0]), { ...aclOf(args[0]), owner: args[2].replace(/^\*/, '') })
      }
      cb(null, '', '')
      return
    }
    cb(Object.assign(new Error(`no ${name} in this test`), { code: 1 }), '', '')
  })
  const no = (file: unknown) => { throw new Error(`no process in this test: ${String(file)}`) }
  return { ...real, execFile, execFileSync: vi.fn(no), spawn: vi.fn(no), spawnSync: vi.fn(no), execSync: vi.fn(no) }
})

import { secureFoldersWindows, secureOwnerOnlyFolders, OWNER_ONLY_READ_SCRIPT, OWNER_ONLY_DIRS_ENV } from '../../../src/main/owner-only-folders'
win.readScript = OWNER_ONLY_READ_SCRIPT
win.dirsEnv = OWNER_ONLY_DIRS_ENV

const PREFIX = 'ccc-owner-only-default-'
let base = ''

beforeEach(() => {
  win.acl.clear()
  win.started.length = 0
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
})

afterEach(() => {
  // TEST CLEANUP GUARD: this suite's own temp folder only.
  if (path.basename(base).startsWith(PREFIX)) fs.rmSync(base, { recursive: true, force: true })
})

const ownerOnly = (dir: string) => win.acl.get(dir.toLowerCase())

describe.runIf(process.platform === 'win32')('the app\'s owner-only rule answers under Constrained Language Mode', () => {
  it('the account sign-in folders\' rule (no runner of its own): both folders owner-only and owned by the user', async () => {
    const home = path.join(base, 'profile')
    const dirs = [home, path.join(home, '.claude')]
    const out = await secureFoldersWindows(dirs)
    expect(out.map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only'], [true, 'owner-only']])
    for (const d of dirs) {
      expect(fs.statSync(d).isDirectory()).toBe(true)
      expect(ownerOnly(d)).toEqual({ owner: USER, dacl: `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})` })
    }
    expect(win.started).toContain('icacls.exe')
  })

  it('the rule the other assistant\'s managed folders get: the same', async () => {
    const root = path.join(base, 'realms')
    const out = await secureOwnerOnlyFolders([root, path.join(root, 'realm-a')])
    expect(out.map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only'], [true, 'owner-only']])
    expect(ownerOnly(root)).toEqual({ owner: USER, dacl: `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})` })
  })
})
