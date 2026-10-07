// [host] ADR-009 round 1 (PR 4, finding L2-2): staging the canvas skills into
// a managed Codex realm (src/main/canvas/codex-realm-skills.ts) writes nothing
// outside the realm's `skills/`, and does not report a skill staged, when a
// path it checked is swapped for a link to a folder outside between the check
// and a later write. Host-safe: the swap is made in an injected file system
// (the module's RealmSkillsIo) over a real temporary folder, which treats the
// swapped path as a link the way Windows and POSIX do (reads and writes under
// it land in its target; lstat says link; a folder cannot be renamed onto it;
// removing it removes the link only). No link is planted on this machine; the
// real-link cases are codex-realm-skills-race-links.test.ts (quarantined from the
// host: CI and VM only).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { stageCodexRealmSkills, removeCodexRealmSkills, realRealmSkillsIo, STAGING_PREFIX } = await import('../../../src/main/canvas/codex-realm-skills')
type RealmSkillsIo = typeof realRealmSkillsIo
const { codexManagedRealmSkillsDir } = await import('../../../src/main/providers/codex/realm-paths')
const { canvasSkillFiles } = await import('../../../src/main/canvas/canvas-plugin')

const REALM = 'realm-0123456789abcdef0123'
let res = ''
let home = ''
let skills = ''
let outside = ''

beforeEach(() => {
  res = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-realm-swap-')))
  home = path.join(res, 'codex-realms', REALM)
  skills = path.join(home, 'skills')
  outside = path.join(res, 'outside')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(outside)
})
afterEach(() => {
  fs.rmSync(res, { recursive: true, force: true })
})

type Op = 'mkdirChecked' | 'mkdir' | 'mkdtemp' | 'writeFile'

/** The real file system, except that once `when` says so (after the named
 *  operation has done its work) the path `at` names is swapped for a link to
 *  `target`: whatever stood there goes, and the link stands in its place. */
function swappingIo(when: (op: Op, p: string) => boolean, at: (p: string) => string, target: () => string) {
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
    // A folder lists the links standing in it, as a real one does.
    readdir: (p) => [...fs.readdirSync(through(p)), ...[...links.keys()].filter((l) => path.dirname(l) === norm(p)).map((l) => path.basename(l))],
    readFile: (p) => fs.readFileSync(through(p)),
    mkdirChecked: (p) => {
      if (links.has(norm(p))) throw new Error('refusing: a link')
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
  return { io, links, get swapped() { return swapped } }
}

const stage = (io: RealmSkillsIo) => stageCodexRealmSkills(home, codexManagedRealmSkillsDir(home, res), io)
const FIRST = canvasSkillFiles()[0].name
const inSkills = (p: string): boolean => p.startsWith(skills + path.sep)
const stagingLeft = (): string[] => (fs.existsSync(skills) ? fs.readdirSync(skills).filter((n) => n.startsWith(STAGING_PREFIX)) : [])

describe('a path swapped for a link between the check and the write', () => {
  it('[host] the skill folder\'s own path, after it was checked: nothing written outside, the skill not staged (finding L2-2)', () => {
    const s = swappingIo((op, p) => op === 'writeFile' && inSkills(p), () => path.join(skills, FIRST), () => outside)
    const out = stage(s.io)
    expect(s.swapped).toBe(true)
    expect(fs.readdirSync(outside)).toEqual([])
    expect(out.staged).toBe(false)
    // The link was not followed or removed by the app, and no staging folder is left.
    expect(s.links.has(path.join(skills, FIRST))).toBe(true)
    expect(stagingLeft()).toEqual([])
  })

  it('[host] the skill folder\'s path swapped after the folder was built, before it is put in place: the same', () => {
    let writes = 0
    const s = swappingIo((op, p) => op === 'writeFile' && inSkills(p) && ++writes === 2, () => path.join(skills, FIRST), () => outside)
    expect(stage(s.io).staged).toBe(false)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('[host] the staging folder itself, swapped as it was made: nothing written, the link removed, the skill not staged', () => {
    const s = swappingIo((op) => op === 'mkdtemp', (p) => p, () => outside)
    expect(stage(s.io).staged).toBe(false)
    expect(fs.readdirSync(outside)).toEqual([])
    expect(s.links.size).toBe(0)
    expect(fs.existsSync(path.join(skills, FIRST))).toBe(false)
  })

  it('[host] the skills folder, swapped right after it was made: nothing staged, nothing written outside', () => {
    const s = swappingIo((op) => op === 'mkdirChecked', () => skills, () => outside)
    expect(stage(s.io)).toEqual({ staged: false, reason: 'link' })
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('[host] the staging folder swapped after its check, before the writes: the skill is not staged and nothing is put in its place', () => {
    const s = swappingIo((op, p) => op === 'writeFile' && inSkills(p), (p) => path.dirname(path.dirname(p)), () => outside)
    // The folder the swap points at is laid out as the build expects.
    fs.mkdirSync(path.join(outside, FIRST))
    expect(stage(s.io).staged).toBe(false)
    expect(fs.existsSync(path.join(skills, FIRST))).toBe(false)
    expect(s.links.size).toBe(0)
  })

  it('[host] with nothing swapped the same file system stages every skill (the stand-in is faithful)', () => {
    const s = swappingIo(() => false, (p) => p, () => outside)
    expect(stage(s.io)).toEqual({ staged: true })
    for (const skill of canvasSkillFiles()) expect(fs.readFileSync(path.join(skills, skill.name, 'SKILL.md')).equals(skill.bytes)).toBe(true)
    expect(stagingLeft()).toEqual([])
  })
})

describe('a link with the staging name (ADR-009 round 2)', () => {
  it.each(['stage', 'removal'] as const)('[host] at %s it is removed as the link itself; its target is never followed', (op) => {
    fs.mkdirSync(skills, { recursive: true })
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me')
    fs.mkdirSync(path.join(outside, FIRST))
    fs.writeFileSync(path.join(outside, FIRST, 'SKILL.md'), 'theirs')
    const s = swappingIo(() => false, (p) => p, () => outside)
    const link = path.join(skills, `${STAGING_PREFIX}Qr12St`)
    s.links.set(link, outside)
    if (op === 'stage') expect(stage(s.io)).toEqual({ staged: true })
    else removeCodexRealmSkills(home, codexManagedRealmSkillsDir(home, res), s.io)
    expect(s.links.has(link)).toBe(false)
    expect(fs.readdirSync(outside).sort()).toEqual([FIRST, 'precious.txt'])
    expect(fs.readFileSync(path.join(outside, FIRST, 'SKILL.md'), 'utf8')).toBe('theirs')
  })
})
