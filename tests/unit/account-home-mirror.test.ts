// tests/unit/account-home-mirror.test.ts
// USERPROFILE fake-home model: the profile dir mirrors the real home (dot-dirs ->
// junctions, dot-files -> hard links) so tools behave identically, while .claude
// + .claude.json stay private. SAFETY: setup never modifies the real home.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _setRootsForTest, getProfileConfigDir, setupProfileLinks,
  migrateProfilesToHomeLayout, upsertProfile, listProfiles,
} from '../../src/main/account-profiles'

let tmp: string
let realHome: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'home-mirror-'))
  realHome = path.join(tmp, 'realhome')
  // sharedRoot = <realHome>/.claude, so realHomeDir() (its parent) = realHome.
  _setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(realHome, '.claude') })
  fs.mkdirSync(path.join(tmp, 'resources'), { recursive: true })
  fs.mkdirSync(path.join(realHome, '.claude'), { recursive: true })
})
afterEach(() => { _setRootsForTest(null); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('mirrorRealHome (via setupProfileLinks)', () => {
  it('junctions dot-dirs and hard-links dot-files; skips Claude private files + non-dot', () => {
    fs.mkdirSync(path.join(realHome, '.ssh'), { recursive: true })
    fs.writeFileSync(path.join(realHome, '.ssh', 'id_ed25519'), 'KEY')
    fs.writeFileSync(path.join(realHome, '.gitconfig'), '[user]\n  email = me@x.com')
    // PRIVATE: a real ~/.claude.json must NEVER be mirrored into the fake home.
    fs.writeFileSync(path.join(realHome, '.claude.json'), '{"oauthAccount":{"emailAddress":"real@x.com"}}')
    // Non-dot folder = user data, not mirrored.
    fs.mkdirSync(path.join(realHome, 'Documents'), { recursive: true })

    setupProfileLinks('p1')
    const home = getProfileConfigDir('p1')

    // dot-dir -> junction, real content visible through it
    expect(fs.lstatSync(path.join(home, '.ssh')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(home, '.ssh', 'id_ed25519'), 'utf8')).toBe('KEY')
    // dot-file -> hard link (not a symlink), same content
    expect(fs.existsSync(path.join(home, '.gitconfig'))).toBe(true)
    expect(fs.lstatSync(path.join(home, '.gitconfig')).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(home, '.gitconfig'), 'utf8')).toContain('me@x.com')
    // PRIVATE Claude files are NOT mirrored.
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false)
    // Non-dot folders are not mirrored.
    expect(fs.existsSync(path.join(home, 'Documents'))).toBe(false)
    // The private .claude config dir exists.
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(true)
  })

  it('does not alter the real home (no top-level changes, file contents intact)', () => {
    fs.writeFileSync(path.join(realHome, '.gitconfig'), 'ORIGINAL')
    fs.mkdirSync(path.join(realHome, '.ssh'), { recursive: true })
    fs.writeFileSync(path.join(realHome, '.ssh', 'key'), 'SECRET')
    const before = fs.readdirSync(realHome).sort()

    setupProfileLinks('p1')

    expect(fs.readdirSync(realHome).sort()).toEqual(before)
    expect(fs.readFileSync(path.join(realHome, '.gitconfig'), 'utf8')).toBe('ORIGINAL')
    expect(fs.readFileSync(path.join(realHome, '.ssh', 'key'), 'utf8')).toBe('SECRET')
  })
})

describe('migrateProfilesToHomeLayout', () => {
  it('rebuilds an OLD-layout profile into the new .claude/ layout and resets the email', () => {
    fs.mkdirSync(path.join(realHome, '.claude', 'projects'), { recursive: true })
    upsertProfile({ id: 'old1', name: 'iCloud', accountEmail: 'polluted@x.com', createdAt: 1 })
    const home = getProfileConfigDir('old1')
    fs.mkdirSync(home, { recursive: true })
    // OLD layout: a junction DIRECTLY in the profile dir + root identity/creds.
    fs.symlinkSync(path.join(realHome, '.claude', 'projects'), path.join(home, 'projects'), process.platform === 'win32' ? 'junction' : 'dir')
    fs.writeFileSync(path.join(home, '.claude.json'), '{"oauthAccount":{"emailAddress":"polluted@x.com"}}')
    fs.writeFileSync(path.join(home, '.credentials.json'), '{}')

    migrateProfilesToHomeLayout()

    // New layout built; old direct junction gone.
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(true)
    expect(fs.lstatSync(path.join(home, '.claude', 'projects')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(home, 'projects'))).toBe(false)
    // Polluted identity dropped -> setup-incomplete, email reset for a clean re-login.
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false)
    expect(listProfiles().find((p) => p.id === 'old1')?.accountEmail).toBe('')
  })

  it('leaves a NEW-layout profile untouched', () => {
    upsertProfile({ id: 'new1', name: 'X', accountEmail: 'keep@x.com', createdAt: 1 })
    setupProfileLinks('new1') // builds the new layout (.claude/ exists)
    migrateProfilesToHomeLayout()
    expect(listProfiles().find((p) => p.id === 'new1')?.accountEmail).toBe('keep@x.com')
  })
})
