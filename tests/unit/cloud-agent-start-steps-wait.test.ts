// A cloud agent that names no account runs on the primary one, and, like a
// local launch, waits for what the app does at start before it reads that
// account: the start's profile steps (they may still be making the primary
// account from the user's own sign-in) and the account's owner-only sign-in
// folder check. So an agent dispatched while those are under way neither runs
// on the bare global sign-in nor is refused for want of a verdict: it starts,
// on the primary account, once they are done. An account whose folders have
// no verdict yet (none pending at start) is checked first in the same way.
//
// The REAL account-profiles module (its owner-only rule replaced through the
// test seam and held on a gate; setupProfileLinks stubbed, so no link is
// made), the real cloud agent manager and the real launch environment; the
// process start is faked, so nothing runs. Synthetic sign-ins only.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../src/main/claude-cli-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/claude-cli-probe')>()),
  recentClaudeOnWindows: () => 'C:\\Tools\\claude.exe',
}))
vi.mock('../../src/main/windows-programs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/windows-programs')>()),
  findOnWindowsPath: (names: readonly string[]) => `C:\\Tools\\${names[0]}`,
  findOnWindowsPathAsync: async (names: readonly string[]) => `C:\\Tools\\${names[0]}`,
}))
vi.mock('../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))

const mockSpawn = vi.hoisted(() => vi.fn())
const fakeChildProcess = vi.hoisted(() => (real: Record<string, unknown>) => {
  const execFileSync = vi.fn((file: string, _a?: unknown, opts?: { encoding?: string }) => {
    if (/icacls/i.test(String(file))) return opts?.encoding ? '' : Buffer.alloc(0)
    throw new Error(`no process in this test: ${file}`)
  })
  const execFile = vi.fn((file: string, _a: unknown, _o: unknown, cb: (e: Error | null, o: string, eo: string) => void) => { cb(new Error(`no process in this test: ${file}`), '', '') })
  const spawn = (...args: unknown[]) => mockSpawn(...args)
  const spawnSync = vi.fn(() => { throw new Error('no process in this test') })
  const execSync = vi.fn(() => { throw new Error('no process in this test') })
  return { ...real, execFileSync, execFile, spawn, spawnSync, execSync, default: { ...real, execFileSync, execFile, spawn, spawnSync, execSync } }
})
vi.mock('child_process', async (importOriginal) => fakeChildProcess(await importOriginal()))
vi.mock('node:child_process', async (importOriginal) => fakeChildProcess(await importOriginal()))
vi.mock('../../src/main/config-manager', () => ({
  readConfig: () => null,
  readConfigChecked: () => ({ value: null, outcome: 'absent' }),
  writeConfig: vi.fn(() => true),
  getConfigDir: () => '/mock/CONFIG',
  ensureConfigDir: vi.fn(),
}))
vi.mock('../../src/main/legacy-version-manager', () => ({
  resolveVersionBinary: vi.fn(() => null),
  isVersionInstalled: vi.fn(() => false),
  installVersion: vi.fn(async () => ({ ok: false, error: 'mock' })),
  legacyCliPin: vi.fn(() => undefined),
}))
// The account's shared folders are linked by setupProfileLinks: stubbed, so
// this suite makes no link or junction.
vi.mock('../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/account-profiles')>()),
  setupProfileLinks: vi.fn(),
}))
// When the project check has answered: the point a dispatch reaches the waits.
const gateAnswered = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../src/main/managed-launch-diagnostics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/managed-launch-diagnostics')>()
  return { ...real, gateManagedLaunch: async (...a: Parameters<typeof real.gateManagedLaunch>) => { const v = await real.gateManagedLaunch(...a); gateAnswered.n++; return v } }
})

import { composeProviders } from '../../src/main/providers/compose'
const ap = await import('../../src/main/account-profiles')
const { initCloudAgentManager, dispatchAgent, listAgents, _resetCloudAgentLatchForTest } = await import('../../src/main/cloud-agent-manager')

const P = 'profile-mabc125-a1b2c5'
const PREFIX = 'ccc-agent-start-wait-'
let base = ''
let project = ''

