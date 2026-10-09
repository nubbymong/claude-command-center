// Where Windows PowerShell gives the owner-only folder rule no read at all --
// it runs in Constrained Language Mode (AppLocker or WDAC script
// enforcement), which refuses the .NET calls the rule's script makes -- the
// rule still answers, with Windows' own programs: the user's SID from
// whoami.exe, the rights set with icacls.exe /restore (exactly the user and
// SYSTEM, full control passed to what is inside, inheritance off) and the
// owner with icacls.exe /setowner, each on the folder itself (/L), then a
// read-back that uses only what that mode allows (Get-Item, Get-Acl's SDDL),
// judged by the same verdict. Same order and the same refusals as the
// script: a link, a junction or any reparse point, not a folder, a missing
// parent, or anything below a refused folder is refused, and nothing is
// written to it. Without the user's SID or a first read, nothing is changed
// and the folders say they could not be checked.
//
// Host-safe: no process starts and no real folder is touched. Windows'
// programs, the file system and PowerShell are an in-memory fake (the real
// round trip is owner-only-folders-real.test.ts, CI and the VM).
import { describe, it, expect, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const no = (file: unknown) => { throw new Error(`no process in this test: ${String(file)}`) }
  return { ...real, execFile: vi.fn(no), execFileSync: vi.fn(no), spawn: vi.fn(no), spawnSync: vi.fn(no), execSync: vi.fn(no) }
})

import {
  secureFoldersWindows, secureFoldersNative, folderReadFromSddl, sidFromWhoami, ownerOnlyVerdict,
  OWNER_ONLY_SCRIPT, OWNER_ONLY_READ_SCRIPT, OWNER_ONLY_DIRS_ENV, OWNER_ONLY_SYSTEM_SID, OWNER_ONLY_ADMINISTRATORS_SID,
} from '../../../src/main/owner-only-folders'
import type { NativeOwnerOnlyTools } from '../../../src/main/owner-only-folders'

const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1005'
const ADMIN_500 = 'S-1-5-21-1111111111-2222222222-3333333333-500'
const CLM_REFUSAL = 'Cannot invoke method. Method invocation is supported only on core types in this language mode.'
const OWNER_ONLY_DACL = (sid: string) => `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${sid})`

type Kind = 'dir' | 'file' | 'link' | 'reparse'
interface Entry { kind: Kind; owner: string; dacl: string }

/** A Windows machine in memory: folders, their owner and rights (SDDL), and
 *  the programs the rule runs against them. */
