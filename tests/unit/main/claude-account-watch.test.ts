import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// claude-account-identity imports BrowserWindow from electron at module load.
// The watcher change-detection under test never touches it; stub so the import
// resolves and pushAccountIdentity is a harmless no-op.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import { _setRootsForTest, getSessionHomeDir } from '../../../src/main/account-profiles'
import {
  captureClaudeAccount,
  getClaudeAccount,
  recheckSessionIdentity,
  _resetClaudeAccounts,
} from '../../../src/main/claude-account-identity'

/** Write a .claude.json identity file in the session's working home with a fixed mtime. */
function writeSessionEmail(sessionId: string, email: string, mtimeSec: number): void {
  const dir = getSessionHomeDir(sessionId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, '.claude.json')
  writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: email } }))
  utimesSync(file, mtimeSec, mtimeSec) // deterministic mtime for the mtime guard
}

describe('recheckSessionIdentity (mid-session /login account change)', () => {
  let sandbox: string

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'claude-acct-watch-'))
    _setRootsForTest({ resourcesDir: sandbox, sharedRoot: join(sandbox, '.claude') })
    _resetClaudeAccounts()
  })

  afterEach(() => {
    _setRootsForTest(null)
    _resetClaudeAccounts()
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('detects a profile session account change after /login and updates the map', () => {
    const sid = 's1', pid = 'profile-x'
    // Seed the session home (the source recheckSessionIdentity reads from).
    writeSessionEmail(sid, 'old@x.com', 1_000_000)
    captureClaudeAccount(sid, pid)
    expect(getClaudeAccount(sid)).toBe('old@x.com')

    // No change yet -> null (and seeds the mtime guard).
    expect(recheckSessionIdentity(sid, pid)).toBeNull()

    // /login rewrote the session home's .claude.json with a new account + newer mtime.
    writeSessionEmail(sid, 'new@y.com', 2_000_000)
    expect(recheckSessionIdentity(sid, pid)).toBe('new@y.com')
    expect(getClaudeAccount(sid)).toBe('new@y.com')

    // No further change -> null (mtime-guarded, no re-parse).
    expect(recheckSessionIdentity(sid, pid)).toBeNull()
  })

  it('returns null when the identity file is missing', () => {
    expect(recheckSessionIdentity('s2', 'no-such-profile')).toBeNull()
  })

  it('does not report a change when the email is unchanged even if mtime moved', () => {
    const sid = 's3', pid = 'profile-y'
    writeSessionEmail(sid, 'same@x.com', 1_000_000)
    captureClaudeAccount(sid, pid)

    // Same email, newer mtime -> the file is re-read but no change is reported.
    writeSessionEmail(sid, 'same@x.com', 3_000_000)
    expect(recheckSessionIdentity(sid, pid)).toBeNull()
    expect(getClaudeAccount(sid)).toBe('same@x.com')
  })
})
