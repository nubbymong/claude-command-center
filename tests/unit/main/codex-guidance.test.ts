// [host] WP2 PR 4, P4.1 (row 51; section 10 question 5, built as its default
// A): which Codex launches carry the Agent Canvas, canvas-plan and Conductor
// vision guidance, and how (src/main/canvas/codex-guidance.ts).
//  - a managed account: its staged skills;
//  - this computer's own sign-in: `-c developer_instructions` on the direct
//    route only, for a version whose settings layers are established, and
//    only when no settings layer Codex reads names `developer_instructions`
//    (one case per layer), failing toward passing nothing; inline on Windows
//    (at most 6,000 characters), a pointer to the plugin's skills elsewhere;
//  - otherwise the tools alone, and why, for the canvas page's line.
// Temporary folders stand in for the account's Codex folder and the project,
// and the scan is handed a reader held to that temporary tree: the walk still
// names every folder above it and the system layer, but anything outside the
// tree is answered as absent without a read. The fs module is watched too:
// while a test body runs, any read outside the tree is refused before it
// reaches the disk and recorded, and every test fails if one was asked for.
// So nothing here reads this user's own ~/.codex or ProgramData (review A-4).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const watch = vi.hoisted(() => ({ root: '', armed: false, outside: [] as string[] }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const nodePath = await import('path')
  const inside = (p: unknown): boolean => {
    if (!watch.armed) return true
    const rel = nodePath.relative(watch.root, nodePath.resolve(String(p)))
    return rel === '' || (!rel.startsWith('..') && !nodePath.isAbsolute(rel))
  }
  const refuse = (p: unknown): never => {
    watch.outside.push(String(p))
    throw Object.assign(new Error(`refused: outside the test tree: ${String(p)}`), { code: 'ENOENT' })
  }
  const guard = <F extends (...a: any[]) => any>(fn: F): F => ((p: unknown, ...rest: unknown[]) => (inside(p) ? fn(p, ...rest) : refuse(p))) as F
  const watched = {
    ...actual,
    statSync: guard(actual.statSync), lstatSync: guard(actual.lstatSync), readFileSync: guard(actual.readFileSync),
    readdirSync: guard(actual.readdirSync), openSync: guard(actual.openSync),
    existsSync: (p: Parameters<typeof actual.existsSync>[0]) => (inside(p) ? actual.existsSync(p) : (watch.outside.push(String(p)), false)),
  }
  return { ...watched, default: watched }
})

const g = await import('../../../src/main/canvas/codex-guidance')
type LayerFs = NonNullable<Parameters<typeof g.decideCodexGuidance>[0]['layerFs']>
const { canvasSkillFiles } = await import('../../../src/main/canvas/canvas-plugin')

let root: string
let home: string
let project: string
let programData: string

/** A reader held to the temporary tree: what lies outside it is answered as
 *  absent, never read, and the path is noted (the walk still asks for it). */
function jailedReader(): LayerFs & { asked: string[] } {
  const asked: string[] = []
  const inRoot = (p: string): boolean => {
    const rel = path.relative(root, path.resolve(p))
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }
  const absent = (p: string): never => { asked.push(p); throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' }) }
  return {
    asked,
    stat: (file) => (inRoot(file) ? fs.statSync(file) : absent(file)),
    readText: (file) => (inRoot(file) ? fs.readFileSync(file, 'utf8') : absent(file)),
    list: (dir) => (inRoot(dir) ? fs.readdirSync(dir) : absent(dir)),
  }
}
let reader: ReturnType<typeof jailedReader>

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-guidance-')))
  home = path.join(root, 'codex-home')
  project = path.join(root, 'repo', 'app')
  programData = path.join(root, 'ProgramData')
  for (const d of [home, path.join(home, 'sessions'), project, programData]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5.5"\n[projects."C:\\\\repo"]\ntrust_level = "trusted"\n')
  g._resetCodexGuidanceForTest()
  reader = jailedReader()
  watch.root = root
  watch.outside = []
  watch.armed = true
})
afterEach(() => {
  watch.armed = false
  fs.rmSync(root, { recursive: true, force: true })
  // No test read anything outside its temporary tree.
  expect(watch.outside).toEqual([])
})

const input = (over: Partial<Parameters<typeof g.decideCodexGuidance>[0]> = {}): Parameters<typeof g.decideCodexGuidance>[0] => ({
  platform: 'win32',
  route: 'direct',
  external: true,
  cliVersion: '0.155.1',
  home,
  cwds: [project],
  pluginSkillsDir: path.join(root, 'res', 'canvas-plugin', 'skills'),
  env: { ProgramData: programData },
  layerFs: reader,
  ...over,
})
const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

