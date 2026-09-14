// rc.15 review R2 (Codex, 2026-09-06; aicc_planning#50): the reviewer's own
// characterization (evidence/accounts-rotation.review.test.ts, second case)
// flipped into the desired behaviour, credit Codex rc.15 stability review; RED
// against 7ef62a2e before this change. The positive control is labelled.
//
// Two sessions on ONE profile used to call the rotation follower twice in the
// same poll -- the first call armed the changed stamp, the second backed it up
// -- so a snapshot could land between the CLI's credential write and its
// identity write (B's token under A's email, restored as a mixed identity
// later). The follower now runs once per DISTINCT profile per poll, before the
// per-session loop, so the "settled, not merely changed" barrier holds for a
// multi-session profile too.
//
// Real account-profiles code over a temp resources root; the identity poll is
// driven by hand (recheckAllAsync), so every call is exactly one observation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import {
  _setRootsForTest, createProfile, upsertProfile, getProfileConfigDir, getAccountIdentityDir, backupProfileHomeToCanonical,
} from '../../../src/main/account-profiles'
import * as identity from '../../../src/main/claude-account-identity'

let base: string
let clock = Date.now()
const credFile = (id: string) => path.join(getProfileConfigDir(id), '.claude', '.credentials.json')
function writeCredentials(id: string, refreshToken: string): void {
  fs.mkdirSync(path.dirname(credFile(id)), { recursive: true })
  fs.writeFileSync(credFile(id), JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-at', refreshToken } }))
  clock += 5000
  fs.utimesSync(credFile(id), new Date(clock), new Date(clock))
}
function writeIdentity(id: string, email: string): void {
  fs.writeFileSync(path.join(getProfileConfigDir(id), '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
}
const tokenAt = (file: string) => (JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeAiOauth: { refreshToken: string } }).claudeAiOauth.refreshToken
const canonical = (id: string) => tokenAt(path.join(getAccountIdentityDir(id), '.credentials.json'))
const canonicalEmail = (id: string) => (JSON.parse(fs.readFileSync(path.join(getAccountIdentityDir(id), '.claude.json'), 'utf8')) as { oauthAccount: { emailAddress: string } }).oauthAccount.emailAddress

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-vitest-rc15-r2-'))
  const resourcesDir = path.join(base, 'resources')
  const sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true })
  fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
  identity._resetForTest()
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

describe('R2: two sessions on one profile, one poll (Codex, flipped)', () => {
  it('Codex: zero snapshots in the poll that first sees the credential move, however many sessions watch the profile', async () => {
    const id = accountA()
    identity.startWatchingAccountIdentity('rotation-two-a', id)
    identity.startWatchingAccountIdentity('rotation-two-b', id)
    await identity.recheckAllAsync()
    // The CLI has written B's credentials; its separate identity write has not landed.
    writeCredentials(id, 'synthetic-b')
    await identity.recheckAllAsync()
    // 7ef62a2e: the second session's call backed the half-written login up in this very poll.
    expect(canonical(id)).toBe('synthetic-a-old')
    expect(canonicalEmail(id)).toBe('a@example.test')
    // The identity write lands; the settled observation sees B's email against A's profile and refuses.
    writeIdentity(id, 'b@example.test')
    await identity.recheckAllAsync()
    await identity.recheckAllAsync()
    expect(canonical(id)).toBe('synthetic-a-old')
    expect(canonicalEmail(id)).toBe('a@example.test')
  })

  it('three sessions: still zero snapshots on the first sight of the change', async () => {
    const id = accountA()
    for (const s of ['r2-3a', 'r2-3b', 'r2-3c']) identity.startWatchingAccountIdentity(s, id)
    await identity.recheckAllAsync()
    writeCredentials(id, 'synthetic-b')
    await identity.recheckAllAsync()
    expect(canonical(id)).toBe('synthetic-a-old')
  })

  it('with two sessions, a rotation of the profile\'s OWN account is backed up once, and only on the settled poll (7ef62a2e backed it up on first sight)', async () => {
    const id = accountA()
    identity.startWatchingAccountIdentity('rotation-ctl-a', id)
    identity.startWatchingAccountIdentity('rotation-ctl-b', id)
    await identity.recheckAllAsync()
    writeCredentials(id, 'synthetic-a-new')
    await identity.recheckAllAsync() // seen moving
    expect(canonical(id)).toBe('synthetic-a-old')
    await identity.recheckAllAsync() // settled: backed up once
    expect(canonical(id)).toBe('synthetic-a-new')
    expect(canonicalEmail(id)).toBe('a@example.test')
  })

  it('positive control: one session, one rotation: backed up once, one poll after it settles (unchanged behaviour)', async () => {
    const id = accountA()
    identity.startWatchingAccountIdentity('rotation-ctl-single', id)
    await identity.recheckAllAsync()
    writeCredentials(id, 'synthetic-a-new')
    await identity.recheckAllAsync() // seen moving
    expect(canonical(id)).toBe('synthetic-a-old')
    await identity.recheckAllAsync() // settled
    expect(canonical(id)).toBe('synthetic-a-new')
  })
})
