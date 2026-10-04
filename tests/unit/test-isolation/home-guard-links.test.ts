// HOST QUARANTINE: plants junctions and symbolic links. [CI] [VM] only -- never run on the owner's machine.
//
// Tests never act on a real home: the home guard (tests/helpers/home-guard-core.mjs)
// follows a REAL link or junction out of an allowed folder. A temporary folder stands
// in for the real home, so nothing here points at one. The host-safe stand-in is the
// fake-filesystem case in home-guard.test.ts.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHomeChecker } from '../../helpers/home-guard-core.mjs'

const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ccc-iso-links-')))
const fakeHome = path.join(base, 'fake-home')
const allowed = path.join(base, 'allowed')
mkdirSync(fakeHome)
mkdirSync(allowed)
// 'junction' on Windows (no privilege needed); ignored elsewhere.
symlinkSync(fakeHome, path.join(allowed, 'live'), 'junction')
symlinkSync(path.join(fakeHome, 'not-yet'), path.join(allowed, 'dangling'), 'junction')

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('[CI] [VM] a real link out of an allowed folder is followed', () => {
  const c = createHomeChecker({ realRoots: [fakeHome], allowedRoots: [{ path: allowed, kind: 'tmp' }] })

  it('through a live link or junction', () => {
    expect(c.isProtected(path.join(allowed, 'live', 'new', 'f'))).toBe(true)
    expect(c.isProtected(path.join(allowed, 'live'))).toBe(true)
  })

  it('through a dangling one (a write would create its target)', () => {
    expect(c.isProtected(path.join(allowed, 'dangling'))).toBe(true)
    expect(c.isProtected(path.join(allowed, 'dangling', 'f'))).toBe(true)
  })

  it('but not into a plain folder beside it', () => {
    expect(c.isProtected(path.join(allowed, 'plain', 'f'))).toBe(false)
  })
})