function machine(opts: { user?: string; whoami?: { code: number | null; stdout: string }; createdOwner?: string } = {}) {
  const user = opts.user ?? USER
  const entries = new Map<string, Entry>()
  const k = (p: string) => p.toLowerCase()
  const parentOf = (p: string) => p.replace(/\\[^\\]+$/, '')
  const calls: Array<{ program: string; args: string[] }> = []
  const lists: string[] = []
  const reads: Array<{ script: string; dirs: string[] }> = []
  const made: string[] = []
  const state = {
    restoreCode: 0 as number | null,
    ownerCode: 0 as number | null,
    /** What /restore writes, from what it was handed (a test may change it). */
    restoreWrites: (sddl: string) => sddl,
    /** Whether /setowner changes the owner. */
    ownerTakes: true,
    /** The script's call: Constrained Language Mode refuses it. */
    script: async (): Promise<string> => { throw new Error(CLM_REFUSAL) },
    /** The read: answered from the machine unless a test says otherwise. */
    readFails: false,
    /** Folders whose read fails on their own (the rest are read). */
    readErrors: new Set<string>(),
    readCountOff: false,
    /** lstat answers, by path, overriding the machine (a swap after a pass). */
    lstatOverride: new Map<string, { link: boolean; folder: boolean } | null>(),
  }
  const add = (p: string, e: Partial<Entry> & { kind: Kind }) => entries.set(k(p), { owner: OWNER_ONLY_ADMINISTRATORS_SID, dacl: 'D:AI(A;OICIID;FA;;;WD)(A;OICIID;FA;;;SY)', ...e })
  const tools: NativeOwnerOnlyTools = {
    run: async (program, args) => {
      calls.push({ program, args: [...args] })
      if (program === 'whoami') return opts.whoami ?? { code: 0, stdout: `"box\\person","${user}"\r\n` }
      if (args[1] === '/restore') {
        if (state.restoreCode !== 0) return { code: state.restoreCode, stdout: '' }
        const [name, sddl] = lists[lists.length - 1].split('\r\n')
        const e = entries.get(k(`${args[0].replace(/\\$/, '')}\\${name}`))
        if (!e) return { code: 2, stdout: '' }
        e.dacl = state.restoreWrites(sddl)
        return { code: 0, stdout: '' }
      }
      if (args[1] === '/setowner') {
        if (state.ownerCode !== 0) return { code: state.ownerCode, stdout: '' }
        const e = entries.get(k(args[0]))
        if (!e) return { code: 2, stdout: '' }
        if (state.ownerTakes) e.owner = args[2].replace(/^\*/, '')
        return { code: 0, stdout: '' }
      }
      return { code: 87, stdout: '' }
    },
    lstat: (p) => {
      if (state.lstatOverride.has(k(p))) return state.lstatOverride.get(k(p))!
      const e = entries.get(k(p))
      return e ? { link: e.kind === 'link', folder: e.kind === 'dir' || e.kind === 'reparse' } : null
    },
    isFolder: (p) => { const e = entries.get(k(p)); return !!e && (e.kind === 'dir' || e.kind === 'reparse' || e.kind === 'link') },
    mkdir: (p) => {
      if (entries.has(k(p))) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      if (!entries.has(k(parentOf(p)))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      made.push(p)
      add(p, { kind: 'dir', owner: opts.createdOwner ?? OWNER_ONLY_ADMINISTRATORS_SID })
    },
    withListFile: async (text, use) => { lists.push(text); return use('C:\\Temp\\ccc-owner-only-x\\rights.txt') },
  }
  const ATTR: Record<Kind, number> = { dir: 0x10, file: 0x20, link: 0x410, reparse: 0x410 }
  const run = async (script: string, env: Record<string, string>): Promise<string> => {
    if (script === OWNER_ONLY_SCRIPT) return state.script()
    if (script !== OWNER_ONLY_READ_SCRIPT) throw new Error('another script')
    const dirs = env[OWNER_ONLY_DIRS_ENV].split('\n')
    reads.push({ script, dirs })
    if (state.readFails) throw new Error(CLM_REFUSAL)
    const out = dirs.map((d) => {
      if (state.readErrors.has(k(d))) return { missing: false, attributes: null, sddl: null, error: true }
      const e = entries.get(k(d))
      return e ? { missing: false, attributes: ATTR[e.kind], sddl: `O:${e.owner}G:${e.owner}${e.dacl}`, error: false } : { missing: true, attributes: null, sddl: null, error: false }
    })
    return JSON.stringify(state.readCountOff ? out.slice(1) : out)
  }
  return { entries, add, tools, run, calls, lists, reads, made, state, user }
}

const icacls = (m: ReturnType<typeof machine>) => m.calls.filter((c) => c.program === 'icacls')

describe('the owner-only rule answers where Windows PowerShell gives its script no read', () => {
  it('a folder already there and one it makes: exactly the user and SYSTEM, inheritance off, owned by the user', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    // Already there: owned by the Administrators group, an entry of another account's, inherited rights.
    m.add('C:\\r\\home', { kind: 'dir', dacl: `D:AI(A;;FR;;;${OTHER})(D;;0x100116;;;BG)(A;OICIID;FA;;;WD)` })
    const out = await secureFoldersWindows(['C:\\r\\home', 'C:\\r\\home\\.claude'], m.run, m.tools)
    expect(out.map((r) => [r.dir, r.ok, r.detail, r.unread])).toEqual([
      ['C:\\r\\home', true, 'owner-only', undefined],
      ['C:\\r\\home\\.claude', true, 'owner-only', undefined],
    ])
    for (const d of ['c:\\r\\home', 'c:\\r\\home\\.claude']) expect(m.entries.get(d)).toMatchObject({ kind: 'dir', owner: USER, dacl: OWNER_ONLY_DACL(USER) })
    expect(m.made).toEqual(['C:\\r\\home\\.claude'])
  })

  it('runs Windows\' own programs by name with plain arguments: whoami for the SID; per folder icacls /restore on its parent, then /setowner, each on the folder itself (/L)', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b'], m.run, m.tools)
    expect(m.calls[0]).toEqual({ program: 'whoami', args: ['/user', '/fo', 'csv', '/nh'] })
    expect(icacls(m).map((c) => c.args)).toEqual([
      ['C:\\r', '/restore', 'C:\\Temp\\ccc-owner-only-x\\rights.txt', '/L'],
      ['C:\\r\\a', '/setowner', `*${USER}`, '/L'],
      ['C:\\r\\a', '/restore', 'C:\\Temp\\ccc-owner-only-x\\rights.txt', '/L'],
      ['C:\\r\\a\\b', '/setowner', `*${USER}`, '/L'],
    ])
    expect(m.lists).toEqual([`a\r\n${OWNER_ONLY_DACL(USER)}\r\n`, `b\r\n${OWNER_ONLY_DACL(USER)}\r\n`])
  })

  it('reads before and after through the environment, never inside the script, with a script Constrained Language Mode allows', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b'], m.run, m.tools)
    expect(m.reads.map((r) => r.dirs)).toEqual([['C:\\r\\a', 'C:\\r\\a\\b'], ['C:\\r\\a', 'C:\\r\\a\\b']])
    expect(OWNER_ONLY_READ_SCRIPT).not.toContain('C:\\r')
    // Cmdlets and property reads only: no .NET type made or method called, no
    // object cast that mode refuses.
    expect(OWNER_ONLY_READ_SCRIPT).toMatch(/Test-Path -LiteralPath \$d/)
    expect(OWNER_ONLY_READ_SCRIPT).toMatch(/Get-Item -LiteralPath \$d -Force/)
    expect(OWNER_ONLY_READ_SCRIPT).toMatch(/\(Get-Acl -LiteralPath \$d\)\.Sddl/)
    expect(OWNER_ONLY_READ_SCRIPT).not.toMatch(/New-Object|::|\.GetAccessControl|\.GetOwner|pscustomobject|\[ordered\]|WindowsIdentity/i)
  })

  it('a link, a junction or any other reparse point is refused and nothing is written to it; nothing is made below it', async () => {
    for (const kind of ['link', 'reparse'] as const) {
      const m = machine()
      m.add('C:\\r', { kind: 'dir' })
      m.add('C:\\r\\l', { kind, owner: OTHER, dacl: 'D:(A;;FA;;;WD)' })
      const out = await secureFoldersWindows(['C:\\r\\l', 'C:\\r\\l\\child'], m.run, m.tools)
      expect(out.map((r) => [r.ok, r.detail]), kind).toEqual([[false, 'a link'], [false, 'its parent was refused']])
      expect(icacls(m), kind).toEqual([])
      expect(m.entries.get('c:\\r\\l'), kind).toMatchObject({ owner: OTHER, dacl: 'D:(A;;FA;;;WD)' })
      expect(m.made, kind).toEqual([])
    }
  })

  it('a folder that is a link by the time it would be written (after the first read) is refused, and nothing is written to it', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    m.add('C:\\r\\a', { kind: 'dir', owner: OTHER, dacl: 'D:(A;;FA;;;WD)' })
    m.state.lstatOverride.set('c:\\r\\a', { link: true, folder: false })
    const out = await secureFoldersWindows(['C:\\r\\a'], m.run, m.tools)
    expect(out.map((r) => [r.ok, r.detail])).toEqual([[false, 'a link']])
    expect(icacls(m)).toEqual([])
    expect(m.entries.get('c:\\r\\a')).toMatchObject({ owner: OTHER, dacl: 'D:(A;;FA;;;WD)' })
  })

  it('a folder whose first read fails on its own is refused, and nothing is written to it or below it', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    m.add('C:\\r\\a', { kind: 'dir', owner: OTHER, dacl: 'D:(A;;FA;;;WD)' })
    m.state.readErrors.add('c:\\r\\a')
    const out = await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b'], m.run, m.tools)
    expect(out.map((r) => [r.ok, r.detail])).toEqual([[false, 'it could not be read'], [false, 'its parent was refused']])
    expect(icacls(m)).toEqual([])
    expect(m.made).toEqual([])
  })

  it('refuses what is not a folder and a folder whose parent is missing, writing nothing', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    m.add('C:\\r\\f', { kind: 'file' })
    const out = await secureFoldersWindows(['C:\\r\\f', 'C:\\r\\nope\\x'], m.run, m.tools)
    expect(out.map((r) => [r.ok, r.detail])).toEqual([[false, 'not a folder'], [false, 'its parent is missing']])
    expect(icacls(m)).toEqual([])
    expect(m.made).toEqual([])
  })

  it('a folder of the call that is a link by the time the next is made inside it: the next is refused', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    const tools = { ...m.tools, run: async (program: 'whoami' | 'icacls', args: readonly string[]) => {
      const r = await m.tools.run(program, args)
      // Swapped for a link as soon as its owner was set.
      if (args[1] === '/setowner' && args[0] === 'C:\\r\\a') m.state.lstatOverride.set('c:\\r\\a', { link: true, folder: false })
      return r
    } }
    const out = await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b'], m.run, tools)
    expect(out[1]).toMatchObject({ ok: false, detail: 'its parent is a link' })
    expect(m.made).toEqual(['C:\\r\\a'])
  })

  it('rights or an owner that cannot be set refuse the folder and what is below it', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    m.state.restoreCode = 5
    expect((await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b'], m.run, m.tools)).map((r) => [r.ok, r.detail]))
      .toEqual([[false, 'its rights could not be set'], [false, 'its parent was refused']])
    const n = machine()
    n.add('C:\\r', { kind: 'dir' })
    n.state.ownerCode = 1
    expect((await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b'], n.run, n.tools)).map((r) => [r.ok, r.detail]))
      .toEqual([[false, 'its owner could not be set'], [false, 'its parent was refused']])
  })

  it('a program that did not start or finish, or a rights list that could not be written, is no answer: that folder and what is below it say unread, never refused', async () => {
    const cases: Array<[string, (m: ReturnType<typeof machine>) => NativeOwnerOnlyTools, string]> = [
      ['rights', (m) => { m.state.restoreCode = null; return m.tools }, 'its rights could not be set: the program did not start or finish'],
      ['owner', (m) => { m.state.ownerCode = null; return m.tools }, 'its owner could not be set: the program did not start or finish'],
      ['list', (m) => ({ ...m.tools, withListFile: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } }), 'its rights list could not be written'],
    ]
    for (const [name, arrange, detail] of cases) {
      const m = machine()
      m.add('C:\\r', { kind: 'dir' })
      const tools = arrange(m)
      const out = await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b', 'C:\\r\\a\\b\\c'], m.run, tools)
      expect(out.map((r) => [r.dir, r.ok, r.detail, r.unread]), name).toEqual([
        ['C:\\r\\a', false, detail, true],
        ['C:\\r\\a\\b', false, 'its parent could not be checked', true],
        ['C:\\r\\a\\b\\c', false, 'its parent could not be checked', true],
      ])
      // Nothing is made or written below the folder that got no answer.
      expect(m.made, name).toEqual(['C:\\r\\a'])
      expect(icacls(m).filter((c) => c.args[0] !== 'C:\\r' && c.args[0] !== 'C:\\r\\a'), name).toEqual([])
    }
  })

  it('a folder that got no answer leaves a folder beside it, not below it, to its own verdict', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    let restores = 0
    const tools = { ...m.tools, run: async (program: 'whoami' | 'icacls', args: readonly string[]) => {
      // The first folder's rights call times out; the next one's answers.
      if (args[1] === '/restore' && ++restores === 1) return { code: null, stdout: '' }
      return m.tools.run(program, args)
    } }
    const out = await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\b'], m.run, tools)
    expect(out.map((r) => [r.dir, r.ok, r.unread])).toEqual([['C:\\r\\a', false, true], ['C:\\r\\b', true, undefined]])
  })

  it('the read-back decides: another entry, another owner or rights inherited from above are refused', async () => {
    const extra = machine()
    extra.add('C:\\r', { kind: 'dir' })
    extra.state.restoreWrites = (sddl) => `${sddl}(A;;FR;;;${OTHER})`
    expect((await secureFoldersWindows(['C:\\r\\a'], extra.run, extra.tools))[0]).toMatchObject({ ok: false, detail: `an entry for ${OTHER}` })
    const owner = machine()
    owner.add('C:\\r', { kind: 'dir' })
    owner.state.ownerTakes = false
    expect((await secureFoldersWindows(['C:\\r\\a'], owner.run, owner.tools))[0]).toMatchObject({ ok: false, detail: 'its owner is not this user' })
    const inherits = machine()
    inherits.add('C:\\r', { kind: 'dir' })
    inherits.state.restoreWrites = (sddl) => sddl.replace('D:PAI', 'D:AI')
    expect((await secureFoldersWindows(['C:\\r\\a'], inherits.run, inherits.tools))[0]).toMatchObject({ ok: false, detail: 'it inherits rights from above' })
  })

  it('a folder that is a link, not a folder or unreadable at its read-back is refused, and so is what is below it', async () => {
    const cases = [['reparse', 'a link'], ['file', 'not a folder'], ['unreadable', 'its rights could not be read back']] as const
    for (const [now, detail] of cases) {
      const m = machine()
      m.add('C:\\r', { kind: 'dir' })
      const tools = { ...m.tools, run: async (program: 'whoami' | 'icacls', args: readonly string[]) => {
        const r = await m.tools.run(program, args)
        // Changed once both folders are written: only the read-back sees it.
        if (args[1] === '/setowner' && args[0] === 'C:\\r\\a\\b') {
          if (now === 'unreadable') m.state.readErrors.add('c:\\r\\a')
          else m.entries.get('c:\\r\\a')!.kind = now
        }
        return r
      } }
      const out = await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b'], m.run, tools)
      expect(out.map((r) => [r.dir, r.ok, r.detail]), now).toEqual([
        ['C:\\r\\a', false, detail],
        ['C:\\r\\a\\b', false, 'its parent was refused'],
      ])
      // Both were written, and the one below reads back owner-only on its own.
      expect(m.entries.get('c:\\r\\a\\b'), now).toMatchObject({ kind: 'dir', owner: USER, dacl: OWNER_ONLY_DACL(USER) })
    }
  })

  it('a folder refused at its read-back refuses every level below it, not only the next one', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    const tools = { ...m.tools, run: async (program: 'whoami' | 'icacls', args: readonly string[]) => {
      const r = await m.tools.run(program, args)
      // A link by the time all three are written: only the read-back sees it.
      if (args[1] === '/setowner' && args[0] === 'C:\\r\\a\\b\\c') m.entries.get('c:\\r\\a')!.kind = 'reparse'
      return r
    } }
    const out = await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b', 'C:\\r\\a\\b\\c'], m.run, tools)
    expect(out.map((r) => [r.dir, r.ok, r.detail])).toEqual([
      ['C:\\r\\a', false, 'a link'],
      ['C:\\r\\a\\b', false, 'its parent was refused'],
      ['C:\\r\\a\\b\\c', false, 'its parent was refused'],
    ])
    // All three were written, and the two below read back owner-only on their own.
    for (const d of ['c:\\r\\a\\b', 'c:\\r\\a\\b\\c']) expect(m.entries.get(d), d).toMatchObject({ kind: 'dir', owner: USER, dacl: OWNER_ONLY_DACL(USER) })
  })

  it('without the user\'s SID, or without a first read, nothing is changed and every folder says it could not be checked', async () => {
    for (const whoami of [{ code: 1, stdout: '' }, { code: 0, stdout: 'not csv' }, { code: 0, stdout: `"a","${USER}"\r\n"b","${OTHER}"\r\n` }, { code: null, stdout: '' }]) {
      const m = machine({ whoami })
      m.add('C:\\r', { kind: 'dir' })
      const out = await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b'], m.run, m.tools)
      expect(out.map((r) => [r.ok, r.unread]), whoami.stdout).toEqual([[false, true], [false, true]])
      expect(icacls(m)).toEqual([])
      expect(m.made).toEqual([])
    }
    // Windows PowerShell blocked outright: the read gives nothing either.
    const blocked = machine()
    blocked.add('C:\\r', { kind: 'dir' })
    blocked.state.readFails = true
    const out = await secureFoldersWindows(['C:\\r\\a'], blocked.run, blocked.tools)
    expect(out.map((r) => [r.ok, r.unread])).toEqual([[false, true]])
    expect(icacls(blocked)).toEqual([])
    expect(blocked.made).toEqual([])
  })

  it('a read-back that gives no answer, or one that does not match what was asked, leaves those folders unread', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    let n = 0
    const failsSecond = async (script: string, env: Record<string, string>) => {
      if (script === OWNER_ONLY_READ_SCRIPT && ++n === 2) throw new Error('timed out')
      return m.run(script, env)
    }
    expect((await secureFoldersWindows(['C:\\r\\a'], failsSecond, m.tools)).map((r) => [r.ok, r.unread])).toEqual([[false, true]])
    const off = machine()
    off.add('C:\\r', { kind: 'dir' })
    off.state.readCountOff = true
    expect((await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\b'], off.run, off.tools)).map((r) => [r.ok, r.unread])).toEqual([[false, true], [false, true]])
  })

  it('is not used when the script gives a read, and a test runner of its own gets none unless it brings it', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    const read = { dir: 'C:\\r\\a', error: null, owner: USER, protected: true, rules: [{ sid: USER, rights: 2032127, allow: true, inherited: false, flags: 3 }, { sid: OWNER_ONLY_SYSTEM_SID, rights: 2032127, allow: true, inherited: false, flags: 3 }] }
    m.state.script = async () => JSON.stringify({ user: USER, folders: [read] })
    expect((await secureFoldersWindows(['C:\\r\\a'], m.run, m.tools)).map((r) => r.ok)).toEqual([true])
    expect(m.calls).toEqual([])
    const none = machine()
    none.add('C:\\r', { kind: 'dir' })
    expect((await secureFoldersWindows(['C:\\r\\a'], none.run)).map((r) => [r.ok, r.unread])).toEqual([[false, true]])
    expect(none.calls).toEqual([])
  })

  it('folders that cannot be named safely never reach Windows\' programs, and keep their place', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    const out = await secureFoldersWindows(['relative\\x', 'C:\\r\\a', 'C:\\r\\b.'], m.run, m.tools)
    expect(out.map((r) => [r.dir, r.ok])).toEqual([['relative\\x', false], ['C:\\r\\a', true], ['C:\\r\\b.', false]])
    expect(m.reads[0].dirs).toEqual(['C:\\r\\a'])
  })

  it('secureFoldersNative alone: one answer per folder, in place', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    const out = await secureFoldersNative(['C:\\r\\a', 'C:\\r\\f'], m.tools, m.run)
    expect(out!.map((r) => [r.dir, r.ok])).toEqual([['C:\\r\\a', true], ['C:\\r\\f', true]])
  })
})

