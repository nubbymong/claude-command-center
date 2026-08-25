// @vitest-environment node
//
// #447 adversarial fix: the account-switch usage snapshot must NEVER rotate a
// profile's single-use refresh token — it fires the instant before the session
// respawns onto that same profile, in the window the live-session guard cannot
// see, so a rotation there would spend the token the child is about to use and
// log the account out. `fetchAccountUsage(id, { noRefresh: true })` suppresses
// the rotation branch outright.
//
// The observable is the network: the refresh grant is a POST to
// console.anthropic.com/v1/oauth/token. With noRefresh it is never sent; without
// it (a lapsed, signed-in, non-primary token, no live consumer) it IS.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AccountProfile } from '../../src/shared/account-types'

let profiles: AccountProfile[] = []
let tmpHome = ''

vi.mock('../../src/main/account-profiles', () => ({
  listProfiles: () => profiles,
  getProfileConfigDir: () => tmpHome,
  readProfileAccountEmail: () => null,
  atomicWriteSecure: vi.fn(),
  hardenCredentialFile: vi.fn(),
}))
vi.mock('../../src/main/claude-account-identity', () => ({
  isProfileInUseByLiveSession: () => false, // the guard would otherwise ALLOW refresh
}))
vi.mock('../../src/main/debug-logger', () => ({ logWarn: vi.fn(), logInfo: vi.fn() }))

// Capture every https request's host; answer the token POST with a 400 so the
// refresh resolves to "rejected" and writes nothing (we only care THAT it was
// attempted, never that it succeeds).
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

const REFRESH_HOST = 'console.anthropic.com'

function writeLapsedCreds(): void {
  const dir = path.join(tmpHome, '.claude')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: 'lapsed-access', refreshToken: 'the-refresh-token', expiresAt: 1 },
    }),
  )
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-norefresh-'))
  profiles = [{ id: 'profile-x-1', name: 'X', accountEmail: 'x@example.com', createdAt: 0, active: true }]
  requestedHosts.length = 0
  writeLapsedCreds()
})

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('fetchAccountUsage noRefresh (#447)', () => {
  it('does NOT attempt a token rotation when noRefresh is set', async () => {
    await fetchAccountUsage('profile-x-1', { noRefresh: true })
    expect(requestedHosts).not.toContain(REFRESH_HOST)
  })

  it('DOES attempt a rotation on the same lapsed token without noRefresh (proves the test can see it)', async () => {
    await fetchAccountUsage('profile-x-1')
    expect(requestedHosts).toContain(REFRESH_HOST)
  })
})
