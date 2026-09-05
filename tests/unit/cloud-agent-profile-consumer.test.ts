// #48/#49 (rc.14 review F4/F5): a cloud agent runs `claude` in a profile's
// credential home for as long as its process lives, but registered nowhere -- the
// usage page's auto-refresh could rotate the token under it and strand the
// account, and an agent could start mid-rotation and read the old file. The
// manager now holds the profile for the child's life and waits out a rotation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockSpawn = vi.fn()
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}))

const mockReadConfig = vi.fn()
vi.mock('../../src/main/config-manager', () => ({
  readConfig: (...args: any[]) => mockReadConfig(...args),
  readConfigChecked: (key: string) => {
    const v = mockReadConfig(key)
    return v == null ? { value: null, outcome: 'absent' } : { value: v, outcome: 'ok' }
  },
  writeConfig: vi.fn(() => true),
  getConfigDir: () => '/mock/CONFIG',
  ensureConfigDir: vi.fn(),
}))
vi.mock('../../src/main/legacy-version-manager', () => ({
  resolveVersionBinary: vi.fn(() => null),
  isVersionInstalled: vi.fn(() => false),
  installVersion: vi.fn(async () => ({ ok: false, error: 'mock' })),
}))

// A REAL directory stands in for the profile home, so the resolver's existsSync
// passes and the agent is stamped with the profile (the default-home fallback is
// what we are proving we DON'T take).
const profMocks = vi.hoisted(() => ({
  homes: {} as Record<string, string>,
  getPrimaryProfileId: vi.fn<() => string | null>(() => null),
}))
vi.mock('../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/account-profiles')>()),
  getPrimaryProfileId: profMocks.getPrimaryProfileId,
  getProfileConfigDir: (id: string) => profMocks.homes[id] ?? `/nonexistent/profiles/${id}`,
  setupProfileLinks: vi.fn(),
  listProfiles: () => Object.keys(profMocks.homes).map((id) => ({ id, name: id, accountEmail: `${id}@example.com` })),
}))

import { initCloudAgentManager, dispatchAgent, _resetCloudAgentLatchForTest } from '../../src/main/cloud-agent-manager'
import {
  hasTransientProfileConsumer,
  noteProfileRefreshInFlight,
  _resetProfileConsumersForTest,
} from '../../src/main/profile-consumers'

function makeChild() {
  const handlers: Record<string, (...a: any[]) => void> = {}
  return {
    pid: 12345,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
    on: (ev: string, cb: (...a: any[]) => void) => { handlers[ev] = cb },
    kill: vi.fn(),
    handlers,
  }
}

const PROFILE = 'profile-agent-01'
const tmpDirs: string[] = []
let child: ReturnType<typeof makeChild>
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await Promise.resolve() }

beforeEach(() => {
  vi.clearAllMocks()
  _resetCloudAgentLatchForTest()
  _resetProfileConsumersForTest()
  mockReadConfig.mockReturnValue(null)
  profMocks.getPrimaryProfileId.mockReturnValue(null)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-agent-prof-'))
  tmpDirs.push(home)
  profMocks.homes = { [PROFILE]: home }
  child = makeChild()
  mockSpawn.mockImplementation(() => child)
  initCloudAgentManager(() => ({ isDestroyed: () => false, webContents: { send: vi.fn() } }) as any)
})

afterEach(() => {
  for (const d of tmpDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

const dispatch = () => dispatchAgent({ name: 'A', description: 'do the thing', projectPath: os.tmpdir(), profileId: PROFILE })

describe('cloud agent — the agent is a profile consumer for its process life (#48)', () => {
  it('holds the profile from dispatch until the child closes', async () => {
    const agent = await dispatch()
    expect(agent.profileId).toBe(PROFILE)
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(hasTransientProfileConsumer(PROFILE)).toBe(true)
    child.handlers.close(0)
    expect(hasTransientProfileConsumer(PROFILE)).toBe(false)
  })

  it('releases on the error path', async () => {
    await dispatch()
    expect(hasTransientProfileConsumer(PROFILE)).toBe(true)
    child.handlers.error(new Error('spawn failed'))
    expect(hasTransientProfileConsumer(PROFILE)).toBe(false)
  })

  it('is NOT swept by the 30s probe clock — an agent that runs for an hour is in use for an hour', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      await dispatch()
      vi.setSystemTime(3_600_000)
      expect(hasTransientProfileConsumer(PROFILE)).toBe(true)
      child.handlers.close(0)
      expect(hasTransientProfileConsumer(PROFILE)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds nothing when the agent falls back to the default/global home', async () => {
    profMocks.homes = {}
    const agent = await dispatch()
    expect(agent.profileId).toBeUndefined()
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(hasTransientProfileConsumer(PROFILE)).toBe(false)
    child.handlers.close(0)
  })
})

describe('cloud agent — starting mid-rotation waits for the refresh (#49)', () => {
  it('does not spawn until an in-flight refresh of the profile settles', async () => {
    let settle!: (v: unknown) => void
    noteProfileRefreshInFlight(PROFILE, new Promise((resolve) => { settle = resolve }))

    const p = dispatch()
    await tick()
    expect(mockSpawn).not.toHaveBeenCalled()

    settle({ accessToken: 'new' })
    await p
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(hasTransientProfileConsumer(PROFILE)).toBe(true)
    child.handlers.close(0)
  })
})
