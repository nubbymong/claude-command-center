// [host] WP2 PR 4 (row 51; section 10 question 5, answered C by the owner on
// 2026-10-04): the canvas skills copied into THIS COMPUTER'S own Codex
// sign-in's skills folder (src/main/canvas/codex-user-skills.ts), and taken
// out again when Codex or the built-in tools are turned off.
//  - only the app's own skill folders, each carrying the app's ownership
//    mark, are written, rewritten or removed; a skill of the user's own with
//    the same name (no mark) is never touched, and is reported by name (a
//    changed mark: codex-user-skills-ownership.test.ts);
//  - the folder is recorded before anything is copied there, and without a
//    record nothing is copied; a record that cannot be read refuses, and one
//    that does not parse is kept aside, never taken as empty; the record
//    lets a folder go once none of the app's copies is left in it;
//  - the switches: off removes from every recorded folder; on keeps the
//    copies already there current (an app update) and adds none;
//  - unreadable settings do nothing.
// A temporary folder stands in for the user's Codex folder and for the app's
// data folder: nothing here reads or writes this user's own ~/.codex. Links
// and junctions are in codex-user-skills-links.test.ts and
// codex-user-skills-race-links.test.ts (quarantined from the host); the host-safe
// stand-in for them is codex-user-skills-swap.test.ts.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Every profile and Codex home variable points inside a temporary root before
// any app module loads, so nothing here can reach this user's own folders even
// through a default; put back after the file.
const ENV_ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-user-skills-env-')))
const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const
const ENV_SAVED = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
for (const k of ENV_KEYS) process.env[k] = path.join(ENV_ROOT, k.toLowerCase())
afterAll(() => {
  for (const k of ENV_KEYS) { if (ENV_SAVED[k] === undefined) delete process.env[k]; else process.env[k] = ENV_SAVED[k] }
  if (path.basename(ENV_ROOT).startsWith('ccc-user-skills-env-')) fs.rmSync(ENV_ROOT, { recursive: true, force: true })
})

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
// The default record folder: never this machine's real data folder.
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getDataDirectory: () => (globalThis as { __cccUserSkillsData?: string }).__cccUserSkillsData ?? '' }))

const u = await import('../../../src/main/canvas/codex-user-skills')
const { STAGED_SKILL_MARK, STAGED_SKILL_MARK_BYTES, STAGING_PREFIX } = await import('../../../src/main/canvas/codex-realm-skills')
const { canvasSkillFiles } = await import('../../../src/main/canvas/canvas-plugin')

const SKILLS = canvasSkillFiles()
let tmp: string
let home: string
let data: string
let deps: { recordFile: () => string }

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-user-skills-')))
  home = path.join(tmp, 'own-codex')
  data = path.join(tmp, 'app-data')
  fs.mkdirSync(home)
  fs.mkdirSync(data)
  deps = { recordFile: () => path.join(data, u.CODEX_USER_SKILLS_RECORD) }
  ;(globalThis as { __cccUserSkillsData?: string }).__cccUserSkillsData = data
  u.stopCodexUserSkills()
})
afterEach(() => {
  u.stopCodexUserSkills()
  vi.useRealTimers()
  delete (globalThis as { __cccUserSkillsData?: string }).__cccUserSkillsData
  fs.rmSync(tmp, { recursive: true, force: true })
})

const skillDir = (h: string, name: string): string => path.join(h, 'skills', name)
const isCopied = (h: string, name: string): boolean => {
  const skill = SKILLS.find((s) => s.name === name)!
  try {
    return fs.readFileSync(path.join(skillDir(h, name), 'SKILL.md')).equals(skill.bytes)
      && fs.readFileSync(path.join(skillDir(h, name), STAGED_SKILL_MARK)).equals(STAGED_SKILL_MARK_BYTES)
      && fs.readdirSync(skillDir(h, name)).length === 2
  } catch { return false }
}
/** A skill of the user's own: no mark. */
function plantOwn(h: string, name: string): void {
  fs.mkdirSync(skillDir(h, name), { recursive: true })
  fs.writeFileSync(path.join(skillDir(h, name), 'SKILL.md'), `---\nname: ${name}\ndescription: mine\n---\nthe user's own\n`)
  fs.writeFileSync(path.join(skillDir(h, name), 'notes.md'), 'theirs')
}
const ownIntact = (h: string, name: string): boolean =>
  fs.readFileSync(path.join(skillDir(h, name), 'SKILL.md'), 'utf8').includes('the user\'s own') && fs.readFileSync(path.join(skillDir(h, name), 'notes.md'), 'utf8') === 'theirs'

