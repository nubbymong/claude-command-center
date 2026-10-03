// HOST QUARANTINE: plants junctions and symbolic links. [CI] [VM] only -- never run on the owner's machine.
/**
 * WP2 PR 4, P4.1 (row 51): the managed-realm skills staging
 * (src/main/canvas/codex-realm-skills.ts) refuses a link of any kind at the
 * realm's `skills/` folder or at a skill folder: it writes nothing through
 * it, removes nothing through it, and reports the skills not staged. A
 * session that answered Codex's first-launch screens runs approved commands
 * outside the sandbox (PB8), so a link planted in the realm is the expected
 * attack: a write or a recursive delete that followed one would land in
 * whatever it points at, with the user's own rights.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const { stageCodexRealmSkills, removeCodexRealmSkills, STAGED_SKILL_MARK, STAGED_SKILL_MARK_BYTES } = await import('../../../src/main/canvas/codex-realm-skills')
// The skills folder comes from the Codex package's path rule (realm-paths.ts),
// which the launch reaches through the registered provider (stagedSkillsDir).
const { codexManagedRealmSkillsDir } = await import('../../../src/main/providers/codex/realm-paths')
const stage = (h: string, r: string) => stageCodexRealmSkills(h, codexManagedRealmSkillsDir(h, r))
const remove = (h: string, r: string) => removeCodexRealmSkills(h, codexManagedRealmSkillsDir(h, r))
const { canvasSkillFiles } = await import('../../../src/main/canvas/canvas-plugin')

const REALM = 'realm-fedcba9876543210fedc'
const LINK_KIND = process.platform === 'win32' ? 'junction' : 'dir'
let res: string
let home: string
let outside: string

beforeEach(() => {
  res = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-realm-links-')))
  outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-realm-outside-')))
  home = path.join(res, 'codex-realms', REALM)
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me')
})
afterEach(() => {
  for (const dir of [path.join(home, 'skills'), path.join(home, 'skills', 'agent-canvas')]) {
    try { if (fs.lstatSync(dir).isSymbolicLink()) fs.unlinkSync(dir) } catch { /* not a link */ }
  }
  fs.rmSync(res, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

describe('links in a managed realm', () => {
  it('a link at skills/: nothing written through it, the skills not staged', () => {
    fs.symlinkSync(outside, path.join(home, 'skills'), LINK_KIND)
    expect(stage(home, res)).toEqual({ staged: false, reason: 'link' })
    expect(fs.readdirSync(outside)).toEqual(['precious.txt'])
  })

  it('a link at skills/: removal deletes nothing through it', () => {
    fs.mkdirSync(path.join(outside, 'agent-canvas'))
    fs.writeFileSync(path.join(outside, 'agent-canvas', 'SKILL.md'), canvasSkillFiles()[0].bytes)
    fs.writeFileSync(path.join(outside, 'agent-canvas', STAGED_SKILL_MARK), STAGED_SKILL_MARK_BYTES)
    fs.symlinkSync(outside, path.join(home, 'skills'), LINK_KIND)
    remove(home, res)
    expect(fs.existsSync(path.join(outside, 'agent-canvas', 'SKILL.md'))).toBe(true)
  })

  it('a link at a skill folder: left alone, its target untouched, the skill not staged', () => {
    fs.mkdirSync(path.join(home, 'skills'))
    fs.symlinkSync(outside, path.join(home, 'skills', 'agent-canvas'), LINK_KIND)
    expect(stage(home, res)).toEqual({ staged: false, reason: 'link' })
    expect(fs.readdirSync(outside)).toEqual(['precious.txt'])
    expect(fs.lstatSync(path.join(home, 'skills', 'agent-canvas')).isSymbolicLink()).toBe(true)
    remove(home, res)
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me')
  })

  it('a link planted INSIDE the app\'s own folder: the rebuild removes the link, never its target', () => {
    expect(stage(home, res)).toEqual({ staged: true })
    fs.symlinkSync(outside, path.join(home, 'skills', 'canvas-plan', 'refs'), LINK_KIND)
    expect(stage(home, res)).toEqual({ staged: true })
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me')
    expect(fs.readdirSync(path.join(home, 'skills', 'canvas-plan')).sort()).toEqual([STAGED_SKILL_MARK, 'SKILL.md'].sort())
  })
})
