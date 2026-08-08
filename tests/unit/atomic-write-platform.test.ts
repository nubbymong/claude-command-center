import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

// Two things the shared atomic write got wrong once and must not get wrong again:
//
//  1. The retry rule was gated on `process.platform === 'win32'` evaluated at
//     module load, so whichever CI leg you were on silently decided which half
//     of it was tested — and the macOS leg went red because the rule was too
//     blunt. It is a pure function taking `platform` now, so both branches are
//     asserted on every runner.
//  2. The stale-staging sweep memoised per DIRECTORY but filtered per FILENAME,
//     so the first file written to a directory marked the whole directory swept
//     and every other name's orphans survived forever. That is most of them in
//     ~/.claude and CONFIG, and for the credential writers each orphan is a
//     token blob — the exact thing the sweep exists to clear.

import { isTransientRenameError, atomicWriteFileSync } from '../../src/main/atomic-write'

describe('isTransientRenameError', () => {
  it('treats EBUSY as transient on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(isTransientRenameError('EBUSY', platform), platform).toBe(true)
    }
  })

  it('treats EPERM and EACCES as transient ONLY on win32', () => {
    for (const code of ['EPERM', 'EACCES']) {
      expect(isTransientRenameError(code, 'win32'), `${code} win32`).toBe(true)
      expect(isTransientRenameError(code, 'darwin'), `${code} darwin`).toBe(false)
      expect(isTransientRenameError(code, 'linux'), `${code} linux`).toBe(false)
    }
  })

  it('never retries an error a wait cannot fix, on any platform', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      for (const code of ['ENOSPC', 'ENOENT', 'EXDEV', 'EROFS', undefined]) {
        expect(isTransientRenameError(code, platform), `${code} ${platform}`).toBe(false)
      }
    }
  })
})

describe('sweepStaleStaging, via atomicWriteFileSync', () => {
  let dir = ''

  /** A staging orphan of the shape a killed process leaves, aged past the gate. */
  function plantOrphan(name: string, ageMs: number): string {
    const p = join(dir, `${name}.${randomUUID()}.tmp`)
    writeFileSync(p, 'stranded')
    const when = new Date(Date.now() - ageMs)
    utimesSync(p, when, when)
    return p
  }
  const leftovers = (): string[] => readdirSync(dir).filter((f) => f.endsWith('.tmp'))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sweep-'))
    vi.resetModules() // the sweep memoises per process; each test needs a clean one
  })
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('reclaims orphans belonging to a DIFFERENT file in the same directory', async () => {
    const { atomicWriteFileSync: write } = await import('../../src/main/atomic-write')
    plantOrphan('alpha.json', 2 * 60 * 60 * 1000)
    plantOrphan('beta.json', 2 * 60 * 60 * 1000)

    // One write, to one of them. Both orphans must go: the sweep runs once per
    // directory, so it cannot be scoped to the name being written.
    write(join(dir, 'alpha.json'), '{}')

    expect(leftovers()).toEqual([])
  })

  it('leaves a FRESH staging file alone, in case another process is mid-write', async () => {
    const { atomicWriteFileSync: write } = await import('../../src/main/atomic-write')
    plantOrphan('alpha.json', 5 * 1000)

    write(join(dir, 'alpha.json'), '{}')

    expect(leftovers()).toHaveLength(1)
  })

  it('ignores files that are not staging files', async () => {
    const { atomicWriteFileSync: write } = await import('../../src/main/atomic-write')
    const decoys = ['notes.tmp', 'alpha.json.tmp', 'alpha.json.12345.tmp', 'alpha.json.not-a-uuid.tmp']
    for (const d of decoys) {
      const p = join(dir, d)
      writeFileSync(p, 'keep')
      const when = new Date(Date.now() - 2 * 60 * 60 * 1000)
      utimesSync(p, when, when)
    }

    write(join(dir, 'alpha.json'), '{}')

    expect(readdirSync(dir).filter((f) => decoys.includes(f)).sort()).toEqual([...decoys].sort())
  })

  it('sweeps a directory once, not on every write', async () => {
    const { atomicWriteFileSync: write } = await import('../../src/main/atomic-write')
    write(join(dir, 'alpha.json'), '{}')
    // Planted AFTER the directory was swept: it must survive, which is what
    // proves the memo is doing its job rather than a readdir per write.
    plantOrphan('alpha.json', 2 * 60 * 60 * 1000)

    write(join(dir, 'alpha.json'), '{"again":true}')

    expect(leftovers()).toHaveLength(1)
  })

  it('does not fall over when the directory does not exist yet', () => {
    const missing = join(dir, 'not-created-yet')
    mkdirSync(missing, { recursive: true })
    expect(() => atomicWriteFileSync(join(missing, 'x.json'), '{}')).not.toThrow()
  })
})
