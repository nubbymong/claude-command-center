// @vitest-environment node
//
// #48 (rc.14 review F4), through the REAL guard: a registered profile consumer
// (a headless run, an Insights run, a cloud agent, a shell-only session, the auth
// probe) must stop the usage page's auto token-refresh from rotating that
// profile's single-use refresh token. The other account-usage suites stub
// `isProfileInUseByLiveSession`; this one keeps the real claude-account-identity
// module so the path is registry -> guard -> no POST, not a mock agreeing with
// itself.
//
// Same harness shape as account-usage-norefresh: the observable is the network.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AccountProfile } from '../../src/shared/account-types'

let profiles: AccountProfile[] = []
let tmpHome = ''

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../src/main/account-profiles', () => ({
  listProfiles: () => profiles,
  getProfileConfigDir: () => tmpHome,
  readProfileAccountEmail: () => null,
  atomicWriteSecure: vi.fn(),
  hardenCredentialFile: vi.fn(),
}))
vi.mock('../../src/main/debug-logger', () => ({ logWarn: vi.fn(), logInfo: vi.fn() }))

const requestedHosts: string[] = []
vi.mock('https', () => {
  const request = (opts: any, cb: (res: any) => void) => {
    requestedHosts.push(opts?.hostname ?? '')
    const res: any = {
      statusCode: 400,
      headers: {},
      on: (ev: string, fn: (arg?: unknown) => void) => {
        if (ev === 'end') fn()
        return res
      },
    }
    cb(res)
    return { on: () => ({}), write: () => {}, end: () => {}, destroy: () => {}, setTimeout: () => {} }
  }
  return { default: { request }, request }
})

const { fetchAccountUsage } = await import('../../src/main/usage/account-usage')
const { acquireProfileConsumer, _resetProfileConsumersForTest } = await import('../../src/main/profile-consumers')
const { isProfileInUseByLiveSession } = await import('../../src/main/claude-account-identity')

const REFRESH_HOST = 'console.anthropic.com'
const PROFILE = 'profile-x-1'

function writeLapsedCreds(): void {
  const dir = path.join(tmpHome, '.claude')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'lapsed-access', refreshToken: 'the-refresh-token', expiresAt: 1 } }),
  )
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-consumer-guard-'))
  profiles = [{ id: PROFILE, name: 'X', accountEmail: 'x@example.com', createdAt: 0, active: true }]
  requestedHosts.length = 0
  _resetProfileConsumersForTest()
  writeLapsedCreds()
})

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('the usage refresh defers to a registered profile consumer (#48)', () => {
  it('does NOT rotate while a long-lived consumer holds the profile, and does once it releases', async () => {
    const release = acquireProfileConsumer(PROFILE, { maxAgeMs: Infinity })
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(true) // the real guard, via the registry

    await fetchAccountUsage(PROFILE)
    expect(requestedHosts).not.toContain(REFRESH_HOST)

    release()
    expect(isProfileInUseByLiveSession(PROFILE)).toBe(false)
    await fetchAccountUsage(PROFILE)
    expect(requestedHosts).toContain(REFRESH_HOST) // proves the test can see a rotation
  })

  it('a consumer of ANOTHER profile does not block this one', async () => {
    const release = acquireProfileConsumer('profile-other-2', { maxAgeMs: Infinity })
    await fetchAccountUsage(PROFILE)
    expect(requestedHosts).toContain(REFRESH_HOST)
    release()
  })

  it('a LEAKED probe ref past its window no longer blocks the refresh (self-heal)', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      acquireProfileConsumer(PROFILE) // the 30s default; never released
      vi.setSystemTime(31_000)
      expect(isProfileInUseByLiveSession(PROFILE)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
    await fetchAccountUsage(PROFILE)
    expect(requestedHosts).toContain(REFRESH_HOST)
  })
})
