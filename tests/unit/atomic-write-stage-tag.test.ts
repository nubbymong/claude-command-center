import { describe, it, expect, afterEach, vi } from 'vitest'

// The write/rename stage tag decides, for any caller that ever keeps a non-atomic
// fallback, whether the failure is safe to fall back on: a rename failure leaves
// the target intact, a staging-write failure does not (falling back would open the
// real target with O_TRUNC). atomic-write.ts's comment designates
// `isRenameStageFailure` as the MANDATORY gate for that decision, so this pins the
// two properties that make it safe — own-property only (prototype pollution can't
// forge a 'rename' verdict) and an accurate tag from the real write path — rather
// than leaving the ban to prose.

const h = vi.hoisted(() => ({ failStage: null as 'write' | 'rename' | null }))

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const patched = {
    ...real,
    writeFileSync: (p: any, d: any, o: any) => {
      if (h.failStage === 'write') {
        const e = new Error('ENOSPC: simulated staging failure') as NodeJS.ErrnoException
        e.code = 'ENOSPC'
        throw e
      }
      return real.writeFileSync(p, d, o)
    },
    renameSync: (f: any, t: any) => {
      if (h.failStage === 'rename') {
        const e = new Error('EIO: simulated rename failure') as NodeJS.ErrnoException
        e.code = 'EIO'
        throw e
      }
      return real.renameSync(f, t)
    },
    unlinkSync: () => {}
  }
  return { ...patched, default: patched }
})

import { isRenameStageFailure } from '../../src/main/atomic-write'

describe('isRenameStageFailure — the mandatory gate for any non-atomic fallback', () => {
  afterEach(() => {
    // A polluted prototype must not leak between tests.
    delete (Object.prototype as any).atomicWriteStage
    h.failStage = null
  })

  it('is true only for an OWN atomicWriteStage of rename', () => {
    expect(isRenameStageFailure(Object.assign(new Error(), { atomicWriteStage: 'rename' }))).toBe(true)
    expect(isRenameStageFailure(Object.assign(new Error(), { atomicWriteStage: 'write' }))).toBe(false)
    expect(isRenameStageFailure(new Error('untagged'))).toBe(false)
  })

  it('is false for non-objects and nullish inputs (no throw)', () => {
    expect(isRenameStageFailure(null)).toBe(false)
    expect(isRenameStageFailure(undefined)).toBe(false)
    expect(isRenameStageFailure('rename')).toBe(false)
  })

  it('cannot be forged by a polluted Object.prototype', () => {
    ;(Object.prototype as any).atomicWriteStage = 'rename'
    // An untagged error would read 'rename' through the prototype chain; the
    // own-property guard must still refuse it, or pollution could authorise a
    // truncating fallback on a staging-write failure.
    expect(isRenameStageFailure(new Error('untagged'))).toBe(false)
    // A frozen error can't be tagged at all, so it must also fail closed.
    expect(isRenameStageFailure(Object.freeze(new Error('frozen')))).toBe(false)
  })

  it('tags a real rename failure as rename and a real staging failure as not-rename', async () => {
    const { atomicWriteFileSync } = await import('../../src/main/atomic-write')
    const { mkdtempSync, rmSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const dir = mkdtempSync(join(tmpdir(), 'stage-tag-'))
    try {
      h.failStage = 'rename'
      let renameErr: unknown
      try { atomicWriteFileSync(join(dir, 'a.json'), '{}') } catch (e) { renameErr = e }
      expect(isRenameStageFailure(renameErr)).toBe(true)

      h.failStage = 'write'
      let writeErr: unknown
      try { atomicWriteFileSync(join(dir, 'b.json'), '{}') } catch (e) { writeErr = e }
      expect(isRenameStageFailure(writeErr)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
