// Where Windows PowerShell gives the owner-only folder rule no read at all --
// it runs in Constrained Language Mode (AppLocker or WDAC script
// enforcement), which refuses the .NET calls the rule's script makes -- the
// rule still answers, with Windows' own programs: the user's SID from
// whoami.exe, the rights set with icacls.exe (inheritance off, the user and
// SYSTEM granted, every other account's own entry removed: exactly the user
// and SYSTEM, full control passed to what is inside; never /restore, which
// needs a privilege only an elevated process has) and the owner with
// icacls.exe /setowner, each on the folder itself (/L); then what is inside
// each folder is read (Get-ChildItem, Get-Acl's SDDL), an entry this user or
// the Administrators group owns that lets anyone else in is reset with
// icacls.exe /reset on that entry itself (/L) and read again, and a read-back
// that uses only what that mode allows (Get-Item, Get-Acl's SDDL) is judged
// by the same verdicts. Same order and the same refusals as the
// script: a link, a junction or any reparse point, not a folder, a missing
// parent, or anything below a refused folder is refused, and nothing is
// written to it. Without the user's SID or a first read, nothing is changed
// and the folders say they could not be checked. A folder is never taken over
// from another account: one already there whose owner, by the first read's
// SDDL, is not this user or the Administrators group, one put there after
// that read found nothing, and one replaced by another folder since that
// read are each refused before anything is written to them.
//
// Host-safe: no process starts and no real folder is touched. Windows'
// programs, the file system and PowerShell are an in-memory fake (the real
// round trip is owner-only-folders-real.test.ts, CI and the VM). Where
// Windows PowerShell is handed a module path it cannot load the read's
// cmdlets from (PowerShell 7 leaves its own modules first in the module path
// of what it starts), the answers it gave are replayed as captured: every
// call gets Windows PowerShell's own modules folder, and a read that stops
// at loading its modules is no read, never a folder passed.
import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const no = (file: unknown) => { throw new Error(`no process in this test: ${String(file)}`) }
  return { ...real, execFile: vi.fn(no), execFileSync: vi.fn(no), spawn: vi.fn(no), spawnSync: vi.fn(no), execSync: vi.fn(no) }
})

import {
  secureFoldersWindows, secureFoldersNative, folderReadFromSddl, ownerFromSddl, sidFromWhoami, ownerOnlyVerdict, windowsPowerShellEnv,
  OWNER_ONLY_SCRIPT, OWNER_ONLY_READ_SCRIPT, OWNER_ONLY_INSIDE_SCRIPT, OWNER_ONLY_DIRS_ENV, OWNER_ONLY_SKIP_ENV, OWNER_ONLY_USER_ENV,
  OWNER_ONLY_SYSTEM_SID, OWNER_ONLY_ADMINISTRATORS_SID,
} from '../../../src/main/owner-only-folders'
import type { NativeOwnerOnlyTools } from '../../../src/main/owner-only-folders'

const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1005'
const ADMIN_500 = 'S-1-5-21-1111111111-2222222222-3333333333-500'
const CLM_REFUSAL = 'Cannot invoke method. Method invocation is supported only on core types in this language mode.'
const OWNER_ONLY_DACL = (sid: string) => `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${sid})`
/** What an entry inside an owner-only folder reads once it takes the folder's rights. */
const INHERITED_DACL = (sid: string) => `D:AI(A;ID;FA;;;SY)(A;ID;FA;;;${sid})`
/** A local group of this machine (synthetic). */
const OTHER_GROUP = 'S-1-5-21-1111111111-2222222222-3333333333-1007'

/** `link`: a link to a folder (a junction); `filelink`: a symbolic link to a file. */
type Kind = 'dir' | 'file' | 'link' | 'reparse' | 'filelink'
/** `id`: its file identity (a folder made in its place has another). `path`: as it was named. */
interface Entry { kind: Kind; owner: string; dacl: string; id: number; path: string }

/** Every entry of an SDDL access list is inherited (what Windows rewrites when the folder above gets rights of its own). */
const inheritsOnly = (dacl: string) => (dacl.match(/\(([^()]*)\)/g) ?? []).every((a) => a.split(';')[1].includes('ID'))

/** A Windows machine in memory: folders, their owner and rights (SDDL), and
 *  the programs the rule runs against them. */
