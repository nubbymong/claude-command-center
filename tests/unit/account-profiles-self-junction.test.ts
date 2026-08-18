// tests/unit/account-profiles-self-junction.test.ts
//
// A per-profile shared junction that points at ITSELF (target === link) is an
// ELOOP that wedges every traversal into it -- Claude memory/projects recall,
// resume, the shared agents/skills/commands/plugins config. It happened in the
// field when a junction was (re)built under a REDIRECTED profile USERPROFILE, so
// sharedRoot() resolved to the profile's own `.claude` and ensureLink junctioned
// each shared dir to itself (adversarial review, 2026-08-18). Two guarantees:
//   1. ensureLink (via setupProfileLinks) must REFUSE to create a self-reference
//      even when the shared root is poisoned to the profile home.
//   2. repairSharedProjectJunctions must HEAL an existing self-referential (or
//      otherwise wrong-target) junction to the correct shared dir -- the old
//      version skipped anything already a junction, so it could never fix this.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _setRootsForTest, getProfileConfigDir, setupProfileLinks,
  repairSharedProjectJunctions, upsertProfile, SHARED_DIR_NAMES,
} from '../../src/main/account-profiles'

const isWin = process.platform === 'win32'
const linkType: fs.symlink.Type = isWin ? 'junction' : 'dir'

let tmp: string
let resources: string
let shared: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-selfjxn-'))
  resources = path.join(tmp, 'resources')
  shared = path.join(tmp, 'shared')
  fs.mkdirSync(resources, { recursive: true })
})
afterEach(() => { _setRootsForTest(null); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ } })

/** True when `link` is a symlink/junction that resolves to itself (or loops). */
function isSelfRef(link: string): boolean {
  let st: fs.Stats
  try { st = fs.lstatSync(link) } catch { return false }
  if (!st.isSymbolicLink()) return false
  let tgt: string
  try { tgt = fs.readlinkSync(link) } catch { return true } // unreadable/looping = broken
  const norm = (p: string) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p))
  return norm(tgt) === norm(link)
}

/** Reproduce the field state: a junction/symlink at `link` whose target is `link`. */
function makeSelfRefJunction(link: string): void {
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(link, link, linkType)
}

describe('shared-junction self-reference guard + heal (adversarial review 2026-08-18)', () => {
  it('setupProfileLinks REFUSES to create self-referential junctions when the shared root resolves to the profile home (poisoned USERPROFILE)', () => {
    // Point the shared root at THIS profile's own `.claude`: target === link for
    // every shared dir -- exactly what os.homedir()==<profileDir> produces.
    _setRootsForTest({ resourcesDir: resources, sharedRoot: path.join(resources, 'account-profiles', 'p1', '.claude') })

    // Must not throw, and must not plant a single self-referential junction.
    expect(() => setupProfileLinks('p1')).not.toThrow()

    const claudeDir = path.join(getProfileConfigDir('p1'), '.claude')
    for (const name of SHARED_DIR_NAMES) {
      expect(isSelfRef(path.join(claudeDir, name)), `${name} must not be a self-referential junction`).toBe(false)
    }
  })

  it('repairSharedProjectJunctions HEALS an existing self-referential projects junction to the correct shared dir', () => {
    _setRootsForTest({ resourcesDir: resources, sharedRoot: shared })
    // A real transcript in the shared store the healed junction must reach.
    fs.mkdirSync(path.join(shared, 'projects', 'C--proj'), { recursive: true })
    fs.writeFileSync(path.join(shared, 'projects', 'C--proj', 'u.jsonl'), 'transcript\n')

    upsertProfile({ id: 'p1', name: 'A', accountEmail: 'a@x.com', createdAt: 1 })
    const link = path.join(getProfileConfigDir('p1'), '.claude', 'projects')
    makeSelfRefJunction(link)
    expect(isSelfRef(link)).toBe(true) // broken before

    repairSharedProjectJunctions()

    expect(isSelfRef(link)).toBe(false) // healed
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true) // still a junction...
    // ...now reaching the shared transcript.
    expect(fs.readFileSync(path.join(link, 'C--proj', 'u.jsonl'), 'utf8')).toBe('transcript\n')
  })

  it('repairSharedProjectJunctions heals EVERY shared dir, not just projects', () => {
    _setRootsForTest({ resourcesDir: resources, sharedRoot: shared })
    upsertProfile({ id: 'p1', name: 'A', accountEmail: 'a@x.com', createdAt: 1 })
    const claudeDir = path.join(getProfileConfigDir('p1'), '.claude')
    for (const name of SHARED_DIR_NAMES) makeSelfRefJunction(path.join(claudeDir, name))

    repairSharedProjectJunctions()

    for (const name of SHARED_DIR_NAMES) {
      const link = path.join(claudeDir, name)
      expect(isSelfRef(link), `${name} should be healed`).toBe(false)
      const tgt = fs.readlinkSync(link)
      const norm = (p: string) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p))
      expect(norm(tgt)).toBe(norm(path.join(shared, name)))
    }
  })

  it('leaves an ALREADY-CORRECT junction untouched (idempotent)', () => {
    _setRootsForTest({ resourcesDir: resources, sharedRoot: shared })
    fs.mkdirSync(path.join(shared, 'projects'), { recursive: true })
    upsertProfile({ id: 'p1', name: 'A', accountEmail: 'a@x.com', createdAt: 1 })
    setupProfileLinks('p1') // builds correct junctions
    const link = path.join(getProfileConfigDir('p1'), '.claude', 'projects')
    const before = fs.readlinkSync(link)

    repairSharedProjectJunctions()
    repairSharedProjectJunctions() // twice: still a no-op

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(link)).toBe(before)
  })

  it('repair FAILS CLOSED under a poisoned shared root: never re-plants a self-reference, never throws', () => {
    // Shared root == the profile home again -> the correct target would equal the
    // link, so repair must SKIP (not rebuild a self-reference).
    _setRootsForTest({ resourcesDir: resources, sharedRoot: path.join(resources, 'account-profiles', 'p1', '.claude') })
    upsertProfile({ id: 'p1', name: 'A', accountEmail: 'a@x.com', createdAt: 1 })
    const link = path.join(getProfileConfigDir('p1'), '.claude', 'projects')
    makeSelfRefJunction(link) // pre-broken (as the field left it)

    expect(() => repairSharedProjectJunctions()).not.toThrow()
    // Still a junction (we couldn't fix it without the real root) but repair did
    // not delete-and-recreate another self-reference or crash the sweep.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
  })
})