describe('the read-back: SDDL read by SID, in any language', () => {
  const sddl = (owner: string, dacl: string) => `O:${owner}G:${owner}${dacl}`
  const verdict = (s: string, user = USER) => ownerOnlyVerdict(folderReadFromSddl(s, user), user)

  it('SYSTEM and the Administrators group by their fixed abbreviations; the user by SID', () => {
    expect(verdict(sddl(USER, OWNER_ONLY_DACL(USER))).ok).toBe(true)
    expect(verdict(sddl(USER, `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`)).ok).toBe(true)
    expect(verdict(`O:${USER}${OWNER_ONLY_DACL(USER)}`).ok).toBe(true)
  })

  it('the built-in Administrator (LA) is the user only when the user is that account', () => {
    expect(verdict(sddl('LA', 'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;LA)'), ADMIN_500).ok).toBe(true)
    expect(verdict(sddl('LA', 'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;LA)'), USER)).toMatchObject({ ok: false })
    expect(verdict(sddl(USER, `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})(A;OICI;FA;;;LA)`), USER)).toMatchObject({ ok: false, detail: 'an entry for LA' })
  })

  it('refuses every other shape', () => {
    const cases: Array<[string, string]> = [
      ['another owner', sddl('BA', OWNER_ONLY_DACL(USER))],
      ['inheritance on', sddl(USER, `D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})`)],
      ['an inherited entry', sddl(USER, `D:PAI(A;OICIID;FA;;;SY)(A;OICI;FA;;;${USER})`)],
      ['another account by abbreviation', sddl(USER, `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})(A;;FR;;;BU)`)],
      ['everyone', sddl(USER, `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})(A;;FR;;;WD)`)],
      ['a deny entry', sddl(USER, `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})(D;;FA;;;${USER})`)],
      ['no SYSTEM', sddl(USER, `D:PAI(A;OICI;FA;;;${USER})`)],
      ['the user without full control', sddl(USER, `D:PAI(A;OICI;FA;;;SY)(A;OICI;FR;;;${USER})`)],
      ['the user\'s rights generic, not file rights', sddl(USER, `D:PAI(A;OICI;FA;;;SY)(A;OICI;GA;;;${USER})`)],
      ['the user\'s rights not passed to what is inside', sddl(USER, `D:PAI(A;OICI;FA;;;SY)(A;CI;FA;;;${USER})`)],
      ['an object entry', sddl(USER, `D:PAI(A;OICI;FA;;;SY)(OA;OICI;FA;bf967aba-0de6-11d0-a285-00aa003049e2;;${USER})`)],
      ['a conditional entry', sddl(USER, `D:PAI(A;OICI;FA;;;SY)(XA;OICI;FA;;;${USER};(@User.x == 1))`)],
      ['no access list', `O:${USER}G:${USER}D:NO_ACCESS_CONTROL`],
      ['not SDDL', 'nonsense'],
      ['an audit list', `${sddl(USER, OWNER_ONLY_DACL(USER))}S:(AU;SA;FA;;;WD)`],
    ]
    for (const [name, s] of cases) expect(verdict(s).ok, name).toBe(false)
    // An entry of a shape a folder's never has is not read at all (not taken for another kind).
    expect(folderReadFromSddl(sddl(USER, `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;bf967aba-0de6-11d0-a285-00aa003049e2;;${USER})`), USER)).toEqual({ error: 'an entry could not be read' })
  })

  it('reads the user\'s SID from whoami\'s one CSV line only', () => {
    expect(sidFromWhoami(`"box\\person","${USER}"\r\n`)).toBe(USER)
    expect(sidFromWhoami('')).toBe('')
    expect(sidFromWhoami(`"box\\person","not-a-sid"`)).toBe('')
    expect(sidFromWhoami(`"a","${USER}"\n"b","${OTHER}"`)).toBe('')
  })
})
