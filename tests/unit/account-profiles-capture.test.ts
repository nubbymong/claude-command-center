import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import {
  _setRootsForTest, captureGlobalLogin, getAccountIdentityDir, getProfileConfigDir, readCanonicalIdentityEmail,
} from '../../src/main/account-profiles'
import { resolveAccountName } from '../../src/shared/account-chip-color'

let base: string; let resourcesDir: string; let sharedRoot: string
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-capture-'))
  resourcesDir = path.join(base, 'res'); sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true }); fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
})
afterEach(() => { _setRootsForTest(null); fs.rmSync(base, { recursive: true, force: true }) })

describe('captureGlobalLogin', () => {
  it('copies ~/.claude.json + ~/.claude/.credentials.json into a new profile and never writes the real home', () => {
    const homeRoot = path.dirname(sharedRoot)
    fs.writeFileSync(path.join(homeRoot, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@live.co.uk' } }))
    fs.writeFileSync(path.join(sharedRoot, '.credentials.json'), '{"token":"t"}')
    const beforeJson = fs.readFileSync(path.join(homeRoot, '.claude.json'), 'utf8')

    const profile = captureGlobalLogin('Live')

    expect(profile).not.toBeNull()
    expect(profile!.accountEmail).toBe('me@live.co.uk')
    expect(profile!.name).toBe('Live')
    expect(readCanonicalIdentityEmail(profile!.id)).toBe('me@live.co.uk')
    expect(fs.existsSync(path.join(getAccountIdentityDir(profile!.id), '.credentials.json'))).toBe(true)
    // per-account-home layout (USERPROFILE=<profileDir>) also seeded
    const homeDir = getProfileConfigDir(profile!.id)
    expect(fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf8')).toContain('me@live.co.uk')
    expect(fs.existsSync(path.join(homeDir, '.claude', '.credentials.json'))).toBe(true)
    // real home untouched
    expect(fs.readFileSync(path.join(homeRoot, '.claude.json'), 'utf8')).toBe(beforeJson)
  })

  it('returns null when there is no global login', () => {
    expect(captureGlobalLogin()).toBeNull()
  })

  it('returns null when .claude.json exists but has no oauthAccount email', () => {
    fs.writeFileSync(path.join(path.dirname(sharedRoot), '.claude.json'), JSON.stringify({ somethingElse: true }))
    expect(captureGlobalLogin()).toBeNull()
  })

  it('leaves name empty (not "New account") when no name is passed, so email shows via resolveAccountName', () => {
    const homeRoot = path.dirname(sharedRoot)
    fs.writeFileSync(path.join(homeRoot, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'nicholas@live.co.uk' } }))

    const profile = captureGlobalLogin() // no name argument

    expect(profile).not.toBeNull()
    expect(profile!.name).toBe('')
    // resolveAccountName must fall back to the email
    expect(resolveAccountName(profile!.accountEmail, profile!.name, undefined)).toBe('nicholas@live.co.uk')
  })
})