describe('copying into this computer\'s Codex skills folder', () => {
  it('[host] copies the three skills as the app\'s exact bytes, each with the app\'s mark, and records the folder', () => {
    const out = u.stageCodexUserSkills(home, deps)
    expect(out).toEqual({ outcome: { staged: true }, skipped: [] })
    for (const skill of SKILLS) expect(isCopied(home, skill.name)).toBe(true)
    expect(u.codexUserSkillsHomes(deps)).toEqual([home])
  })

  it('[host] the default record lives in the app\'s data folder', () => {
    expect(u.stageCodexUserSkills(home).outcome).toEqual({ staged: true })
    expect(JSON.parse(fs.readFileSync(path.join(data, u.CODEX_USER_SKILLS_RECORD), 'utf8'))).toEqual({ homes: [home] })
  })

  it('[host] a skill of the user\'s own with the same name (no mark) is never touched; it is skipped by name and the others are copied', () => {
    plantOwn(home, 'agent-canvas')
    const before = fs.readdirSync(skillDir(home, 'agent-canvas')).sort()
    const out = u.stageCodexUserSkills(home, deps)
    expect(out.outcome).toEqual({ staged: false, reason: 'not-ours' })
    expect(out.skipped).toEqual([{ name: 'agent-canvas', reason: 'not-ours' }])
    expect(ownIntact(home, 'agent-canvas')).toBe(true)
    expect(fs.readdirSync(skillDir(home, 'agent-canvas')).sort()).toEqual(before)
    expect(isCopied(home, 'canvas-plan')).toBe(true)
    expect(isCopied(home, 'conductor-vision')).toBe(true)
    // ...and removal leaves it as it is too.
    u.removeCodexUserSkills(home, deps)
    expect(ownIntact(home, 'agent-canvas')).toBe(true)
    expect(fs.existsSync(skillDir(home, 'canvas-plan'))).toBe(false)
  })

  it('[host] a file of the user\'s at a skill\'s name is left alone and reported', () => {
    fs.mkdirSync(path.join(home, 'skills'))
    fs.writeFileSync(skillDir(home, 'canvas-plan'), 'a file of mine')
    const out = u.stageCodexUserSkills(home, deps)
    expect(out.skipped).toEqual([{ name: 'canvas-plan', reason: 'not-ours' }])
    expect(fs.readFileSync(skillDir(home, 'canvas-plan'), 'utf8')).toBe('a file of mine')
  })

  it('[host] the user\'s other skills and files in the folder are left alone at copy and at removal', () => {
    fs.mkdirSync(path.join(home, 'skills', 'my-skill'), { recursive: true })
    fs.writeFileSync(path.join(home, 'skills', 'my-skill', 'SKILL.md'), 'mine')
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "x"\n')
    u.stageCodexUserSkills(home, deps)
    u.removeCodexUserSkills(home, deps)
    expect(fs.readFileSync(path.join(home, 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toBe('mine')
    expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe('model = "x"\n')
    expect(fs.readdirSync(path.join(home, 'skills'))).toEqual(['my-skill'])
  })

  it('[host] keeps the app\'s copies current: one whose text differs (an older app version) or that holds anything extra is rebuilt', () => {
    u.stageCodexUserSkills(home, deps)
    fs.writeFileSync(path.join(skillDir(home, 'agent-canvas'), 'SKILL.md'), 'an older version of the skill')
    fs.writeFileSync(path.join(skillDir(home, 'canvas-plan'), 'extra.md'), 'planted')
    expect(u.stageCodexUserSkills(home, deps).outcome).toEqual({ staged: true })
    expect(isCopied(home, 'agent-canvas')).toBe(true)
    expect(isCopied(home, 'canvas-plan')).toBe(true)
  })

  it('[host] nothing is written without a record to write the folder into', () => {
    const none = u.stageCodexUserSkills(home, { recordFile: () => null })
    expect(none.outcome.staged).toBe(false)
    expect(none.skipped.map((s) => s.name).sort()).toEqual(SKILLS.map((s) => s.name).sort())
    expect(fs.existsSync(path.join(home, 'skills'))).toBe(false)
    // A record that cannot be written: the same.
    const blocked = path.join(tmp, 'no-such-folder', u.CODEX_USER_SKILLS_RECORD)
    expect(u.stageCodexUserSkills(home, { recordFile: () => blocked }).outcome.staged).toBe(false)
    expect(fs.existsSync(path.join(home, 'skills'))).toBe(false)
  })

  it('[host] a record larger than the app ever writes is not read: nothing copied', () => {
    fs.writeFileSync(deps.recordFile(), JSON.stringify({ homes: [home], pad: 'x'.repeat(70 * 1024) }))
    expect(u.stageCodexUserSkills(home, deps).outcome.staged).toBe(false)
    expect(fs.existsSync(path.join(home, 'skills'))).toBe(false)
  })

  it('[host] a record that is not a plain file is never read or written: nothing copied', () => {
    fs.mkdirSync(path.join(data, u.CODEX_USER_SKILLS_RECORD))
    expect(u.stageCodexUserSkills(home, deps).outcome.staged).toBe(false)
    expect(fs.existsSync(path.join(home, 'skills'))).toBe(false)
  })

  it.each([
    ['a relative path', 'own-codex'],
    ['an empty path', ''],
  ])('[host] %s is not a folder the app copies into', (_name, h) => {
    expect(u.stageCodexUserSkills(h, deps).outcome.staged).toBe(false)
    expect(u.codexUserSkillsHomes(deps)).toEqual([])
  })

  it('[host] a folder that does not exist gets nothing made (no home created)', () => {
    const gone = path.join(tmp, 'never-made')
    expect(u.stageCodexUserSkills(gone, deps).outcome).toEqual({ staged: false, reason: 'failed' })
    expect(fs.existsSync(gone)).toBe(false)
  })

  it('[host] a full record refuses a new folder; an older one is never let go to make room', () => {
    const homes = Array.from({ length: u.CODEX_USER_SKILLS_HOMES_MAX }, (_, i) => path.join(tmp, `h${i}`))
    fs.writeFileSync(deps.recordFile(), JSON.stringify({ homes }))
    expect(u.stageCodexUserSkills(home, deps).outcome.staged).toBe(false)
    expect(fs.existsSync(path.join(home, 'skills'))).toBe(false)
    expect(u.codexUserSkillsHomes(deps)).toEqual(homes)
  })

  it.each([
    ['does not parse', '{ not json'],
    ['parses as something other than the app\'s record', JSON.stringify(['x'])],
    ['has no list of folders', JSON.stringify({ homes: 'x' })],
  ])('[host] a record that %s is kept aside and refused this time (never taken as empty): nothing copied or removed; the next pass starts a new one (review B-Q2)', (_name, text) => {
    const other = path.join(tmp, 'other-codex-home')
    fs.mkdirSync(other)
    u.stageCodexUserSkills(other, deps)
    fs.writeFileSync(deps.recordFile(), text)
    expect(u.stageCodexUserSkills(home, deps).outcome.staged).toBe(false)
    expect(fs.existsSync(path.join(home, 'skills'))).toBe(false)
    u.reconcileCodexUserSkills(false, deps)
    expect(isCopied(other, 'agent-canvas')).toBe(true)
    expect(fs.readFileSync(`${deps.recordFile()}.damaged`, 'utf8')).toBe(text)
    expect(fs.existsSync(deps.recordFile())).toBe(false)
    expect(u.stageCodexUserSkills(home, deps).outcome).toEqual({ staged: true })
    expect(u.codexUserSkillsHomes(deps)).toEqual([home])
    // Nothing the app can read in it: it stays kept aside, as it is.
    expect(fs.readFileSync(`${deps.recordFile()}.damaged`, 'utf8')).toBe(text)
  })

  it('[host] a record that does not parse never replaces one kept aside earlier: each is kept under its own name (ADR-009 delta L1-6)', () => {
    fs.writeFileSync(deps.recordFile(), '{ first damage')
    expect(u.stageCodexUserSkills(home, deps).outcome.staged).toBe(false)
    fs.writeFileSync(deps.recordFile(), '{ second damage')
    expect(u.stageCodexUserSkills(home, deps).outcome.staged).toBe(false)
    const kept = fs.readdirSync(data).filter((n) => n.startsWith(`${u.CODEX_USER_SKILLS_RECORD}.damaged`)).sort()
    expect(kept).toHaveLength(2)
    expect(kept.map((n) => fs.readFileSync(path.join(data, n), 'utf8')).sort()).toEqual(['{ first damage', '{ second damage'])
  })

  it('[host] a later pass takes back the folders a kept-aside record still names in full, and lets that record go once they are recorded again; the switch-off then reaches them (ADR-009 delta L1-6)', () => {
    const other = path.join(tmp, 'other-codex-home')
    fs.mkdirSync(other)
    u.stageCodexUserSkills(other, deps)
    u.stageCodexUserSkills(home, deps)
    const whole = fs.readFileSync(deps.recordFile(), 'utf8')
    // Cut off in the middle of the second folder's path: the first is still whole.
    fs.writeFileSync(deps.recordFile(), whole.slice(0, whole.lastIndexOf(JSON.stringify(home).slice(0, 8))))
    u.reconcileCodexUserSkills(false, deps)
    expect(isCopied(other, 'agent-canvas')).toBe(true)
    // The next pass reads the folder back from the kept-aside record and removes its copies.
    u.reconcileCodexUserSkills(false, deps)
    for (const skill of SKILLS) expect(fs.existsSync(skillDir(other, skill.name))).toBe(false)
    expect(fs.readdirSync(data).filter((n) => n.includes('.damaged'))).toEqual([])
    expect(u.codexUserSkillsHomes(deps)).toEqual([])
  })

  it('[host] with every kept-aside name taken, a new damaged record replaces the oldest kept-aside record that names no folder, never one that still names a folder, so the passes are never refused for good (ADR-009 delta L1-7)', () => {
    const other = path.join(tmp, 'other-codex-home')
    fs.mkdirSync(other)
    u.stageCodexUserSkills(other, deps)
    const rf = deps.recordFile()
    const names = Array.from({ length: 10 }, (_, i) => `${rf}.damaged${i === 0 ? '' : `.${i}`}`)
    // The oldest names a folder; the next oldest is the oldest that names none.
    names.forEach((n, i) => {
      fs.writeFileSync(n, i === 0 ? JSON.stringify({ homes: [other] }) : '{}')
      const t = new Date(Date.UTC(2026, 0, 1 + i))
      fs.utimesSync(n, t, t)
    })
    fs.writeFileSync(rf, 'damaged again')
    u.reconcileCodexUserSkills(false, deps)
    expect(fs.existsSync(rf)).toBe(false)
    expect(fs.readFileSync(names[1], 'utf8')).toBe('damaged again')
    expect(JSON.parse(fs.readFileSync(names[0], 'utf8'))).toEqual({ homes: [other] })
    // The next pass is not refused: it takes the named folder back and removes its copies.
    u.reconcileCodexUserSkills(false, deps)
    for (const skill of SKILLS) expect(fs.existsSync(skillDir(other, skill.name))).toBe(false)
    expect(u.stageCodexUserSkills(home, deps).outcome).toEqual({ staged: true })
  })

  it('[host] reading the recorded folders writes nothing: no record kept aside, none taken back (review B-Q14)', () => {
    const other = path.join(tmp, 'other-codex-home')
    const rf = deps.recordFile()
    fs.writeFileSync(rf, 'damaged')
    fs.writeFileSync(`${rf}.damaged`, JSON.stringify({ homes: [other] }))
    expect(u.codexUserSkillsHomes(deps)).toEqual([])
    expect(fs.readFileSync(rf, 'utf8')).toBe('damaged')
    expect(fs.readFileSync(`${rf}.damaged`, 'utf8')).toBe(JSON.stringify({ homes: [other] }))
    fs.writeFileSync(rf, JSON.stringify({ homes: [home] }))
    expect(u.codexUserSkillsHomes(deps)).toEqual([home])
    expect(JSON.parse(fs.readFileSync(rf, 'utf8'))).toEqual({ homes: [home] })
    expect(fs.existsSync(`${rf}.damaged`)).toBe(true)
  })

  it('[host] a record that cannot be read now is refused and kept as it is: nothing copied, nothing removed, no folder let go (review B-Q2)', () => {
    const other = path.join(tmp, 'other-codex-home')
    fs.mkdirSync(other)
    u.stageCodexUserSkills(other, deps)
    const busy = { ...deps, readFile: (): string => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }) } }
    expect(u.stageCodexUserSkills(home, busy).outcome.staged).toBe(false)
    expect(fs.existsSync(path.join(home, 'skills'))).toBe(false)
    u.reconcileCodexUserSkills(false, busy)
    expect(isCopied(other, 'agent-canvas')).toBe(true)
    expect(u.codexUserSkillsHomes(deps)).toEqual([other])
    expect(fs.existsSync(`${deps.recordFile()}.damaged`)).toBe(false)
  })

  it('[host] entries that are not full paths are dropped', () => {
    fs.writeFileSync(deps.recordFile(), JSON.stringify({ homes: ['relative/x', 7, '', home, home] }))
    expect(u.codexUserSkillsHomes(deps)).toEqual([home])
  })

  it('[host] two folders whose names differ only in letter case: one folder on Windows, two elsewhere (a macOS or Linux volume can tell them apart; review L1-3)', () => {
    const rf = deps.recordFile()
    fs.writeFileSync(rf, JSON.stringify({ homes: ['C:\\Codex\\Home', 'c:\\codex\\home'] }))
    expect(u.codexUserSkillsHomes({ recordFile: () => rf, platform: 'win32' })).toHaveLength(1)
    fs.writeFileSync(rf, JSON.stringify({ homes: ['/Users/a/Codex', '/Users/a/codex'] }))
    expect(u.codexUserSkillsHomes({ recordFile: () => rf, platform: 'darwin' })).toHaveLength(2)
    expect(u.codexUserSkillsHomes({ recordFile: () => rf, platform: 'linux' })).toHaveLength(2)
  })
})

