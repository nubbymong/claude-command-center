// The file the carried-conversation marks are kept in (P3.14 rounds 1 and 2;
// ADR-023): `<resources>/providers/carry-marks.json`, next to the account
// registry and never in an account's folder. PURE: every call goes to an
// injected file system and writer; no disk is touched.
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { createCarryMarksFilePort, CARRY_MARKS_FILENAME, CARRY_MARKS_MAX_BYTES, CARRY_MARKS_ASIDE_KEPT } from '../../../src/main/carry-marks-port'
import type { CarryMarksFileDeps } from '../../../src/main/carry-marks-port'

const DIR = path.join(path.sep === '\\' ? 'C:\\data\\res' : '/data/res', 'providers')
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

type Entry = { kind: 'file' | 'dir' | 'link'; text?: string; size?: number }

/** A folder with named entries, every call logged. */
function port(over: Partial<CarryMarksFileDeps> & { entries?: Record<string, Entry>; dirs?: string[]; at?: number } = {}) {
  const entries: Record<string, Entry> = over.entries ?? {}
  const dirs = new Set(over.dirs ?? [path.dirname(DIR), DIR])
  const calls: string[] = []
  const stat = (e: Entry) => ({ isFile: () => e.kind === 'file', isDirectory: () => e.kind === 'dir', isSymbolicLink: () => e.kind === 'link', size: e.size ?? (e.text ?? '').length })
  const deps: CarryMarksFileDeps = {
    directory: () => DIR,
    mkdirSecure: (d) => { calls.push(`mkdirSecure ${d}`) },
    atomicWrite: (f, data, options) => { calls.push(`atomicWrite ${f} ${JSON.stringify(options ?? null)}`); entries[f] = { kind: 'file', text: data } },
    posix: false,
    now: () => over.at ?? 1_000_000,
    fs: {
      readFileSync: ((f: string) => { const e = entries[f]; if (e && e.kind === 'file') return e.text ?? ''; throw enoent() }) as never,
      statSync: ((d: string) => { if (dirs.has(d)) return { isDirectory: () => true }; throw enoent() }) as never,
      lstatSync: ((f: string) => { const e = entries[f]; if (e) return stat(e); throw enoent() }) as never,
      renameSync: ((from: string, to: string) => { calls.push(`rename ${path.basename(from)} ${path.basename(to)}`); const e = entries[from]; if (!e) throw enoent(); delete entries[from]; entries[to] = e }) as never,
      readdirSync: ((d: string) => Object.keys(entries).filter((k) => path.dirname(k) === d).map((k) => path.basename(k))) as never,
      unlinkSync: ((f: string) => { calls.push(`unlink ${path.basename(f)}`); if (!entries[f]) throw enoent(); delete entries[f] }) as never,
    },
    ...over,
  }
  return { p: createCarryMarksFilePort(deps), entries, calls }
}

const FILE = path.join(DIR, CARRY_MARKS_FILENAME)
const at = (n: number) => path.join(DIR, `${CARRY_MARKS_FILENAME}.bad-${n}`)

