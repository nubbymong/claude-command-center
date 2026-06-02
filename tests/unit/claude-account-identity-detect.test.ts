// tests/unit/claude-account-identity-detect.test.ts
// Tests for the ACCOUNT_NEW_DETECTED broadcast in recheckAll.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'

const sent: Array<{ channel: string; payload: unknown }> = []
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }],
  },
}))
vi.mock('../../src/main/account-color', () => ({ colourForEmail: () => 'mauve' }))

import { _setRootsForTest, getSessionHomeDir, upsertProfile } from '../../src/main/account-profiles'
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

/** Write a .claude.json identity file inside the session's working home and return its path. */
function writeSessionIdentity(sessionId: string, email: string): string {
  const dir = getSessionHomeDir(sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, '.claude.json')
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: email } }))
  return file
}

/** Advance a session home's .claude.json mtime by writing it again (ensures the watcher sees a change). */
function rewriteSessionIdentity(sessionId: string, email: string): void {
  // We must ensure a different mtime; on fast filesystems write twice with a
  // stat-verify loop, falling back to utimesSync to force the stamp forward.
  const dir = getSessionHomeDir(sessionId)
  const file = path.join(dir, '.claude.json')
  const before = fs.statSync(file).mtimeMs
  const content = JSON.stringify({ oauthAccount: { emailAddress: email } })
  fs.writeFileSync(file, content)
  // If mtime did not advance (sub-millisecond write on some FS), force it.
  if (fs.statSync(file).mtimeMs === before) {
    const future = new Date(before + 1000)
    fs.utimesSync(file, future, future)
  }
}

describe('recheckAll — ACCOUNT_NEW_DETECTED', () => {
  it('fires when /login switches to an email not yet a known profile', () => {
    const profileId = 'profile-detect-1'
    const sessionId = 's1'
    // Set up the profile with an initial email.
    upsertProfile({ id: profileId, name: 'Test', accountEmail: 'a@x.com', createdAt: Date.now() })
    writeSessionIdentity(sessionId, 'a@x.com')

    // Capture the initial identity so bySession is populated.
    captureClaudeAccount(sessionId, profileId)
    startWatchingAccountIdentity(sessionId, profileId)

    // Advance the identity file to a NEW, unknown email.
    rewriteSessionIdentity(sessionId, 'new@x.com')

    recheckAll()

    const detected = sent.filter((m) => m.channel === IPC.ACCOUNT_NEW_DETECTED)
    expect(detected).toHaveLength(1)
    expect(detected[0].payload).toEqual({ sessionId, profileId, email: 'new@x.com' })
  })

  it('does NOT fire when /login switches to an email that IS already a known profile', () => {
    const profileA = 'profile-detect-A'
    const profileB = 'profile-detect-B'
    const sessionId = 's2'

    // Two known profiles.
    upsertProfile({ id: profileA, name: 'Alice', accountEmail: 'a@x.com', createdAt: Date.now() })
    upsertProfile({ id: profileB, name: 'Bob', accountEmail: 'b@x.com', createdAt: Date.now() })
    writeSessionIdentity(sessionId, 'a@x.com')

    captureClaudeAccount(sessionId, profileA)
    startWatchingAccountIdentity(sessionId, profileA)

    // Switch to b@x.com — which IS already profile B.
    rewriteSessionIdentity(sessionId, 'b@x.com')

    recheckAll()

    const detected = sent.filter((m) => m.channel === IPC.ACCOUNT_NEW_DETECTED)
    expect(detected).toHaveLength(0)
  })

  it('does NOT fire for a default (profileId=undefined) session even on email change', () => {
    // Default session: no profile, identity lives in home-root .claude.json.
    const homeRoot = path.dirname(path.join(tmp, 'shared')) // parent of sharedRoot = tmp
    const defaultIdentityFile = path.join(homeRoot, '.claude.json')
    fs.writeFileSync(defaultIdentityFile, JSON.stringify({ oauthAccount: { emailAddress: 'default@x.com' } }))

    captureClaudeAccount('s3', undefined)
    startWatchingAccountIdentity('s3', undefined)

    // Change the default identity file to a completely unknown email.
    const before = fs.statSync(defaultIdentityFile).mtimeMs
    fs.writeFileSync(defaultIdentityFile, JSON.stringify({ oauthAccount: { emailAddress: 'stranger@x.com' } }))
    if (fs.statSync(defaultIdentityFile).mtimeMs === before) {
      const future = new Date(before + 1000)
      fs.utimesSync(defaultIdentityFile, future, future)
    }

    recheckAll()

    const detected = sent.filter((m) => m.channel === IPC.ACCOUNT_NEW_DETECTED)
    // Default sessions have no profileId context — detection is skipped.
    expect(detected).toHaveLength(0)
  })
})
