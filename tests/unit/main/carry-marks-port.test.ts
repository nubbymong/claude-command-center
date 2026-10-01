// The file the carried-conversation marks are kept in (P3.14 round 1; ADR-023):
// `<resources>/providers/carry-marks.json`, next to the account registry and
// never in an account's folder. PURE: every call goes to an injected file
// system and writer; no disk is touched.
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { createCarryMarksFilePort, CARRY_MARKS_FILENAME } from '../../../src/main/carry-marks-port'
import type { CarryMarksFileDeps } from '../../../src/main/carry-marks-port'

const DIR = path.join(path.sep === '\\' ? 'C:\\data\\res' : '/data/res', 'providers')
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

function port(over: Partial<CarryMarksFileDeps> & { files?: Record<string, string>; dirs?: string[] } = {}) {
  const files = over.files ?? {}
  const dirs = new Set(over.dirs ?? [path.dirname(DIR)])
  const calls: string[] = []
  const deps: CarryMarksFileDeps = {
    directory: () => DIR,
    mkdirSecure: (d) => { calls.push(`mkdirSecure ${d}`) },
    atomicWrite: (f, data, options) => { calls.push(`atomicWrite ${f} ${JSON.stringify(options ?? null)}`); files[f] = data },
    posix: false,
    fs: {
      readFileSync: ((f: string) => { if (f in files) return files[f]; throw enoent() }) as never,
      statSync: ((d: string) => { if (dirs.has(d)) return { isDirectory: () => true }; throw enoent() }) as never,
    },
    ...over,
  }
  return { p: createCarryMarksFilePort(deps), files, calls }
}

const FILE = path.join(DIR, CARRY_MARKS_FILENAME)

describe('the carry marks file (ADR-023)', () => {
  it('is carry-marks.json in the providers folder, next to the registry', () => {
    expect(CARRY_MARKS_FILENAME).toBe('carry-marks.json')
    expect(FILE).toBe(path.join(DIR, 'carry-marks.json'))
  })

  it('reads the text a write left, and writes through the folder\'s secure make and the one atomic write', () => {
    const { p, calls, files } = port()
    expect(p.read()).toEqual({ kind: 'missing' })
    p.write('{"schema":1,"marks":[]}')
    expect(files[FILE]).toBe('{"schema":1,"marks":[]}')
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
  })

  it('a missing file is absence only when the folder above it is there: an unmounted drive says ENOENT for everything', () => {
    expect(port({ dirs: [] }).p.read()).toEqual({ kind: 'unavailable' })
    expect(port({ dirs: [path.dirname(DIR)] }).p.read()).toEqual({ kind: 'missing' })
    // The folder above is not a folder (a file, a mount point gone): not absence either.
    const notAFolder = port({ fs: { readFileSync: (() => { throw enoent() }) as never, statSync: (() => ({ isDirectory: () => false })) as never } })
    expect(notAFolder.p.read()).toEqual({ kind: 'unavailable' })
  })

  it('any other read error is "not now", never absence', () => {
    const { p } = port({ fs: { readFileSync: (() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }) as never, statSync: (() => ({ isDirectory: () => true })) as never } })
    expect(p.read()).toEqual({ kind: 'unavailable' })
    const odd = port({ fs: { readFileSync: (() => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }) as never, statSync: (() => { throw new Error('stat') }) as never } })
    expect(odd.p.read()).toEqual({ kind: 'unavailable' })
  })

  it('a write that fails throws, for the marks to keep what it has in memory', () => {
    const { p } = port({ atomicWrite: () => { throw new Error('disk full') } })
    expect(() => p.write('x')).toThrow('disk full')
  })
})

// The composition root hands the package this file's port; without it the
// marks live only until the app quits, and a carried conversation would show
// the earlier account's figures again after a restart.
describe('the composition root', () => {
  it('gives the Codex package the marks file next to the registry', async () => {
    const { readFileSync } = await import('node:fs')
    const compose = readFileSync(path.join(__dirname, '../../../src/main/providers/compose.ts'), 'utf-8')
    expect(compose).toMatch(/createCarryMarksFilePort\(\{/)
    expect(compose).toMatch(/path\.join\(resources, REGISTRY_DIRNAME\)/)
    expect(compose).toMatch(/createCodexPackage\(\{[^\n]*carryMarksPort[^\n]*\}\)/)
  })
})
