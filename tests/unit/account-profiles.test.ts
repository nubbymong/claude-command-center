// tests/unit/account-profiles.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _setRootsForTest, listProfiles, upsertProfile, deleteProfileMeta, getProfileConfigDir,
  setupProfileLinks, safeTeardownProfile,
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

    expect(fs.existsSync(path.join(dir, 'memory', 'M.md'))).toBe(true)
    expect(fs.lstatSync(path.join(dir, 'projects')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(true)
    expect(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink()).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).effortLevel).toBe('xhigh')
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

    safeTeardownProfile('p1')

    expect(fs.existsSync(dir)).toBe(false)
    expect(fs.existsSync(path.join(shared, 'projects', 'PRECIOUS.jsonl'))).toBe(true)
  })
})
