// @vitest-environment node
//
// logoutClaudeCli (WP2 PR 4, owner answers 2026-10-04, and the review fix pass):
// the sign-out the Claude package's auth.logout runs. [host] The CLI runs only
// through a FAKE runner (no process starts, no real claude), and the profiles
// root is a temp folder (_setRootsForTest); withProfileHome, the project gate,
// the profile list, the consumer registry and the session registry are the REAL
// ones, so what is asserted is the environment and the order the real code uses.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { composeProviders } from '../../src/main/providers/compose'
import type { ClaudeCliAuthRun, ClaudeCliAuthRunner } from '../../src/main/account-web/claude-cli-auth'

type ExecCb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
const execCalls: string[][] = []
let execFileImpl: (cmd: string, args: string[], opts: unknown, cb: ExecCb) => void = (_c, _a, _o, cb) => cb(new Error('no cli'))
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb: ExecCb) => { execCalls.push([cmd, ...args]); return execFileImpl(cmd, args, opts, cb) },
}))
const logs = vi.hoisted(() => ({ info: [] as string[] }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: (m: string) => { logs.info.push(m) }, logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn() }))
const gateSeam = vi.hoisted(() => ({ refuse: false }))
vi.mock('../../src/main/managed-launch-diagnostics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/managed-launch-diagnostics')>()
  return {
    ...real,
    peekGateVerdict: (cwd: string) => (gateSeam.refuse ? undefined : real.peekGateVerdict(cwd)),
    gateManagedLaunch: async (cwd: string) => (gateSeam.refuse
      ? { status: 'refused' as const, keys: ['settings.local.json: apiKeyHelper'] }
      : real.gateManagedLaunch(cwd)),
  }
})

const { logoutClaudeCli, readClaudeCliAuth } = await import('../../src/main/account-web/claude-cli-auth')
const profiles = await import('../../src/main/account-profiles')
const consumers = await import('../../src/main/profile-consumers')
const identity = await import('../../src/main/claude-account-identity')
const { gateManagedLaunch, _resetProjectScanStateForTest } = await import('../../src/main/managed-launch-diagnostics')

const PRIMARY = 'profile-pri-000'
const ID = 'profile-abc-123'
const OTHER = 'profile-def-456'
let sandbox = ''
let root = ''
let binDir = ''

type RunCall = { args: string[]; env: Record<string, string>; timeoutMs: number }
const signedOut = (): ClaudeCliAuthRun => ({ exitCode: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }), timedOut: false })
const ok = (stdout = 'Successfully logged out from your Anthropic account.'): ClaudeCliAuthRun => ({ exitCode: 0, stdout, timedOut: false })

/** A runner that starts nothing: `script` answers each run (logout, then status). */
function fakeRunner(script: (args: readonly string[], n: number) => ClaudeCliAuthRun | Promise<ClaudeCliAuthRun> = (args) => (args.includes('logout') ? ok() : signedOut())): ClaudeCliAuthRunner & { calls: RunCall[] } {
  const calls: RunCall[] = []
  return {
    calls,
    cwd: binDir,
    run: async (args, env, timeoutMs) => {
      calls.push({ args: [...args], env: { ...env }, timeoutMs })
      return script(args, calls.length)
    },
  }
}

