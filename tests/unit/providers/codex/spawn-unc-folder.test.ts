// A Codex session in a network folder (src/main/providers/codex/spawn.ts):
// cmd.exe cannot start in a share or a device path (two leading slashes of
// either kind), so a launch that would start Codex's npm launcher through
// cmd.exe in such a folder is
// refused with the reason, on every route that starts it there: a fresh
// launch, an exact resume, and the picker's fallback when the picker is not
// deployed. The standalone codex.exe starts there as before, so does every
// drive folder, and the picker itself (node takes a network folder; the
// picker refuses its own launch there, codex-resume-picker-network-folder).
// Synthetic environments; nothing is started.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execSync: vi.fn(() => { throw new Error('nothing is started here') }) }
})
// The disk, for the picker route's node lookup on Windows: one fixed node.exe
// (named in the picker launches' PATH below) answers as a file; every other
// path as the real disk answers.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    statSync: vi.fn((p: unknown, o?: unknown) => {
      if (p === 'C:\\ccc-test-only\\nodejs\\node.exe') return { isFile: () => true } as import('fs').Stats
      return (actual.statSync as (a: unknown, b?: unknown) => import('fs').Stats)(p, o)
    }),
  }
})
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => (globalThis as any).__uncResDir ?? '', getDataDirectory: () => '' }))
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
// What an exact resume's lookup answers, forced per case.
vi.mock('../../../../src/main/providers/codex/rollout-lookup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/providers/codex/rollout-lookup')>()
  return { ...actual, resolveCodexResume: () => (globalThis as any).__uncResume ?? null }
})

const { buildCodexSpawn } = await import('../../../../src/main/providers/codex/spawn')

const ID = '019dd000-0001-7000-8000-0000000000c1'
const SHIM = 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd'
const EXE = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\bin\\codex.exe'
const winEnv = { SystemRoot: 'C:\\Windows', CODEX_HOME: 'C:\\r' }
const STANDARD = { model: 'gpt-5.5', permissionsPreset: 'standard' as const }
const REFUSED = /^Cannot start Codex in a network folder through its npm launcher: open the folder from a mapped drive letter, or install the standalone Codex\.$/
const NETWORK = ['\\\\srv\\share\\project', '//srv/share/project', '\\/srv\\share', '\\\\?\\C:\\project', '\\\\?\\UNC\\srv\\share\\project', '\\\\.\\C:\\project']

function onPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try { return fn() } finally { if (orig) Object.defineProperty(process, 'platform', orig) }
}
const win32 = <T>(fn: () => T): T => onPlatform('win32', fn)
const build = (executable: string, extra: Record<string, unknown>) =>
  win32(() => buildCodexSpawn({ sessionId: 'sid', realmLaunch: { executable, env: winEnv, sessionsDir: 'C:\\r\\sessions' }, codexOptions: STANDARD, ...extra }))

beforeEach(() => { delete (globalThis as any).__uncResume })
afterEach(() => {
  delete (globalThis as any).__uncResume
  delete (globalThis as any).__uncResDir
})

describe('a network folder on the npm launcher route is refused with the reason', () => {
  it('a fresh launch in a share or a device path, either slash', () => {
    for (const cwd of NETWORK) expect(() => build(SHIM, { cwd }), cwd).toThrow(REFUSED)
  })

  it('an exact resume into a network folder', () => {
    ;(globalThis as any).__uncResume = { resumeId: ID, cwd: '\\\\srv\\share\\project', cwdMismatch: false, path: 'C:\\r\\sessions\\x.jsonl' }
    expect(() => build(SHIM, { cwd: 'C:\\configured', resume: { uuid: ID, cwd: '\\\\srv\\share\\project' } })).toThrow(REFUSED)
  })

  it('an exact resume with no folder of its own starts in the configured one, and is refused when that is a network folder', () => {
    ;(globalThis as any).__uncResume = { resumeId: ID, cwd: '', cwdMismatch: true, path: 'C:\\r\\sessions\\x.jsonl' }
    expect(() => build(SHIM, { cwd: '\\\\srv\\share\\project', resume: { uuid: ID, cwd: 'C:\\gone' } })).toThrow(REFUSED)
  })

  it('the picker\'s fallback (picker not deployed) is the fresh launch, refused the same way', () => {
    expect(() => build(SHIM, { cwd: '\\\\srv\\share\\project', useResumePicker: true })).toThrow(REFUSED)
  })
})

