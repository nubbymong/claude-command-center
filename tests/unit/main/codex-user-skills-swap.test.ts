// [host] WP2 PR 4 (row 51; section 10 question 5, answered C): copying the
// canvas skills into this computer's own Codex skills folder
// (src/main/canvas/codex-user-skills.ts) writes nothing and removes nothing
// outside that folder when a link stands at the Codex folder, at its
// `skills/`, at a skill folder or at a staging name, or is put in place of a
// path it checked mid-copy, and never reports such a skill copied. Host-safe:
// the links are made in an injected file system (RealmSkillsIo) over a real
// temporary folder, which treats a linked path the way Windows and POSIX do
// (reads and writes under it land in its target; lstat says link; a folder
// cannot be renamed onto it; removing it removes the link only). No link is
// planted on this machine; the real-link cases are
// codex-user-skills-links.test.ts and codex-user-skills-race-links.test.ts
// (quarantined from the host: CI and VM only).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const u = await import('../../../src/main/canvas/codex-user-skills')
const g = await import('../../../src/main/canvas/codex-guidance')
const { realRealmSkillsIo, STAGING_PREFIX, STAGED_SKILL_MARK, STAGED_SKILL_MARK_BYTES } = await import('../../../src/main/canvas/codex-realm-skills')
type RealmSkillsIo = typeof realRealmSkillsIo
const { canvasSkillFiles } = await import('../../../src/main/canvas/canvas-plugin')

const FIRST = canvasSkillFiles()[0].name
let tmp = ''
let home = ''
let skills = ''
let outside = ''
let recordFile = ''

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-user-swap-')))
  home = path.join(tmp, 'own-codex')
  skills = path.join(home, 'skills')
  outside = path.join(tmp, 'outside')
  recordFile = path.join(tmp, 'codex-user-skills.json')
  fs.mkdirSync(home)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me')
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

type Op = 'mkdirChecked' | 'mkdir' | 'mkdtemp' | 'writeFile' | 'never'

/** The real file system with links standing in it: `links` from the start,
 *  and, once `when` says so (after the named operation did its work), the
 *  path `at` names swapped for a link to `target`. */
function linkingIo(when: (op: Op, p: string) => boolean = () => false, at: (p: string) => string = (p) => p, target: () => string = () => outside) {
  const links = new Map<string, string>()
  let swapped = false
  const norm = (p: string): string => path.resolve(p)
  const through = (p: string): string => {
    const s = norm(p)
    for (const [link, to] of links) {
      if (s === link) return to
      if (s.startsWith(link + path.sep)) return to + s.slice(link.length)
    }
    return s
  }
  const after = (op: Op, p: string): void => {
    if (swapped || !when(op, norm(p))) return
    swapped = true
    const spot = norm(at(norm(p)))
    fs.rmSync(through(spot), { recursive: true, force: true })
    links.set(spot, norm(target()))
  }
  const io: RealmSkillsIo = {
    lstat: (p) => (links.has(norm(p)) ? { dir: false, file: false, link: true, size: 0, id: `link:${norm(p)}` } : realRealmSkillsIo.lstat(through(p))),
    readdir: (p) => [...fs.readdirSync(through(p)), ...[...links.keys()].filter((l) => path.dirname(l) === norm(p)).map((l) => path.basename(l))],
    readFile: (p) => fs.readFileSync(through(p)),
    mkdirChecked: (p) => {
      // The app's checked mkdir refuses a link at the folder or above it.
      for (const l of links.keys()) if (norm(p) === l || norm(p).startsWith(l + path.sep)) throw new Error('refusing: a link')
      fs.mkdirSync(through(p), { recursive: true })
      after('mkdirChecked', p)
    },
    mkdir: (p) => {
      if (links.has(norm(p))) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      fs.mkdirSync(through(p))
      after('mkdir', p)
    },
    mkdtemp: (prefix) => {
      const made = fs.mkdtempSync(through(prefix))
      const spelled = norm(prefix) + made.slice(through(prefix).length)
      after('mkdtemp', spelled)
      return spelled
    },
    writeFile: (p, bytes) => {
      after('writeFile', p)
      fs.writeFileSync(through(p), bytes)
    },
    rename: (from, to) => {
      if (links.has(norm(to))) throw Object.assign(new Error('EPERM: a folder is not renamed onto a link'), { code: 'EPERM' })
      fs.renameSync(through(from), through(to))
    },
    removeTree: (p) => {
      if (links.delete(norm(p))) return
      fs.rmSync(through(p), { recursive: true, force: true })
    },
    removeEntry: (p) => {
      if (links.delete(norm(p))) return
      fs.rmdirSync(through(p))
    },
  }
  return { io, links, through, get swapped() { return swapped } }
}