describe('removal', () => {
  it('[host] removes only the app\'s marked folders, and the record lets the folder go', () => {
    u.stageCodexUserSkills(home, deps)
    u.removeCodexUserSkills(home, deps)
    for (const skill of SKILLS) expect(fs.existsSync(skillDir(home, skill.name))).toBe(false)
    expect(u.codexUserSkillsHomes(deps)).toEqual([])
  })

  it('[host] a staging folder a crash left is swept with them; one that is not the app\'s stays', () => {
    u.stageCodexUserSkills(home, deps)
    const left = path.join(home, 'skills', `${STAGING_PREFIX}Ab12Cd`, SKILLS[0].name)
    fs.mkdirSync(left, { recursive: true })
    fs.writeFileSync(path.join(left, STAGED_SKILL_MARK), STAGED_SKILL_MARK_BYTES)
    const theirs = path.join(home, 'skills', `${STAGING_PREFIX}Zz99Zz`)
    fs.mkdirSync(theirs)
    fs.writeFileSync(path.join(theirs, 'mine.txt'), 'theirs')
    u.removeCodexUserSkills(home, deps)
    expect(fs.existsSync(path.dirname(left))).toBe(false)
    expect(fs.readFileSync(path.join(theirs, 'mine.txt'), 'utf8')).toBe('theirs')
  })

  it('[host] never throws for a folder that is gone, and lets it go', () => {
    u.stageCodexUserSkills(home, deps)
    fs.rmSync(home, { recursive: true, force: true })
    expect(() => u.removeCodexUserSkills(home, deps)).not.toThrow()
    expect(u.codexUserSkillsHomes(deps)).toEqual([])
  })
})

