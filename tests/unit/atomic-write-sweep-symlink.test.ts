import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'path'

// The stale-staging sweep unlinks files. Anything it unlinks must be a file WE
// left behind, and we only ever create staging files with O_EXCL — so a
// staging-shaped entry that is a SYMLINK was put there by someone else.
// Resolving it would turn a tidy-up into "unlink whatever that points at",
// which is an arbitrary-delete primitive handed to anyone who can write to the
// directory. Verified by mock rather than by creating a real symlink, so it runs
// on the Windows CI leg too (creating one there needs privileges the runner and
// this box lack).

const h = vi.hoisted(() => ({
  entries: [] as string[],
  /** entry name -> lstat result */
  stats: {} as Record<string, { isSymbolicLink: boolean; mtimeMs: number }>,
  unlinked: [] as string[],
  lstatted: [] as string[],
  statted: [] as string[]
}))

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const patched = {
    ...real,
    readdirSync: (p: any, o?: any) => (String(p).includes('sweep-fixture') ? h.entries : real.readdirSync(p, o)),
    lstatSync: (p: any) => {
      const name = String(p).split(/[\\/]/).pop()!
      h.lstatted.push(name)
      const s = h.stats[name]
      if (!s) return real.lstatSync(p)
      return { isSymbolicLink: () => s.isSymbolicLink, mtimeMs: s.mtimeMs } as any
    },
    statSync: (p: any) => {
      const name = String(p).split(/[\\/]/).pop()!
      h.statted.push(name)
      const s = h.stats[name]
      if (!s) return real.statSync(p)
      return { isSymbolicLink: () => s.isSymbolicLink, mtimeMs: s.mtimeMs } as any
    },
    unlinkSync: (p: any) => {
      const name = String(p).split(/[\\/]/).pop()!
      if (h.stats[name]) { h.unlinked.push(name); return }
      return real.unlinkSync(p)
    },
    writeFileSync: () => {},
    renameSync: () => {}
  }
  return { ...patched, default: patched }
})

const UUID = '11111111-2222-3333-4444-555555555555'
const LINK = `victim.json.${UUID}.tmp`
const REAL = `victim.json.99999999-2222-3333-4444-555555555555.tmp`
const ANCIENT = 0 // epoch: comfortably past the one-hour age gate

describe('the sweep never resolves a link', () => {
  beforeEach(() => {
    vi.resetModules()
    h.entries = [LINK, REAL]
    h.stats = {
      [LINK]: { isSymbolicLink: true, mtimeMs: ANCIENT },
      [REAL]: { isSymbolicLink: false, mtimeMs: ANCIENT }
    }
    h.unlinked = []
    h.lstatted = []
    h.statted = []
  })

  // Each test uses a DISTINCT fixture dir (both still match the readdir mock's
  // `includes('sweep-fixture')`). The sweep memoises per (dir, basename) at module
  // scope, and vi.resetModules() does not reliably hand back a fresh module here
  // under parallel/cold runs -- a shared instance whose memo already held the dir
  // would skip the sweep and leave h.lstatted empty. A unique dir per test makes
  // the memo key fresh regardless, so the sweep always runs.
  it('skips a staging-shaped symlink and still reclaims the real orphan', async () => {
    const { atomicWriteFileSync } = await import('../../src/main/atomic-write')

    atomicWriteFileSync(join('sweep-fixture-1', 'victim.json'), '{}')

    expect(h.unlinked).toContain(REAL)
    expect(h.unlinked).not.toContain(LINK)
  })

  it('inspects entries with lstat, never stat', async () => {
    const { atomicWriteFileSync } = await import('../../src/main/atomic-write')

    atomicWriteFileSync(join('sweep-fixture-2', 'victim.json'), '{}')

    // stat() follows a link, so reaching for it at all reopens the hole even if
    // an isSymbolicLink() check happens to sit next to it.
    expect(h.lstatted).toEqual(expect.arrayContaining([LINK, REAL]))
    expect(h.statted).toEqual([])
  })
})
