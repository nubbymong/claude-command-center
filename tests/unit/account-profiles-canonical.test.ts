import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import {
  _setRootsForTest, createProfile, getAccountIdentityDir,
  writeCanonicalIdentity, readCanonicalIdentityEmail,
} from '../../src/main/account-profiles'

let resourcesDir: string; let sharedRoot: string
beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-canon-'))
  resourcesDir = path.join(base, 'res'); sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true }); fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
})
afterEach(() => _setRootsForTest(null))

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
