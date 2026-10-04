// [host] WP2 PR 4 (row 51; section 10 question 5, answered C): the app's own
// copies of its canvas skills in this computer's own Codex skills folder stay
// recognisably the app's in every state they can be left in, so the app can
// always finish removing them and never tells the user they are the user's.
//  - a removal that fails part-way (a file held open by another program)
//    never leaves a copy without the app's mark at the skill's name: the copy
//    is taken out of its place in one rename first, and deleted with its mark
//    last; the next pass finishes it, and the record keeps the folder until
//    then;
//  - a copy whose mark was changed (by one byte, or replaced) is still the
//    app's: rebuilt at a launch, removed whole when Codex or the built-in
//    tools are turned off, never reported as a skill of the user's own;
//  - the record lets a folder go only when it is really gone (nothing there,
//    its parent present) or provably holds none of the app's copies.
// The failures are made in an injected file system over a real temporary
// folder (RealmSkillsIo); nothing here reads or writes this user's own
// ~/.codex, and no link is made.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const u = await import('../../../src/main/canvas/codex-user-skills')
const g = await import('../../../src/main/canvas/codex-guidance')
const { realRealmSkillsIo, STAGED_SKILL_MARK, STAGED_SKILL_MARK_BYTES, STAGING_PREFIX } = await import('../../../src/main/canvas/codex-realm-skills')
type RealmSkillsIo = typeof realRealmSkillsIo
const { canvasSkillFiles } = await import('../../../src/main/canvas/canvas-plugin')

const SKILLS = canvasSkillFiles()
const FIRST = SKILLS[0].name
let tmp = ''
let home = ''
let skills = ''
let recordFile = ''

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-user-own-')))
  home = path.join(tmp, 'own-codex')
  skills = path.join(home, 'skills')
  recordFile = path.join(tmp, 'codex-user-skills.json')
  fs.mkdirSync(home)
})
afterEach(() => {
  if (tmp && path.basename(tmp).startsWith('ccc-user-own-')) fs.rmSync(tmp, { recursive: true, force: true })
})

const deps = (io: RealmSkillsIo = realRealmSkillsIo) => ({ io, recordFile: () => recordFile })
const recorded = (): string[] => u.codexUserSkillsHomes({ recordFile: () => recordFile })
const skillDir = (name: string): string => path.join(skills, name)
const leftovers = (): string[] => (fs.existsSync(skills) ? fs.readdirSync(skills).filter((n) => n.startsWith(STAGING_PREFIX)) : [])
const isCopied = (name: string): boolean => {
  const skill = SKILLS.find((s) => s.name === name)!
  try {
    return fs.readFileSync(path.join(skillDir(name), 'SKILL.md')).equals(skill.bytes)
      && fs.readFileSync(path.join(skillDir(name), STAGED_SKILL_MARK)).equals(STAGED_SKILL_MARK_BYTES)
      && fs.readdirSync(skillDir(name)).length === 2
  } catch { return false }
}
/** Never a folder at the skill's name without the app's mark. */
const neverUnmarked = (name: string): void => {
  const dir = skillDir(name)
  if (fs.existsSync(dir)) expect(fs.existsSync(path.join(dir, STAGED_SKILL_MARK)), `${name} left without its mark`).toBe(true)
}
const EPERM = (): Error => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })

/** The app's file system with SKILL.md of the first skill held open by another
 *  program, as on Windows: removing a folder deletes its entries in name
 *  order, so the mark goes first and SKILL.md then cannot be deleted. */
function heldOpenIo(): RealmSkillsIo {
  return {
    ...realRealmSkillsIo,
    removeTree: (p) => {
      if (p.split(/[\\/]/).includes(FIRST)) {
        const st = fs.lstatSync(p, { throwIfNoEntry: false })
        if (st?.isDirectory()) {
          const mark = path.join(p, STAGED_SKILL_MARK)
          if (fs.existsSync(mark)) fs.rmSync(mark)
          throw EPERM()
        }
        if (path.basename(p) === 'SKILL.md') throw EPERM()
      }
      realRealmSkillsIo.removeTree(p)
    },
  }
}

