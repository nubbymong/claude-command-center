// tests/unit/account-profiles.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _setRootsForTest, listProfiles, upsertProfile, deleteProfileMeta, getProfileConfigDir,
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