function writeProfiles(list: Array<{ id: string; isPrimary?: boolean }>): void {
  fs.writeFileSync(join(root, 'profiles.json'), JSON.stringify({ profiles: list.map((p) => ({ id: p.id, name: p.id, createdAt: 1, ...(p.isPrimary ? { isPrimary: true } : {}) })) }))
}
const home = (id: string) => join(root, id)
const identityCopy = (id: string) => join(root, id, 'identity', '.credentials.json')
function plantIdentity(id: string): void {
  fs.mkdirSync(join(root, id, 'identity'), { recursive: true })
  fs.writeFileSync(identityCopy(id), '{"claudeAiOauth":{"accessToken":"t","refreshToken":"r"}}')
  fs.writeFileSync(join(root, id, 'identity', '.claude.json'), '{"oauthAccount":{"emailAddress":"a@example.com"}}')
}
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }
async function until(cond: () => boolean, why: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${why}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

beforeAll(() => { composeProviders() })
beforeEach(async () => {
  sandbox = fs.mkdtempSync(join(os.tmpdir(), 'ccc-cli-logout-'))
  profiles._setRootsForTest({ resourcesDir: sandbox, sharedRoot: join(sandbox, '.claude') })
  root = profiles.getProfilesRoot()
  binDir = join(sandbox, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  for (const id of [PRIMARY, ID, OTHER]) fs.mkdirSync(home(id), { recursive: true })
  writeProfiles([{ id: PRIMARY, isPrimary: true }, { id: ID }, { id: OTHER }])
  execCalls.length = 0
  execFileImpl = (_c, _a, _o, cb) => cb(new Error('no cli'))
  logs.info.length = 0
  gateSeam.refuse = false
  consumers._resetProfileConsumersForTest()
  identity._resetClaudeAccounts()
  _resetProjectScanStateForTest()
  await gateManagedLaunch(binDir)
})
afterEach(() => {
  vi.restoreAllMocks()
  profiles._setRootsForTest(null)
  if (sandbox.startsWith(join(os.tmpdir(), 'ccc-cli-logout-'))) fs.rmSync(sandbox, { recursive: true, force: true })
})

describe('logoutClaudeCli: the CLI\'s own sign-out in exactly this profile\'s home [host]', () => {
  it('runs `claude auth logout` then reads the state afresh, through the runner, in the profile\'s own hardened home', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ambient-poison'
    process.env.CLAUDE_CONFIG_DIR = '/elsewhere'
    const runner = fakeRunner()
    let r: Awaited<ReturnType<typeof logoutClaudeCli>>
    try {
      r = await logoutClaudeCli(ID, { runner })
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CONFIG_DIR
    }
    expect(r).toEqual({ ran: true, after: expect.objectContaining({ authenticated: false, source: 'cli-status' }) })
    expect(runner.calls.map((c) => c.args)).toEqual([['auth', 'logout'], ['auth', 'status']])
    expect(runner.calls.map((c) => c.timeoutMs)).toEqual([30_000, 10_000])
    for (const c of runner.calls) {
      expect(c.env.USERPROFILE).toBe(home(ID))
      expect(c.env.HOME).toBe(home(ID))
      expect(c.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(c.env.CLAUDE_CONFIG_DIR).toBeUndefined()
      expect(c.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined()
      expect(JSON.stringify(c.env)).not.toContain(OTHER)
    }
    // Nothing went through a shell by name.
    expect(execCalls).toEqual([])
  })

  it('without an executable discovery proved, or with one the runner cannot start, nothing runs (cli-unavailable)', async () => {
    expect(await logoutClaudeCli(ID)).toEqual({ ran: false, after: null, refused: 'cli-unavailable' })
    expect(await logoutClaudeCli(ID, { runner: null })).toEqual({ ran: false, after: null, refused: 'cli-unavailable' })
    const refused = fakeRunner(() => ({ refused: 'the Claude Code executable path is not absolute', exitCode: null, stdout: '', timedOut: false }))
    expect(await logoutClaudeCli(ID, { runner: refused })).toEqual({ ran: false, after: null, refused: 'cli-unavailable' })
    expect(refused.calls).toHaveLength(1)
    const noSpawn = fakeRunner(() => ({ spawnError: 'ENOENT', exitCode: null, stdout: '', timedOut: false }))
    expect(await logoutClaudeCli(ID, { runner: noSpawn })).toEqual({ ran: false, after: null, refused: 'cli-unavailable' })
    expect(execCalls).toEqual([])
  })

  it('is refused, and runs nothing, while the profile is in use (a session or a check holding it)', async () => {
    const runner = fakeRunner()
    const release = consumers.acquireProfileConsumer(ID)
    try {
      expect(await logoutClaudeCli(ID, { runner })).toEqual({ ran: false, after: null, refused: 'in-use' })
      expect(runner.calls).toEqual([])
    } finally {
      release()
    }
    identity.captureClaudeAccount('sid-live-1', ID)
    try {
      expect(await logoutClaudeCli(ID, { runner })).toEqual({ ran: false, after: null, refused: 'in-use' })
      expect(runner.calls).toEqual([])
    } finally {
      identity.clearClaudeAccount('sid-live-1')
    }
    // Another profile in use does not stop this one.
    const other = consumers.acquireProfileConsumer(OTHER)
    try {
      expect(await logoutClaudeCli(ID, { runner })).toMatchObject({ ran: true })
    } finally {
      other()
    }
  })

  it('the primary profile shares this computer\'s own sign-in: it runs only with the acknowledgement; a list that cannot be read counts as shared', async () => {
    const runner = fakeRunner()
    expect(await logoutClaudeCli(PRIMARY, { runner })).toEqual({ ran: false, after: null, refused: 'computer-sign-in' })
    expect(await logoutClaudeCli(PRIMARY, { runner, acknowledgeComputerSignIn: false })).toEqual({ ran: false, after: null, refused: 'computer-sign-in' })
    expect(runner.calls).toEqual([])
    expect(await logoutClaudeCli(PRIMARY, { runner, acknowledgeComputerSignIn: true })).toMatchObject({ ran: true })
    expect(runner.calls[0].env.USERPROFILE).toBe(home(PRIMARY))
    // A profile that is not the primary needs no acknowledgement.
    const plain = fakeRunner()
    expect(await logoutClaudeCli(ID, { runner: plain })).toMatchObject({ ran: true })
    // profiles.json unreadable: which profile is the primary is unknown, so every one asks.
    fs.writeFileSync(join(root, 'profiles.json'), '{not json')
    const unknown = fakeRunner()
    expect(await logoutClaudeCli(ID, { runner: unknown })).toEqual({ ran: false, after: null, refused: 'computer-sign-in' })
    expect(unknown.calls).toEqual([])
    expect(await logoutClaudeCli(ID, { runner: unknown, acknowledgeComputerSignIn: true })).toMatchObject({ ran: true })
  })

  it('macOS: every profile runs on the Mac\'s one sign-in, so every sign-out needs the acknowledgement, and HOME stays the real home', async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const runner = fakeRunner()
    try {
      expect(await logoutClaudeCli(ID, { runner })).toEqual({ ran: false, after: null, refused: 'computer-sign-in' })
      expect(runner.calls).toEqual([])
      expect(await logoutClaudeCli(ID, { runner, acknowledgeComputerSignIn: true })).toMatchObject({ ran: true })
    } finally {
      Object.defineProperty(process, 'platform', realPlatform)
    }
    expect(runner.calls).toHaveLength(2)
    for (const c of runner.calls) expect(c.env.HOME).not.toBe(home(ID))
  })

  it('holds the profile for the whole run (past the 30 s default bound), waits for a token rotation in flight, and lets go after', async () => {
    let resolveRotation: () => void = () => {}
    consumers.noteProfileRefreshInFlight(ID, new Promise<void>((res) => { resolveRotation = res }))
    let finishLogout: (r: ClaudeCliAuthRun) => void = () => {}
    const runner = fakeRunner((args) => (args.includes('logout') ? new Promise<ClaudeCliAuthRun>((res) => { finishLogout = res }) : signedOut()))
    const run = logoutClaudeCli(ID, { runner })
    await settle()
    expect(runner.calls, 'started while a rotation was in flight').toEqual([])
    resolveRotation()
    await until(() => runner.calls.length === 1, 'the sign-out to start')
    const realNow = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(realNow + 45_000)
    expect(consumers.hasTransientProfileConsumer(ID), 'the hold aged out while the sign-out was still running').toBe(true)
    now.mockRestore()
    finishLogout(ok())
    expect(await run).toMatchObject({ ran: true })
    expect(consumers.hasTransientProfileConsumer(ID)).toBe(false)
  })

  it('a session opened on the profile while the sign-out waited refuses it just before the start', async () => {
    let resolveRotation: () => void = () => {}
    consumers.noteProfileRefreshInFlight(ID, new Promise<void>((res) => { resolveRotation = res }))
    const runner = fakeRunner()
    const run = logoutClaudeCli(ID, { runner })
    await settle()
    identity.captureClaudeAccount('sid-late-1', ID)
    try {
      resolveRotation()
      expect(await run).toEqual({ ran: false, after: null, refused: 'in-use' })
      expect(runner.calls).toEqual([])
    } finally {
      identity.clearClaudeAccount('sid-late-1')
    }
  })

  it('a probe of the profile asked for during the sign-out waits for it; a second sign-out is refused', async () => {
    let finishLogout: (r: ClaudeCliAuthRun) => void = () => {}
    const runner = fakeRunner((args) => (args.includes('logout') ? new Promise<ClaudeCliAuthRun>((res) => { finishLogout = res }) : signedOut()))
    const run = logoutClaudeCli(ID, { runner })
    await until(() => runner.calls.length === 1, 'the sign-out to start')
    execFileImpl = (_c, _a, _o, cb) => cb(null, { stdout: JSON.stringify({ loggedIn: false }), stderr: '' })
    const probe = readClaudeCliAuth(ID)
    expect(await logoutClaudeCli(ID, { runner: fakeRunner() })).toEqual({ ran: false, after: null, refused: 'in-use' })
    await settle()
    expect(execCalls, 'the probe ran beside the sign-out').toEqual([])
    finishLogout(ok())
    await run
    await probe
    expect(execCalls).toEqual([['claude', 'auth', 'status']])
  })

  it('a sign-out stopped at its time limit: no status read, its process tree ended before it answers, unconfirmed in the log', async () => {
    let killDone: () => void = () => {}
    const killSettled = new Promise<void>((res) => { killDone = res })
    const runner = fakeRunner((args) => (args.includes('logout') ? { exitCode: null, stdout: '', timedOut: true, killSettled } : signedOut()))
    let answered = false
    const run = logoutClaudeCli(ID, { runner }).then((r) => { answered = true; return r })
    await until(() => runner.calls.length === 1, 'the sign-out to start')
    await settle()
    expect(answered, 'answered before its process tree ended').toBe(false)
    expect(consumers.hasTransientProfileConsumer(ID)).toBe(true)
    killDone()
    expect(await run).toEqual({ ran: true, after: null, timedOut: true })
    expect(runner.calls.map((c) => c.args)).toEqual([['auth', 'logout']])
    await settle()
    expect(consumers.hasTransientProfileConsumer(ID)).toBe(false)
    expect(logs.info.some((l) => l.includes(ID) && l.includes('unconfirmed'))).toBe(true)
  })

  it('the verdict is the state afterwards, the log says unconfirmed when it is, and the identity copy goes unless still signed in', async () => {
    plantIdentity(ID)
    const still = fakeRunner((args) => (args.includes('logout') ? { exitCode: 1, stdout: '', timedOut: false } : ok(JSON.stringify({ loggedIn: true, email: 'a@example.com' }))))
    expect(await logoutClaudeCli(ID, { runner: still })).toEqual({ ran: true, after: expect.objectContaining({ authenticated: true }) })
    expect(fs.existsSync(identityCopy(ID)), 'the copy of a profile still signed in was removed').toBe(true)
    expect(logs.info.some((l) => l.includes('still reads as signed in'))).toBe(true)

    const unread = fakeRunner((args) => (args.includes('logout') ? ok('') : { exitCode: null, stdout: 'not json', timedOut: false }))
    expect(await logoutClaudeCli(ID, { runner: unread })).toEqual({ ran: true, after: null })
    expect(logs.info.some((l) => l.includes('signed out is unconfirmed'))).toBe(true)
    expect(fs.existsSync(identityCopy(ID)), 'a sign-out that ran left the credential copy').toBe(false)
    expect(fs.existsSync(join(root, ID, 'identity', '.claude.json')), 'the identity itself was removed').toBe(true)

    plantIdentity(ID)
    logs.info.length = 0
    expect(await logoutClaudeCli(ID, { runner: fakeRunner() })).toMatchObject({ ran: true })
    expect(fs.existsSync(identityCopy(ID))).toBe(false)
    expect(logs.info.some((l) => l.includes('confirmed by its status'))).toBe(true)
  })

  it('the identity copy removal: nothing there is fine, a folder planted at its name goes, the identity stays, a bad id is refused', () => {
    expect(profiles.removeProfileIdentityCredentials(ID)).toBe(true)
    fs.mkdirSync(join(root, ID, 'identity', '.credentials.json', 'inner'), { recursive: true })
    fs.writeFileSync(join(root, ID, 'identity', '.claude.json'), '{}')
    expect(profiles.removeProfileIdentityCredentials(ID)).toBe(true)
    expect(fs.existsSync(identityCopy(ID))).toBe(false)
    expect(fs.existsSync(join(root, ID, 'identity', '.claude.json'))).toBe(true)
    expect(profiles.removeProfileIdentityCredentials('../../etc')).toBe(false)
  })

  it('a refused project gate, a missing home or a bad id runs nothing', async () => {
    const runner = fakeRunner()
    gateSeam.refuse = true
    _resetProjectScanStateForTest()
    expect(await logoutClaudeCli(ID, { runner })).toEqual({ ran: false, after: null, refused: 'host-control' })
    expect(consumers.hasTransientProfileConsumer(ID)).toBe(false)
    gateSeam.refuse = false
    expect(await logoutClaudeCli('profile-not-there-1', { runner })).toEqual({ ran: false, after: null, refused: 'no-home' })
    for (const bad of ['../../etc', '', 'a b']) expect(await logoutClaudeCli(bad, { runner })).toEqual({ ran: false, after: null, refused: 'invalid-profile' })
    expect(runner.calls).toEqual([])
  })
})
