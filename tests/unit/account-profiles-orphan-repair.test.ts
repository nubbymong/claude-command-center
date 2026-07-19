// tests/unit/account-profiles-orphan-repair.test.ts
// #131: a profile whose `.claude/projects` became a REAL dir (the junction never
// established, e.g. Claude wrote transcripts there first) orphans those sessions
// from every other account. setupProfileLinks / repairSharedProjectJunctions must
// merge them into the shared store and replace the dir with a junction, without
// losing conversation history.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _setRootsForTest, getProfileConfigDir, setupProfileLinks, upsertProfile,
  repairSharedProjectJunctions,
} from '../../src/main/account-profiles'

let tmp: string
let shared: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-orphan-'))
  shared = path.join(tmp, 'shared')
  _setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: shared })
  fs.mkdirSync(path.join(tmp, 'resources'), { recursive: true })
  fs.mkdirSync(path.join(shared, 'projects'), { recursive: true })
})
afterEach(() => { _setRootsForTest(null); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ } })

/** Seed a profile whose `.claude/projects` is a REAL dir holding a transcript. */
function seedOrphan(id: string, project: string, file: string, body: string): string {
  const proj = path.join(getProfileConfigDir(id), '.claude', 'projects', project)
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, file), body)
  return path.join(getProfileConfigDir(id), '.claude', 'projects')
}

describe('orphaned projects recovery (#131)', () => {
  it('setupProfileLinks merges an orphaned REAL projects dir into shared and junctions it', () => {
    const link = seedOrphan('p1', 'C--proj', 'uuid1.jsonl', 'line1\n')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false) // REAL dir before

    setupProfileLinks('p1')

    // Transcript recovered into the shared store...
    const sharedFile = path.join(shared, 'projects', 'C--proj', 'uuid1.jsonl')
    expect(fs.existsSync(sharedFile)).toBe(true)
    expect(fs.readFileSync(sharedFile, 'utf8')).toBe('line1\n')
    // ...and the profile's projects is now a junction reaching the same file.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(link, 'C--proj', 'uuid1.jsonl'))).toBe(true)
  })

  it('keeps the LARGER transcript on a filename collision (history never lost)', () => {
    // shared has a short copy; the orphan has a longer (more complete) one.
    const sharedProj = path.join(shared, 'projects', 'C--proj')
    fs.mkdirSync(sharedProj, { recursive: true })
    fs.writeFileSync(path.join(sharedProj, 'u.jsonl'), 'short')
    seedOrphan('p1', 'C--proj', 'u.jsonl', 'a much longer, more complete transcript')

    setupProfileLinks('p1')

    expect(fs.readFileSync(path.join(shared, 'projects', 'C--proj', 'u.jsonl'), 'utf8'))
      .toBe('a much longer, more complete transcript')
  })

  it('keeps the SHARED transcript when it is the larger one', () => {
    const sharedProj = path.join(shared, 'projects', 'C--proj')
    fs.mkdirSync(sharedProj, { recursive: true })
    fs.writeFileSync(path.join(sharedProj, 'u.jsonl'), 'the shared copy is longer and complete')
    seedOrphan('p1', 'C--proj', 'u.jsonl', 'stub')

    setupProfileLinks('p1')

    expect(fs.readFileSync(path.join(shared, 'projects', 'C--proj', 'u.jsonl'), 'utf8'))
      .toBe('the shared copy is longer and complete')
  })

  it('repairSharedProjectJunctions recovers orphans across all registered profiles', () => {
    upsertProfile({ id: 'p1', name: 'A', accountEmail: 'a@x.com', createdAt: 1 })
    upsertProfile({ id: 'p2', name: 'B', accountEmail: 'b@x.com', createdAt: 2 })
    const link1 = seedOrphan('p1', 'C--a', 'u1.jsonl', 'from-p1')
    setupProfileLinks('p2') // p2 is already correctly junctioned (no orphan)
    const link2 = path.join(getProfileConfigDir('p2'), '.claude', 'projects')

    repairSharedProjectJunctions()

    expect(fs.lstatSync(link1).isSymbolicLink()).toBe(true)            // repaired
    expect(fs.lstatSync(link2).isSymbolicLink()).toBe(true)           // left junctioned
    expect(fs.existsSync(path.join(shared, 'projects', 'C--a', 'u1.jsonl'))).toBe(true)
    expect(fs.readFileSync(path.join(shared, 'projects', 'C--a', 'u1.jsonl'), 'utf8')).toBe('from-p1')
  })

  it('is idempotent — a second pass over an already-junctioned profile is a no-op', () => {
    seedOrphan('p1', 'C--proj', 'u.jsonl', 'body')
    setupProfileLinks('p1')
    const before = fs.readFileSync(path.join(shared, 'projects', 'C--proj', 'u.jsonl'), 'utf8')
    // Re-run both entry points; must not throw or corrupt the recovered data.
    setupProfileLinks('p1')
    upsertProfile({ id: 'p1', name: 'A', accountEmail: 'a@x.com', createdAt: 1 })
    repairSharedProjectJunctions()
    expect(fs.lstatSync(path.join(getProfileConfigDir('p1'), '.claude', 'projects')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(shared, 'projects', 'C--proj', 'u.jsonl'), 'utf8')).toBe(before)
  })
})
