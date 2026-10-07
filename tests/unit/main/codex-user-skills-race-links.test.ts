// HOST QUARANTINE: plants directory junctions and symbolic links. [CI] [VM] only -- never run on the owner's machine.
/**
 * WP2 PR 4 (row 51; section 10 question 5, answered C): copying the canvas
 * skills into this computer's own Codex skills folder
 * (src/main/canvas/codex-user-skills.ts) writes nothing outside that folder
 * when a REAL link is put in place of a path it checked, mid-copy -- what any
 * program the user runs could do in the user's own folder -- and then does
 * not report the skill copied. The host-safe twin, with the swap made in an
 * injected file system, is codex-user-skills-swap.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const hook = vi.hoisted(() => ({ outside: '', swapMadeFolder: false, plantAt: '' }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
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
    // A link appears at a skill's own path as the first skill file is written
    // (the record's own write passes through untouched).
    atomicWriteSecure: (file: string, data: string | Uint8Array, mode?: number) => {
      if (hook.plantAt && hook.outside && !file.endsWith('.json')) {
        const at = hook.plantAt
        hook.plantAt = ''
        try { fs.rmSync(at, { recursive: true, force: true }) } catch { /* nothing there */ }
        fs.symlinkSync(hook.outside, at, process.platform === 'win32' ? 'junction' : 'dir')
      }
      return actual.atomicWriteSecure(file, data, mode)
    },
  }
})

const u = await import('../../../src/main/canvas/codex-user-skills')
const { canvasSkillFiles } = await import('../../../src/main/canvas/canvas-plugin')

let tmp = ''
const links: string[] = []
afterEach(() => {
  hook.outside = ''
  hook.swapMadeFolder = false
  hook.plantAt = ''
  for (const l of links.splice(0)) { try { if (fs.lstatSync(l).isSymbolicLink()) fs.rmdirSync(l) } catch { /* gone */ } }
  if (tmp && path.basename(tmp).startsWith('ccc-user-race-')) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

function own(): { home: string; skills: string; deps: { recordFile: () => string } } {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-user-race-')))
  const home = path.join(tmp, 'own-codex')
  fs.mkdirSync(home)
  hook.outside = path.join(tmp, 'outside')
  fs.mkdirSync(hook.outside)
  fs.writeFileSync(path.join(hook.outside, 'precious.txt'), 'keep me')
  return { home, skills: path.join(home, 'skills'), deps: { recordFile: () => path.join(tmp, u.CODEX_USER_SKILLS_RECORD) } }
}

describe('a real link put in place mid-copy', () => {
  it('the folder just made (skills/) swapped for a link: nothing written outside, nothing copied', () => {
    const { home, skills, deps } = own()
    links.push(skills)
    hook.swapMadeFolder = true
    const out = u.stageCodexUserSkills(home, deps)
    expect(fs.readdirSync(hook.outside)).toEqual(['precious.txt'])
    expect(out.outcome.staged).toBe(false)
  })

  it('a link appears at a skill\'s own path as its files are written: nothing written outside, the skill not copied, the link not followed', () => {
    const { home, skills, deps } = own()
    const first = path.join(skills, canvasSkillFiles()[0].name)
    links.push(first)
    hook.plantAt = first
    const out = u.stageCodexUserSkills(home, deps)
    expect(fs.readdirSync(hook.outside)).toEqual(['precious.txt'])
    expect(fs.readFileSync(path.join(hook.outside, 'precious.txt'), 'utf8')).toBe('keep me')
    expect(out.skipped.map((s) => s.name)).toContain(canvasSkillFiles()[0].name)
    expect(fs.lstatSync(first).isSymbolicLink()).toBe(true)
  })
})