describe('everything else starts as before', () => {
  it('a standalone codex starts in a network folder, fresh and resumed', () => {
    const fresh = build(EXE, { cwd: '\\\\srv\\share\\project' })
    expect(fresh.cmd).toBe(EXE)
    ;(globalThis as any).__uncResume = { resumeId: ID, cwd: '\\\\srv\\share\\project', cwdMismatch: false, path: 'C:\\r\\sessions\\x.jsonl' }
    const resumed = build(EXE, { cwd: 'C:\\configured', resume: { uuid: ID, cwd: '\\\\srv\\share\\project' } })
    expect(resumed.cmd).toBe(EXE)
    expect(resumed.cwd).toBe('\\\\srv\\share\\project')
  })

  it('the npm launcher starts in a drive folder, fresh and resumed into one from a network folder', () => {
    const fresh = build(SHIM, { cwd: 'C:\\project' })
    expect(fresh.cmd).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(fresh.commandLine).toContain(`"${SHIM}"`)
    ;(globalThis as any).__uncResume = { resumeId: ID, cwd: 'D:\\work', cwdMismatch: false, path: 'C:\\r\\sessions\\x.jsonl' }
    const resumed = build(SHIM, { cwd: '\\\\srv\\share\\project', resume: { uuid: ID, cwd: 'D:\\work' } })
    expect(resumed.cmd).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(resumed.cwd).toBe('D:\\work')
  })

  it('the picker itself starts in a network folder (it refuses its own launch there)', async () => {
    const fs = await vi.importActual<typeof import('fs')>('fs')
    const os = await vi.importActual<typeof import('os')>('os')
    const res = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-unc-picker-'))
    try {
      fs.mkdirSync(path.join(res, 'scripts'), { recursive: true })
      fs.writeFileSync(path.join(res, 'scripts', 'codex-resume-picker.js'), '// stub')
      ;(globalThis as any).__uncResDir = res
      const out = win32(() => buildCodexSpawn({ sessionId: 'sid', realmLaunch: { executable: SHIM, env: { ...winEnv, PATH: 'C:\\ccc-test-only\\nodejs' }, sessionsDir: 'C:\\r\\sessions' }, codexOptions: STANDARD, cwd: '\\\\srv\\share\\project', useResumePicker: true }))
      const pickDir = out.pickFile ? path.dirname(out.pickFile) : null
      if (pickDir && path.dirname(pickDir) === os.tmpdir() && /^ccc-codex-pick-/.test(path.basename(pickDir))) fs.rmSync(pickDir, { recursive: true, force: true })
      expect(out.args[0]).toBe(path.join(res, 'scripts', 'codex-resume-picker.js'))
      expect(out.env.CCC_CODEX_EXECUTABLE).toBe(SHIM)
    } finally {
      if (path.dirname(res) === os.tmpdir() && /^ccc-unc-picker-/.test(path.basename(res))) fs.rmSync(res, { recursive: true, force: true })
    }
  })

  it('on macOS and Linux nothing changes (no cmd.exe)', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const out = onPlatform(platform, () => buildCodexSpawn({ sessionId: 'sid', cwd: '//srv/share/project', realmLaunch: { executable: '/usr/local/bin/codex', env: { PATH: '/usr/bin' }, sessionsDir: '/h/.codex/sessions' }, codexOptions: STANDARD }))
      expect(out.cmd, platform).toBe('/usr/local/bin/codex')
      expect(out.commandLine, platform).toBeUndefined()
    }
  })
})