describe('this computer\'s sign-in: the default A', () => {
  it('passes the inline guidance on Windows when every layer is clear', () => {
    const d = g.decideCodexGuidance(input())
    expect(d.guidance).toEqual({ guidance: 'full' })
    expect(d.developerInstructions).toBe(g.codexInlineGuidance())
  })

  it('the inline text is at most 6,000 characters, ASCII apart from the review marker line\'s own characters', () => {
    const text = g.codexInlineGuidance()
    expect(text.length).toBeLessThanOrEqual(6_000)
    const nonAscii = [...text].filter((c) => c.charCodeAt(0) > 126)
    expect(new Set(nonAscii)).toEqual(new Set([String.fromCharCode(0x2014), String.fromCharCode(0xb7)]))
    for (const tool of ['canvas_render', 'canvas_snapshot', 'canvas_review', 'canvas_resolve', 'canvas_verdict', 'canvas_version_verdict', 'canvas_pick', 'canvas_complete', 'vision_text', 'open_in_app_browser']) {
      expect(text).toContain(tool)
    }
    expect(text).toContain(`Review #3 ${String.fromCharCode(0x2014)} 5 notes ${String.fromCharCode(0xb7)} canvas_review R3`)
  })

  it.each(['linux', 'darwin'] as const)('on %s a pointer naming the three skills and where their full text is', (platform) => {
    const d = g.decideCodexGuidance(input({ platform, env: {} }))
    expect(d.guidance).toEqual({ guidance: 'full' })
    for (const skill of canvasSkillFiles()) {
      expect(d.developerInstructions).toContain(`- ${skill.name}: ${skill.description}`)
      expect(d.developerInstructions).toContain(path.join(root, 'res', 'canvas-plugin', 'skills', skill.name, 'SKILL.md'))
    }
    expect(d.developerInstructions!.length).toBeLessThan(3_000)
  })

  it('on macOS and Linux without the plugin folder: the tools alone', () => {
    expect(g.decideCodexGuidance(input({ platform: 'linux', pluginSkillsDir: null })).guidance).toEqual({ guidance: 'tools-only', reason: 'skills-not-staged' })
  })

  it('never on the npm .cmd route', () => {
    const d = g.decideCodexGuidance(input({ route: 'cmd' }))
    expect(d).toEqual({ guidance: { guidance: 'tools-only', reason: 'npm-route' } })
  })

  it.each([null, '0.153.3', '0.157.0', '0.156.1-alpha.1'])('passes nothing on a version whose layers are not established (%s)', (v) => {
    expect(g.decideCodexGuidance(input({ cliVersion: v }))).toEqual({ guidance: { guidance: 'tools-only', reason: 'unknown-settings' } })
  })

  it.each(['0.153.4', '0.154.0', '0.155.0', '0.155.1', '0.156.0', '0.156.1'])('the established versions (%s) pass it', (v) => {
    expect(g.decideCodexGuidance(input({ cliVersion: v })).guidance).toEqual({ guidance: 'full' })
  })

  it('passes nothing when the resume picker chooses the working folder', () => {
    expect(g.decideCodexGuidance(input({ cwds: null })).guidance).toEqual({ guidance: 'tools-only', reason: 'unknown-settings' })
  })
})

