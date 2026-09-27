// @vitest-environment node
//
// Usage track MP3, D5 (approved as drawn): with Claude Code switched off (or
// its setting unreadable), the Account usage page makes no Claude call at all.
// Every account comes back `off` before any credential file is located or
// read, before any token refresh and before any usage GET; the stream does
// not pace (nothing is networked). The Settings label list is cached data only:
// no network and no credential read, whatever the switch.
//
// The observables: the credential folder is never asked for (getProfileConfigDir),
// the account's email file is never read, and no request leaves (https mock).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AccountProfile } from '../../src/shared/account-types'
import type { UsageBucket } from '../../src/shared/usage-types'

let profiles: AccountProfile[] = []
let tmpHome = ''
const configDirAsked: string[] = []
const emailRead: string[] = []
let seededSnapshots: Record<string, { buckets: UsageBucket[]; fetchedAt: number }> = {}
const profileBySession = new Map<string, string>()

vi.mock('../../src/main/account-profiles', () => ({
  listProfiles: () => profiles,
  getProfileConfigDir: (id: string) => { configDirAsked.push(id); return tmpHome },
  readProfileAccountEmail: (id: string) => { emailRead.push(id); return null },
  atomicWriteSecure: vi.fn(),
  hardenCredentialFile: vi.fn(),
}))
vi.mock('../../src/main/claude-account-identity', () => ({
  isProfileInUseByLiveSession: () => false,
  getClaudeProfileId: (sessionId: string) => profileBySession.get(sessionId),
}))
vi.mock('../../src/main/usage/usage-snapshots', () => ({
  loadSnapshots: () => new Map(Object.entries(seededSnapshots)),
  saveSnapshots: () => true,
}))
vi.mock('../../src/main/debug-logger', () => ({ logWarn: vi.fn(), logInfo: vi.fn() }))

const requestedHosts: string[] = []
vi.mock('https', () => {
  const request = (opts: any, cb: (res: any) => void) => {
    requestedHosts.push(opts?.hostname ?? '')
    const isUsageGet = opts?.hostname === 'api.anthropic.com'
    const res: any = {
      statusCode: isUsageGet ? 200 : 400,
      headers: {},
      on: (ev: string, fn: (arg?: unknown) => void) => {
        if (ev === 'data' && isUsageGet) fn(JSON.stringify({ limits: [{ group: 'session', percent: 3, resets_at: '' }] }))
        if (ev === 'end') fn()
        return res
      },
    }
    cb(res)
    return { on: () => ({}), write: () => {}, end: () => {}, destroy: () => {}, setTimeout: () => {} }
  }
  return { default: { request }, request }
})

const {
  fetchAccountUsage, fetchAllAccountsUsageStreaming, setClaudeAccountDataAllowed, claudeAccountDataAllowed, knownUsageLabels,
  recordLiveUsageForSession, setLiveUsageTranscriptProfile, _resetLiveUsageForTest, _resetSnapshotsForTest,
} = await import('../../src/main/usage/account-usage')

// P3.2: the recorder files a figure under a profile only when the session's
// transcript lies in that profile's folder (the Tokenomics folder rule, tested
// in tk-attribution). Here a stand-in for that rule: /profiles/<id>/projects/...
const transcriptOf = (sessionId: string, profileId = profileBySession.get(sessionId)) =>
  `/profiles/${profileId}/projects/p/00000000-0000-4000-8000-000000000000.jsonl`
const fakeFolderRule = (transcriptPath: string) => /^\/profiles\/([^/]+)\/projects\/[^/]+\/[^/]+\.jsonl$/.exec(transcriptPath)?.[1]

const profile = (id: string, over: Partial<AccountProfile> = {}): AccountProfile => ({ id, name: `Acct ${id}`, accountEmail: `${id}@example.com`, createdAt: 0, ...over })
const bucket = (label: string): UsageBucket => ({ key: `k:${label}`, label, group: 'weekly', percent: 5, resetsAt: '', severity: 'normal' })

function writeCreds(expiresAt: number): void {
  const dir = path.join(tmpHome, '.claude')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', refreshToken: 'r', expiresAt } }))
}

