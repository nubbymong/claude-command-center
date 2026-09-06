// rc.15 review R4 (Codex, 2026-09-06; aicc_planning#50): the reviewer's own
// characterization (evidence/accounts-rotation.review.test.ts, first case)
// flipped into the desired behaviour, credit Codex rc.15 stability review; RED
// against 7ef62a2e before this change. The positive controls are labelled.
//
// A rotates after the canonical backup, and /login replaces the shared home
// with B before the rotation was observed settled. The email guard refuses B as
// A, but A's canonical token is a generation A may already have spent, and the
// capture path reinstalled it -- a restore that strands A silently. The capture
// path now restores IDENTITY ONLY and sanitises both token-bearing files, so A
// reads as Sign in (owner decision, plan Q1 = (a)). A rotation and a login
// inside one unobserved poll cannot be told apart from outside, so the same
// holds with no intervening observation at all.
//
// Real account-profiles + identity code over a temp resources root; the capture
// is driven through the real IPC handler (electron's ipcMain mocked to a map).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const handlers = vi.hoisted(() => new Map<string, (...a: any[]) => any>())
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
}))
vi.mock('../../../src/main/usage/usage-snapshots', () => ({ loadSnapshots: () => new Map(), saveSnapshots() {} }))
vi.mock('../../../src/main/account-auth-info', () => ({ readAllProfileAuthInfo: vi.fn(() => []) }))
vi.mock('../../../src/main/account-web/sign-in', () => ({ clearWebSession: vi.fn() }))
vi.mock('../../../src/main/account-web/session-store', () => ({ removeWebSession: vi.fn() }))
vi.mock('../../../src/main/account-web/artifacts', () => ({ closeArtifacts: vi.fn() }))
vi.mock('../../../src/main/account-web/account-pane', () => ({ closeAccountPanesForProfile: vi.fn() }))

import * as profiles from '../../../src/main/account-profiles'
import * as identity from '../../../src/main/claude-account-identity'
import { registerAccountProfilesHandlers } from '../../../src/main/ipc/account-profiles-handlers'
import { fetchAccountUsage, _resetLiveUsageForTest, _resetSnapshotsForTest } from '../../../src/main/usage/account-usage'
import { IPC } from '../../../src/shared/ipc-channels'

const {
  _setRootsForTest, createProfile, upsertProfile, getProfileConfigDir, getAccountIdentityDir,
  backupProfileHomeToCanonical, readProfileCredentialStamp,
} = profiles

let base: string
let clock = Date.now()
const credFile = (id: string) => path.join(getProfileConfigDir(id), '.claude', '.credentials.json')
const identityFile = (id: string) => path.join(getProfileConfigDir(id), '.claude.json')
function writeCredentials(id: string, refreshToken: string): void {
  fs.mkdirSync(path.dirname(credFile(id)), { recursive: true })
  fs.writeFileSync(credFile(id), JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-at', refreshToken } }))
  clock += 5000
  fs.utimesSync(credFile(id), new Date(clock), new Date(clock))
}
/** The identity file, carrying token-shaped keys as some CLI versions have, so the
 *  identity-only restore has something to strip. */
function writeIdentity(id: string, email: string): void {
  fs.writeFileSync(identityFile(id), JSON.stringify({
    oauthAccount: { emailAddress: email, accountUuid: 'uuid-' + email, accessToken: 'synthetic-identity-token-' + email },
    primaryApiKey: 'synthetic-apikey-' + email,
    projects: { '/work': { allowedTools: [] } },
  }))
}
const tokenAt = (file: string) => (JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeAiOauth: { refreshToken: string } }).claudeAiOauth.refreshToken
const canonical = (id: string) => tokenAt(path.join(getAccountIdentityDir(id), '.credentials.json'))
const home = (id: string) => tokenAt(credFile(id))

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-vitest-rc15-r4-'))
  const resourcesDir = path.join(base, 'resources')
  const sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true })
  fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
  identity._resetForTest()
  _resetLiveUsageForTest()
  _resetSnapshotsForTest()
  handlers.clear()
})
afterEach(() => {
  identity._resetForTest()
  _setRootsForTest(null)
  fs.rmSync(base, { recursive: true, force: true })
})

/** Account A: profile, identity, credentials, and the canonical backup an
 *  add-account (or the last exit) left behind. */
function accountA(): string {
  const a = createProfile('Synthetic A')
  upsertProfile({ ...a, accountEmail: 'a@example.test' })
  writeIdentity(a.id, 'a@example.test')
  writeCredentials(a.id, 'synthetic-a-old')
  backupProfileHomeToCanonical(a.id)
  return a.id
}

/** A rotates after the canonical backup; before the rotation is observed
 *  settled, B completes /login in the shared home. The email guard refuses B as
 *  A, so canonical still holds A's OLD token -- a generation A may have spent. */
