// rc.14 review F6 (aicc_planning#50), the acceptance bullet end to end with the
// REAL account-profiles code over a temp resources root: rotate A's token
// without exiting, sign B into A's shared home, capture B, restore A -- and A
// must get its POST-rotation token back, not the pre-rotation one that the
// exit-time-only backup used to leave in canonical.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import {
  _setRootsForTest, createProfile, upsertProfile, listProfiles, getProfileConfigDir,
  restoreProfileHomeFromCanonical, backupProfileHomeToCanonical, getAccountIdentityDir,
} from '../../../src/main/account-profiles'
import * as identity from '../../../src/main/claude-account-identity'

let base: string
let clock = Date.now()
function writeHome(profileId: string, email: string, refreshToken: string) {
  const home = getProfileConfigDir(profileId)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  const creds = path.join(home, '.claude', '.credentials.json')
  fs.writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken } }))
  clock += 5000
  fs.utimesSync(creds, new Date(clock), new Date(clock))
}
const homeRefreshToken = (profileId: string) =>
  (JSON.parse(fs.readFileSync(path.join(getProfileConfigDir(profileId), '.claude', '.credentials.json'), 'utf8')) as { claudeAiOauth: { refreshToken: string } }).claudeAiOauth.refreshToken
const canonicalRefreshToken = (profileId: string) =>
  (JSON.parse(fs.readFileSync(path.join(getAccountIdentityDir(profileId), '.credentials.json'), 'utf8')) as { claudeAiOauth: { refreshToken: string } }).claudeAiOauth.refreshToken

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-vitest-rot-e2e-'))
  const resourcesDir = path.join(base, 'res'); const sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true }); fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
  identity._resetForTest()
})
afterEach(() => {
  identity._resetForTest()
  _setRootsForTest(null)
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best-effort */ }
})

describe('capture B, restore A, after A rotated mid-session', () => {
  it('REGRESSION: restoring A installs the post-rotation token, because the poll kept canonical current', async () => {
    const a = createProfile('A')
    upsertProfile({ ...a, accountEmail: 'a@corp.test' })
    writeHome(a.id, 'a@corp.test', 'rt-old')
    backupProfileHomeToCanonical(a.id) // what add-account / the last exit left behind
    expect(canonicalRefreshToken(a.id)).toBe('rt-old')

    // A session on A is running and its identity is being polled.
    identity.startWatchingAccountIdentity('s1', a.id)
    await identity.recheckAllAsync() // first observation

    // The CLI rotates A's refresh token mid-session (email unchanged).
    writeHome(a.id, 'a@corp.test', 'rt-new')
    await identity.recheckAllAsync() // the change is seen...
    await identity.recheckAllAsync() // ...and, seen again unchanged, has settled (adversarial pass on #598)
    expect(canonicalRefreshToken(a.id)).toBe('rt-new') // the fix: canonical followed the rotation

    // /login inside that session switches the SHARED home to B (A's current token is overwritten).
    writeHome(a.id, 'b@corp.test', 'rt-b')
    await identity.recheckAllAsync()
    await identity.recheckAllAsync() // settled -- and the email changed: the guarded backup must NOT back B up over A
    expect(canonicalRefreshToken(a.id)).toBe('rt-new')

    // Capture of B ends with restoring A's home from canonical.
    expect(restoreProfileHomeFromCanonical(a.id)).toBe(true)
    expect(homeRefreshToken(a.id)).toBe('rt-new')
    expect(listProfiles().find((p) => p.id === a.id)?.accountEmail).toBe('a@corp.test')
    identity.stopWatchingAccountIdentity('s1')
  })
})