describe('the carry marks file (ADR-023)', () => {
  it('is carry-marks.json in the providers folder, next to the registry', () => {
    expect(CARRY_MARKS_FILENAME).toBe('carry-marks.json')
    expect(FILE).toBe(path.join(DIR, 'carry-marks.json'))
  })

  it('reads the text a write left, and writes through the folder\'s secure make and the one atomic write', () => {
    const { p, calls, entries } = port()
    expect(p.read()).toEqual({ kind: 'missing' })
    p.write('{"schema":1,"marks":[]}')
    expect(entries[FILE]).toEqual({ kind: 'file', text: '{"schema":1,"marks":[]}' })
    expect(calls).toEqual([`mkdirSecure ${DIR}`, `atomicWrite ${FILE} null`])
    expect(p.read()).toEqual({ kind: 'ok', text: '{"schema":1,"marks":[]}' })
  })

  it('is owner-only where there are modes', () => {
    const { p, calls } = port({ posix: true })
    p.write('x')
    expect(calls[1]).toBe(`atomicWrite ${FILE} {"mode":384}`)
  })

  it('cannot be read, nor written, before the resources folder is known', () => {
    const { p } = port({ directory: () => null })
    expect(p.read()).toEqual({ kind: 'unavailable' })
    expect(() => p.write('x')).toThrow(/not known yet/)
    expect(p.setAside()).toBe(false)
  })

  it('a missing file is absence only when the folder above it is there: an unmounted drive says ENOENT for everything', () => {
    expect(port({ dirs: [] }).p.read()).toEqual({ kind: 'unavailable' })
    expect(port({ dirs: [path.dirname(DIR)] }).p.read()).toEqual({ kind: 'missing' })
    // The folder above is not a folder (a file, a mount point gone): not absence either.
    const notAFolder = port({ fs: { ...port().p && {}, readFileSync: (() => { throw enoent() }) as never, statSync: (() => ({ isDirectory: () => false })) as never, lstatSync: (() => { throw enoent() }) as never, renameSync: (() => {}) as never, readdirSync: (() => []) as never, unlinkSync: (() => {}) as never } })
    expect(notAFolder.p.read()).toEqual({ kind: 'unavailable' })
  })

  it('any other look or read error is "not now", never absence', () => {
    const noRead = { statSync: (() => ({ isDirectory: () => true })) as never, renameSync: (() => {}) as never, readdirSync: (() => []) as never, unlinkSync: (() => {}) as never }
    const eacces = () => Object.assign(new Error('EACCES'), { code: 'EACCES' })
    expect(port({ fs: { ...noRead, readFileSync: (() => '') as never, lstatSync: (() => { throw eacces() }) as never } }).p.read()).toEqual({ kind: 'unavailable' })
    expect(port({ fs: { ...noRead, readFileSync: (() => { throw eacces() }) as never, lstatSync: (() => ({ isFile: () => true, size: 3 })) as never } }).p.read()).toEqual({ kind: 'unavailable' })
    const odd = port({ fs: { ...noRead, readFileSync: (() => '') as never, lstatSync: (() => { throw enoent() }) as never, statSync: (() => { throw new Error('stat') }) as never } })
    expect(odd.p.read()).toEqual({ kind: 'unavailable' })
  })

  it('a write that fails throws, for the marks to keep what they have in memory', () => {
    const { p } = port({ atomicWrite: () => { throw new Error('disk full') } })
    expect(() => p.write('x')).toThrow('disk full')
  })

  describe('looks before it reads (round 2)', () => {
    it('a link, a folder or any other thing in its place is corrupt, and is never read', () => {
      for (const kind of ['dir', 'link'] as const) {
        const { p } = port({ entries: { [FILE]: { kind, text: '{"schema":1,"marks":[]}' } } })
        expect(p.read(), kind).toEqual({ kind: 'corrupt' })
      }
    })

    it('a file over the cap is corrupt, and one at it is read; the size is asked before the text', () => {
      let reads = 0
      const over = port({ entries: { [FILE]: { kind: 'file', text: 'x', size: CARRY_MARKS_MAX_BYTES + 1 } } })
      const counting = port({ entries: { [FILE]: { kind: 'file', text: 'x', size: CARRY_MARKS_MAX_BYTES + 1 } }, fs: { ...over.p && {}, readFileSync: (() => { reads++; return 'x' }) as never, statSync: (() => ({ isDirectory: () => true })) as never, lstatSync: (() => ({ isFile: () => true, size: CARRY_MARKS_MAX_BYTES + 1 })) as never, renameSync: (() => {}) as never, readdirSync: (() => []) as never, unlinkSync: (() => {}) as never } })
      expect(over.p.read()).toEqual({ kind: 'corrupt' })
      expect(counting.p.read()).toEqual({ kind: 'corrupt' })
      expect(reads).toBe(0)
      expect(port({ entries: { [FILE]: { kind: 'file', text: 'x', size: CARRY_MARKS_MAX_BYTES } } }).p.read()).toEqual({ kind: 'ok', text: 'x' })
    })
  })

  describe('sets a file aside (round 2)', () => {
    it('renames it by the time, never overwriting or deleting it, and it is gone from its place', () => {
      const { p, calls, entries } = port({ entries: { [FILE]: { kind: 'file', text: 'junk' } }, at: 4242 })
      expect(p.setAside()).toBe(true)
      expect(calls).toEqual(['rename carry-marks.json carry-marks.json.bad-4242'])
      expect(entries[FILE]).toBeUndefined()
      expect(entries[at(4242)]).toEqual({ kind: 'file', text: 'junk' })
      expect(p.read()).toEqual({ kind: 'missing' })
    })

    it('keeps only the newest few of the copies it has set aside, and touches no other name', () => {
      const entries: Record<string, Entry> = {
        [FILE]: { kind: 'file', text: 'junk' },
        [at(10)]: { kind: 'file', text: 'a' }, [at(20)]: { kind: 'file', text: 'b' }, [at(30)]: { kind: 'file', text: 'c' },
        [path.join(DIR, 'registry.json')]: { kind: 'file', text: 'registry' },
        [path.join(DIR, 'carry-marks.json.bad-x')]: { kind: 'file', text: 'other' },
        [path.join(DIR, 'carry-marks.json.keep')]: { kind: 'file', text: 'other' },
      }
      const { p } = port({ entries, at: 40 })
      expect(p.setAside()).toBe(true)
      const bad = Object.keys(entries).map((k) => path.basename(k)).filter((n) => /^carry-marks\.json\.bad-\d+$/.test(n)).sort()
      expect(bad).toEqual(['carry-marks.json.bad-20', 'carry-marks.json.bad-30', 'carry-marks.json.bad-40'].slice(0, CARRY_MARKS_ASIDE_KEPT))
      expect(entries[path.join(DIR, 'registry.json')]).toBeDefined()
      expect(entries[path.join(DIR, 'carry-marks.json.bad-x')]).toBeDefined()
      expect(entries[path.join(DIR, 'carry-marks.json.keep')]).toBeDefined()
    })

    it('a file already gone is what was asked for; any other failure to rename is not', () => {
      expect(port().p.setAside()).toBe(true)
      const eperm = () => Object.assign(new Error('EPERM'), { code: 'EPERM' })
      const noWay = port({ entries: { [FILE]: { kind: 'file', text: 'junk' } }, fs: { readFileSync: (() => '') as never, statSync: (() => ({ isDirectory: () => true })) as never, lstatSync: (() => ({ isFile: () => true, size: 4 })) as never, renameSync: (() => { throw eperm() }) as never, readdirSync: (() => []) as never, unlinkSync: (() => {}) as never } })
      expect(noWay.p.setAside()).toBe(false)
    })

    it('a folder that cannot be listed, or a copy that cannot be removed, never fails the set-aside', () => {
      const fsOf = (over: Record<string, unknown>) => ({ readFileSync: (() => '') as never, statSync: (() => ({ isDirectory: () => true })) as never, lstatSync: (() => ({ isFile: () => true, size: 4 })) as never, renameSync: (() => {}) as never, readdirSync: (() => []) as never, unlinkSync: (() => {}) as never, ...over })
      expect(port({ fs: fsOf({ readdirSync: () => { throw new Error('list') } }) }).p.setAside()).toBe(true)
      // One copy that cannot be removed does not stop the others being removed.
      const names = [1, 2, 3, 4, 5, 6].map((n) => `${CARRY_MARKS_FILENAME}.bad-${n}`)
      const tried: string[] = []
      const stuck = port({ fs: fsOf({ readdirSync: () => names, unlinkSync: (f: string) => { tried.push(path.basename(f)); if (f.endsWith('bad-3')) throw new Error('busy') } }) })
      expect(stuck.p.setAside()).toBe(true)
      expect(tried.sort()).toEqual(['carry-marks.json.bad-1', 'carry-marks.json.bad-2', 'carry-marks.json.bad-3'])
    })
  })
})

// The composition root hands the package this file's port; without it the
// marks live only until the app quits, and a carried conversation would show
// the earlier account's figures again after a restart.
describe('the composition root', () => {
  it('gives the provider package that keeps conversations the marks file next to the registry', async () => {
    const { readFileSync } = await import('node:fs')
    const compose = readFileSync(path.join(__dirname, '../../../src/main/providers/compose.ts'), 'utf-8')
    expect(compose).toMatch(/createCarryMarksFilePort\(\{/)
    expect(compose).toMatch(/path\.join\(resources, REGISTRY_DIRNAME\)/)
    expect(compose).toMatch(/create\w+Package\(\{[^\n]*carryMarksPort[^\n]*\}\)/)
  })
})
