// Ask Conductor's conversation list stays inside its help folder
// (src/main/providers/codex/spawn.ts): on every Ask route (fresh, exact
// resume, the picker) the session's environment, which the picker and its
// own git inherit, carries GIT_CEILING_DIRECTORIES = the help folder's
// parent, so git looks for a repository in the help folder alone, wherever
// the resources folder sits.
// A launch that is not Ask's is unchanged. Synthetic environments; nothing is
// started.
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as path from 'path'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execSync: vi.fn(() => { throw new Error('nothing is started here') }) }
})
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => (globalThis as any).__ceilResDir ?? '', getDataDirectory: () => '' }))
vi.mock('../../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  issueMcpSessionToken: (sessionId: string) => `tok-${sessionId}`,
}))
vi.mock('../../../../src/main/config-manager', () => ({
  readConfig: () => ({}),
  readConfigChecked: () => ({ outcome: 'absent', value: null }),
  getConfigDir: () => '/cfg',
}))
vi.mock('../../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../../src/main/providers/codex/rollout-lookup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/providers/codex/rollout-lookup')>()
  return { ...actual, resolveCodexResume: () => (globalThis as any).__ceilResume ?? null }
})

const { buildCodexSpawn } = await import('../../../../src/main/providers/codex/spawn')

const ID = '019dd000-0001-7000-8000-0000000000c1'
const STANDARD = { model: 'gpt-5.5', permissionsPreset: 'standard' as const }
const ASK = { askProjectDocMaxBytes: 65536 }
const linux = (env: Record<string, string> = {}) => ({ executable: '/usr/local/bin/codex', env: { PATH: '/usr/bin', CODEX_HOME: '/h/.codex', ...env }, sessionsDir: '/h/.codex/sessions' })
const windows = (executable: string, env: Record<string, string> = {}) => ({ executable, env: { SystemRoot: 'C:\\Windows', CODEX_HOME: 'C:\\r', ...env }, sessionsDir: 'C:\\r\\sessions' })
const ceilings = (env: Record<string, string>) => Object.keys(env).filter((k) => k.toUpperCase() === 'GIT_CEILING_DIRECTORIES')
/** The variables that name a repository for git, in any spelling. */
const repositoryNames = (env: Record<string, string>) => Object.keys(env).filter((k) => ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'].includes(k.toUpperCase()))

function win32<T>(fn: () => T): T {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try { return fn() } finally { if (orig) Object.defineProperty(process, 'platform', orig) }
}
function posix<T>(fn: () => T): T {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  try { return fn() } finally { if (orig) Object.defineProperty(process, 'platform', orig) }
}
/** A resources folder with the picker deployed; removed after the case. */
async function withPicker<T>(fn: () => T): Promise<T> {
  const fs = await vi.importActual<typeof import('fs')>('fs')
  const os = await vi.importActual<typeof import('os')>('os')
  const res = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-ask-ceiling-'))
  try {
    fs.mkdirSync(path.join(res, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(res, 'scripts', 'codex-resume-picker.js'), '// stub')
    ;(globalThis as any).__ceilResDir = res
    const out = fn() as { pickFile?: string }
    const pickDir = out.pickFile ? path.dirname(out.pickFile) : null
    if (pickDir && path.dirname(pickDir) === os.tmpdir() && /^ccc-codex-pick-/.test(path.basename(pickDir))) fs.rmSync(pickDir, { recursive: true, force: true })
    return out as T
  } finally {
    delete (globalThis as any).__ceilResDir
    if (path.dirname(res) === os.tmpdir() && /^ccc-ask-ceiling-/.test(path.basename(res))) fs.rmSync(res, { recursive: true, force: true })
  }
}

afterEach(() => { delete (globalThis as any).__ceilResume })

describe('ask lists only the conversations of its help folder', () => {
  it('a fresh Ask launch: git stops at the help folder\'s parent', () => {
    const out = posix(() => buildCodexSpawn({ sessionId: 's', cwd: '/res/help', realmLaunch: linux(), codexOptions: STANDARD, ...ASK }))
    expect(out.env.GIT_CEILING_DIRECTORIES).toBe('/res')
  })

  it('on Windows, on the npm launcher route, in the variable\'s one spelling (an inherited one is replaced)', () => {
    const out = win32(() => buildCodexSpawn({
      sessionId: 's', cwd: 'C:\\Users\\u\\Resources\\help',
      realmLaunch: windows('C:\\npm\\codex.cmd', { git_ceiling_directories: 'C:\\elsewhere' }), codexOptions: STANDARD, ...ASK,
    }))
    expect(ceilings(out.env)).toEqual(['GIT_CEILING_DIRECTORIES'])
    expect(out.env.GIT_CEILING_DIRECTORIES).toBe('C:\\Users\\u\\Resources')
  })

  it('the picker, and the git it runs, inherit it', async () => {
    const out = await withPicker(() => posix(() => buildCodexSpawn({ sessionId: 's', cwd: '/res/help', useResumePicker: true, realmLaunch: linux(), codexOptions: STANDARD, ...ASK })))
    expect(out.args[0]).toMatch(/codex-resume-picker\.js$/)
    expect(out.env.GIT_CEILING_DIRECTORIES).toBe('/res')
    expect(out.env.CCC_CODEX_EXECUTABLE).toBe('/usr/local/bin/codex')
  })

  it('an exact resume in the help folder carries it too', () => {
    ;(globalThis as any).__ceilResume = { resumeId: ID, cwd: '/res/help', cwdMismatch: false, path: '/h/.codex/sessions/x.jsonl' }
    const out = posix(() => buildCodexSpawn({ sessionId: 's', cwd: '/res/help', resume: { uuid: ID, cwd: '/res/help' }, realmLaunch: linux(), codexOptions: STANDARD, ...ASK }))
    expect(out.resumeId).toBe(ID)
    expect(out.env.GIT_CEILING_DIRECTORIES).toBe('/res')
  })

  it('an exact resume\'s git stops above the folder it starts in: the conversation\'s own, else the help folder', () => {
    ;(globalThis as any).__ceilResume = { resumeId: ID, cwd: '/res/help/sub', cwdMismatch: false, path: '/h/.codex/sessions/x.jsonl' }
    const own = posix(() => buildCodexSpawn({ sessionId: 's', cwd: '/res/help', resume: { uuid: ID, cwd: '/res/help/sub' }, realmLaunch: linux(), codexOptions: STANDARD, ...ASK }))
    expect(own.cwd).toBe('/res/help/sub')
    expect(own.env.GIT_CEILING_DIRECTORIES).toBe('/res/help')
    ;(globalThis as any).__ceilResume = { resumeId: ID, cwd: '', cwdMismatch: true, path: '/h/.codex/sessions/x.jsonl' }
    const configured = posix(() => buildCodexSpawn({ sessionId: 's', cwd: '/res/help', resume: { uuid: ID, cwd: '/gone' }, realmLaunch: linux(), codexOptions: STANDARD, ...ASK }))
    expect(configured.env.GIT_CEILING_DIRECTORIES).toBe('/res')
  })

  it('an Ask launch whose help folder is not an absolute path is refused', () => {
    for (const cwd of [undefined, '', 'help', './help']) {
      expect(() => posix(() => buildCodexSpawn({ sessionId: 's', ...(cwd !== undefined ? { cwd } : {}), realmLaunch: linux(), codexOptions: STANDARD, ...ASK })), String(cwd)).toThrow(/Ask Conductor/)
    }
    expect(() => win32(() => buildCodexSpawn({ sessionId: 's', cwd: 'help', realmLaunch: windows('C:\\a\\codex.exe'), codexOptions: STANDARD, ...ASK }))).toThrow(/Ask Conductor/)
  })

  it('an Ask launch whose help folder\'s parent git would read as two folders is refused', () => {
    expect(() => win32(() => buildCodexSpawn({ sessionId: 's', cwd: 'C:\\a;b\\help', realmLaunch: windows('C:\\a\\codex.exe'), codexOptions: STANDARD, ...ASK }))).toThrow(/Ask Conductor/)
    expect(() => posix(() => buildCodexSpawn({ sessionId: 's', cwd: '/a:b/help', realmLaunch: linux(), codexOptions: STANDARD, ...ASK }))).toThrow(/Ask Conductor/)
  })

  it('a refused Ask launch says what to change', () => {
    const exactly = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
    const ask = (cwd: string, onWindows: boolean) => () => (onWindows
      ? win32(() => buildCodexSpawn({ sessionId: 's', cwd, realmLaunch: windows('C:\\a\\codex.exe'), codexOptions: STANDARD, ...ASK }))
      : posix(() => buildCodexSpawn({ sessionId: 's', cwd, realmLaunch: linux(), codexOptions: STANDARD, ...ASK })))
    expect(ask('C:\\a;b\\help', true)).toThrow(exactly('Cannot start Ask Conductor on Codex: the resources folder\'s path holds a \';\', which git reads as a list of folders: choose a resources folder whose path has none.'))
    expect(ask('/a:b/help', false)).toThrow(exactly('Cannot start Ask Conductor on Codex: the resources folder\'s path holds a \':\', which git reads as a list of folders: choose a resources folder whose path has none.'))
    expect(ask(`/a${String.fromCharCode(7)}b/help`, false)).toThrow(exactly('Cannot start Ask Conductor on Codex: the resources folder\'s path holds a control character: choose a resources folder whose path has none.'))
    expect(ask('help', false)).toThrow(exactly('Cannot start Ask Conductor on Codex: its help folder is not an absolute path.'))
  })

  it('an Ask launch carries no variable naming a repository, in any spelling, so git finds one only from where it starts', async () => {
    const posixNamed = { GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere', GIT_COMMON_DIR: '/elsewhere/.git' }
    const fresh = posix(() => buildCodexSpawn({ sessionId: 's', cwd: '/res/help', realmLaunch: linux(posixNamed), codexOptions: STANDARD, ...ASK }))
    expect(repositoryNames(fresh.env)).toEqual([])
    expect(fresh.env.GIT_CEILING_DIRECTORIES).toBe('/res')
    const picker = await withPicker(() => posix(() => buildCodexSpawn({ sessionId: 's', cwd: '/res/help', useResumePicker: true, realmLaunch: linux(posixNamed), codexOptions: STANDARD, ...ASK })))
    expect(picker.args[0]).toMatch(/codex-resume-picker\.js$/)
    expect(repositoryNames(picker.env)).toEqual([])
    const onWindows = win32(() => buildCodexSpawn({
      sessionId: 's', cwd: 'C:\\Users\\u\\Resources\\help',
      realmLaunch: windows('C:\\npm\\codex.cmd', { git_dir: 'C:\\x\\.git', Git_Work_Tree: 'C:\\x', GIT_COMMON_DIR: 'C:\\x\\.git' }), codexOptions: STANDARD, ...ASK,
    }))
    expect(repositoryNames(onWindows.env)).toEqual([])
  })
})

describe('a normal session\'s picker is unchanged', () => {
  it('a launch that is not Ask\'s gets no ceiling, and keeps the git variables the environment already had', async () => {
    const fresh = posix(() => buildCodexSpawn({ sessionId: 's', cwd: '/proj', realmLaunch: linux(), codexOptions: STANDARD }))
    expect(ceilings(fresh.env)).toEqual([])
    const picker = await withPicker(() => posix(() => buildCodexSpawn({ sessionId: 's', cwd: '/proj', useResumePicker: true, realmLaunch: linux(), codexOptions: STANDARD })))
    expect(ceilings(picker.env)).toEqual([])
    const kept = posix(() => buildCodexSpawn({ sessionId: 's', cwd: '/proj', realmLaunch: linux({ GIT_CEILING_DIRECTORIES: '/home', GIT_DIR: '/proj/.git' }), codexOptions: STANDARD }))
    expect(kept.env.GIT_CEILING_DIRECTORIES).toBe('/home')
    expect(kept.env.GIT_DIR).toBe('/proj/.git')
  })
})
