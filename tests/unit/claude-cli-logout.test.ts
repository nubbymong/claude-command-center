// @vitest-environment node
//
// logoutClaudeCli (WP2 PR 4, owner answers 2026-10-04): the sign-out beside
// the `claude auth status` probe, and what the Claude package's auth.logout
// runs. [host] The CLI is a mocked execFile (no real claude runs) and the
// profiles root is a temp folder; withProfileHome and the project gate are the
// REAL ones, so the environment the sign-out would run in is what is asserted.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { composeProviders } from '../../src/main/providers/compose'

let root: string

type ExecCb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
type Call = { cmd: string; args: string[]; env: Record<string, string>; shell: unknown }
let calls: Call[] = []
let execFileImpl: (cmd: string, args: string[], opts: unknown, cb: ExecCb) => void

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb: ExecCb) => {
    const o = opts as { env: Record<string, string>; shell?: unknown }
    calls.push({ cmd, args, env: o.env, shell: o.shell })
    return execFileImpl(cmd, args, opts, cb)
  },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
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
vi.mock('../../src/main/account-profiles', async () => ({
  ...(await vi.importActual<typeof import('../../src/main/account-profiles')>('../../src/main/account-profiles')),
  getProfilesRoot: () => root,
  getProfileConfigDir: (id: string) => join(root, id),
}))

const { logoutClaudeCli } = await import('../../src/main/account-web/claude-cli-auth')
const { acquireProfileConsumer, hasTransientProfileConsumer, noteProfileRefreshInFlight, _resetProfileConsumersForTest } = await import('../../src/main/profile-consumers')
const { gateManagedLaunch, _resetProjectScanStateForTest } = await import('../../src/main/managed-launch-diagnostics')

const ID = 'profile-abc-123'
const OTHER = 'profile-def-456'
const signedOutAnswer = () => Object.assign(new Error('Command failed: claude auth status'), { code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }), stderr: '' })
/** logout succeeds; status then answers signed out (exit 1, its JSON on stdout). */
const cleanRun: typeof execFileImpl = (_c, args, _o, cb) => (args.includes('logout') ? cb(null, { stdout: 'Successfully logged out from your Anthropic account.', stderr: '' }) : cb(signedOutAnswer()))

beforeAll(() => { composeProviders() })
beforeEach(async () => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'ccc-cli-logout-'))
  calls = []
  execFileImpl = cleanRun
  gateSeam.refuse = false
  _resetProfileConsumersForTest()
  _resetProjectScanStateForTest()
  await gateManagedLaunch(process.cwd())
})
afterEach(() => {
  if (root.startsWith(join(os.tmpdir(), 'ccc-cli-logout-'))) fs.rmSync(root, { recursive: true, force: true })
})

describe('logoutClaudeCli: the CLI\'s own sign-out in exactly this profile\'s home [host]', () => {
  it('runs `claude auth logout` then reads the state afresh, both in the profile\'s own hardened home', async () => {
    fs.mkdirSync(join(root, ID), { recursive: true })
    fs.mkdirSync(join(root, OTHER), { recursive: true })
    process.env.ANTHROPIC_API_KEY = 'sk-ambient-poison'
    process.env.CLAUDE_CONFIG_DIR = '/elsewhere'
    let r: Awaited<ReturnType<typeof logoutClaudeCli>>
    try {
      r = await logoutClaudeCli(ID)
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CONFIG_DIR
    }
    expect(r).toEqual({ ran: true, after: expect.objectContaining({ authenticated: false, source: 'cli-status' }) })
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([['claude', 'auth', 'logout'], ['claude', 'auth', 'status']])
    for (const c of calls) {
      // This profile's home and no other; the ambient authority stripped.
      expect(c.env.USERPROFILE).toBe(join(root, ID))
      expect(c.env.HOME).toBe(join(root, ID))
      expect(c.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(c.env.CLAUDE_CONFIG_DIR).toBeUndefined()
      expect(c.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined()
      expect(JSON.stringify(c.env)).not.toContain(OTHER)
    }
  })

  it('is refused, and runs nothing, while the profile is in use (a session or a check holding it)', async () => {
    fs.mkdirSync(join(root, ID), { recursive: true })
    const release = acquireProfileConsumer(ID)
    try {
      expect(await logoutClaudeCli(ID)).toEqual({ ran: false, after: null, refused: 'in-use' })
      expect(calls).toEqual([])
    } finally {
      release()
    }
    // Another profile in use does not stop this one.
    const other = acquireProfileConsumer(OTHER)
    try {
      expect(await logoutClaudeCli(ID)).toMatchObject({ ran: true })
    } finally {
      other()
    }
  })

  it('holds the profile for the run, waits for a token rotation already in flight, and lets go after', async () => {
    fs.mkdirSync(join(root, ID), { recursive: true })
    let resolveRotation: () => void = () => {}
    noteProfileRefreshInFlight(ID, new Promise<void>((res) => { resolveRotation = res }))
    let heldDuring: boolean | undefined
    execFileImpl = (c, args, o, cb) => { heldDuring = hasTransientProfileConsumer(ID); cleanRun(c, args, o, cb) }
    const run = logoutClaudeCli(ID)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls, 'started while a rotation was in flight').toEqual([])
    resolveRotation()
    expect(await run).toMatchObject({ ran: true })
    expect(heldDuring).toBe(true)
    expect(hasTransientProfileConsumer(ID)).toBe(false)
  })

  it('a refused project gate, a missing home or a bad id runs nothing', async () => {
    fs.mkdirSync(join(root, ID), { recursive: true })
    gateSeam.refuse = true
    _resetProjectScanStateForTest()
    expect(await logoutClaudeCli(ID)).toEqual({ ran: false, after: null, refused: 'host-control' })
    expect(hasTransientProfileConsumer(ID)).toBe(false)
    gateSeam.refuse = false
    expect(await logoutClaudeCli('profile-not-there-1')).toEqual({ ran: false, after: null, refused: 'no-home' })
    for (const bad of ['../../etc', '', 'a b']) expect(await logoutClaudeCli(bad)).toEqual({ ran: false, after: null, refused: 'invalid-profile' })
    expect(calls).toEqual([])
  })

  it('the verdict is the state afterwards: a failed sign-out that left it signed in says so; a timed-out one says it ran', async () => {
    fs.mkdirSync(join(root, ID), { recursive: true })
    execFileImpl = (_c, args, _o, cb) => (args.includes('logout')
      ? cb(Object.assign(new Error('Logout failed'), { code: 1, stdout: '', stderr: 'Logout failed: x' }))
      : cb(null, { stdout: JSON.stringify({ loggedIn: true, email: 'a@example.com' }), stderr: '' }))
    expect(await logoutClaudeCli(ID)).toEqual({ ran: true, after: expect.objectContaining({ authenticated: true }) })
    execFileImpl = (_c, args, _o, cb) => (args.includes('logout') ? cb(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })) : cb(signedOutAnswer()))
    expect(await logoutClaudeCli(ID)).toEqual({ ran: true, after: expect.objectContaining({ authenticated: false }), timedOut: true })
    execFileImpl = (_c, args, _o, cb) => (args.includes('logout') ? cb(null, { stdout: '', stderr: '' }) : cb(new Error('no cli')))
    expect(await logoutClaudeCli(ID)).toEqual({ ran: true, after: null })
  })
})
