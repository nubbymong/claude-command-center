// tests/unit/account-profiles-identity.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _setRootsForTest, getProfileConfigDir, readProfileAccountEmail } from '../../src/main/account-profiles'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apid-'))
  _setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'shared') })
})
afterEach(() => { _setRootsForTest(null); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('readProfileAccountEmail', () => {
  it('reads oauthAccount.emailAddress from the profile own .claude.json', () => {
    const dir = getProfileConfigDir('p1'); fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'b@live.co.uk' } }))
    expect(readProfileAccountEmail('p1')).toBe('b@live.co.uk')
  })
  it('returns null when not logged in', () => {
    fs.mkdirSync(getProfileConfigDir('p2'), { recursive: true })
    expect(readProfileAccountEmail('p2')).toBeNull()
  })
})
