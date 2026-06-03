/**
 * syncPrimaryCredentialsWithGlobal keeps the user's REAL global Claude login
 * (~/.claude/.credentials.json) in lockstep with the PRIMARY account's profile
 * home, so a CCC session's OAuth token rotation never leaves an external
 * `claude -p` on a dead refresh token (and an external /login is picked up by
 * the next session). Token-file only, freshest-wins, email-guarded, primary-only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import {
  _setRootsForTest, createProfile, setPrimaryProfile, upsertProfile, listProfiles,
  getProfileConfigDir, syncPrimaryCredentialsWithGlobal, getAccountIdentityDir,
} from '../../src/main/account-profiles'

let base: string; let resourcesDir: string; let sharedRoot: string; let realHome: string

function idJson(email: string): string {
  return JSON.stringify({ oauthAccount: { emailAddress: email } })
}
function credJson(expiresAt: number, token = `tok-${expiresAt}`): string {
  return JSON.stringify({ claudeAiOauth: { expiresAt, refreshToken: token } })
}
function writeProfileHome(id: string, email: string, expiresAt: number | null): void {
  const home = getProfileConfigDir(id)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude.json'), idJson(email))
  if (expiresAt != null) fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), credJson(expiresAt))
}
function writeGlobal(email: string | null, expiresAt: number | null): void {
  if (email != null) fs.writeFileSync(path.join(realHome, '.claude.json'), idJson(email))
  if (expiresAt != null) fs.writeFileSync(path.join(sharedRoot, '.credentials.json'), credJson(expiresAt))
}
function readGlobalCredExp(): number {
  const c = JSON.parse(fs.readFileSync(path.join(sharedRoot, '.credentials.json'), 'utf8'))
  return c.claudeAiOauth.expiresAt
}
function readProfileCredExp(id: string): number {
  const c = JSON.parse(fs.readFileSync(path.join(getProfileConfigDir(id), '.claude', '.credentials.json'), 'utf8'))
  return c.claudeAiOauth.expiresAt
}
function makePrimary(email: string): string {
  const p = createProfile('Primary')
  upsertProfile({ ...p, accountEmail: email })
  setPrimaryProfile(p.id)
  return p.id
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-gsync-'))
  resourcesDir = path.join(base, 'res')
  realHome = path.join(base, 'home')
  sharedRoot = path.join(realHome, '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true }); fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
})
afterEach(() => { _setRootsForTest(null); fs.rmSync(base, { recursive: true, force: true }) })

describe('syncPrimaryCredentialsWithGlobal', () => {
  const EMAIL = 'me@live.co.uk'

  it('pushes the fresher PROFILE token to the stale global (the reported bug)', () => {
    const id = makePrimary(EMAIL)
    writeProfileHome(id, EMAIL, 5000) // session rotated to a newer token
    writeGlobal(EMAIL, 1000)          // global frozen at the old token

    expect(syncPrimaryCredentialsWithGlobal()).toBe('profile->global')
    expect(readGlobalCredExp()).toBe(5000) // external claude -p now has the live token
  })

  it('pulls a fresher GLOBAL token (external /login) into the profile + canonical', () => {
    const id = makePrimary(EMAIL)
    writeProfileHome(id, EMAIL, 1000)
    writeGlobal(EMAIL, 9000) // user re-logged outside CCC

    expect(syncPrimaryCredentialsWithGlobal()).toBe('global->profile')
    expect(readProfileCredExp(id)).toBe(9000)
    // canonical kept in lockstep
    const canon = JSON.parse(fs.readFileSync(path.join(getAccountIdentityDir(id), '.credentials.json'), 'utf8'))
    expect(canon.claudeAiOauth.expiresAt).toBe(9000)
  })

  it('is a no-op when both tokens are equally fresh', () => {
    const id = makePrimary(EMAIL)
    writeProfileHome(id, EMAIL, 3000)
    writeGlobal(EMAIL, 3000)
    expect(syncPrimaryCredentialsWithGlobal()).toBe('none')
    expect(readGlobalCredExp()).toBe(3000)
  })

  it('GUARD A: refuses to sync when the profile home was switched to a different account', () => {
    const id = makePrimary(EMAIL)
    writeProfileHome(id, 'other@example.com', 9000) // mid-session /login switched it
    writeGlobal(EMAIL, 1000)
    expect(syncPrimaryCredentialsWithGlobal()).toBe('none')
    expect(readGlobalCredExp()).toBe(1000) // global untouched -> no cross-contamination
  })

  it('GUARD B: refuses to sync when the global is a different account', () => {
    const id = makePrimary(EMAIL)
    writeProfileHome(id, EMAIL, 9000)
    writeGlobal('other@example.com', 1000) // a different account is logged in globally
    expect(syncPrimaryCredentialsWithGlobal()).toBe('none')
    expect(readGlobalCredExp()).toBe(1000) // never overwrite a different global account
  })

  it('creates the global token when missing (profile fresher, identity matches)', () => {
    const id = makePrimary(EMAIL)
    writeProfileHome(id, EMAIL, 7000)
    writeGlobal(EMAIL, null) // global identity present, but creds gone
    expect(syncPrimaryCredentialsWithGlobal()).toBe('profile->global')
    expect(readGlobalCredExp()).toBe(7000)
  })

  it('no-op when there is no primary profile', () => {
    writeGlobal(EMAIL, 1000)
    expect(syncPrimaryCredentialsWithGlobal()).toBe('none')
  })

  it('no-op when the primary profile has no known account email', () => {
    const p = createProfile('Primary')
    setPrimaryProfile(p.id) // accountEmail stays ''
    writeProfileHome(p.id, EMAIL, 9000)
    writeGlobal(EMAIL, 1000)
    expect(syncPrimaryCredentialsWithGlobal()).toBe('none')
    expect(listProfiles().find((x) => x.id === p.id)?.accountEmail).toBe('')
  })
})
