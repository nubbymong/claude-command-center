// [host] WP2 PR 4, P4.1 (row 51; section 10 question 5, answered C by the
// owner on 2026-10-04): how the Agent Canvas, canvas-plan and Conductor
// vision guidance reaches a Codex launch (src/main/canvas/codex-guidance.ts).
//  - a managed account: its realm's staged skills;
//  - this computer's own sign-in (and only it, by its realm, at a home the
//    managed path rule does not take): the skills copied into the user's own
//    Codex skills folder, never over a skill of the user's own;
//  - the built-in tools off: nothing, and the app's copies removed;
//  - what the canvas page is told: every skill in place, or which are not
//    and why.
// Option A (developer instructions on the launch line, after a scan of the
// settings files Codex reads) is gone with its tests: the layer scan, the
// established-version list, the inline and pointer texts and the npm-route,
// user-instructions and unknown-settings reasons no longer exist.
// Temporary folders stand in for the account's Codex folder, the app's
// resources and its data folder: nothing here reads or writes this user's
// own ~/.codex.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getDataDirectory: () => '' }))

const g = await import('../../../src/main/canvas/codex-guidance')
const { STAGED_SKILL_MARK, STAGED_SKILL_MARK_BYTES } = await import('../../../src/main/canvas/codex-realm-skills')
const { codexUserSkillsHomes } = await import('../../../src/main/canvas/codex-user-skills')
const { codexManagedRealmSkillsDir } = await import('../../../src/main/providers/codex/realm-paths')
const { canvasSkillFiles } = await import('../../../src/main/canvas/canvas-plugin')

const ALL = canvasSkillFiles().map((s) => s.name)
const REALM = 'realm-0123456789abcdef0c0d'
let tmp: string
let res: string
let managedHome: string
let ownHome: string
let deps: { recordFile: () => string }

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-guidance-')))
  res = path.join(tmp, 'res')
  managedHome = path.join(res, 'codex-realms', REALM)
  ownHome = path.join(tmp, 'own-codex')
  fs.mkdirSync(managedHome, { recursive: true })
  fs.mkdirSync(ownHome)
  deps = { recordFile: () => path.join(tmp, 'codex-user-skills.json') }
  g._resetCodexGuidanceForTest()
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

type Input = Parameters<typeof g.codexLaunchGuidance>[0]
const skill = (home: string, name: string): string => path.join(home, 'skills', name, 'SKILL.md')
const managed = (over: Partial<Input> = {}): Input => ({
  home: managedHome, toolsOn: true, managed: true, managedSkillsDir: codexManagedRealmSkillsDir(managedHome, res), ruleSkillsDir: codexManagedRealmSkillsDir(managedHome, res), ownership: 'conductor-managed', ...over,
})
const own = (over: Partial<Input> = {}): Input => ({
  home: ownHome, toolsOn: true, managed: false, managedSkillsDir: null, ruleSkillsDir: null, ownership: 'external-default', ...over,
})
function plantOwn(home: string, name: string): void {
  fs.mkdirSync(path.dirname(skill(home, name)), { recursive: true })
  fs.writeFileSync(skill(home, name), 'the user\'s own skill')
}

describe('a managed account: its realm\'s skills', () => {
  it('[host] staged, and the session told every skill is in place', () => {
    expect(g.codexLaunchGuidance(managed(), deps)).toEqual({ guidance: 'full' })
    for (const name of ALL) expect(fs.existsSync(skill(managedHome, name))).toBe(true)
    expect(codexUserSkillsHomes(deps)).toEqual([])
  })

  it('[host] a same-named folder that is not the app\'s: named, and never replaced', () => {
    plantOwn(managedHome, 'canvas-plan')
    expect(g.codexLaunchGuidance(managed(), deps)).toEqual({ guidance: 'tools-only', reason: 'own-skill', skills: ['canvas-plan'] })
    expect(fs.readFileSync(skill(managedHome, 'canvas-plan'), 'utf8')).toBe('the user\'s own skill')
  })

  it('[host] a managed account whose folder the path rule cannot find: nothing staged, every skill named', () => {
    expect(g.codexLaunchGuidance(managed({ managedSkillsDir: null }), deps)).toEqual({ guidance: 'tools-only', reason: 'skills-not-staged', skills: ALL })
    expect(fs.existsSync(path.join(managedHome, 'skills'))).toBe(false)
  })

  it('[host] the tools off: its staged skills removed, nothing recorded', () => {
    g.codexLaunchGuidance(managed(), deps)
    expect(g.codexLaunchGuidance(managed({ toolsOn: false }), deps)).toBeNull()
    for (const name of ALL) expect(fs.existsSync(path.dirname(skill(managedHome, name)))).toBe(false)
  })
})

