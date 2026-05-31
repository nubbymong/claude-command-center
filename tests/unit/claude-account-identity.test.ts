// tests/unit/claude-account-identity.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'

// MIRRORS effort-tracker.test.ts: capture every webContents.send so we can assert
// the main->renderer push, and pin colourForEmail to a fixed key so identity tests
// don't depend on the sha256 bucket.
const sent: Array<{ channel: string; payload: unknown }> = []
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }],
  },
}))
vi.mock('../../src/main/account-color', () => ({ colourForEmail: () => 'mauve' }))

import { _setRootsForTest, getProfileConfigDir as getProfileConfigDirForTest } from '../../src/main/account-profiles'
import { captureClaudeAccount, getClaudeAccount, clearClaudeAccount, getAccountIdentity, pushAccountIdentity, _resetClaudeAccounts } from '../../src/main/claude-account-identity'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-'))
  _setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'shared') })
  fs.mkdirSync(path.join(tmp, 'shared'), { recursive: true })
  _resetClaudeAccounts()
  sent.length = 0
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

describe('getAccountIdentity', () => {
  it('returns { email, colourKey } after capture', () => {
    fs.writeFileSync(path.join(tmp, 'shared', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@me.com' } }))
    captureClaudeAccount('s1', undefined)
    expect(getAccountIdentity('s1')).toEqual({ email: 'a@me.com', colourKey: 'mauve' })
  })
  it('returns null when the session was never captured', () => {
    expect(getAccountIdentity('nope')).toBeNull()
  })
})

describe('pushAccountIdentity', () => {
  it('sends { sessionId, email, colourKey } on identity:accountUpdate', () => {
    fs.writeFileSync(path.join(tmp, 'shared', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@me.com' } }))
    captureClaudeAccount('s1', undefined)
    pushAccountIdentity('s1')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({ channel: 'identity:accountUpdate', payload: { sessionId: 's1', email: 'a@me.com', colourKey: 'mauve' } })
  })
  it('no-ops when the session was never captured', () => {
    pushAccountIdentity('nope')
    expect(sent).toHaveLength(0)
  })
})
