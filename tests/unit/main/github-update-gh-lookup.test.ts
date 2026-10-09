// The update check's GitHub CLI fallbacks start gh the way every other start of
// a promised program does on Windows: gh.exe by the full path found in the
// folders PATH names in full, the child's own lookup kept to them, and nothing
// at all when there is none there -- never gh by name, which Windows would also
// look for in the app's working folder and in folders PATH names relative to
// it. The public request fails here (as with no network), so each check walks
// the whole cascade: the token, then the release list; the installer and
// CHECKSUMS.txt downloads go through gh when there is no direct URL.
//
// The REAL PATH walk (windows-programs.ts) runs over a PATH this test sets:
// relative entries hold a gh.exe that must never be chosen. The file test is
// injected (no real file is read) and child_process is mocked (no process
// starts). The platform is forced per case so every runner checks both.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({
  present: new Set<string>(),
  asked: [] as string[],
  execFile: [] as Array<{ file: string; args: string[]; opts: Record<string, unknown> }>,
  logs: [] as string[],
  dataDir: '',
}))

function isFile(p: string): boolean {
  h.asked.push(p)
  return h.present.has(p.toLowerCase())
}

vi.mock('../../../src/main/windows-programs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/windows-programs')>()
  return {
    ...real,
    findOnWindowsPathAsync: async (names: string[], env: NodeJS.ProcessEnv, _stat?: unknown, order?: 'folder' | 'name') => real.findOnWindowsPath(names, env, isFile, order),
  }
})

function childProcessMock(real: typeof import('child_process')): Record<string, unknown> {
  return {
    ...real,
    execFile: (file: string, args: string[], opts: Record<string, unknown>, cb?: (e: unknown, out: unknown) => void) => {
      h.execFile.push({ file, args, opts })
      // No token, and an empty release list: the cascade reaches every leg.
      cb?.(null, { stdout: args[0] === 'release' && args[1] === 'list' ? '[]' : '', stderr: '' })
      return { pid: 1 }
    },
  }
}
vi.mock('child_process', async (importOriginal) => childProcessMock(await importOriginal<typeof import('child_process')>()))
vi.mock('node:child_process', async (importOriginal) => childProcessMock(await importOriginal<typeof import('child_process')>()))

// The public request fails as it does with no network.
vi.mock('https', async (importOriginal) => {
  const real = await importOriginal<typeof import('https')>()
  const { EventEmitter } = await import('node:events')
  const get = (): unknown => {
    const req = new EventEmitter() as import('node:events').EventEmitter & { destroy: () => void; setTimeout: () => void }
    req.destroy = () => {}
    req.setTimeout = () => {}
    queueMicrotask(() => req.emit('error', new Error('connect EACCES')))
    return req
  }
  return { ...real, default: { ...real, get }, get }
})
vi.mock('electron', () => ({ app: { getVersion: () => '2.1.0', getPath: () => h.dataDir } }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => ({ updateChannel: 'beta' }) }))
vi.mock('../../../src/main/registry', () => ({ readRegistry: () => null, writeRegistry: () => true }))
vi.mock('../../../src/main/data-paths', () => ({ getDataDirectory: () => h.dataDir }))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (m: string) => { h.logs.push(String(m)) },
  logError: (m: string) => { h.logs.push(String(m)) },
  logWarn: () => {},
  logDebug: () => {},
}))

const { checkGitHubRelease, downloadInstallerFile, downloadGitHubRelease, activeRepo } = await import('../../../src/main/github-update')
const { ghStartCommand, GH_NOT_ON_PATH } = await import('../../../src/main/github/gh-program')
const { windowsEnvValue } = await import('../../../src/main/windows-programs')

/** Relative entries first (each holds a gh.exe), then folders named in full. */
const RELATIVE = '.;..\\stubs;rel\\bin'
const IN_RELATIVE_ENTRIES = ['.\\gh.exe', '..\\stubs\\gh.exe', 'rel\\bin\\gh.exe', 'gh.exe', 'gh']

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const saved = { path: process.env.PATH, root: process.env.SystemRoot }

