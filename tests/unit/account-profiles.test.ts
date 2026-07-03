// tests/unit/account-profiles.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _setRootsForTest, listProfiles, upsertProfile, deleteProfileMeta, getProfileConfigDir,
  setupProfileLinks, safeTeardownProfile, isValidProfileId, createProfile,
} from '../../src/main/account-profiles'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-'))
  _setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'shared') })
  fs.mkdirSync(path.join(tmp, 'resources'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'shared'), { recursive: true })
})
afterEach(() => { _setRootsForTest(null); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('profile metadata CRUD', () => {
  it('starts empty', () => { expect(listProfiles()).toEqual([]) })
  it('upserts, lists, and deletes a profile', () => {
    upsertProfile({ id: 'p1', name: 'Personal', accountEmail: 'a@me.com', createdAt: 1 })
    expect(listProfiles()).toHaveLength(1)
    upsertProfile({ id: 'p1', name: 'Renamed', accountEmail: 'a@me.com', createdAt: 1 })
    expect(listProfiles()[0].name).toBe('Renamed')
    deleteProfileMeta('p1')
    expect(listProfiles()).toEqual([])
  })
  it('computes the per-profile config dir under the resources root', () => {
    expect(getProfileConfigDir('p1')).toBe(path.join(tmp, 'resources', 'account-profiles', 'p1'))
  })
})

describe('setupProfileLinks', () => {
  it('junctions shared dirs and copies settings.json one-way from the shared root', () => {
    const shared = path.join(tmp, 'shared')
    fs.mkdirSync(path.join(shared, 'projects'), { recursive: true })
    fs.mkdirSync(path.join(shared, 'memory'), { recursive: true })
    fs.writeFileSync(path.join(shared, 'memory', 'M.md'), 'shared mem')
    fs.writeFileSync(path.join(shared, 'settings.json'), '{"effortLevel":"xhigh"}')

    const dir = getProfileConfigDir('p1')
    fs.mkdirSync(dir, { recursive: true })
    setupProfileLinks('p1')

    // New layout: the shared junctions + settings live under <home>/.claude/.
    const claudeDir = path.join(dir, '.claude')
    expect(fs.existsSync(path.join(claudeDir, 'memory', 'M.md'))).toBe(true)
    expect(fs.lstatSync(path.join(claudeDir, 'projects')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(true)
    expect(fs.lstatSync(path.join(claudeDir, 'settings.json')).isSymbolicLink()).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).effortLevel).toBe('xhigh')
  })
})

describe('safeTeardownProfile (junction-safe)', () => {
  it('removes the profile dir but PRESERVES junction targets (the data behind ~/.claude/projects)', () => {
    const shared = path.join(tmp, 'shared')
    fs.mkdirSync(path.join(shared, 'projects'), { recursive: true })
    fs.writeFileSync(path.join(shared, 'projects', 'PRECIOUS.jsonl'), 'do not delete')
    const dir = getProfileConfigDir('p1')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{}')
    setupProfileLinks('p1')

    // The gate's load-bearing invariant: the shared dir is reachable as a LINK.
    expect(fs.lstatSync(path.join(dir, '.claude', 'projects')).isSymbolicLink()).toBe(true)

    safeTeardownProfile('p1')

    expect(fs.existsSync(dir)).toBe(false)
    expect(fs.existsSync(path.join(shared, 'projects', 'PRECIOUS.jsonl'))).toBe(true)
  })
})

describe('isValidProfileId', () => {
  it('accepts CCC-generated ids and rejects escaping ones', () => {
    expect(isValidProfileId('profile-123-primary')).toBe(true)
    expect(isValidProfileId('../x')).toBe(false)
  })
})

describe('createProfile', () => {
  it('creates a profile with a valid id, blank email, correct name, junctioned projects dir, and does not touch the shared root', () => {
    const shared = path.join(tmp, 'shared')
    // Pre-populate shared dirs + a sentinel file to model a real ~/.claude
    for (const name of ['projects', 'memory', 'agents', 'skills', 'commands', 'plugins']) {
      fs.mkdirSync(path.join(shared, name), { recursive: true })
    }
    fs.writeFileSync(path.join(shared, 'settings.json'), '{"theme":"dark"}')
    fs.writeFileSync(path.join(shared, 'projects', 'SENTINEL.jsonl'), 'keep me')
    const sharedBefore = fs.readdirSync(shared).sort()

    const profile = createProfile('Work')

    // id is valid
    expect(isValidProfileId(profile.id)).toBe(true)
    // name set correctly
    expect(profile.name).toBe('Work')
    // accountEmail is empty (not logged in yet)
    expect(profile.accountEmail).toBe('')
    // profile dir exists
    const dir = getProfileConfigDir(profile.id)
    expect(fs.existsSync(dir)).toBe(true)
    // projects inside the profile's .claude dir is a symlink/junction
    expect(fs.lstatSync(path.join(dir, '.claude', 'projects')).isSymbolicLink()).toBe(true)
    // listProfiles includes the new profile
    const all = listProfiles()
    expect(all.some((p) => p.id === profile.id)).toBe(true)
    // shared root is UNCHANGED
    const sharedAfter = fs.readdirSync(shared).sort()
    expect(sharedAfter).toEqual(sharedBefore)
  })

  it('leaves the name BLANK by default (identified by email once /login resolves it)', () => {
    const profile = createProfile()
    expect(profile.name).toBe('')
    expect(profile.accountEmail).toBe('')
    expect(isValidProfileId(profile.id)).toBe(true)
  })

  it('leaves the name blank when only whitespace is provided', () => {
    const profile = createProfile('   ')
    expect(profile.name).toBe('')
    expect(isValidProfileId(profile.id)).toBe(true)
  })

  it('keeps a real provided name', () => {
    const profile = createProfile('  Work  ')
    expect(profile.name).toBe('Work')
  })
})

describe('safeTeardownProfile safety guards', () => {
  it('preserves a junction TARGET nested inside a real profile subdir', () => {
    const shared = path.join(tmp, 'shared')
    fs.mkdirSync(path.join(shared, 'projects'), { recursive: true })
    fs.writeFileSync(path.join(shared, 'projects', 'PRECIOUS.jsonl'), 'do not delete')
    const dir = getProfileConfigDir('p1')
    fs.mkdirSync(path.join(dir, 'realsub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'realsub', 'note.txt'), 'private')
    // a junction nested inside a REAL subdir
    fs.symlinkSync(path.join(shared, 'projects'), path.join(dir, 'realsub', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    safeTeardownProfile('p1')

    expect(fs.existsSync(dir)).toBe(false)
    expect(fs.existsSync(path.join(shared, 'projects', 'PRECIOUS.jsonl'))).toBe(true)
  })
  it('rejects an invalid/escaping id without touching the filesystem', () => {
    expect(() => safeTeardownProfile('../evil')).toThrow(/invalid profile id/)
    expect(() => safeTeardownProfile('..\\..\\.claude')).toThrow(/invalid profile id/)
    expect(() => safeTeardownProfile('')).toThrow(/invalid profile id/)
  })
  it('setupProfileLinks is idempotent (re-run does not throw and keeps junctions)', () => {
    const shared = path.join(tmp, 'shared')
    fs.mkdirSync(path.join(shared, 'projects'), { recursive: true })
    const dir = getProfileConfigDir('p1'); fs.mkdirSync(dir, { recursive: true })
    setupProfileLinks('p1')
    expect(() => setupProfileLinks('p1')).not.toThrow()
    expect(fs.lstatSync(path.join(dir, '.claude', 'projects')).isSymbolicLink()).toBe(true)
  })
})
