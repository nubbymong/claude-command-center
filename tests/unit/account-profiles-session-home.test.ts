import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import {
  _setRootsForTest, createProfile, writeCanonicalIdentity, getAccountIdentityDir,
  setupSessionHome, teardownSessionHome,
} from '../../src/main/account-profiles'

let base: string; let resourcesDir: string; let sharedRoot: string
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-sesshome-'))
  resourcesDir = path.join(base, 'res'); sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true }); fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
})
afterEach(() => { _setRootsForTest(null); fs.rmSync(base, { recursive: true, force: true }) })

describe('per-session working home', () => {
  it('seeds the chosen account identity and junctions shared dirs; teardown removes only links', () => {
    fs.mkdirSync(path.join(sharedRoot, 'projects'), { recursive: true })
    fs.writeFileSync(path.join(sharedRoot, 'projects', 'keep.txt'), 'keep')
    const p = createProfile('Work')
    writeCanonicalIdentity(p.id, {
      claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'a@work.com' } }),
      credentials: '{"token":"x"}',
    })

    const home = setupSessionHome('sess-1', p.id)
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toContain('a@work.com')
    expect(fs.existsSync(path.join(home, '.claude', '.credentials.json'))).toBe(true)
    // shared projects junctioned through
    expect(fs.readFileSync(path.join(home, '.claude', 'projects', 'keep.txt'), 'utf8')).toBe('keep')

    teardownSessionHome('sess-1')
    expect(fs.existsSync(home)).toBe(false)
    // teardown removed the junction LINK only, never the target file
    expect(fs.readFileSync(path.join(sharedRoot, 'projects', 'keep.txt'), 'utf8')).toBe('keep')
  })
})
