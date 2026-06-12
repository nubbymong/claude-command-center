import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import {
  _setRootsForTest, createProfile, getAccountIdentityDir,
  writeCanonicalIdentity, readCanonicalIdentityEmail,
} from '../../src/main/account-profiles'

let base: string
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-canon-'))
  const resourcesDir = path.join(base, 'res'); const sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true }); fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
})
afterEach(() => { _setRootsForTest(null); try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('canonical identity store', () => {
  it('writeCanonicalIdentity stores .claude.json + .credentials.json under identity/ and reads the email', () => {
    const p = createProfile('Work')
    writeCanonicalIdentity(p.id, {
      claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'a@work.com' } }),
      credentials: '{"token":"x"}',
    })
    const dir = getAccountIdentityDir(p.id)
    expect(fs.existsSync(path.join(dir, '.claude.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, '.credentials.json'))).toBe(true)
    expect(readCanonicalIdentityEmail(p.id)).toBe('a@work.com')
  })

  // POSIX: the credential file must be 0o600 (not world-readable). Mode bits are
  // ignored on Windows, so this only runs off-Win32.
  const posixIt = process.platform === 'win32' ? it.skip : it
  posixIt('writes .credentials.json with restrictive 0o600 mode on POSIX', () => {
    const p = createProfile('Sec')
    writeCanonicalIdentity(p.id, {
      claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 's@sec.com' } }),
      credentials: '{"token":"secret"}',
    })
    const credFile = path.join(getAccountIdentityDir(p.id), '.credentials.json')
    const mode = fs.statSync(credFile).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
