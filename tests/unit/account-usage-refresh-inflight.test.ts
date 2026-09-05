// @vitest-environment node
//
// #49 (rc.14 review F5): the usage page's token refresh must PUBLISH itself while
// its POST is in flight, so a consumer that starts in that window (a session, a
// headless run, a cloud agent) can wait for the new lineage instead of reading a
// credential file whose refresh token is about to be spent. profile-consumers
// owns the registry; this pins that account-usage actually writes to it -- the
// registration is what every consumer's `waitForProfileRefresh` reads.
//
// Same harness shape as account-usage-norefresh: the observable is the network,
// except here the token POST is HELD OPEN until the test answers it.
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
  isProfileInUseByLiveSession: () => false, // no consumer: the guard ALLOWS the refresh
}))
vi.mock('../../src/main/debug-logger', () => ({ logWarn: vi.fn(), logInfo: vi.fn() }))

/** The token POST, held until `answer()` is called. */
const held: { hosts: string[]; answer: (() => void) | null } = { hosts: [], answer: null }
vi.mock('https', () => {
  const request = (opts: any, cb: (res: any) => void) => {
    held.hosts.push(opts?.hostname ?? '')
    const res: any = {
      statusCode: 400,
      headers: {},
      on: (ev: string, fn: (arg?: unknown) => void) => {
        if (ev === 'end') fn()
        return res
      },
    }
    if (opts?.hostname === 'console.anthropic.com') held.answer = () => cb(res)
    else cb(res)
    return { on: () => ({}), write: () => {}, end: () => {}, destroy: () => {}, setTimeout: () => {} }
  }
  return { default: { request }, request }
})

const { fetchAccountUsage } = await import('../../src/main/usage/account-usage')
const { pendingProfileRefresh, waitForProfileRefresh, _resetProfileConsumersForTest } = await import('../../src/main/profile-consumers')

const PROFILE = 'profile-x-1'

function writeLapsedCreds(): void {
  const dir = path.join(tmpHome, '.claude')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'lapsed-access', refreshToken: 'the-refresh-token', expiresAt: 1 } }),
  )
}

async function untilPostHeld(): Promise<void> {
  for (let i = 0; i < 200 && !held.answer; i++) await new Promise((r) => setTimeout(r, 5))
  expect(held.answer, 'the token POST was issued').toBeTruthy()
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-refresh-inflight-'))
  profiles = [{ id: PROFILE, name: 'X', accountEmail: 'x@example.com', createdAt: 0, active: true }]
  held.hosts.length = 0
  held.answer = null
  _resetProfileConsumersForTest()
  writeLapsedCreds()
})

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('fetchAccountUsage publishes its in-flight token refresh (#49)', () => {
  it('is registered while the POST is pending, and cleared once it settles', async () => {
    expect(pendingProfileRefresh(PROFILE)).toBeNull()
    const fetching = fetchAccountUsage(PROFILE)
    await untilPostHeld()

    // The rotation is in flight: a consumer starting now would see it and wait.
    expect(pendingProfileRefresh(PROFILE)).not.toBeNull()
    let consumerStarted = false
    const consumer = waitForProfileRefresh(PROFILE).then(() => { consumerStarted = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(consumerStarted).toBe(false)

    held.answer!()
    await fetching
    await consumer
    expect(consumerStarted).toBe(true)
    expect(pendingProfileRefresh(PROFILE)).toBeNull()
  })

  it('is scoped to the profile being refreshed', async () => {
    const fetching = fetchAccountUsage(PROFILE)
    await untilPostHeld()
    expect(pendingProfileRefresh('profile-other-2')).toBeNull()
    held.answer!()
    await fetching
  })
})
