import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// claude-account-identity imports BrowserWindow from electron at module load.
// The watcher change-detection under test never touches it; stub so the import
// resolves and pushAccountIdentity is a harmless no-op.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import { _setRootsForTest, getProfileConfigDir } from '../../../src/main/account-profiles'
import {
  captureClaudeAccount,
  getClaudeAccount,
  recheckSessionIdentity,
  startWatchingAccountIdentity,
  stopWatchingAccountIdentity,
  isProfileInUseByLiveSession,
  _resetClaudeAccounts,
} from '../../../src/main/claude-account-identity'
import { acquireProfileConsumer, _resetProfileConsumersForTest } from '../../../src/main/profile-consumers'

// Bug 2: sessions of an account share the account's PROFILE home, so the watcher
// reads the profile home's .claude.json (not a per-session home). A /login rewrites
// that shared file; the watcher must pick the change up for the session.
function writeProfileEmail(profileId: string, email: string, mtimeSec: number): void {
  const dir = getProfileConfigDir(profileId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, '.claude.json')
  writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: email } }))
  utimesSync(file, mtimeSec, mtimeSec) // deterministic mtime for the mtime guard
}

describe('recheckSessionIdentity (mid-session /login account change, shared profile home)', () => {
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

  it('detects a profile account change after /login and updates the map', () => {
    const sid = 's1', pid = 'profile-x'
    // Seed the PROFILE home (the source recheckSessionIdentity reads from).
    writeProfileEmail(pid, 'old@x.com', 1_000_000)
    captureClaudeAccount(sid, pid)
    expect(getClaudeAccount(sid)).toBe('old@x.com')

    // No change yet -> null (and seeds the mtime guard).
    expect(recheckSessionIdentity(sid, pid)).toBeNull()

    // /login rewrote the shared profile home's .claude.json with a new account.
    writeProfileEmail(pid, 'new@y.com', 2_000_000)
    expect(recheckSessionIdentity(sid, pid)).toBe('new@y.com')
    expect(getClaudeAccount(sid)).toBe('new@y.com')

    // No further change -> null (mtime-guarded, no re-parse).
    expect(recheckSessionIdentity(sid, pid)).toBeNull()
  })

  it('two sessions sharing one profile home both observe the change', () => {
    const a = 'sA', b = 'sB', pid = 'profile-shared'
    writeProfileEmail(pid, 'live@x.com', 1_000_000)
    captureClaudeAccount(a, pid)
    captureClaudeAccount(b, pid)
    expect(recheckSessionIdentity(a, pid)).toBeNull() // seed guards
    expect(recheckSessionIdentity(b, pid)).toBeNull()

    writeProfileEmail(pid, 'icloud@x.com', 2_000_000)
    // Both sessions read the SAME shared file and see the new account.
    expect(recheckSessionIdentity(a, pid)).toBe('icloud@x.com')
    expect(recheckSessionIdentity(b, pid)).toBe('icloud@x.com')
  })

  it('returns null when the identity file is missing', () => {
    expect(recheckSessionIdentity('s2', 'no-such-profile')).toBeNull()
  })

  it('does not report a change when the email is unchanged even if mtime moved', () => {
    const sid = 's3', pid = 'profile-y'
    writeProfileEmail(pid, 'same@x.com', 1_000_000)
    captureClaudeAccount(sid, pid)

    // Same email, newer mtime -> the file is re-read but no change is reported.
    writeProfileEmail(pid, 'same@x.com', 3_000_000)
    expect(recheckSessionIdentity(sid, pid)).toBeNull()
    expect(getClaudeAccount(sid)).toBe('same@x.com')
  })
})

describe('isProfileInUseByLiveSession (R-006: refuse delete of an in-use profile)', () => {
  beforeEach(() => { _resetClaudeAccounts() })
  afterEach(() => { _resetClaudeAccounts() })

  it('is false when no session is live', () => {
    expect(isProfileInUseByLiveSession('p1')).toBe(false)
  })

  it('is true while a session is watching that profile, false after it stops', () => {
    startWatchingAccountIdentity('s1', 'p1')
    expect(isProfileInUseByLiveSession('p1')).toBe(true)
    // a different profile is not affected
    expect(isProfileInUseByLiveSession('p2')).toBe(false)
    stopWatchingAccountIdentity('s1')
    expect(isProfileInUseByLiveSession('p1')).toBe(false)
  })

  it('detects a profile captured at spawn even without an active watcher', () => {
    captureClaudeAccount('s2', 'p9')
    expect(isProfileInUseByLiveSession('p9')).toBe(true)
  })

  it('returns false for a falsy/empty profile id', () => {
    startWatchingAccountIdentity('s3', undefined) // default/single-account session
    expect(isProfileInUseByLiveSession('')).toBe(false)
    expect(isProfileInUseByLiveSession(undefined as unknown as string)).toBe(false)
  })

  // #48: the registry is the third source the guard reads. A consumer with no
  // session id -- the auth probe, a headless run, an Insights run, a cloud agent,
  // a shell-only session -- makes the profile in-use for exactly its life.
  it('is true while a registered consumer holds the profile (no session at all), false after release', () => {
    _resetProfileConsumersForTest()
    const release = acquireProfileConsumer('p7', { maxAgeMs: Infinity })
    expect(isProfileInUseByLiveSession('p7')).toBe(true)
    expect(isProfileInUseByLiveSession('p8')).toBe(false)
    release()
    expect(isProfileInUseByLiveSession('p7')).toBe(false)
  })

  it('a session and a consumer on one profile: in use until BOTH are gone', () => {
    _resetProfileConsumersForTest()
    startWatchingAccountIdentity('s9', 'p9')
    const release = acquireProfileConsumer('p9', { maxAgeMs: Infinity })
    stopWatchingAccountIdentity('s9')
    expect(isProfileInUseByLiveSession('p9')).toBe(true) // the consumer still holds it
    release()
    expect(isProfileInUseByLiveSession('p9')).toBe(false)
  })
})