async function rotateThenLoginBeforeSettle(sessionId: string): Promise<string> {
  const id = accountA()
  identity.startWatchingAccountIdentity(sessionId, id)
  await identity.recheckAllAsync()
  writeCredentials(id, 'synthetic-a-new')
  await identity.recheckAllAsync() // seen moving, not settled
  expect(canonical(id)).toBe('synthetic-a-old')
  writeCredentials(id, 'synthetic-b')
  writeIdentity(id, 'b@example.test')
  await identity.recheckAllAsync()
  await identity.recheckAllAsync()
  expect(canonical(id)).toBe('synthetic-a-old') // refused: B is not A
  return id
}

function expectIdentityOnly(id: string): void {
  // 7ef62a2e reinstalled 'synthetic-a-old' here.
  expect(fs.existsSync(credFile(id))).toBe(false)
  expect(readProfileCredentialStamp(id)).toEqual({ stamp: null, signedIn: false })
  const restored = JSON.parse(fs.readFileSync(identityFile(id), 'utf8')) as Record<string, unknown>
  expect((restored.oauthAccount as { emailAddress: string }).emailAddress).toBe('a@example.test')
  expect((restored.oauthAccount as { accountUuid: string }).accountUuid).toBe('uuid-a@example.test')
  expect(restored.projects).toEqual({ '/work': { allowedTools: [] } })
  expect(JSON.stringify(restored)).not.toMatch(/synthetic-identity-token|synthetic-apikey|primaryApiKey|accessToken/)
}

describe('R4: rotation, then /login before the settled observation (Codex, flipped)', () => {
  it('Codex: the capture IPC puts A\'s IDENTITY back and nothing token-bearing -- both files sanitised, and A reads Sign in', async () => {
    const id = await rotateThenLoginBeforeSettle('rotation-one')
    registerAccountProfilesHandlers()
    const np = handlers.get(IPC.ACCOUNT_PROFILES_CAPTURE_DETECTED)!({}, { sessionId: 'rotation-one', name: 'Synthetic B' })
    expect(np?.accountEmail).toBe('b@example.test')
    expect(home(np.id)).toBe('synthetic-b') // B keeps B's token in B's new profile
    expectIdentityOnly(id)
    // Not a soft "open a session to refresh": no usable credentials at all is the one Sign in case.
    const usage = await fetchAccountUsage(id)
    expect(usage.status).toBe('needs-login')
  })

  it('the same when the rotation and the login land inside ONE unobserved poll (no intervening observation at all)', async () => {
    const id = accountA()
    identity.startWatchingAccountIdentity('rotation-same-poll', id)
    await identity.recheckAllAsync()
    writeCredentials(id, 'synthetic-a-new')
    writeCredentials(id, 'synthetic-b')
    writeIdentity(id, 'b@example.test')
    await identity.recheckAllAsync()
    await identity.recheckAllAsync()
    expect(canonical(id)).toBe('synthetic-a-old')
    expect(profiles.restoreProfileIdentityFromCanonical(id)).toBe(true)
    expectIdentityOnly(id)
  })

  it('a home with no credentials file at all is left signed out (nothing is created)', () => {
    const id = accountA()
    fs.rmSync(credFile(id))
    expect(profiles.restoreProfileIdentityFromCanonical(id)).toBe(true)
    expect(fs.existsSync(credFile(id))).toBe(false)
    expect(readProfileCredentialStamp(id).signedIn).toBe(false)
  })

  it('returns false with no canonical identity to restore from, and touches nothing', () => {
    const a = createProfile('Never backed up')
    upsertProfile({ ...a, accountEmail: 'n@example.test' })
    writeIdentity(a.id, 'n@example.test')
    writeCredentials(a.id, 'synthetic-n')
    expect(profiles.restoreProfileIdentityFromCanonical(a.id)).toBe(false)
    expect(home(a.id)).toBe('synthetic-n')
  })

  it('positive control: restoreProfileHomeFromCanonical (no production caller) still reinstalls credentials, so the follower tests keep their meaning', () => {
    const id = accountA()
    fs.rmSync(credFile(id))
    expect(profiles.restoreProfileHomeFromCanonical(id)).toBe(true)
    expect(home(id)).toBe('synthetic-a-old')
  })

  it('stripIdentityTokens: token-bearing keys go, at the top level and inside oauthAccount; the email and state stay; garbage yields {}', () => {
    const out = JSON.parse(profiles.stripIdentityTokens(JSON.stringify({
      oauthAccount: { emailAddress: 'a@example.test', accountUuid: 'u', accessToken: 't', refreshToken: 'r', organizationUuid: 'o' },
      claudeAiOauth: { accessToken: 't2' },
      primaryApiKey: 'k',
      someSecret: 's',
      credentials: { x: 1 },
      projects: { '/p': {} },
      numStartups: 3,
    }))) as Record<string, unknown>
    expect(out).toEqual({
      oauthAccount: { emailAddress: 'a@example.test', accountUuid: 'u', organizationUuid: 'o' },
      projects: { '/p': {} },
      numStartups: 3,
    })
    expect(profiles.stripIdentityTokens('not json')).toBe('{}')
    expect(profiles.stripIdentityTokens('[1,2]')).toBe('{}')
    expect(profiles.stripIdentityTokens('null')).toBe('{}')
  })
})