const deps = (io: RealmSkillsIo) => ({ io, recordFile: () => recordFile })
const outsideUntouched = (): void => {
  expect(fs.readdirSync(outside).sort()).toEqual(['precious.txt'])
  expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me')
}
/** What the app's copy looks like, planted in the folder a link points at. */
function plantAppCopyOutside(): void {
  fs.mkdirSync(path.join(outside, FIRST))
  fs.writeFileSync(path.join(outside, FIRST, 'SKILL.md'), canvasSkillFiles()[0].bytes)
  fs.writeFileSync(path.join(outside, FIRST, STAGED_SKILL_MARK), STAGED_SKILL_MARK_BYTES)
}

describe('a link standing in this computer\'s Codex folder', () => {
  it('[host] at the Codex folder itself: nothing copied, nothing written through it', () => {
    const l = linkingIo()
    fs.rmSync(home, { recursive: true })
    l.links.set(home, outside)
    const out = u.stageCodexUserSkills(home, deps(l.io))
    expect(out.outcome).toEqual({ staged: false, reason: 'link' })
    expect(out.skipped.every((s) => s.reason === 'folder-link')).toBe(true)
    // The page: the app could not put them there (never "the user's own skill").
    expect(g.codexGuidanceFromStaging(out)).toMatchObject({ reason: 'skills-not-staged' })
    outsideUntouched()
  })

  it('[host] at skills/: nothing copied or written through it, and removal deletes nothing through it', () => {
    const l = linkingIo()
    l.links.set(skills, outside)
    const out = u.stageCodexUserSkills(home, deps(l.io))
    expect(out.outcome).toEqual({ staged: false, reason: 'link' })
    expect(out.skipped.every((s) => s.reason === 'folder-link')).toBe(true)
    expect(g.codexGuidanceFromStaging(out)).toMatchObject({ reason: 'skills-not-staged' })
    outsideUntouched()
    plantAppCopyOutside()
    u.removeCodexUserSkills(home, deps(l.io))
    u.reconcileCodexUserSkills(false, deps(l.io))
    u.reconcileCodexUserSkills(true, deps(l.io))
    expect(fs.readFileSync(path.join(outside, FIRST, 'SKILL.md')).equals(canvasSkillFiles()[0].bytes)).toBe(true)
    expect(l.links.get(skills)).toBe(outside)
  })

  it('[host] at a skill folder: left alone and reported, its target untouched at copy and at removal', () => {
    fs.mkdirSync(skills)
    const l = linkingIo()
    l.links.set(path.join(skills, FIRST), outside)
    const out = u.stageCodexUserSkills(home, deps(l.io))
    expect(out.skipped).toEqual([{ name: FIRST, reason: 'link' }])
    // A link the user put at a skill's own name is the user's (review B-S4).
    expect(g.codexGuidanceFromStaging(out)).toEqual({ guidance: 'tools-only', reason: 'own-skill', skills: [FIRST] })
    outsideUntouched()
    plantAppCopyOutside()
    u.removeCodexUserSkills(home, deps(l.io))
    u.reconcileCodexUserSkills(false, deps(l.io))
    expect(l.links.has(path.join(skills, FIRST))).toBe(true)
    expect(fs.existsSync(path.join(outside, FIRST, 'SKILL.md'))).toBe(true)
  })

  it('[host] at a staging name: left alone at copy and at removal (only staging the app can tell is its own is swept; review B-S8); its target is never followed', () => {
    fs.mkdirSync(skills)
    plantAppCopyOutside()
    for (const op of ['copy', 'removal'] as const) {
      const l = linkingIo()
      const link = path.join(skills, `${STAGING_PREFIX}Qr12St`)
      l.links.set(link, outside)
      if (op === 'copy') u.stageCodexUserSkills(home, deps(l.io))
      else u.removeCodexUserSkills(home, deps(l.io))
      expect(l.links.get(link)).toBe(outside)
      expect(fs.readdirSync(outside).sort()).toEqual([FIRST, 'precious.txt'])
    }
  })

  it('[host] an empty folder at a staging name is not the app\'s to tell: left alone (review B-S8)', () => {
    fs.mkdirSync(path.join(skills, `${STAGING_PREFIX}Uv34Wx`), { recursive: true })
    u.stageCodexUserSkills(home, deps(realRealmSkillsIo))
    u.removeCodexUserSkills(home, deps(realRealmSkillsIo))
    expect(fs.existsSync(path.join(skills, `${STAGING_PREFIX}Uv34Wx`))).toBe(true)
  })

  it('[host] a link put at skills/ after it was checked, before it is made: nothing is made at the link\'s target (review L1-2)', () => {
    const l = linkingIo()
    const missing = path.join(outside, 'missing')
    let looks = 0
    const io: RealmSkillsIo = {
      ...l.io,
      lstat: (p) => {
        const out = l.io.lstat(p)
        if (path.resolve(p) === skills && out === null && ++looks === 1) l.links.set(skills, missing)
        return out
      },
      // As the app's checked mkdir does: the folders made, then the walk for a link.
      mkdirChecked: (p) => {
        fs.mkdirSync(l.through(p), { recursive: true })
        for (const k of l.links.keys()) if (path.resolve(p) === k || path.resolve(p).startsWith(k + path.sep)) throw new Error('refusing: a link')
      },
    }
    expect(u.stageCodexUserSkills(home, deps(io)).outcome.staged).toBe(false)
    expect(fs.existsSync(missing)).toBe(false)
    outsideUntouched()
  })
})