function makeChild() {
  const handlers: Record<string, (...a: unknown[]) => void> = {}
  return {
    pid: 777,
    stdout: { on: vi.fn() }, stderr: { on: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
    on: (ev: string, cb: (...a: unknown[]) => void) => { handlers[ev] = cb },
    kill: vi.fn(),
    handlers,
  }
}

/** The owner-only rule as the app's answers for folders it made owner-only,
 *  held until `release()`. */
function heldRule() {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const rule = async (dirs: readonly string[]) => {
    await gate
    return dirs.map((dir) => {
      if (!fs.existsSync(dir) && fs.existsSync(path.dirname(dir))) fs.mkdirSync(dir)
      return { dir, ok: true, detail: 'owner-only' }
    })
  }
  return { rule, release }
}

/** The primary account as the start's capture leaves it: real folders, a
 *  synthetic sign-in, the account listed and marked primary. */
function makePrimary(): void {
  const home = ap.getProfileConfigDir(P)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1 } }))
  ap.upsertProfile({ id: P, name: 'Primary', accountEmail: 'primary@example.test', createdAt: 1 } as never)
  ap.setPrimaryProfile(P)
}

const settle = () => new Promise((r) => setTimeout(r, 50))
const until = async (cond: () => boolean, why: string) => {
  const deadline = Date.now() + 5000
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  if (!cond()) throw new Error(`timed out waiting for ${why}`)
}
const dispatch = () => dispatchAgent({ name: 'A', description: 'do the thing', projectPath: project })
const spawnedEnv = (): Record<string, string> => (mockSpawn.mock.calls[0][2] as { env: Record<string, string> }).env

beforeAll(() => { composeProviders() })

beforeEach(() => {
  mockSpawn.mockReset()
  mockSpawn.mockImplementation(() => makeChild())
  gateAnswered.n = 0
  _resetCloudAgentLatchForTest()
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)))
  const res = path.join(base, 'res')
  const shared = path.join(base, 'home', '.claude')
  project = path.join(base, 'project')
  for (const d of [res, shared, project]) fs.mkdirSync(d, { recursive: true })
  ap._setRootsForTest({ resourcesDir: res, sharedRoot: shared })
  ap._setCredentialFolderRuleForTest(null)
  initCloudAgentManager(() => ({ isDestroyed: () => false, webContents: { send: vi.fn() } }) as never)
})

afterEach(() => {
  ap._setCredentialFolderRuleForTest(null)
  ap._setRootsForTest(null)
  // TEST CLEANUP GUARD: this suite's own temp folder only.
  if (path.basename(base).startsWith(PREFIX)) fs.rmSync(base, { recursive: true, force: true })
})

describe('a cloud agent that names no account waits for the start, then runs on the primary account', () => {
  it('first run: the start is still making the primary account, so the agent waits and runs on it, never on the bare global sign-in', async () => {
    const { rule, release } = heldRule()
    ap._setCredentialFolderRuleForTest(rule)
    const start = ap.startOwnerOnlyCredentialFolders(() => { makePrimary() }, rule)
    const p = dispatch()
    await until(() => gateAnswered.n > 0, 'the project check')
    await settle()
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(listAgents()).toHaveLength(0)
    release()
    await start
    const agent = await p
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect((agent as { profileId?: string }).profileId).toBe(P)
    expect(spawnedEnv().USERPROFILE).toBe(ap.getProfileConfigDir(P))
  })

  it('an upgrade: the primary account is there but its folders are still being checked at start, so the agent waits and runs, never refused', async () => {
    makePrimary()
    const { rule, release } = heldRule()
    ap._setCredentialFolderRuleForTest(rule)
    const start = ap.startOwnerOnlyCredentialFolders(() => {}, rule)
    const p = dispatch()
    await until(() => gateAnswered.n > 0, 'the project check')
    await settle()
    expect(mockSpawn).not.toHaveBeenCalled()
    release()
    await start
    const agent = await p
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect((agent as { profileId?: string }).profileId).toBe(P)
    expect(spawnedEnv().USERPROFILE).toBe(ap.getProfileConfigDir(P))
  })

  it('no start pending, the account\'s folders not checked yet: the agent waits for their check, then runs', async () => {
    makePrimary()
    const { rule, release } = heldRule()
    ap._setCredentialFolderRuleForTest(rule)
    expect(ap.startProfileStepsPending()).toBe(false)
    expect(ap.profileCredentialFoldersChecked(P)).toBe(false)
    const p = dispatch()
    await until(() => gateAnswered.n > 0, 'the project check')
    await settle()
    expect(mockSpawn).not.toHaveBeenCalled()
    release()
    const agent = await p
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect((agent as { profileId?: string }).profileId).toBe(P)
    expect(spawnedEnv().USERPROFILE).toBe(ap.getProfileConfigDir(P))
  })
})
