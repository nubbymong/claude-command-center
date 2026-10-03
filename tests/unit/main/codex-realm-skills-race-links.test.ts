// HOST QUARANTINE: plants directory junctions and symbolic links. [CI] [VM] only -- never run on the owner's machine.
/**
 * ADR-009 round 1 (PR 4, finding L2-2): staging the canvas skills into a
 * managed Codex realm (src/main/canvas/codex-realm-skills.ts) writes nothing
 * outside the realm's `skills/` when a REAL link is put in place of a path it
 * checked, mid-stage -- what a session of the same account running approved
 * commands outside the sandbox could do -- and then does not report the skill
 * staged. The host-safe twin, with the swap made in an injected file system,
 * is codex-realm-skills-swap.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const hook = vi.hoisted(() => ({ outside: '', swapMadeFolder: false, plantAt: '' }))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/account-profiles')>()
  return {
    ...actual,
    // The folder just made is put back as a link to a folder outside.
    mkdirSecure: (dir: string) => {
      actual.mkdirSecure(dir)
      if (hook.swapMadeFolder && hook.outside) {
        hook.swapMadeFolder = false
        fs.rmdirSync(dir)
        fs.symlinkSync(hook.outside, dir, process.platform === 'win32' ? 'junction' : 'dir')
      }
    },
    // A link appears at a skill's own path as the first file is written.
    atomicWriteSecure: (file: string, data: string | Uint8Array, mode?: number) => {
      if (hook.plantAt && hook.outside) {
        const at = hook.plantAt
        hook.plantAt = ''
        try { fs.rmSync(at, { recursive: true, force: true }) } catch { /* nothing there */ }
        fs.symlinkSync(hook.outside, at, process.platform === 'win32' ? 'junction' : 'dir')
      }
      return actual.atomicWriteSecure(file, data, mode)
    },
  }
})

const { stageCodexRealmSkills } = await import('../../../src/main/canvas/codex-realm-skills')
const { codexManagedRealmSkillsDir } = await import('../../../src/main/providers/codex/realm-paths')
const { canvasSkillFiles } = await import('../../../src/main/canvas/canvas-plugin')

let tmp = ''
const links: string[] = []
afterEach(() => {
  hook.outside = ''
  hook.swapMadeFolder = false
  hook.plantAt = ''
  for (const l of links.splice(0)) { try { if (fs.lstatSync(l).isSymbolicLink()) fs.rmdirSync(l) } catch { /* gone */ } }
  if (tmp && path.basename(tmp).startsWith('ccc-realm-race-')) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

function realm(): { home: string; skills: string } {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-realm-race-')))
  const home = path.join(tmp, 'codex-realms', 'realm-0123456789abcdef0123')
  fs.mkdirSync(home, { recursive: true })
  hook.outside = path.join(tmp, 'outside')
  fs.mkdirSync(hook.outside)
  fs.writeFileSync(path.join(hook.outside, 'precious.txt'), 'keep me')
  return { home, skills: path.join(home, 'skills') }
}

describe('a real link put in place mid-stage', () => {
  it('the folder just made (skills/) swapped for a link: nothing written outside, nothing staged', () => {
    const { home, skills } = realm()
    links.push(skills)
    hook.swapMadeFolder = true
    const out = stageCodexRealmSkills(home, codexManagedRealmSkillsDir(home, tmp))
    expect(fs.readdirSync(hook.outside)).toEqual(['precious.txt'])
    expect(out.staged).toBe(false)
  })

  it('a link appears at a skill\'s own path as its files are written: nothing written outside, the skill not staged, the link not followed', () => {
    const { home, skills } = realm()
    const first = path.join(skills, canvasSkillFiles()[0].name)
    links.push(first)
    hook.plantAt = first
    const out = stageCodexRealmSkills(home, codexManagedRealmSkillsDir(home, tmp))
    expect(fs.readdirSync(hook.outside)).toEqual(['precious.txt'])
    expect(fs.readFileSync(path.join(hook.outside, 'precious.txt'), 'utf8')).toBe('keep me')
    expect(out.staged).toBe(false)
    expect(fs.lstatSync(first).isSymbolicLink()).toBe(true)
  })
})

describe('a real link with the staging name (ADR-009 round 2)', () => {
  it.each(['stage', 'removal'])('at %s it is removed as the link itself, its target untouched', async (op) => {
    const { removeCodexRealmSkills, STAGING_PREFIX } = await import('../../../src/main/canvas/codex-realm-skills')
    const { home, skills } = realm()
    fs.mkdirSync(skills)
    const theirs = path.join(hook.outside, canvasSkillFiles()[0].name)
    fs.mkdirSync(theirs)
    fs.writeFileSync(path.join(theirs, 'SKILL.md'), 'theirs')
    const link = path.join(skills, `${STAGING_PREFIX}Qr12St`)
    links.push(link)
    fs.symlinkSync(hook.outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    if (op === 'stage') expect(stageCodexRealmSkills(home, codexManagedRealmSkillsDir(home, tmp))).toEqual({ staged: true })
    else removeCodexRealmSkills(home, codexManagedRealmSkillsDir(home, tmp))
    expect(fs.existsSync(link)).toBe(false)
    expect(fs.readdirSync(hook.outside).sort()).toEqual([canvasSkillFiles()[0].name, 'precious.txt'])
    expect(fs.readFileSync(path.join(theirs, 'SKILL.md'), 'utf8')).toBe('theirs')
  })
})