describe('a removal that fails part-way (a file held open)', () => {
  it('[host] never leaves a copy without its mark at the skill\'s name; the record keeps the folder; the next pass finishes it', () => {
    expect(u.stageCodexUserSkills(home, deps()).outcome).toEqual({ staged: true })
    u.removeCodexUserSkills(home, deps(heldOpenIo()))
    neverUnmarked(FIRST)
    expect(recorded()).toEqual([home])
    u.reconcileCodexUserSkills(false, deps(heldOpenIo()))
    neverUnmarked(FIRST)
    expect(recorded()).toEqual([home])
    // The file is let go: the next pass removes everything the app left.
    u.reconcileCodexUserSkills(false, deps())
    for (const skill of SKILLS) expect(fs.existsSync(skillDir(skill.name))).toBe(false)
    expect(leftovers()).toEqual([])
    expect(recorded()).toEqual([])
  })

  it('[host] a launch after it is never told the skill is the user\'s own; the copy is put back in place', () => {
    u.stageCodexUserSkills(home, deps())
    u.removeCodexUserSkills(home, deps(heldOpenIo()))
    const out = u.stageCodexUserSkills(home, deps())
    expect(g.codexGuidanceFromStaging(out)).not.toMatchObject({ reason: 'own-skill' })
    expect(g.codexGuidanceFromStaging(out)).toEqual({ guidance: 'full' })
    for (const skill of SKILLS) expect(isCopied(skill.name)).toBe(true)
  })

  it('[host] a file another program added and holds open: what is left keeps the app\'s mark (deleted last), stays recorded, and a later pass sweeps it', () => {
    u.stageCodexUserSkills(home, deps())
    fs.writeFileSync(path.join(skillDir(FIRST), 'extra.md'), 'another program\'s file')
    const held: RealmSkillsIo = { ...realRealmSkillsIo, removeTree: (p) => { if (path.basename(p) === 'extra.md') throw EPERM(); realRealmSkillsIo.removeTree(p) } }
    u.reconcileCodexUserSkills(false, deps(held))
    neverUnmarked(FIRST)
    const left = leftovers().map((n) => path.join(skills, n, FIRST))
    expect(left).toHaveLength(1)
    expect(fs.existsSync(path.join(left[0], STAGED_SKILL_MARK))).toBe(true)
    expect(recorded()).toEqual([home])
    u.reconcileCodexUserSkills(false, deps())
    expect(leftovers()).toEqual([])
    expect(recorded()).toEqual([])
  })

  it('[host] a folder put in the place of the app\'s copy just before it is taken out is put back untouched, never deleted', () => {
    u.stageCodexUserSkills(home, deps())
    const aside = path.join(tmp, 'aside')
    const swapping: RealmSkillsIo = {
      ...realRealmSkillsIo,
      rename: (from, to) => {
        if (path.resolve(from) === skillDir(FIRST) && path.basename(path.dirname(to)).startsWith(STAGING_PREFIX)) {
          // Another program swaps in a folder of its own at that moment.
          fs.renameSync(skillDir(FIRST), aside)
          fs.mkdirSync(skillDir(FIRST))
          fs.writeFileSync(path.join(skillDir(FIRST), 'SKILL.md'), 'the user\'s own skill')
        }
        realRealmSkillsIo.rename(from, to)
      },
    }
    u.removeCodexUserSkills(home, deps(swapping))
    expect(fs.readFileSync(path.join(skillDir(FIRST), 'SKILL.md'), 'utf8')).toBe('the user\'s own skill')
    expect(leftovers()).toEqual([])
  })

  it('[host] a copy that cannot be taken out at all (its rename refused): left whole and marked, kept in the record, and a launch says the app could not put it in', () => {
    u.stageCodexUserSkills(home, deps())
    const stuck: RealmSkillsIo = { ...realRealmSkillsIo, rename: (from, to) => { if (path.resolve(from) === skillDir(FIRST)) throw EPERM(); realRealmSkillsIo.rename(from, to) } }
    u.removeCodexUserSkills(home, deps(stuck))
    expect(isCopied(FIRST)).toBe(true)
    expect(fs.existsSync(skillDir('canvas-plan'))).toBe(false)
    expect(recorded()).toEqual([home])
    fs.writeFileSync(path.join(skillDir(FIRST), 'SKILL.md'), 'an older version of the skill')
    const out = u.stageCodexUserSkills(home, deps(stuck))
    expect(out.skipped).toEqual([{ name: FIRST, reason: 'failed' }])
    expect(g.codexGuidanceFromStaging(out)).toEqual({ guidance: 'tools-only', reason: 'skills-not-staged', skills: [FIRST] })
    expect(fs.existsSync(path.join(skillDir(FIRST), STAGED_SKILL_MARK))).toBe(true)
  })
})

