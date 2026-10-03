// HOST QUARANTINE: plants directory links (junctions on Windows). CI and the test VM only; never on the owner's
// workstation (the host test rules). P4.11 review C-1, C-2: the README staging guard refuses a staging root, a
// staging folder or a project folder reached through a link, and its remover takes a link away as a link.
/**
 * [CI] [VM] Every link points at a decoy folder of this file's own mkdtemp
 * folder (its own prefix, directly in the temp folder), removed by that
 * prefix and parent alone; a link is removed as a link before the tree.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync, unlinkSync, rmdirSync, lstatSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { createRequire } from 'module'

const STAGE_DIR = resolve(__dirname, '..', '..', '..', 'scripts', 'readme-shots', 'stage')
const S = createRequire(join(STAGE_DIR, 'seed.js'))('./stage-root.js') as {
  MARKER: string; DEV_MARKER: string
  resolveStage: (env: Record<string, string | undefined>, platform?: string, deps?: Record<string, unknown>) => Record<string, string>
  checkDevTargets: (dev: string) => void
  removeNoFollow: (p: string) => void
}

const PREFIX = 'ccc-test-readme-stage-links-'
const made: string[] = []
const links: string[] = []
afterEach(() => {
  for (const l of links.splice(0)) { try { lstatSync(l); try { unlinkSync(l) } catch { rmdirSync(l) } } catch { /* gone */ } }
  for (const d of made.splice(0)) if (dirname(d) === tmpdir() && basename(d).startsWith(PREFIX)) rmSync(d, { recursive: true, force: true })
})
const base = (): string => { const d = mkdtempSync(join(tmpdir(), PREFIX)); made.push(d); return d }
const link = (target: string, at: string) => { mkdirSync(dirname(at), { recursive: true }); symlinkSync(target, at, 'junction'); links.push(at) }
const noReg = { registryFolders: () => [] as string[] }

describe('the README staging guard and links', () => {
  it('[CI] [VM] refuses a staging root reached through a link', () => {
    const b = base()
    const decoyHome = join(b, 'decoy-home'); mkdirSync(join(decoyHome, '.claude'), { recursive: true })
    link(decoyHome, join(b, 'root-link'))
    expect(() => S.resolveStage({ CCC_STAGE_ROOT: join(b, 'root-link'), CCC_STAGE_DEV: join(b, 'root-link', 'dev') }, process.platform, noReg)).toThrow(/link on its path/)
  })

  it('[CI] [VM] refuses a staging folder that is a link out of the root', () => {
    const b = base()
    const root = join(b, 'stage'); mkdirSync(root)
    const decoyHome = join(b, 'decoy-home'); mkdirSync(decoyHome)
    link(decoyHome, join(root, 'data'))
    expect(() => S.resolveStage({ CCC_STAGE_ROOT: root, CCC_STAGE_DEV: join(root, 'dev') }, process.platform, noReg)).toThrow(/CCC_STAGE_DATA .* has a link on its path/)
  })

  it('[CI] [VM] refuses a project folder that is a link, even to a marked folder', () => {
    const b = base()
    const dev = join(b, 'dev'); mkdirSync(dev)
    const marked = join(b, 'elsewhere'); mkdirSync(marked); writeFileSync(join(marked, S.DEV_MARKER), 'm')
    link(marked, join(dev, 'web'))
    expect(() => S.checkDevTargets(dev)).toThrow(/was not made by this tool/)
  })

  it('[CI] [VM] the remover takes a link away as a link and never enters it', () => {
    const b = base()
    const target = join(b, 'keep'); mkdirSync(target); writeFileSync(join(target, 'precious.txt'), 'x')
    const tree = join(b, 'tree'); mkdirSync(tree)
    link(target, join(tree, 'link'))
    S.removeNoFollow(tree)
    expect(existsSync(tree)).toBe(false)
    expect(readdirSync(target)).toEqual(['precious.txt'])
  })
})
