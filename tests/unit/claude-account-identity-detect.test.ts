// tests/unit/claude-account-identity-detect.test.ts
// Tests for the ACCOUNT_NEW_DETECTED broadcast in recheckAll. Bug 2: identity lives
// in the account's shared PROFILE home now, so a /login rewrites the profile home's
// .claude.json and the watcher detects it there. Sessions sharing a home dedupe.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'

const sent: Array<{ channel: string; payload: unknown }> = []
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }],
  },
}))
vi.mock('../../src/main/account-color', () => ({ colourForEmail: () => 'mauve' }))

import { _setRootsForTest, getProfileConfigDir, upsertProfile } from '../../src/main/account-profiles'
import {
  captureClaudeAccount,
  startWatchingAccountIdentity,
  recheckAll,
  _resetClaudeAccounts,
} from '../../src/main/claude-account-identity'
import { IPC } from '../../src/shared/ipc-channels'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-detect-'))
  _setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'shared') })
  fs.mkdirSync(path.join(tmp, 'shared'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'resources'), { recursive: true })
  _resetClaudeAccounts()
  sent.length = 0
})
afterEach(() => {
  _setRootsForTest(null)
  _resetClaudeAccounts()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

/** Write a .claude.json identity file inside the account's PROFILE home. */
function writeProfileIdentity(profileId: string, email: string): string {
  const dir = getProfileConfigDir(profileId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, '.claude.json')
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: email } }))
  return file
}

/** Rewrite the profile home's .claude.json, forcing the mtime forward so the
 *  mtime-guarded watcher sees the change. */
function rewriteProfileIdentity(profileId: string, email: string): void {
  const file = path.join(getProfileConfigDir(profileId), '.claude.json')
  const before = fs.statSync(file).mtimeMs
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: email } }))
  if (fs.statSync(file).mtimeMs === before) {
    const future = new Date(before + 1000)
    fs.utimesSync(file, future, future)
  }
}

describe('recheckAll — ACCOUNT_NEW_DETECTED', () => {
  it('fires when /login switches to an email not yet a known profile', () => {
    const profileId = 'profile-detect-1'
    const sessionId = 's1'
    upsertProfile({ id: profileId, name: 'Test', accountEmail: 'a@x.com', createdAt: Date.now() })
    writeProfileIdentity(profileId, 'a@x.com')

    captureClaudeAccount(sessionId, profileId)
    startWatchingAccountIdentity(sessionId, profileId)

    rewriteProfileIdentity(profileId, 'new@x.com')
    recheckAll()

    const detected = sent.filter((m) => m.channel === IPC.ACCOUNT_NEW_DETECTED)
    expect(detected).toHaveLength(1)
    expect(detected[0].payload).toEqual({ sessionId, profileId, email: 'new@x.com' })
  })

  it('broadcasts only ONCE when two sessions share the profile home (dedup)', () => {
    const profileId = 'profile-shared'
    upsertProfile({ id: profileId, name: 'Shared', accountEmail: 'a@x.com', createdAt: Date.now() })
    writeProfileIdentity(profileId, 'a@x.com')

    captureClaudeAccount('sA', profileId)
    captureClaudeAccount('sB', profileId)
    startWatchingAccountIdentity('sA', profileId)
    startWatchingAccountIdentity('sB', profileId)

    // One /login changes the SHARED home; both sessions will observe it.
    rewriteProfileIdentity(profileId, 'new@x.com')
    recheckAll()

    const detected = sent.filter((m) => m.channel === IPC.ACCOUNT_NEW_DETECTED)
    expect(detected).toHaveLength(1)
  })

  it('does NOT fire when /login switches to an email that IS already a known profile', () => {
    const profileA = 'profile-detect-A'
    const profileB = 'profile-detect-B'
    const sessionId = 's2'

    upsertProfile({ id: profileA, name: 'Alice', accountEmail: 'a@x.com', createdAt: Date.now() })
    upsertProfile({ id: profileB, name: 'Bob', accountEmail: 'b@x.com', createdAt: Date.now() })
    writeProfileIdentity(profileA, 'a@x.com')

    captureClaudeAccount(sessionId, profileA)
    startWatchingAccountIdentity(sessionId, profileA)

    rewriteProfileIdentity(profileA, 'b@x.com') // b@x.com IS already profile B
    recheckAll()

    const detected = sent.filter((m) => m.channel === IPC.ACCOUNT_NEW_DETECTED)
    expect(detected).toHaveLength(0)
  })

  it('does NOT fire for a default (profileId=undefined) session even on email change', () => {
    const homeRoot = path.dirname(path.join(tmp, 'shared')) // parent of sharedRoot = tmp
    const defaultIdentityFile = path.join(homeRoot, '.claude.json')
    fs.writeFileSync(defaultIdentityFile, JSON.stringify({ oauthAccount: { emailAddress: 'default@x.com' } }))

    captureClaudeAccount('s3', undefined)
    startWatchingAccountIdentity('s3', undefined)

    const before = fs.statSync(defaultIdentityFile).mtimeMs
    fs.writeFileSync(defaultIdentityFile, JSON.stringify({ oauthAccount: { emailAddress: 'stranger@x.com' } }))
    if (fs.statSync(defaultIdentityFile).mtimeMs === before) {
      const future = new Date(before + 1000)
      fs.utimesSync(defaultIdentityFile, future, future)
    }

    recheckAll()

    const detected = sent.filter((m) => m.channel === IPC.ACCOUNT_NEW_DETECTED)
    expect(detected).toHaveLength(0)
  })
})
