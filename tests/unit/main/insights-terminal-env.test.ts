// The /insights terminal finds the programs it starts only in the folders
// PATH names on Windows: its environment carries the lookup setting, in one
// spelling, on top of the environment the account's home gave it. Elsewhere
// the environment is as given. Every environment here is synthetic; no
// terminal or CLI starts (node-pty and the headless run are fakes).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// Every provider is on here: main's launch rule has its own suites.
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const h = vi.hoisted(() => ({
  resourcesDir: '',
  /** What the account's home step hands back: a fresh object, built from nothing it was given. */
  homeEnv: {} as Record<string, string>,
  spawnEnvs: [] as Array<Record<string, string>>,
}))

vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.resourcesDir, registerSetupHandlers: () => {} }))
vi.mock('../../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../../src/main/account-profiles', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/account-profiles')>()),
  getPrimaryProfileId: () => null,
  listProfiles: () => [],
  setupProfileLinks: () => {},
}))
vi.mock('../../../src/main/pty-manager', () => ({
  resolveClaudeForPty: () => ({ cmd: 'claude' }),
  withProfileHome: () => ({ ...h.homeEnv }),
}))
vi.mock('node-pty', () => ({
  spawn: (_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
    h.spawnEnvs.push(opts.env)
    return { onData: () => {}, onExit: (cb: (e: { exitCode: number }) => void) => cb({ exitCode: 1 }), write: () => {}, kill: () => {} }
  },
}))
vi.mock('../../../src/main/claude-headless', () => ({ spawnClaudeHeadless: async () => ({ code: 1, stdout: '', stderr: '' }) }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))

import { insightsTerminalEnv, runInsights } from '../../../src/main/insights-runner'

const KEY = 'NoDefaultCurrentDirectoryInExePath'
const lookupKeys = (env: Record<string, string>) => Object.keys(env).filter((k) => k.toUpperCase() === KEY.toUpperCase())

describe('the insights terminal finds programs only in the folders path names on windows', () => {
  it('on Windows the setting is on, in one spelling, and the rest of the environment is kept', () => {
    const given = { Path: 'C:\\Tools;C:\\Windows', USERPROFILE: 'C:\\Users\\someone', nodefaultcurrentdirectoryinexepath: '0' }
    const out = insightsTerminalEnv(given, 'win32')
    expect(lookupKeys(out)).toEqual([KEY])
    expect(out[KEY]).toBe('1')
    expect(out.Path).toBe(given.Path)
    expect(out.USERPROFILE).toBe(given.USERPROFILE)
    // The environment passed in is left as it was.
    expect(given).toEqual({ Path: 'C:\\Tools;C:\\Windows', USERPROFILE: 'C:\\Users\\someone', nodefaultcurrentdirectoryinexepath: '0' })
  })

  it('on Windows PATH keeps only its fully qualified folders, in every spelling', () => {
    const given = { Path: '.;tools;C:\\Tools;"D:\\Quoted"', PATH: 'relative', USERPROFILE: 'C:\\Users\\someone' }
    const out = insightsTerminalEnv(given, 'win32')
    expect(out.Path).toBe('C:\\Tools;D:\\Quoted')
    expect('PATH' in out).toBe(false)
    expect(given.Path).toBe('.;tools;C:\\Tools;"D:\\Quoted"')
  })

  it('elsewhere the environment is as given', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const given = { PATH: '/usr/bin', HOME: '/home/someone' }
      expect(insightsTerminalEnv(given, platform), platform).toEqual({ PATH: '/usr/bin', HOME: '/home/someone' })
    }
  })
})

describe("the insights terminal's environment as it starts", () => {
  let tmpRoot = ''
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'insights-term-env-'))
    h.resourcesDir = join(tmpRoot, 'resources')
    mkdirSync(h.resourcesDir, { recursive: true })
    h.homeEnv = { PATH: 'C:\\Tools', HOME: 'C:\\fake-home', NODEFAULTCURRENTDIRECTORYINEXEPATH: '0' }
    h.spawnEnvs = []
  })
  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it("is the account's home environment, with the setting on top on Windows", async () => {
    await runInsights(() => null)
    expect(h.spawnEnvs).toHaveLength(1)
    const env = h.spawnEnvs[0]
    expect(env.PATH).toBe('C:\\Tools')
    expect(env.HOME).toBe('C:\\fake-home')
    if (process.platform === 'win32') {
      expect(lookupKeys(env)).toEqual([KEY])
      expect(env[KEY]).toBe('1')
    } else {
      expect(env).toEqual(h.homeEnv)
    }
  })
})