function machine(opts: { user?: string; whoami?: { code: number | null; stdout: string }; createdOwner?: string } = {}) {
  const user = opts.user ?? USER
  const entries = new Map<string, Entry>()
  const k = (p: string) => p.toLowerCase()
  const parentOf = (p: string) => p.replace(/\\[^\\]+$/, '')
  const calls: Array<{ program: string; args: string[] }> = []
  const reads: Array<{ script: string; dirs: string[] }> = []
  const insideReads: Array<{ dir: string; skip: string[]; user: string }> = []
  const made: string[] = []
  let ids = 0
  const state = {
    rightsCode: 0 as number | null,
    ownerCode: 0 as number | null,
    /** What the rights call writes, from the owner-only rights (a test may change it). */
    rightsWrites: (sddl: string) => sddl,
    /** Whether /setowner changes the owner. */
    ownerTakes: true,
    /** /reset of an entry inside: its answer, and whether it takes. */
    resetCode: 0 as number | null,
    resetTakes: true,
    /** The read of what is inside: no answer at all, or an error for these folders. */
    insideFails: false,
    insideErrors: new Set<string>(),
    /** The script's call: Constrained Language Mode refuses it. */
    script: async (): Promise<string> => { throw new Error(CLM_REFUSAL) },
    /** The read: answered from the machine unless a test says otherwise. */
    readFails: false,
    /** Folders whose read fails on their own (the rest are read). */
    readErrors: new Set<string>(),
    readCountOff: false,
    /** lstat answers, by path, overriding the machine (a swap after a pass). */
    lstatOverride: new Map<string, { link: boolean; folder: boolean } | null>(),
    /** The SDDL every read gives for a folder there, by path, overriding the machine's. */
    sddlOverride: new Map<string, string | null>(),
    /** Runs once the first read has answered (what changes before the folders are written). */
    afterFirstRead: null as null | (() => void),
  }
  const add = (p: string, e: Partial<Entry> & { kind: Kind }) => entries.set(k(p), { owner: OWNER_ONLY_ADMINISTRATORS_SID, dacl: 'D:AI(A;OICIID;FA;;;WD)(A;OICIID;FA;;;SY)', id: ++ids, path: p, ...e })
  const tools: NativeOwnerOnlyTools = {
    run: async (program, args) => {
      calls.push({ program, args: [...args] })
      if (program === 'whoami') return opts.whoami ?? { code: 0, stdout: `"box\\person","${user}"\r\n` }
      if (args[1] === '/inheritance:r') {
        if (state.rightsCode !== 0) return { code: state.rightsCode, stdout: '' }
        const e = entries.get(k(args[0]))
        if (!e) return { code: 2, stdout: '' }
        e.dacl = state.rightsWrites(OWNER_ONLY_DACL(user))
        // A write of rights alone: Windows passes them on to every entry
        // below whose rights are all inherited, whoever owns it.
        for (const [p, x] of entries) if (p.startsWith(`${k(args[0])}\\`) && inheritsOnly(x.dacl)) x.dacl = INHERITED_DACL(user)
        return { code: 0, stdout: '' }
      }
      if (args[1] === '/reset') {
        if (state.resetCode !== 0) return { code: state.resetCode, stdout: '' }
        const e = entries.get(k(args[0].replace(/^\\\\\?\\/, '')))
        if (!e) return { code: 2, stdout: '' }
        if (state.resetTakes) e.dacl = INHERITED_DACL(user)
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
      return e ? { link: e.kind === 'link', folder: e.kind === 'dir' || e.kind === 'reparse', id: `1:${e.id}` } : null
    },
    isFolder: (p) => { const e = entries.get(k(p)); return !!e && (e.kind === 'dir' || e.kind === 'reparse' || e.kind === 'link') },
    mkdir: (p) => {
      if (entries.has(k(p))) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      if (!entries.has(k(parentOf(p)))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      made.push(p)
      add(p, { kind: 'dir', owner: opts.createdOwner ?? OWNER_ONLY_ADMINISTRATORS_SID })
    },
  }
  const ATTR: Record<Kind, number> = { dir: 0x10, file: 0x20, link: 0x410, reparse: 0x410, filelink: 0x420 }
  /** As the script decides what to print: an owner this user or the Administrators group, allow entries for the user, SYSTEM or the Administrators group only. */
  const plainlyClean = (e: Entry) => (e.owner === user || e.owner === 'BA' || e.owner === OWNER_ONLY_ADMINISTRATORS_SID) &&
    (e.dacl.match(/\(([^()]*)\)/g) ?? []).every((a) => { const f = a.slice(1, -1).split(';'); return f[0] === 'A' && ['SY', 'BA', user, OWNER_ONLY_SYSTEM_SID, OWNER_ONLY_ADMINISTRATORS_SID].includes(f[5]) })
  /** The read of what is inside one folder (OWNER_ONLY_INSIDE_SCRIPT), from the machine. */
  const readInside = (env: Record<string, string>): string => {
    const dir = env[OWNER_ONLY_DIRS_ENV]
    const skip = env[OWNER_ONLY_SKIP_ENV].split('\n').filter(Boolean)
    insideReads.push({ dir, skip, user: env[OWNER_ONLY_USER_ENV] })
    if (state.insideFails) throw new Error('timed out')
    if (state.insideErrors.has(k(dir))) return JSON.stringify([{ inside: [], error: true }])
    const skipped = new Set(skip.map(k))
    const inside: Array<{ name: number[]; attributes: number; sddl: string | null }> = []
    const codes = (t: string) => [...t].map((c) => c.charCodeAt(0))
    const walk = (at: string, rel: string) => {
      for (const [p, e] of entries) {
        if (parentOf(p) !== k(at) || skipped.has(p)) continue
        const name = rel ? `${rel}\\${e.path.slice(at.length + 1)}` : e.path.slice(at.length + 1)
        if (e.kind === 'link' || e.kind === 'reparse' || e.kind === 'filelink') {
          if (!rel || e.kind === 'filelink') inside.push({ name: codes(name), attributes: ATTR[e.kind], sddl: null })
          continue
        }
        const clean = plainlyClean(e)
        if (!rel || !clean) inside.push({ name: codes(name), attributes: ATTR[e.kind], sddl: `O:${e.owner}G:${e.owner}${e.dacl}` })
        if (e.kind === 'dir' && (e.owner === user || e.owner === 'BA' || e.owner === OWNER_ONLY_ADMINISTRATORS_SID)) walk(e.path, name)
      }
    }
    walk(entries.get(k(dir))?.path ?? dir, '')
    return JSON.stringify([{ inside, error: false }])
  }
  const run = async (script: string, env: Record<string, string>): Promise<string> => {
    if (script === OWNER_ONLY_SCRIPT) return state.script()
    if (script === OWNER_ONLY_INSIDE_SCRIPT) return readInside(env)
    if (script !== OWNER_ONLY_READ_SCRIPT) throw new Error('another script')
    const dirs = env[OWNER_ONLY_DIRS_ENV].split('\n')
    reads.push({ script, dirs })
    if (state.readFails) throw new Error(CLM_REFUSAL)
    const out = dirs.map((d) => {
      if (state.readErrors.has(k(d))) return { missing: false, attributes: null, sddl: null, error: true }
      const e = entries.get(k(d))
      const sddl = state.sddlOverride.has(k(d)) ? state.sddlOverride.get(k(d)) : `O:${e?.owner}G:${e?.owner}${e?.dacl}`
      return e ? { missing: false, attributes: ATTR[e.kind], sddl, error: false } : { missing: true, attributes: null, sddl: null, error: false }
    })
    if (reads.length === 1) state.afterFirstRead?.()
    return JSON.stringify(state.readCountOff ? out.slice(1) : out)
  }
  return { entries, add, tools, run, calls, reads, insideReads, made, state, user }
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

  it('runs Windows\' own programs by name with plain arguments: whoami for the SID; per folder icacls with the rights alone (inheritance off, the user and SYSTEM granted), then /setowner, each on the folder itself (/L); never /restore', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b'], m.run, m.tools)
    expect(m.calls[0]).toEqual({ program: 'whoami', args: ['/user', '/fo', 'csv', '/nh'] })
    const rights = (d: string) => [d, '/inheritance:r', '/grant:r', `*${USER}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/L']
    expect(icacls(m).map((c) => c.args)).toEqual([
      rights('C:\\r\\a'),
      ['C:\\r\\a', '/setowner', `*${USER}`, '/L'],
      rights('C:\\r\\a\\b'),
      ['C:\\r\\a\\b', '/setowner', `*${USER}`, '/L'],
    ])
    expect(icacls(m).flatMap((c) => c.args)).not.toContain('/restore')
  })

  it('a folder already there loses every other account\'s own entry: each is named to icacls by SID, an SDDL abbreviation by its SID', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    m.add('C:\\r\\home', { kind: 'dir', dacl: `D:AI(A;;FR;;;${OTHER})(D;;0x100116;;;BG)(A;;FA;;;${USER})(A;OICIID;FA;;;WD)` })
    await secureFoldersWindows(['C:\\r\\home'], m.run, m.tools)
    expect(icacls(m)[0].args).toEqual(['C:\\r\\home', '/inheritance:r', '/grant:r', `*${USER}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/remove', `*${OTHER}`, '*S-1-5-32-546', '/L'])
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
    m.state.rightsCode = 5
    expect((await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b'], m.run, m.tools)).map((r) => [r.ok, r.detail]))
      .toEqual([[false, 'its rights could not be set'], [false, 'its parent was refused']])
    const n = machine()
    n.add('C:\\r', { kind: 'dir' })
    n.state.ownerCode = 1
    expect((await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b'], n.run, n.tools)).map((r) => [r.ok, r.detail]))
      .toEqual([[false, 'its owner could not be set'], [false, 'its parent was refused']])
  })

  it('a program that did not start or finish is no answer: that folder and what is below it say unread, never refused', async () => {
    const cases: Array<[string, (m: ReturnType<typeof machine>) => NativeOwnerOnlyTools, string]> = [
      ['rights', (m) => { m.state.rightsCode = null; return m.tools }, 'its rights could not be set: the program did not start or finish'],
      ['owner', (m) => { m.state.ownerCode = null; return m.tools }, 'its owner could not be set: the program did not start or finish'],
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
      if (args[1] === '/inheritance:r' && ++restores === 1) return { code: null, stdout: '' }
      return m.tools.run(program, args)
    } }
    const out = await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\b'], m.run, tools)
    expect(out.map((r) => [r.dir, r.ok, r.unread])).toEqual([['C:\\r\\a', false, true], ['C:\\r\\b', true, undefined]])
  })

  it('the read-back decides: another entry, another owner or rights inherited from above are refused', async () => {
    const extra = machine()
    extra.add('C:\\r', { kind: 'dir' })
    extra.state.rightsWrites = (sddl) => `${sddl}(A;;FR;;;${OTHER})`
    expect((await secureFoldersWindows(['C:\\r\\a'], extra.run, extra.tools))[0]).toMatchObject({ ok: false, detail: `an entry for ${OTHER}` })
    const owner = machine()
    owner.add('C:\\r', { kind: 'dir' })
    owner.state.ownerTakes = false
    expect((await secureFoldersWindows(['C:\\r\\a'], owner.run, owner.tools))[0]).toMatchObject({ ok: false, detail: 'its owner is not this user' })
    const inherits = machine()
    inherits.add('C:\\r', { kind: 'dir' })
    inherits.state.rightsWrites = (sddl) => sddl.replace('D:PAI', 'D:AI')
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
    const read = { dir: 'C:\\r\\a', error: null, owner: USER, protected: true, rules: [{ sid: USER, rights: 2032127, allow: true, inherited: false, flags: 3 }, { sid: OWNER_ONLY_SYSTEM_SID, rights: 2032127, allow: true, inherited: false, flags: 3 }], inside: [], insideError: null }
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

describe('a folder is never taken over from another account', () => {
  const ORIGINAL = 'D:AI(A;OICIID;FA;;;WD)'

  it('a folder already there that another account owns is refused before anything is written: no icacls call, nothing made below it, its owner and rights as they were', async () => {
    // As Get-Acl writes them: another account by SID, SYSTEM as SY, and LA for
    // a user who is not the built-in Administrator (so LA is another account).
    for (const owner of [OTHER, 'SY', 'LA']) {
      const m = machine()
      m.add('C:\\r', { kind: 'dir' })
      m.add('C:\\r\\home', { kind: 'dir', owner, dacl: ORIGINAL })
      const out = await secureFoldersWindows(['C:\\r\\home', 'C:\\r\\home\\.claude'], m.run, m.tools)
      expect(out.map((r) => [r.ok, r.detail, r.unread]), owner).toEqual([
        [false, 'its owner is not this user', undefined],
        [false, 'its parent was refused', undefined],
      ])
      expect(icacls(m), owner).toEqual([])
      expect(m.made, owner).toEqual([])
      expect(m.entries.get('c:\\r\\home'), owner).toMatchObject({ owner, dacl: ORIGINAL })
    }
  })

  it('a folder this user or the Administrators group owns is taken in place, however the SDDL names the owner', async () => {
    const cases: Array<[string, string]> = [[USER, USER], ['BA', USER], [OWNER_ONLY_ADMINISTRATORS_SID, USER], ['LA', ADMIN_500]]
    for (const [owner, user] of cases) {
      const m = machine({ user })
      m.add('C:\\r', { kind: 'dir' })
      m.add('C:\\r\\home', { kind: 'dir', owner, dacl: ORIGINAL })
      const out = await secureFoldersWindows(['C:\\r\\home'], m.run, m.tools)
      expect(out.map((r) => [r.ok, r.detail]), owner).toEqual([[true, 'owner-only']])
      expect(m.entries.get('c:\\r\\home'), owner).toMatchObject({ owner: user, dacl: OWNER_ONLY_DACL(user) })
    }
  })

  it('a folder whose owner the first read does not give is refused unwritten', async () => {
    for (const sddl of [null, 'nonsense', OWNER_ONLY_DACL(USER), `G:${USER}${OWNER_ONLY_DACL(USER)}`, `O:BAX${OWNER_ONLY_DACL(USER)}`]) {
      const m = machine()
      m.add('C:\\r', { kind: 'dir' })
      m.add('C:\\r\\a', { kind: 'dir', owner: USER, dacl: ORIGINAL })
      m.state.sddlOverride.set('c:\\r\\a', sddl)
      const out = await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b'], m.run, m.tools)
      expect(out.map((r) => [r.ok, r.detail]), String(sddl)).toEqual([[false, 'its owner could not be read'], [false, 'its parent was refused']])
      expect(icacls(m), String(sddl)).toEqual([])
      expect(m.made, String(sddl)).toEqual([])
    }
  })

  it('a folder put there after the first read found nothing is refused unwritten, never taken over: its owner was never read', async () => {
    for (const owner of [OTHER, USER]) {
      const m = machine()
      m.add('C:\\r', { kind: 'dir' })
      m.state.afterFirstRead = () => m.add('C:\\r\\a', { kind: 'dir', owner, dacl: ORIGINAL })
      const out = await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b'], m.run, m.tools)
      expect(out.map((r) => [r.ok, r.detail, r.unread]), owner).toEqual([
        [false, 'its owner could not be read', undefined],
        [false, 'its parent was refused', undefined],
      ])
      expect(icacls(m), owner).toEqual([])
      expect(m.made, owner).toEqual([])
      expect(m.entries.get('c:\\r\\a'), owner).toMatchObject({ owner, dacl: ORIGINAL })
    }
  })

  it('a folder replaced by another between the first read and its write is refused unwritten: the folder written must be the one whose owner was read', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    m.add('C:\\r\\a', { kind: 'dir', owner: USER, dacl: ORIGINAL })
    // Read while this user's; then moved away and another account's put in its place.
    m.state.afterFirstRead = () => m.add('C:\\r\\a', { kind: 'dir', owner: OTHER, dacl: ORIGINAL })
    const out = await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b'], m.run, m.tools)
    expect(out.map((r) => [r.ok, r.detail])).toEqual([[false, 'it was replaced while it was checked'], [false, 'its parent was refused']])
    expect(icacls(m)).toEqual([])
    expect(m.made).toEqual([])
    expect(m.entries.get('c:\\r\\a')).toMatchObject({ owner: OTHER, dacl: ORIGINAL })
  })

  it('a folder the call makes is made only where nothing is by then: one put there meanwhile fails the make and is refused unwritten', async () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    // Nothing there at the first read or at the look just before the make; there by the make itself.
    const tools: NativeOwnerOnlyTools = { ...m.tools, mkdir: (p) => { m.add(p, { kind: 'dir', owner: OTHER, dacl: ORIGINAL }); m.tools.mkdir(p) } }
    const out = await secureFoldersWindows(['C:\\r\\a', 'C:\\r\\a\\b'], m.run, tools)
    expect(out.map((r) => r.ok)).toEqual([false, false])
    expect(out[1].detail).toBe('its parent was refused')
    expect(icacls(m)).toEqual([])
    expect(m.entries.get('c:\\r\\a')).toMatchObject({ owner: OTHER, dacl: ORIGINAL })
  })

  // Captured from real Windows PowerShell 5.1 (an administrator's elevated
  // process), each folder inside a temp folder that lets Everyone in: one
  // SYSTEM owns, one the Administrators group owns, one this user owns, one
  // missing. The read under Constrained Language Mode, and the main script's
  // answer in Full Language for the first, a folder inside it and the second.
  const CAPTURED_USER = 'S-1-5-21-1234567890-1234567890-1234567890-1000'
  const CAPTURED_DACL = 'D:AI(A;OICIID;FA;;;WD)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)(A;OICIIOID;SDGXGWGR;;;AU)'
  const CAPTURED_READ = '[{"error":false,"attributes":16,"missing":false,"sddl":"O:SYG:S-1-5-21-1234567890-1234567890-1234567890-513' + CAPTURED_DACL + '"},' +
    '{"error":false,"attributes":16,"missing":false,"sddl":"O:BAG:S-1-5-21-1234567890-1234567890-1234567890-513' + CAPTURED_DACL + '"},' +
    '{"error":false,"attributes":16,"missing":false,"sddl":"O:S-1-5-21-1234567890-1234567890-1234567890-1000G:S-1-5-21-1234567890-1234567890-1234567890-513' + CAPTURED_DACL + '"},' +
    '{"error":false,"attributes":null,"missing":true,"sddl":null}]'
  // The main script's answer, captured again once it read what is inside
  // (an administrator's elevated process, a temp folder that lets Everyone
  // in; folder names shortened): the same three folders, the Administrators
  // group's holding one file the Administrators group owns, which took the
  // folder's rights.
  const CAPTURED_MAIN = '{"user":"S-1-5-21-1234567890-1234567890-1234567890-1000","folders":[' +
    '{"dir":"C:\\\\t\\\\sys","error":"its owner is not this user","owner":null,"protected":false,"rules":[],"inside":null,"insideError":null},' +
    '{"dir":"C:\\\\t\\\\sys\\\\inside","error":"its parent was refused","owner":null,"protected":false,"rules":[],"inside":null,"insideError":null},' +
    '{"dir":"C:\\\\t\\\\ba","error":null,"owner":"S-1-5-21-1234567890-1234567890-1234567890-1000","protected":true,"rules":[' +
    '{"sid":"S-1-5-18","rights":2032127,"allow":true,"inherited":false,"flags":3},{"sid":"S-1-5-21-1234567890-1234567890-1234567890-1000","rights":2032127,"allow":true,"inherited":false,"flags":3}],' +
    '"inside":[{"name":"notes.json","link":false,"folder":false,"owner":"S-1-5-32-544","rules":[' +
    '{"sid":"S-1-5-18","rights":2032127,"allow":true,"inherited":true,"flags":0},{"sid":"S-1-5-21-1234567890-1234567890-1234567890-1000","rights":2032127,"allow":true,"inherited":true,"flags":0}]}],"insideError":null}]}'

  it('replays the real read under Constrained Language Mode: the folder SYSTEM owns is refused unwritten; the Administrators group\'s, this user\'s and a missing one are made owner-only', async () => {
    const m = machine({ user: CAPTURED_USER })
    m.add('C:\\t', { kind: 'dir' })
    const dirs = ['C:\\t\\sys', 'C:\\t\\ba', 'C:\\t\\mine', 'C:\\t\\missing']
    m.add(dirs[0], { kind: 'dir', owner: 'SY', dacl: CAPTURED_DACL })
    m.add(dirs[1], { kind: 'dir', owner: 'BA', dacl: CAPTURED_DACL })
    m.add(dirs[2], { kind: 'dir', owner: CAPTURED_USER, dacl: CAPTURED_DACL })
    let first = true
    const run = async (script: string, env: Record<string, string>) => {
      if (script === OWNER_ONLY_READ_SCRIPT && first) {
        first = false
        expect(env[OWNER_ONLY_DIRS_ENV].split('\n')).toEqual(dirs)
        return CAPTURED_READ
      }
      return m.run(script, env)
    }
    const out = await secureFoldersWindows(dirs, run, m.tools)
    expect(out.map((r) => [r.dir, r.ok, r.detail])).toEqual([
      [dirs[0], false, 'its owner is not this user'],
      [dirs[1], true, 'owner-only'],
      [dirs[2], true, 'owner-only'],
      [dirs[3], true, 'owner-only'],
    ])
    expect(icacls(m).map((c) => c.args[0])).not.toContain(dirs[0])
    expect(m.entries.get('c:\\t\\sys')).toMatchObject({ owner: 'SY', dacl: CAPTURED_DACL })
    expect(m.made).toEqual([dirs[3]])
  })

  it('replays the main script\'s real answer: the folder SYSTEM owns and the one inside it refused, the Administrators group\'s owner-only', async () => {
    const out = await secureFoldersWindows(['C:\\t\\sys', 'C:\\t\\sys\\inside', 'C:\\t\\ba'], async () => CAPTURED_MAIN)
    expect(out.map((r) => [r.ok, r.detail, r.unread])).toEqual([
      [false, 'its owner is not this user', undefined],
      [false, 'its parent was refused', undefined],
      [true, 'owner-only', undefined],
    ])
  })

  it('the owner an SDDL string names, as the verdict names accounts; none when it names none', () => {
    expect(ownerFromSddl(`O:${USER}G:${USER}${OWNER_ONLY_DACL(USER)}`, USER)).toBe(USER)
    expect(ownerFromSddl(`O:${USER}`, USER)).toBe(USER)
    expect(ownerFromSddl(`O:BAG:SY${OWNER_ONLY_DACL(USER)}`, USER)).toBe(OWNER_ONLY_ADMINISTRATORS_SID)
    expect(ownerFromSddl(`O:BAD:PAI(A;OICI;FA;;;SY)`, USER)).toBe(OWNER_ONLY_ADMINISTRATORS_SID)
    expect(ownerFromSddl('O:SYG:SYD:PAI', USER)).toBe(OWNER_ONLY_SYSTEM_SID)
    expect(ownerFromSddl('O:LAG:LAD:PAI', ADMIN_500)).toBe(ADMIN_500)
    expect(ownerFromSddl('O:LAG:LAD:PAI', USER)).toBe('LA')
    expect(ownerFromSddl('O:BUG:BUD:PAI', USER)).toBe('BU')
    for (const s of ['', 'nonsense', OWNER_ONLY_DACL(USER), `G:${USER}O:${USER}`, 'O:BAX', 'O:S-1-5', ` O:${USER}`]) expect(ownerFromSddl(s, USER), s).toBe('')
  })
})

describe('Windows PowerShell handed a module path it cannot load the read\'s cmdlets from', () => {
  // Captured from real Windows PowerShell 5.1 under Constrained Language Mode,
  // started (through node) by PowerShell 7, which leaves its own modules
  // first in the module path of what it starts; the folders, in order: one
  // already there, a junction, one missing. The read without its modules
  // loaded first gave each folder's Get-Acl failure inside that folder's own
  // try (the first answer); the read as it is stops at loading them
  // (PowerShell 7's Microsoft.PowerShell.Security, whose type data clashes
  // with Windows PowerShell's own), exit 1 and nothing printed (the second).
  const PER_FOLDER_FAILURE = '[{"error":true,"attributes":16,"missing":false,"sddl":null},{"error":true,"attributes":1040,"missing":false,"sddl":null},{"error":false,"attributes":null,"missing":true,"sddl":null}]'
  const AN_EXISTING_FOLDER_FAILED = '[{"error":true,"attributes":16,"missing":false,"sddl":null}]'
  const MODULES_FAILURE = [
    'Command failed',
    'Import-Module : The following error occurred while loading the extended type data file: Error in TypeData ',
    '"System.Security.AccessControl.ObjectSecurity": The member Sddl is already present.',
    '    + FullyQualifiedErrorId : FormatXmlUpdateException,Microsoft.PowerShell.Commands.ImportModuleCommand',
  ].join('\r\n')
  const DIRS = ['C:\\r\\existing', 'C:\\r\\link', 'C:\\r\\missing']
  const withThree = () => {
    const m = machine()
    m.add('C:\\r', { kind: 'dir' })
    m.add('C:\\r\\existing', { kind: 'dir', owner: OTHER, dacl: 'D:(A;;FA;;;WD)' })
    m.add('C:\\r\\link', { kind: 'link', owner: OTHER, dacl: 'D:(A;;FA;;;WD)' })
    return m
  }

  it('the read loads its cmdlets\' modules first, outside every folder\'s own try, so a module that cannot load stops the whole read', () => {
    const lines = OWNER_ONLY_READ_SCRIPT.split('\n')
    expect(lines[0]).toBe("$ErrorActionPreference = 'Stop'")
    const imports = lines.indexOf('Import-Module -Name Microsoft.PowerShell.Management, Microsoft.PowerShell.Security, Microsoft.PowerShell.Utility')
    expect(imports).toBe(1)
    expect(imports).toBeLessThan(lines.findIndex((l) => l.startsWith('foreach (')))
    expect(lines.slice(0, imports + 1).join('\n')).not.toMatch(/\btry\b/)
  })

  it('a read that stops at loading its modules is no read: nothing is made or written, and every folder says unread, never refused', async () => {
    const m = withThree()
    const run = async (script: string, env: Record<string, string>) => {
      if (script === OWNER_ONLY_READ_SCRIPT) throw Object.assign(new Error(MODULES_FAILURE), { code: 1, stdout: '' })
      return m.run(script, env)
    }
    const out = await secureFoldersWindows(DIRS, run, m.tools)
    expect(out.map((r) => [r.dir, r.ok, r.unread])).toEqual(DIRS.map((d) => [d, false, true]))
    expect(icacls(m)).toEqual([])
    expect(m.made).toEqual([])
    expect(m.entries.get('c:\\r\\existing')).toMatchObject({ owner: OTHER, dacl: 'D:(A;;FA;;;WD)' })
  })

  it('a read of each folder that failed is never a pass: the folder already there and the junction are refused unwritten, and a folder made beside them is refused at its read-back', async () => {
    const m = withThree()
    let n = 0
    const run = async (script: string, env: Record<string, string>) => {
      if (script !== OWNER_ONLY_READ_SCRIPT) return m.run(script, env)
      const dirs = env[OWNER_ONLY_DIRS_ENV].split('\n')
      if (++n === 1) { expect(dirs).toEqual(DIRS); return PER_FOLDER_FAILURE }
      expect(dirs).toEqual(['C:\\r\\missing'])
      return AN_EXISTING_FOLDER_FAILED
    }
    const out = await secureFoldersWindows(DIRS, run, m.tools)
    expect(out.map((r) => [r.ok, r.detail, r.unread])).toEqual([
      [false, 'it could not be read', undefined],
      [false, 'it could not be read', undefined],
      [false, 'its rights could not be read back', undefined],
    ])
    expect(icacls(m).map((c) => c.args[0])).toEqual(['C:\\r\\missing', 'C:\\r\\missing'])
    expect(m.entries.get('c:\\r\\existing')).toMatchObject({ owner: OTHER, dacl: 'D:(A;;FA;;;WD)' })
    expect(m.entries.get('c:\\r\\link')).toMatchObject({ owner: OTHER, dacl: 'D:(A;;FA;;;WD)' })
  })

  it('every Windows PowerShell call gets Windows PowerShell\'s own modules folder as its module path, whatever it inherited and in whatever spelling', () => {
    const root = process.env.SystemRoot
    const want = path.win32.join(typeof root === 'string' && /^[A-Za-z]:\\/.test(root) ? root : 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
    const inherited = {
      PSModulePath: 'C:\\Users\\person\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\Modules;c:\\program files\\powershell\\7\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules',
      PSMODULEPATH: 'C:\\x', psmodulepath: 'C:\\y', Path: 'C:\\bin', HOME: 'C:\\h',
    }
    const env = windowsPowerShellEnv(inherited, { [OWNER_ONLY_DIRS_ENV]: 'C:\\r\\a' })
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PSMODULEPATH')).toEqual(['PSModulePath'])
    expect(env.PSModulePath).toBe(want)
    expect(env).toMatchObject({ Path: 'C:\\bin', HOME: 'C:\\h', [OWNER_ONLY_DIRS_ENV]: 'C:\\r\\a' })
    // Nothing a call adds can hand it another one either.
    expect(windowsPowerShellEnv({}, { psModulePath: 'C:\\x' })).toEqual({ PSModulePath: want })
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

// What is already inside a folder the rule makes owner-only in place, with
// Windows' own programs: read (each folder in its own read, the folders of the
// call left to their own turn), an entry this user or the Administrators group
// owns that lets anyone else in reset on the entry itself and read again, and
// the folder passed only when what is inside then reads back owner-only.
describe('what is inside a folder made owner-only in place, with Windows\' own programs', () => {
  const HOME = 'C:\\r\\home'
  const resets = (m: ReturnType<typeof machine>) => icacls(m).filter((c) => c.args[1] === '/reset').map((c) => c.args)
  /** A profile home the Administrators group owns, every file inheriting another group's read. */
  const adminOwnedHome = (m: ReturnType<typeof machine>) => {
    const kept = `D:AI(A;ID;0x1200a9;;;${OTHER_GROUP})(A;ID;FA;;;${USER})(A;ID;FA;;;BA)(A;ID;FA;;;SY)`
    m.add('C:\\r', { kind: 'dir' })
    m.add(HOME, { kind: 'dir', dacl: kept })
    m.add(`${HOME}\\.claude.json`, { kind: 'file', dacl: kept })
    m.add(`${HOME}\\.claude`, { kind: 'dir', dacl: kept })
    m.add(`${HOME}\\.claude\\.credentials.json`, { kind: 'file', dacl: kept })
    m.add(`${HOME}\\.claude\\todos`, { kind: 'dir', dacl: kept })
    m.add(`${HOME}\\.claude\\todos\\t1.json`, { kind: 'file', dacl: kept })
    m.add(`${HOME}\\identity`, { kind: 'dir', dacl: kept })
    m.add(`${HOME}\\identity\\.credentials.json`, { kind: 'file', dacl: kept })
    return [HOME, `${HOME}\\.claude`, `${HOME}\\identity`]
  }

  it('a profile home the Administrators group owns: every file the Administrators group owns takes the folder\'s rights with the rights alone written, and all three folders pass', async () => {
    const m = machine()
    const dirs = adminOwnedHome(m)
    const out = await secureFoldersWindows(dirs, m.run, m.tools)
    expect(out.map((r) => [r.ok, r.detail])).toEqual(dirs.map(() => [true, 'owner-only']))
    for (const f of ['.claude.json', '.claude\\.credentials.json', '.claude\\todos\\t1.json', 'identity\\.credentials.json']) {
      expect(m.entries.get(`${HOME}\\${f}`.toLowerCase()), f).toMatchObject({ owner: OWNER_ONLY_ADMINISTRATORS_SID, dacl: INHERITED_DACL(USER) })
    }
    expect(resets(m)).toEqual([])
    // One read of what is inside per folder set, each told the folders of the whole call and the user.
    expect(m.insideReads).toEqual(dirs.map((dir) => ({ dir, skip: dirs, user: USER })))
  })

  it('an entry with an entry of its own for another account is reset on the entry itself (/L) and read again; then the folder passes', async () => {
    const m = machine()
    const dirs = adminOwnedHome(m)
    m.entries.get(`${HOME}\\.claude\\.credentials.json`.toLowerCase())!.dacl = `D:AI(A;;FR;;;${OTHER_GROUP})(A;ID;FA;;;${USER})(A;ID;FA;;;SY)`
    m.entries.get(`${HOME}\\identity\\.credentials.json`.toLowerCase())!.dacl = `D:PAI(A;;FA;;;${USER})(A;;FR;;;BU)`
    m.entries.get(`${HOME}\\.claude\\todos\\t1.json`.toLowerCase())!.dacl = `D:AI(A;;FR;;;WD)(A;ID;FA;;;${USER})`
    const out = await secureFoldersWindows(dirs, m.run, m.tools)
    expect(out.map((r) => [r.ok, r.detail])).toEqual(dirs.map(() => [true, 'owner-only']))
    expect(resets(m)).toEqual([
      [`${HOME}\\.claude\\.credentials.json`, '/reset', '/L', '/Q'],
      [`${HOME}\\.claude\\todos\\t1.json`, '/reset', '/L', '/Q'],
      [`${HOME}\\identity\\.credentials.json`, '/reset', '/L', '/Q'],
    ])
    for (const f of ['.claude\\.credentials.json', '.claude\\todos\\t1.json', 'identity\\.credentials.json']) expect(m.entries.get(`${HOME}\\${f}`.toLowerCase())!.dacl, f).toBe(INHERITED_DACL(USER))
    // Read again where something was reset.
    expect(m.insideReads.map((r) => r.dir)).toEqual([HOME, dirs[1], dirs[1], dirs[2], dirs[2]])
  })

  it('a reset that does not take, or one that answers a failure, refuses the folder; one that did not start or finish leaves it unread', async () => {
    const cases: Array<[string, (m: ReturnType<typeof machine>) => void, [boolean, string, true | undefined]]> = [
      ['does not take', (m) => { m.state.resetTakes = false }, [false, 'an entry inside it is not owner-only', undefined]],
      ['a failure', (m) => { m.state.resetCode = 5 }, [false, 'what is inside it could not be made owner-only', undefined]],
      ['no answer', (m) => { m.state.resetCode = null }, [false, 'an entry inside it could not be reset: the program did not start or finish', true]],
    ]
    for (const [name, arrange, want] of cases) {
      const m = machine()
      const dirs = adminOwnedHome(m)
      m.entries.get(`${HOME}\\.claude\\.credentials.json`.toLowerCase())!.dacl = `D:AI(A;;FR;;;${OTHER_GROUP})(A;ID;FA;;;${USER})`
      arrange(m)
      const out = await secureFoldersWindows(dirs, m.run, m.tools)
      expect(out.map((r) => [r.ok, r.detail, r.unread]), name).toEqual([[true, 'owner-only', undefined], want, [true, 'owner-only', undefined]])
    }
  })

  it('an entry another account owns refuses the folder: it is not reset, and nothing below it is read', async () => {
    const m = machine()
    const dirs = adminOwnedHome(m)
    m.entries.get(`${HOME}\\.claude\\todos`.toLowerCase())!.owner = OTHER
    m.entries.get(`${HOME}\\.claude\\todos\\t1.json`.toLowerCase())!.dacl = `D:AI(A;;FR;;;WD)(A;ID;FA;;;${USER})`
    const out = await secureFoldersWindows(dirs, m.run, m.tools)
    expect(out.map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only'], [false, "an entry inside it is another account's"], [true, 'owner-only']])
    expect(resets(m)).toEqual([])
    expect(m.entries.get(`${HOME}\\.claude\\todos\\t1.json`.toLowerCase())!.dacl).toBe(`D:AI(A;;FR;;;WD)(A;ID;FA;;;${USER})`)
  })

  it('a link to a file inside refuses the folder; a link to a folder is neither judged nor gone into', async () => {
    const m = machine()
    const dirs = adminOwnedHome(m)
    m.add('C:\\shared', { kind: 'dir' })
    m.add(`${HOME}\\.claude\\projects`, { kind: 'link', owner: OTHER, dacl: 'D:(A;;FA;;;WD)' })
    m.add(`${HOME}\\.claude\\projects\\p.jsonl`, { kind: 'file', owner: OTHER, dacl: 'D:(A;;FA;;;WD)' })
    m.add(`${HOME}\\.ssh`, { kind: 'link', owner: OTHER, dacl: 'D:(A;;FA;;;WD)' })
    let out = await secureFoldersWindows(dirs, m.run, m.tools)
    expect(out.map((r) => [r.ok, r.detail])).toEqual(dirs.map(() => [true, 'owner-only']))
    expect(resets(m)).toEqual([])
    expect(m.entries.get(`${HOME}\\.claude\\projects\\p.jsonl`.toLowerCase())).toMatchObject({ owner: OTHER, dacl: 'D:(A;;FA;;;WD)' })
    const n = machine()
    adminOwnedHome(n)
    n.entries.delete(`${HOME}\\identity\\.credentials.json`.toLowerCase())
    n.add(`${HOME}\\identity\\.credentials.json`, { kind: 'filelink', owner: OTHER, dacl: 'D:(A;;FA;;;WD)' })
    out = await secureFoldersWindows(dirs, n.run, n.tools)
    expect(out.map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only'], [true, 'owner-only'], [false, 'a link to a file is inside it']])
  })

  it('a read of what is inside that gives no answer leaves the folder unread; one that failed refuses it', async () => {
    const m = machine()
    const dirs = adminOwnedHome(m)
    m.state.insideFails = true
    expect((await secureFoldersWindows(dirs, m.run, m.tools)).map((r) => [r.ok, r.unread])).toEqual(dirs.map(() => [false, true]))
    const n = machine()
    adminOwnedHome(n)
    n.state.insideErrors.add(dirs[1].toLowerCase())
    expect((await secureFoldersWindows(dirs, n.run, n.tools)).map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only'], [false, 'what is inside it was not read'], [true, 'owner-only']])
  })

  it('an entry whose path is past Windows\' 260-character limit is reset by its \\\\?\\ name', async () => {
    const m = machine()
    const dirs = adminOwnedHome(m)
    const deep = `${HOME}\\.claude\\todos\\${'d'.repeat(120)}`
    m.add(deep, { kind: 'dir' })
    m.add(`${deep}\\${'f'.repeat(120)}.json`, { kind: 'file', dacl: `D:AI(A;;FR;;;WD)(A;ID;FA;;;${USER})` })
    const out = await secureFoldersWindows(dirs, m.run, m.tools)
    expect(out.map((r) => r.ok)).toEqual([true, true, true])
    expect(resets(m)).toEqual([[`\\\\?\\${deep}\\${'f'.repeat(120)}.json`, '/reset', '/L', '/Q']])
  })
})