describe('a copy that cannot be removed (a file held open)', () => {
  it('[host] keeps the folder in the record, so a later pass removes it', () => {
    const l = linkingIo()
    const recorded = (): string[] => u.codexUserSkillsHomes({ recordFile: () => recordFile })
    u.stageCodexUserSkills(home, deps(l.io))
    // A file in it held open: the folder cannot be renamed out of its place,
    // and that file cannot be deleted.
    const EBUSY = (): Error => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    const busy: RealmSkillsIo = {
      ...l.io,
      rename: (from, to) => { if (path.basename(from) === FIRST) throw EBUSY(); l.io.rename(from, to) },
      removeTree: (p) => { if (p.split(/[\\/]/).includes(FIRST)) throw EBUSY(); l.io.removeTree(p) },
    }
    u.removeCodexUserSkills(home, deps(busy))
    expect(fs.existsSync(path.join(skills, FIRST))).toBe(true)
    expect(recorded()).toEqual([home])
    u.reconcileCodexUserSkills(false, deps(busy))
    expect(recorded()).toEqual([home])
    u.reconcileCodexUserSkills(false, deps(l.io))
    expect(fs.existsSync(path.join(skills, FIRST))).toBe(false)
    expect(recorded()).toEqual([])
  })
})

describe('a path swapped for a link mid-copy', () => {
  const inSkills = (p: string): boolean => p.startsWith(skills + path.sep)

  it('[host] the skill folder\'s own path, after it was checked: nothing written outside, the skill not copied', () => {
    const l = linkingIo((op, p) => op === 'writeFile' && inSkills(p), () => path.join(skills, FIRST))
    const out = u.stageCodexUserSkills(home, deps(l.io))
    expect(l.swapped).toBe(true)
    outsideUntouched()
    expect(out.skipped.map((s) => s.name)).toContain(FIRST)
    expect(l.links.has(path.join(skills, FIRST))).toBe(true)
  })

  it('[host] the skills folder, right after it was made: nothing copied, nothing written outside', () => {
    const l = linkingIo((op) => op === 'mkdirChecked', () => skills)
    expect(u.stageCodexUserSkills(home, deps(l.io)).outcome).toEqual({ staged: false, reason: 'link' })
    outsideUntouched()
  })

  it('[host] the staging folder, as it was made: nothing written, the link removed, the skill not copied', () => {
    const l = linkingIo((op) => op === 'mkdtemp')
    expect(u.stageCodexUserSkills(home, deps(l.io)).outcome.staged).toBe(false)
    outsideUntouched()
    expect(l.links.size).toBe(0)
  })

  it('[host] with nothing swapped the same file system copies every skill (the stand-in is faithful)', () => {
    const l = linkingIo()
    expect(u.stageCodexUserSkills(home, deps(l.io)).outcome).toEqual({ staged: true })
    for (const skill of canvasSkillFiles()) expect(fs.readFileSync(path.join(skills, skill.name, 'SKILL.md')).equals(skill.bytes)).toBe(true)
  })
})