describe('a settings layer that names developer_instructions: nothing passed (one case per layer)', () => {
  const NAMES = 'developer_instructions = "be terse"\n'
  it.each([
    ['the account\'s config.toml, top level', () => write(path.join(home, 'config.toml'), `model = "x"\n${NAMES}`)],
    ['a [profiles.*] table', () => write(path.join(home, 'config.toml'), `profile = "work"\n[profiles.work]\n${NAMES}`)],
    ['a profile file beside it', () => write(path.join(home, 'work.config.toml'), NAMES)],
    ['a trusted project\'s settings at the working folder', () => write(path.join(project, '.codex', 'config.toml'), NAMES)],
    ['a project\'s settings at a parent below the root marker', () => write(path.join(root, 'repo', '.codex', 'config.toml'), NAMES)],
    ['the working folder\'s own config.toml', () => write(path.join(project, 'config.toml'), NAMES)],
    ['the system layer (ProgramData)', () => write(path.join(programData, 'OpenAI', 'Codex', 'config.toml'), NAMES)],
    ['the requirements (ProgramData)', () => write(path.join(programData, 'OpenAI', 'Codex', 'requirements.toml'), 'additional_developer_instructions = "x"\n')],
    ['the account\'s managed_config.toml', () => write(path.join(home, 'managed_config.toml'), NAMES)],
    ['the enterprise cloud layer\'s cache', () => write(path.join(home, 'cloud-config-bundle-cache.json'), '{"signed_payload":{"bundle":{"config_toml":{"enterprise_managed":["developer\\u005finstructions = \\"x\\""]}}}}')],
    ['a quoted key spelled with a TOML escape', () => write(path.join(home, 'config.toml'), '"developer\\u005Finstructions" = "x"\n')],
    ['another case', () => write(path.join(home, 'config.toml'), 'DEVELOPER_INSTRUCTIONS = "x"\n')],
  ])('%s', (_name, plant) => {
    plant()
    expect(g.decideCodexGuidance(input())).toEqual({ guidance: { guidance: 'tools-only', reason: 'user-instructions' } })
  })

  it('a resumed conversation\'s own folder is read too', () => {
    const other = path.join(root, 'elsewhere')
    write(path.join(other, '.codex', 'config.toml'), NAMES)
    expect(g.decideCodexGuidance(input({ cwds: [project, other] })).guidance).toEqual({ guidance: 'tools-only', reason: 'user-instructions' })
  })

  it('a layer that cannot be read as text passes nothing', () => {
    fs.mkdirSync(path.join(project, '.codex', 'config.toml'), { recursive: true })
    expect(g.decideCodexGuidance(input()).guidance).toEqual({ guidance: 'tools-only', reason: 'unknown-settings' })
  })

  it('a folder Codex has never run in, with no cloud cache: the cloud layer is unknown, nothing passed', () => {
    fs.rmSync(path.join(home, 'sessions'), { recursive: true })
    expect(g.decideCodexGuidance(input()).guidance).toEqual({ guidance: 'tools-only', reason: 'unknown-settings' })
  })

  it('a clean cloud cache is read and passes', () => {
    write(path.join(home, 'cloud-config-bundle-cache.json'), '{"signed_payload":{"bundle":{}}}')
    expect(g.decideCodexGuidance(input()).guidance).toEqual({ guidance: 'full' })
  })

  it('the walk covers every ancestor of the working folder, the account folder and the system layer', () => {
    const files = g.codexSettingsLayerFiles({ platform: 'win32', home, cwds: [project], env: { ProgramData: programData }, fs: reader })
    expect(files).toContain(path.join(home, 'config.toml'))
    expect(files).toContain(path.join(project, '.codex', 'config.toml'))
    expect(files).toContain(path.join(root, '.codex', 'config.toml'))
    expect(files).toContain(path.join(programData, 'OpenAI', 'Codex', 'requirements.toml'))
    expect(files).toContain('C:\\ProgramData\\OpenAI\\Codex\\config.toml')
    const posix = g.codexSettingsLayerFiles({ platform: 'linux', home, cwds: [project], env: {}, fs: reader })
    expect(posix).toEqual(expect.arrayContaining(['/etc/codex/config.toml', '/etc/codex/requirements.toml', '/etc/codex/managed_config.toml', path.join(project, '.codex', 'config.toml')]))
    expect(posix.some((f) => f.includes('ProgramData'))).toBe(false)
  })
})

describe('the scan reads only through the reader it is handed (review A-4)', () => {
  it('[host] the watch reaches the fs the module itself imports: a read outside the tree is refused before the disk', () => {
    const nowhere = path.join(path.dirname(root), 'ccc-guidance-no-such-file')
    expect(() => g.NODE_LAYER_FS.stat(nowhere)).toThrow(/refused: outside the test tree/)
    expect(watch.outside).toEqual([nowhere])
    watch.outside = []
  })

  it('[host] the walk still asks for the folders above the tree and the system layer, answered as absent, and nothing outside the tree is read', () => {
    expect(g.decideCodexGuidance(input()).guidance).toEqual({ guidance: 'full' })
    expect(reader.asked).toContain(path.join(path.dirname(root), '.codex', 'config.toml'))
    expect(reader.asked).toContain('C:\\ProgramData\\OpenAI\\Codex\\config.toml')
    expect(watch.outside).toEqual([])
  })

  it('[host] a layer outside the tree is read through that reader, not the disk', () => {
    const sample = path.join(home, 'config.toml')
    const systemRequirements = 'C:\\ProgramData\\OpenAI\\Codex\\requirements.toml'
    const base = jailedReader()
    const withSystemLayer: LayerFs = {
      list: base.list,
      stat: (file) => (file === systemRequirements ? fs.statSync(sample) : base.stat(file)),
      readText: (file) => (file === systemRequirements ? 'developer_instructions = "x"\n' : base.readText(file)),
    }
    expect(g.decideCodexGuidance(input({ layerFs: withSystemLayer }))).toEqual({ guidance: { guidance: 'tools-only', reason: 'user-instructions' } })
  })
})

describe('a managed account: its staged skills', () => {
  it('full when they are staged, and no developer instructions', () => {
    expect(g.decideCodexGuidance(input({ external: false, managedSkills: { staged: true }, route: 'cmd' }))).toEqual({ guidance: { guidance: 'full' } })
  })

  it.each(['link', 'not-ours', 'failed', 'not-managed'] as const)('the tools alone when they are not (%s)', (reason) => {
    expect(g.decideCodexGuidance(input({ external: false, managedSkills: { staged: false, reason } }))).toEqual({ guidance: { guidance: 'tools-only', reason: 'skills-not-staged' } })
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