beforeEach(() => {
  setLiveUsageTranscriptProfile(fakeFolderRule)
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-usage-off-'))
  profiles = [profile('profile-a-1'), profile('profile-b-1'), profile('profile-c-1'), profile('profile-d-1'), profile('profile-e-1')]
  configDirAsked.length = 0
  emailRead.length = 0
  requestedHosts.length = 0
  seededSnapshots = {}
  profileBySession.clear()
  _resetLiveUsageForTest()
  _resetSnapshotsForTest()
  setClaudeAccountDataAllowed(() => true)
  // A lapsed token: the closed-account path would refresh it if it ran.
  writeCreds(Date.now() - 60_000)
})
afterEach(() => { try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('Claude Code off: the usage page makes no Claude call (D5)', () => {
  it('one account comes back off before its credentials are located, refreshed or used', async () => {
    setClaudeAccountDataAllowed(() => false)
    const r = await fetchAccountUsage('profile-a-1')
    expect(r).toMatchObject({ profileId: 'profile-a-1', status: 'off', buckets: [], email: 'profile-a-1@example.com', name: 'Acct profile-a-1' })
    expect(configDirAsked).toEqual([])
    expect(emailRead).toEqual([])
    expect(requestedHosts).toEqual([])
  })

  it('a rule that cannot answer counts as off (fail closed)', async () => {
    setClaudeAccountDataAllowed(() => { throw new Error('settings unreadable') })
    expect((await fetchAccountUsage('profile-a-1')).status).toBe('off')
    expect(configDirAsked).toEqual([])
    expect(requestedHosts).toEqual([])
  })

  // Review L-A (MP3 round 2): the credential-state handler asks the same rule.
  it('the rule the credential-state handler asks is this one, and a rule that throws is a no', () => {
    setClaudeAccountDataAllowed(() => true)
    expect(claudeAccountDataAllowed()).toBe(true)
    setClaudeAccountDataAllowed(() => false)
    expect(claudeAccountDataAllowed()).toBe(false)
    setClaudeAccountDataAllowed(() => { throw new Error('settings unreadable') })
    expect(claudeAccountDataAllowed()).toBe(false)
  })

  it('the stream delivers every account off, with no call and no pacing', async () => {
    setClaudeAccountDataAllowed(() => false)
    const got: string[] = []
    const started = Date.now()
    await fetchAllAccountsUsageStreaming((u) => got.push(`${u.profileId}:${u.status}`))
    expect(Date.now() - started).toBeLessThan(600) // five paced accounts would wait 1200 ms
    expect(got).toEqual(profiles.map((p) => `${p.id}:off`))
    expect(configDirAsked).toEqual([])
    expect(requestedHosts).toEqual([])
  })

  it('switched off during a stream, the accounts not yet read come back off', async () => {
    let on = true
    setClaudeAccountDataAllowed(() => on)
    profiles = [profile('profile-a-1'), profile('profile-b-1')]
    const got: string[] = []
    await fetchAllAccountsUsageStreaming((u) => { got.push(u.status); on = false })
    expect(got[1]).toBe('off')
    expect(configDirAsked).toEqual(['profile-a-1'])
  })

  it('with Claude Code on, the same account is fetched (the observables can fail)', async () => {
    const r = await fetchAccountUsage('profile-a-1')
    expect(r.status).not.toBe('off')
    expect(configDirAsked).toContain('profile-a-1')
    expect(requestedHosts.length).toBeGreaterThan(0)
  })
})

describe('knownUsageLabels (Settings, no network)', () => {
  it('lists the labels of the saved and live figures, once each, with no call and no credential read', async () => {
    seededSnapshots = { 'profile-a-1': { buckets: [bucket('5h'), bucket('Weekly')], fetchedAt: 1 }, 'profile-b-1': { buckets: [bucket('Weekly'), bucket('Fable')], fetchedAt: 1 } }
    profileBySession.set('sess-1', 'profile-c-1')
    recordLiveUsageForSession('sess-1', [bucket('Opus')], false, transcriptOf('sess-1'))
    setClaudeAccountDataAllowed(() => false)
    expect(knownUsageLabels()).toEqual(['5h', 'Weekly', 'Fable', 'Opus'])
    expect(configDirAsked).toEqual([])
    expect(emailRead).toEqual([])
    expect(requestedHosts).toEqual([])
  })

  it('bounds the list and every label', () => {
    // An over-long label first, so the count cap cannot hide the length bound.
    const many: UsageBucket[] = [bucket('x'.repeat(500))]
    for (let i = 0; i < 200; i++) many.push(bucket(`L${i}`))
    seededSnapshots = { 'profile-a-1': { buckets: many, fetchedAt: 1 } }
    const labels = knownUsageLabels()
    expect(labels).toHaveLength(64)
    expect(labels[0]).toBe('L0')
    for (const l of labels) expect(l.length).toBeLessThanOrEqual(64)
  })
})
