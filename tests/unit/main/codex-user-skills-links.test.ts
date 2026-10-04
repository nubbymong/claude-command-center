// HOST QUARANTINE: plants junctions and symbolic links. [CI] [VM] only -- never run on the owner's machine.
/**
 * WP2 PR 4 (row 51; section 10 question 5, answered C): copying the canvas
 * skills into this computer's own Codex skills folder
 * (src/main/canvas/codex-user-skills.ts) refuses a REAL link of any kind at
 * the Codex folder, at its `skills/` or at a skill folder: it writes nothing
 * through it, removes nothing through it, and reports the skill not copied.
 * The folder is the user's own, and any program the user runs (a Codex
 * session running approved commands outside the sandbox included) can put a
 * link there; a write or a recursive delete that followed one would land in
 * whatever it points at. A temporary folder stands in for the user's Codex
 * folder. The host-safe stand-in is codex-user-skills-swap.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const u = await import('../../../src/main/canvas/codex-user-skills')
const { STAGED_SKILL_MARK, STAGED_SKILL_MARK_BYTES, STAGING_PREFIX } = await import('../../../src/main/canvas/codex-realm-skills')
const { canvasSkillFiles } = await import('../../../src/main/canvas/canvas-plugin')

const LINK_KIND = process.platform === 'win32' ? 'junction' : 'dir'
const FIRST = canvasSkillFiles()[0].name
let tmp: string
let home: string
let outside: string
let deps: { recordFile: () => string }
const links: string[] = []

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-user-links-')))
  home = path.join(tmp, 'own-codex')
  outside = path.join(tmp, 'outside')
  fs.mkdirSync(home)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me')
  deps = { recordFile: () => path.join(tmp, u.CODEX_USER_SKILLS_RECORD) }
})
afterEach(() => {
  for (const l of links.splice(0)) { try { if (fs.lstatSync(l).isSymbolicLink()) fs.rmdirSync(l) } catch { /* gone */ } }
  if (tmp && path.basename(tmp).startsWith('ccc-user-links-')) fs.rmSync(tmp, { recursive: true, force: true })
})

function link(at: string): void {
  links.push(at)
  fs.symlinkSync(outside, at, LINK_KIND)
}
function appCopyOutside(): void {
  fs.mkdirSync(path.join(outside, FIRST))
  fs.writeFileSync(path.join(outside, FIRST, 'SKILL.md'), canvasSkillFiles()[0].bytes)
  fs.writeFileSync(path.join(outside, FIRST, STAGED_SKILL_MARK), STAGED_SKILL_MARK_BYTES)
}

describe('real links in this computer\'s Codex folder', () => {
  it('a link at the Codex folder itself: nothing copied, nothing written through it', () => {
    fs.rmSync(home, { recursive: true })
    link(home)
    expect(u.stageCodexUserSkills(home, deps).outcome).toEqual({ staged: false, reason: 'link' })
    expect(fs.readdirSync(outside)).toEqual(['precious.txt'])
  })

  it('a link at skills/: nothing copied through it, and removal and the switches delete nothing through it', () => {
    link(path.join(home, 'skills'))
    expect(u.stageCodexUserSkills(home, deps).outcome).toEqual({ staged: false, reason: 'link' })
    expect(fs.readdirSync(outside)).toEqual(['precious.txt'])
    appCopyOutside()
    u.removeCodexUserSkills(home, deps)
    fs.writeFileSync(deps.recordFile(), JSON.stringify({ homes: [home] }))
    u.reconcileCodexUserSkills(false, deps)
    u.reconcileCodexUserSkills(true, deps)
    expect(fs.readFileSync(path.join(outside, FIRST, 'SKILL.md')).equals(canvasSkillFiles()[0].bytes)).toBe(true)
    expect(fs.lstatSync(path.join(home, 'skills')).isSymbolicLink()).toBe(true)
  })

  it('a link at a skill folder: left alone and reported, its target untouched at copy, at removal and at the switch off', () => {
    fs.mkdirSync(path.join(home, 'skills'))
    link(path.join(home, 'skills', FIRST))
    expect(u.stageCodexUserSkills(home, deps).skipped).toEqual([{ name: FIRST, reason: 'link' }])
    expect(fs.readdirSync(outside)).toEqual(['precious.txt'])
    appCopyOutside()
    u.removeCodexUserSkills(home, deps)
    fs.writeFileSync(deps.recordFile(), JSON.stringify({ homes: [home] }))
    u.reconcileCodexUserSkills(false, deps)
    expect(fs.lstatSync(path.join(home, 'skills', FIRST)).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(outside, FIRST, 'SKILL.md'))).toBe(true)
  })

  it('a link planted INSIDE the app\'s own copy: the rebuild removes the link, never its target', () => {
    expect(u.stageCodexUserSkills(home, deps).outcome).toEqual({ staged: true })
    link(path.join(home, 'skills', 'canvas-plan', 'refs'))
    expect(u.stageCodexUserSkills(home, deps).outcome).toEqual({ staged: true })
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me')
    expect(fs.readdirSync(path.join(home, 'skills', 'canvas-plan')).sort()).toEqual([STAGED_SKILL_MARK, 'SKILL.md'].sort())
  })

  it('a link at a staging name: left alone (only staging the app can tell is its own is swept; review B-S8), its target untouched', () => {
    fs.mkdirSync(path.join(home, 'skills'))
    appCopyOutside()
    link(path.join(home, 'skills', `${STAGING_PREFIX}Qr12St`))
    u.removeCodexUserSkills(home, deps)
    expect(fs.lstatSync(path.join(home, 'skills', `${STAGING_PREFIX}Qr12St`)).isSymbolicLink()).toBe(true)
    expect(fs.readdirSync(outside).sort()).toEqual([FIRST, 'precious.txt'])
  })

  it('a link planted INSIDE the app\'s own copy: the switch-off removal removes the link, never its target', () => {
    expect(u.stageCodexUserSkills(home, deps).outcome).toEqual({ staged: true })
    link(path.join(home, 'skills', 'canvas-plan', 'refs'))
    u.reconcileCodexUserSkills(false, deps)
    expect(fs.existsSync(path.join(home, 'skills', 'canvas-plan'))).toBe(false)
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me')
    expect(u.codexUserSkillsHomes(deps)).toEqual([])
  })

  it('the record itself a link: never read or written through, nothing copied', () => {
    // A folder link (a junction on Windows needs no privilege, unlike a file link).
    link(deps.recordFile())
    expect(u.stageCodexUserSkills(home, deps).outcome.staged).toBe(false)
    expect(fs.existsSync(path.join(home, 'skills'))).toBe(false)
    expect(fs.readdirSync(outside)).toEqual(['precious.txt'])
  })
})
