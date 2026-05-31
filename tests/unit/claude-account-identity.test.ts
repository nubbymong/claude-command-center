// tests/unit/claude-account-identity.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { _setRootsForTest, getProfileConfigDir as getProfileConfigDirForTest } from '../../src/main/account-profiles'
import { captureClaudeAccount, getClaudeAccount, clearClaudeAccount, _resetClaudeAccounts } from '../../src/main/claude-account-identity'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-'))
  _setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'shared') })
  fs.mkdirSync(path.join(tmp, 'shared'), { recursive: true })
  _resetClaudeAccounts()
})
afterEach(() => { _setRootsForTest(null); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('captureClaudeAccount', () => {
  it('captures the DEFAULT account when the session has no profile', () => {
    fs.writeFileSync(path.join(tmp, 'shared', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@me.com' } }))
    captureClaudeAccount('s1', undefined)
    expect(getClaudeAccount('s1')).toBe('a@me.com')
  })
  it('does not change once captured (drift-immune)', () => {
    fs.writeFileSync(path.join(tmp, 'shared', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@me.com' } }))
    captureClaudeAccount('s1', undefined)
    fs.writeFileSync(path.join(tmp, 'shared', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'b@live.co.uk' } }))
    captureClaudeAccount('s1', undefined)
    expect(getClaudeAccount('s1')).toBe('a@me.com')
  })
  it('reads the PROFILE account when the session has a profileId', () => {
    const dir = getProfileConfigDirForTest('p1')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'b@live.co.uk' } }))
    captureClaudeAccount('s2', 'p1')
    expect(getClaudeAccount('s2')).toBe('b@live.co.uk')
  })
  it('clears on cleanup', () => {
    fs.writeFileSync(path.join(tmp, 'shared', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@me.com' } }))
    captureClaudeAccount('s1', undefined); clearClaudeAccount('s1')
    expect(getClaudeAccount('s1')).toBeNull()
  })
})