function have(...files: string[]): void {
  h.present = new Set([...IN_RELATIVE_ENTRIES, ...files].map((f) => f.toLowerCase()))
}
function restore(name: 'PATH' | 'SystemRoot', value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
function onWindows(pathValue: string): void {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.PATH = pathValue
  process.env.SystemRoot = 'C:\\Windows'
}

beforeEach(() => {
  h.asked.length = 0
  h.execFile.length = 0
  h.logs.length = 0
  h.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-lookup-'))
  have()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', hostPlatform)
  restore('PATH', saved.path)
  restore('SystemRoot', saved.root)
  fs.rmSync(h.dataDir, { recursive: true, force: true })
})

/** Every candidate the walk asked for was in a folder named in full. */
function onlyAbsoluteAsked(): void {
  expect(h.asked.length).toBeGreaterThan(0)
  for (const p of h.asked) expect(p, p).toMatch(/^[A-Za-z]:\\/)
}

describe('on Windows the update check starts gh by its full path, never by name', () => {
  it('gh.exe in a folder PATH names in full: the token and the release list start it by that path, the child\'s lookup kept to those folders', async () => {
    onWindows(`${RELATIVE};C:\\Empty;C:\\Tools`)
    have('C:\\Tools\\gh.exe')
    expect(await checkGitHubRelease()).toBeNull()
    expect(h.execFile.map((c) => [c.file, c.args.slice(0, 2)])).toEqual([
      ['C:\\Tools\\gh.exe', ['auth', 'token']],
      ['C:\\Tools\\gh.exe', ['release', 'list']],
    ])
    expect(h.execFile[1].args).toEqual(['release', 'list', '--repo', activeRepo(), '--limit', expect.any(String), '--json', 'tagName,isPrerelease,isDraft,assets'])
    for (const c of h.execFile) {
      expect(c.opts).not.toHaveProperty('shell')
      expect(c.opts).toMatchObject({ windowsHide: true, encoding: 'utf-8' })
      const env = c.opts.env as NodeJS.ProcessEnv
      expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1')
      expect(windowsEnvValue(env, 'PATH')).toBe('C:\\Empty;C:\\Tools')
    }
    expect(h.execFile.map((c) => c.opts.timeout)).toEqual([5000, 15000])
    onlyAbsoluteAsked()
  })

  it('the installer and CHECKSUMS.txt downloads start it by that path too', async () => {
    onWindows(`${RELATIVE};C:\\Tools`)
    have('C:\\Tools\\gh.exe')
    expect(await downloadInstallerFile('v9.9.9', 'Setup-9.9.9.exe', null)).toBeNull()
    await expect(downloadGitHubRelease('v9.9.9', 'Setup-9.9.9.exe', null)).rejects.toThrow()
    expect(h.execFile.map((c) => [c.file, c.args.slice(0, 3), c.args[c.args.indexOf('--pattern') + 1]])).toEqual([
      ['C:\\Tools\\gh.exe', ['release', 'download', 'v9.9.9'], 'Setup-9.9.9.exe'],
      ['C:\\Tools\\gh.exe', ['release', 'download', 'v9.9.9'], 'CHECKSUMS.txt'],
    ])
    for (const c of h.execFile) expect((c.opts.env as NodeJS.ProcessEnv).NoDefaultCurrentDirectoryInExePath).toBe('1')
    onlyAbsoluteAsked()
  })

  it('gh.exe only in the working folder or a folder PATH names relative to it: nothing starts, and every fallback reports no gh', async () => {
    onWindows(`${RELATIVE};C:\\Empty`)
    expect(await checkGitHubRelease()).toBeNull()
    expect(await downloadInstallerFile('v9.9.9', 'Setup-9.9.9.exe', null)).toBeNull()
    await expect(downloadGitHubRelease('v9.9.9', 'Setup-9.9.9.exe', null)).rejects.toThrow()
    expect(h.execFile).toEqual([])
    expect(h.asked).toEqual(Array(4).fill('C:\\Empty\\gh.exe'))
    expect(h.logs).toContain('[github-update] No gh auth token available — skipping authenticated API')
    expect(h.logs).toContain(`[github-update] gh CLI error: ${GH_NOT_ON_PATH}`)
  })

  it('no gh in any folder: the same', async () => {
    onWindows('C:\\Empty;C:\\Other')
    expect(await checkGitHubRelease()).toBeNull()
    expect(h.execFile).toEqual([])
    onlyAbsoluteAsked()
  })
})

describe('the gh start itself', () => {
  const ENV = Object.freeze({ PATH: `${RELATIVE};C:\\Tools`, SystemRoot: 'C:\\Windows' })
  it('on Windows: the full path, no shell, PATH kept to its folders named in full; none there: refused, with the one message', async () => {
    have('C:\\Tools\\gh.exe')
    expect(await ghStartCommand(['auth', 'token'], ENV, 'win32')).toEqual({
      file: 'C:\\Tools\\gh.exe',
      args: ['auth', 'token'],
      windowsVerbatimArguments: false,
      env: { PATH: 'C:\\Tools', SystemRoot: 'C:\\Windows', NoDefaultCurrentDirectoryInExePath: '1' },
    })
    have()
    expect(await ghStartCommand(['auth', 'token'], ENV, 'win32')).toEqual({ refused: GH_NOT_ON_PATH })
    expect(GH_NOT_ON_PATH).toBe('gh was not found in a folder PATH names (gh.exe)')
    onlyAbsoluteAsked()
  })

  it('elsewhere: gh by name with this process\'s environment, as before, and no lookup', async () => {
    expect(await ghStartCommand(['auth', 'token'], ENV, 'linux')).toEqual({ file: 'gh', args: ['auth', 'token'], windowsVerbatimArguments: false })
    expect(h.asked).toEqual([])
  })
})

describe('off Windows the update check starts gh as it always has', () => {
  it('gh by name, with the options it always had and no environment of its own', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(await checkGitHubRelease()).toBeNull()
    expect(h.execFile.map((c) => c.file)).toEqual(['gh', 'gh'])
    expect(h.execFile[0]).toEqual({ file: 'gh', args: ['auth', 'token'], opts: { encoding: 'utf-8', timeout: 5000, windowsHide: true } })
    expect(h.asked).toEqual([])
  })
})