describe('this computer\'s own sign-in: the skills copied into the user\'s own Codex skills folder (question 5, C)', () => {
  it('[host] copied with the app\'s mark, the folder recorded, and the session told every skill is in place', () => {
    expect(g.codexLaunchGuidance(own(), deps)).toEqual({ guidance: 'full' })
    for (const s of canvasSkillFiles()) {
      expect(fs.readFileSync(skill(ownHome, s.name)).equals(s.bytes)).toBe(true)
      expect(fs.readFileSync(path.join(ownHome, 'skills', s.name, STAGED_SKILL_MARK)).equals(STAGED_SKILL_MARK_BYTES)).toBe(true)
    }
    expect(codexUserSkillsHomes(deps)).toEqual([ownHome])
  })

  it('[host] a skill of the user\'s own with the same name: skipped by name, never touched, the others copied', () => {
    plantOwn(ownHome, 'agent-canvas')
    expect(g.codexLaunchGuidance(own(), deps)).toEqual({ guidance: 'tools-only', reason: 'own-skill', skills: ['agent-canvas'] })
    expect(fs.readFileSync(skill(ownHome, 'agent-canvas'), 'utf8')).toBe('the user\'s own skill')
    expect(fs.existsSync(skill(ownHome, 'conductor-vision'))).toBe(true)
  })

  it('[host] no record to write the folder into (the default data folder is not known here): nothing copied, every skill named', () => {
    expect(g.codexLaunchGuidance(own(), {})).toEqual({ guidance: 'tools-only', reason: 'skills-not-staged', skills: ALL })
    expect(fs.existsSync(path.join(ownHome, 'skills'))).toBe(false)
  })

  it('[host] the tools off: the app\'s copies removed from that folder (the user\'s own skill stays), nothing recorded for the page', () => {
    plantOwn(ownHome, 'agent-canvas')
    g.codexLaunchGuidance(own(), deps)
    expect(g.codexLaunchGuidance(own({ toolsOn: false }), deps)).toBeNull()
    expect(fs.existsSync(path.dirname(skill(ownHome, 'canvas-plan')))).toBe(false)
    expect(fs.readFileSync(skill(ownHome, 'agent-canvas'), 'utf8')).toBe('the user\'s own skill')
    expect(codexUserSkillsHomes(deps)).toEqual([])
  })

  it.each([
    ['an account whose realm cannot be told', (): Partial<Input> => ({ ownership: undefined })],
    ['an app-managed account the path rule does not find', (): Partial<Input> => ({ ownership: 'conductor-managed' })],
    ['this computer\'s sign-in at a home the managed path rule takes', (): Partial<Input> => ({ ruleSkillsDir: path.join(ownHome, 'skills') })],
  ])('[host] %s: nothing written into that folder, at copy or at removal', (_name, over) => {
    plantOwn(ownHome, 'canvas-plan')
    fs.mkdirSync(path.join(ownHome, 'skills', 'agent-canvas'))
    fs.writeFileSync(skill(ownHome, 'agent-canvas'), canvasSkillFiles()[0].bytes)
    fs.writeFileSync(path.join(ownHome, 'skills', 'agent-canvas', STAGED_SKILL_MARK), STAGED_SKILL_MARK_BYTES)
    const before = fs.readdirSync(path.join(ownHome, 'skills')).sort()
    expect(g.codexLaunchGuidance(own(over()), deps)).toEqual({ guidance: 'tools-only', reason: 'skills-not-staged', skills: ALL })
    expect(g.codexLaunchGuidance(own({ ...over(), toolsOn: false }), deps)).toBeNull()
    expect(fs.readdirSync(path.join(ownHome, 'skills')).sort()).toEqual(before)
    expect(fs.existsSync(skill(ownHome, 'agent-canvas'))).toBe(true)
    expect(codexUserSkillsHomes(deps)).toEqual([])
  })
})

describe('what the page is told', () => {
  it.each([
    ['every skill in place', { outcome: { staged: true as const }, skipped: [] }, { guidance: 'full' }],
    ['only skills not the app\'s', { outcome: { staged: false as const, reason: 'not-ours' as const }, skipped: [{ name: 'agent-canvas', reason: 'not-ours' as const }, { name: 'canvas-plan', reason: 'not-ours' as const }] }, { guidance: 'tools-only', reason: 'own-skill', skills: ['agent-canvas', 'canvas-plan'] }],
    ['one not the app\'s and one that failed', { outcome: { staged: false as const, reason: 'not-ours' as const }, skipped: [{ name: 'agent-canvas', reason: 'not-ours' as const }, { name: 'canvas-plan', reason: 'failed' as const }] }, { guidance: 'tools-only', reason: 'skills-not-staged', skills: ['agent-canvas', 'canvas-plan'] }],
    ['a link', { outcome: { staged: false as const, reason: 'link' as const }, skipped: [{ name: 'conductor-vision', reason: 'link' as const }] }, { guidance: 'tools-only', reason: 'skills-not-staged', skills: ['conductor-vision'] }],
    ['not staged, with no skill named', { outcome: { staged: false as const, reason: 'failed' as const }, skipped: [] }, { guidance: 'tools-only', reason: 'skills-not-staged', skills: ALL }],
  ])('[host] %s', (_name, staging, told) => {
    expect(g.codexGuidanceFromStaging(staging)).toEqual(told)
  })

  it('[host] the route a launch took no longer changes what it carried (the skills reach every conversation of the account)', () => {
    const full = { guidance: 'full' as const }
    expect(g.codexGuidanceAsLaunched({ guidance: full }, { viaPicker: true })).toEqual(full)
    expect(g.codexGuidanceAsLaunched({ guidance: full }, { viaPicker: false })).toEqual(full)
    expect(g.codexGuidanceAsLaunched({ guidance: null }, { viaPicker: true })).toBeNull()
  })
})

describe('the session record the canvas page reads', () => {
  it('holds the launch\'s guidance until forgotten, bounded', () => {
    g.noteCodexSessionGuidance('s1', { guidance: 'full' })
    expect(g.codexSessionGuidance('s1')).toEqual({ guidance: 'full' })
    g.forgetCodexSessionGuidance('s1')
    expect(g.codexSessionGuidance('s1')).toBeNull()
    for (let i = 0; i < g.CODEX_GUIDANCE_RECORDS_MAX + 5; i++) g.noteCodexSessionGuidance(`s${i}`, { guidance: 'full' })
    expect(g.codexSessionGuidance('s0')).toBeNull()
    expect(g.codexSessionGuidance(`s${g.CODEX_GUIDANCE_RECORDS_MAX + 4}`)).toEqual({ guidance: 'full' })
  })
})