describe('the switches (question 5, answered C: removed when Codex or the built-in tools are turned off)', () => {
  let other: string
  beforeEach(() => {
    other = path.join(tmp, 'other-codex-home')
    fs.mkdirSync(other)
  })

  it('[host] off: the app\'s copies go from every recorded folder, the user\'s own skills stay, and the record empties', () => {
    plantOwn(other, 'conductor-vision')
    u.stageCodexUserSkills(home, deps)
    u.stageCodexUserSkills(other, deps)
    u.reconcileCodexUserSkills(false, deps)
    for (const h of [home, other]) for (const name of ['agent-canvas', 'canvas-plan']) expect(fs.existsSync(skillDir(h, name))).toBe(false)
    expect(fs.existsSync(skillDir(home, 'conductor-vision'))).toBe(false)
    expect(ownIntact(other, 'conductor-vision')).toBe(true)
    expect(u.codexUserSkillsHomes(deps)).toEqual([])
  })

  it('[host] on: the copies already there are kept current, and none is added where there is none', () => {
    u.stageCodexUserSkills(home, deps)
    u.stageCodexUserSkills(other, deps)
    fs.writeFileSync(path.join(skillDir(home, 'agent-canvas'), 'SKILL.md'), 'an older version of the skill')
    fs.rmSync(skillDir(home, 'canvas-plan'), { recursive: true })
    fs.rmSync(path.join(other, 'skills'), { recursive: true })
    u.reconcileCodexUserSkills(true, deps)
    expect(isCopied(home, 'agent-canvas')).toBe(true)
    expect(fs.existsSync(skillDir(home, 'canvas-plan'))).toBe(false)
    expect(fs.existsSync(path.join(other, 'skills'))).toBe(false)
    // A folder with none of the app's copies left leaves the record.
    expect(u.codexUserSkillsHomes(deps)).toEqual([home])
  })

  it.each([
    ['the built-in tools switched off', { conductorToolsEnabled: false }, true, false],
    ['Codex not on', {}, false, false],
    ['both on (the tools on by default)', {}, true, true],
    ['both on (the tools on by name)', { conductorToolsEnabled: true }, true, true],
  ])('[host] wanted: %s', (_name, settings, codexOn, wanted) => {
    expect(u.codexUserSkillsWanted({ settings: () => settings, codexOn: () => codexOn })).toBe(wanted)
  })

  it('[host] settings that cannot be read are no answer: nothing is copied or removed', () => {
    expect(u.codexUserSkillsWanted({ settings: () => null, codexOn: () => false })).toBeNull()
    expect(u.codexUserSkillsWanted({ settings: () => { throw new Error('EBUSY') }, codexOn: () => false })).toBeNull()
    vi.useFakeTimers()
    u.stageCodexUserSkills(home, deps)
    u.startCodexUserSkills({ settings: () => null, codexOn: () => false, startDelayMs: 10, deps })
    vi.advanceTimersByTime(10)
    u.codexUserSkillsSettingsChanged()
    for (const skill of SKILLS) expect(isCopied(home, skill.name)).toBe(true)
  })

  it('[host] wired: nothing before the start delay, then the start pass; a settings save and an accounts change each apply the switches', () => {
    vi.useFakeTimers()
    const s = { settings: {} as Record<string, unknown>, codexOn: true, listener: null as null | (() => void) }
    u.stageCodexUserSkills(home, deps)
    u.startCodexUserSkills({
      settings: () => s.settings, codexOn: () => s.codexOn, startDelayMs: 50, deps,
      subscribe: (l) => { s.listener = l; return () => { s.listener = null } },
    })
    // Turned off before the start pass: nothing happens until it runs.
    s.settings = { conductorToolsEnabled: false }
    u.codexUserSkillsSettingsChanged()
    expect(isCopied(home, 'agent-canvas')).toBe(true)
    vi.advanceTimersByTime(50)
    expect(fs.existsSync(skillDir(home, 'agent-canvas'))).toBe(false)
    // Copied again by a launch; the Providers switch turns Codex off.
    s.settings = {}
    u.codexUserSkillsSettingsChanged()
    u.stageCodexUserSkills(home, deps)
    s.codexOn = false
    s.listener?.()
    expect(fs.existsSync(skillDir(home, 'agent-canvas'))).toBe(false)
    // A settings save with the tools off removes them too.
    s.codexOn = true
    s.listener?.()
    u.stageCodexUserSkills(home, deps)
    s.settings = { conductorToolsEnabled: false }
    u.codexUserSkillsSettingsChanged()
    expect(fs.existsSync(skillDir(home, 'agent-canvas'))).toBe(false)
  })

  it('[host] the start pass keeps the copies current while both are on (an app update)', () => {
    vi.useFakeTimers()
    u.stageCodexUserSkills(home, deps)
    fs.writeFileSync(path.join(skillDir(home, 'conductor-vision'), 'SKILL.md'), 'an older version of the skill')
    u.startCodexUserSkills({ settings: () => ({}), codexOn: () => true, startDelayMs: 5, deps })
    vi.advanceTimersByTime(5)
    expect(isCopied(home, 'conductor-vision')).toBe(true)
  })

  it('[host] stopped: a later settings save does nothing', () => {
    vi.useFakeTimers()
    u.stageCodexUserSkills(home, deps)
    u.startCodexUserSkills({ settings: () => ({ conductorToolsEnabled: false }), codexOn: () => true, startDelayMs: 5, deps })
    u.stopCodexUserSkills()
    vi.advanceTimersByTime(5)
    u.codexUserSkillsSettingsChanged()
    expect(isCopied(home, 'agent-canvas')).toBe(true)
  })
})
