import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// NOTE: 'fs' and 'node:fs' resolve to the SAME module under vitest, so the
// fixture writes below DO go through the mock. An earlier version of this comment
// claimed otherwise and the retry assertion silently counted a fixture write —
// it passed with zero retries. The recorded calls are filtered to staging paths
// instead, which is the thing actually under test.
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Staging a file next to its destination and renaming it over is only safe if
// the staging file is CREATED. Opening whatever already sits at that path means
// a link planted there redirects the write, and means the mode argument — which
// open(2) honours only on creation — silently does not apply.
//
// The assertions are deliberately split:
//   - "was it opened exclusively" is mockable and runs EVERYWHERE, including the
//     Windows CI leg;
//   - "did the bytes land at 0600" needs a real POSIX filesystem.
// A guard that only runs on one leg of the matrix is a guard that is usually off.

const h = vi.hoisted(() => ({
  writeCalls: [] as Array<{ path: string; opts: unknown }>,
  renameFrom: [] as string[],
  /** errno writeFileSync should throw on every call, or null. */
  writeFail: null as string | null,
  /** errno renameSync should throw on every call, or null. */
  renameFail: null as string | null
}))

function errnoOf(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException
  err.code = code
  return err
}

vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<any>()
  const real = mod.default ?? mod
  const patched = {
    ...real,
    writeFileSync: (p: any, d: any, o: any) => {
      h.writeCalls.push({ path: String(p), opts: o })
      if (h.writeFail) throw errnoOf(h.writeFail)
      return real.writeFileSync(p, d, o)
    },
    renameSync: (from: any, to: any) => {
      h.renameFrom.push(String(from))
      if (h.renameFail) throw errnoOf(h.renameFail)
      return real.renameSync(from, to)
    }
  }
  return { ...patched, default: patched }
})

import { atomicWriteSecure } from '../../src/main/account-profiles'

let dir = ''
let target = ''

function stagingFiles(): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.tmp'))
}
function reset(): void {
  h.writeCalls = []
  h.renameFrom = []
  h.writeFail = null
  h.renameFail = null
}

describe('atomicWriteSecure', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secure-staging-'))
    target = join(dir, '.credentials.json')
    reset()
  })
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('writes the payload and leaves no staging file', () => {
    atomicWriteSecure(target, '{"token":"x"}')
    expect(readFileSync(target, 'utf-8')).toBe('{"token":"x"}')
    expect(stagingFiles()).toEqual([])
  })

  it('replaces existing content', () => {
    writeFileSync(target, 'old')
    atomicWriteSecure(target, 'new')
    expect(readFileSync(target, 'utf-8')).toBe('new')
  })

  // The core guarantee. Runs on every platform, including Windows CI.
  it('creates the staging file exclusively, so an existing path is never opened', () => {
    atomicWriteSecure(target, 'data', 0o600)

    expect(h.writeCalls).toHaveLength(1)
    expect(h.writeCalls[0].opts).toMatchObject({ flag: 'wx', mode: 0o600 })
  })

  it('passes the exclusive flag even when no mode is requested', () => {
    atomicWriteSecure(target, 'data')
    expect(h.writeCalls[0].opts).toMatchObject({ flag: 'wx' })
  })

  it('refuses to write through anything already sitting at the staging path', () => {
    writeFileSync(target, 'untouched')
    h.writeFail = 'EEXIST' // every drawn name collides, as a pre-planted path would

    expect(() => atomicWriteSecure(target, 'attacker-redirected')).toThrow(/EEXIST/)

    // Retried with FRESH names rather than reusing one, then gave up. Count only
    // STAGING writes: the fixture write above goes through the same mock, and
    // counting it made this pass with zero retries.
    const staged = h.writeCalls.filter((c) => c.path.endsWith('.tmp'))
    expect(staged.length).toBeGreaterThan(1)
    expect(new Set(staged.map((c) => c.path)).size).toBe(staged.length)
    expect(h.renameFrom).toEqual([]) // never reached the rename
    expect(readFileSync(target, 'utf-8')).toBe('untouched')
  })

  it('draws an unpredictable staging name, never one derived from the pid', () => {
    atomicWriteSecure(target, 'a')
    atomicWriteSecure(target, 'b')

    const names = h.writeCalls.map((c) => c.path)
    expect(new Set(names).size).toBe(2)
    for (const n of names) {
      expect(n).not.toBe(`${target}.tmp`)
      expect(n).not.toBe(`${target}.tmp.${process.pid}`)
      expect(n).not.toContain(`.${process.pid}.`)
    }
  })

  it('leaves the target intact and cleans up when the rename fails', () => {
    writeFileSync(target, 'original')
    h.renameFail = 'EPERM'

    expect(() => atomicWriteSecure(target, 'replacement')).toThrow(/EPERM/)

    expect(readFileSync(target, 'utf-8')).toBe('original')
    expect(stagingFiles()).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('lands 0600 even when a loose-moded file already occupies the target', () => {
    writeFileSync(target, 'old', { mode: 0o666 })
    atomicWriteSecure(target, 'new', 0o600)
    // The staged inode carries the mode and the rename replaces the loose one,
    // rather than writing into it and inheriting 0666.
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it.runIf(process.platform !== 'win32')('O_EXCL is what rejects a planted symlink, and the plain write does not', () => {
    // Exercise the primitive directly: the staging name is unguessable by design,
    // so this asserts the property that makes planting useless rather than trying
    // to guess a name.
    const sink = join(dir, 'sink')
    const staged = join(dir, 'planted.tmp')
    writeFileSync(sink, 'SINK-ORIGINAL')
    symlinkSync(sink, staged)

    expect(() => writeFileSync(staged, 'REDIRECTED', { flag: 'wx', mode: 0o600 })).toThrow(/EEXIST/)
    expect(readFileSync(sink, 'utf-8')).toBe('SINK-ORIGINAL')

    // The unguarded form this replaced follows the link.
    writeFileSync(staged, 'REDIRECTED')
    expect(readFileSync(sink, 'utf-8')).toBe('REDIRECTED')
  })
})