describe('a copy whose mark was changed is still the app\'s', () => {
  it.each([
    ['the mark with one byte more', (m: string) => fs.appendFileSync(m, ' ')],
    ['the mark with one byte changed', (m: string) => { const b = fs.readFileSync(m); b[0] = b[0] ^ 1; fs.writeFileSync(m, b) }],
    ['the mark replaced by other text', (m: string) => fs.writeFileSync(m, 'not the app\'s mark')],
    ['the mark emptied', (m: string) => fs.writeFileSync(m, '')],
  ])('[host] %s: rebuilt at a launch, never reported as the user\'s, and removed whole when switched off', (_name, alter) => {
    u.stageCodexUserSkills(home, deps())
    const mark = path.join(skillDir(FIRST), STAGED_SKILL_MARK)
    alter(mark)
    fs.writeFileSync(path.join(skillDir(FIRST), 'SKILL.md'), '---\nname: agent-canvas\ndescription: changed\n---\nchanged text\n')
    fs.writeFileSync(path.join(skillDir(FIRST), 'extra.md'), 'planted')
    const out = u.stageCodexUserSkills(home, deps())
    expect(out).toEqual({ outcome: { staged: true }, skipped: [] })
    expect(g.codexGuidanceFromStaging(out)).toEqual({ guidance: 'full' })
    expect(isCopied(FIRST)).toBe(true)
    // Changed again, then Codex or the built-in tools turned off.
    alter(mark)
    fs.writeFileSync(path.join(skillDir(FIRST), 'SKILL.md'), 'changed text')
    u.reconcileCodexUserSkills(false, deps())
    expect(fs.existsSync(skillDir(FIRST))).toBe(false)
    expect(leftovers()).toEqual([])
    expect(recorded()).toEqual([])
  })

  it('[host] a changed mark on a copy that cannot be taken out keeps the folder in the record', () => {
    u.stageCodexUserSkills(home, deps())
    fs.appendFileSync(path.join(skillDir(FIRST), STAGED_SKILL_MARK), ' ')
    const stuck: RealmSkillsIo = { ...realRealmSkillsIo, rename: (from, to) => { if (path.resolve(from) === skillDir(FIRST)) throw EPERM(); realRealmSkillsIo.rename(from, to) } }
    u.reconcileCodexUserSkills(false, deps(stuck))
    expect(fs.existsSync(path.join(skillDir(FIRST), STAGED_SKILL_MARK))).toBe(true)
    expect(recorded()).toEqual([home])
  })

  it('[host] only a folder without the app\'s mark is the user\'s own: reported so, and never touched', () => {
    fs.mkdirSync(skillDir(FIRST), { recursive: true })
    fs.writeFileSync(path.join(skillDir(FIRST), 'SKILL.md'), 'the user\'s own skill')
    const out = u.stageCodexUserSkills(home, deps())
    expect(g.codexGuidanceFromStaging(out)).toEqual({ guidance: 'tools-only', reason: 'own-skill', skills: [FIRST] })
    u.reconcileCodexUserSkills(false, deps())
    expect(fs.readFileSync(path.join(skillDir(FIRST), 'SKILL.md'), 'utf8')).toBe('the user\'s own skill')
  })
})

describe('the record lets a folder go only when it holds none of the app\'s copies', () => {
  it('[host] a folder that cannot be read now (not missing) stays recorded, at the switch off and while both switches are on', () => {
    u.stageCodexUserSkills(home, deps())
    const away: RealmSkillsIo = {
      ...realRealmSkillsIo,
      lstat: (p) => (path.resolve(p).startsWith(home) ? null : realRealmSkillsIo.lstat(p)),
      absent: (p) => !path.resolve(p).startsWith(home) && realRealmSkillsIo.absent!(p),
    }
    u.reconcileCodexUserSkills(false, deps(away))
    expect(recorded()).toEqual([home])
    u.reconcileCodexUserSkills(true, deps(away))
    expect(recorded()).toEqual([home])
    u.removeCodexUserSkills(home, deps(away))
    expect(recorded()).toEqual([home])
    // Back again: the switch off removes the copies and lets the folder go.
    u.reconcileCodexUserSkills(false, deps())
    for (const skill of SKILLS) expect(fs.existsSync(skillDir(skill.name))).toBe(false)
    expect(recorded()).toEqual([])
  })

  it('[host] a folder whose parent is missing too (a drive or share not there now) stays recorded', () => {
    const gone = path.join(tmp, 'drive', 'codex')
    fs.writeFileSync(recordFile, JSON.stringify({ homes: [gone] }))
    u.reconcileCodexUserSkills(false, deps())
    u.reconcileCodexUserSkills(true, deps())
    expect(recorded()).toEqual([gone])
  })

  it('[host] a folder that is really gone (its parent present) is let go', () => {
    u.stageCodexUserSkills(home, deps())
    fs.rmSync(home, { recursive: true, force: true })
    u.reconcileCodexUserSkills(true, deps())
    expect(recorded()).toEqual([])
  })

  it('[host] a staging folder of the app\'s still there keeps the folder recorded until it is gone', () => {
    u.stageCodexUserSkills(home, deps())
    const left = path.join(skills, `${STAGING_PREFIX}Ab12Cd`, FIRST)
    fs.mkdirSync(left, { recursive: true })
    fs.writeFileSync(path.join(left, STAGED_SKILL_MARK), STAGED_SKILL_MARK_BYTES)
    fs.writeFileSync(path.join(left, 'SKILL.md'), SKILLS[0].bytes)
    const stuck: RealmSkillsIo = { ...realRealmSkillsIo, removeTree: (p) => { if (p.includes(`${STAGING_PREFIX}Ab12Cd`)) throw EPERM(); realRealmSkillsIo.removeTree(p) } }
    u.reconcileCodexUserSkills(false, deps(stuck))
    expect(fs.existsSync(left)).toBe(true)
    expect(recorded()).toEqual([home])
    u.reconcileCodexUserSkills(false, deps())
    expect(leftovers()).toEqual([])
    expect(recorded()).toEqual([])
  })
})
