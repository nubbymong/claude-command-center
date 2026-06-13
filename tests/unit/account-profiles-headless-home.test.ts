// resolveHeadlessProfileHome picks the home for headless `claude` spawns
// (Sentinel analysis, insights). Bug: when account profiles exist but none is
// the captured primary and no analysis account is chosen, it fell through to
// the bare global ~/.claude login -- which is frozen and hangs the headless
// `claude -p` at auth until timeout. It must pick a real per-account home
// instead (preferring a signed-in one), and only use the bare global on a
// genuine single-account install (no profiles at all).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _setRootsForTest,
  createProfile,
  setPrimaryProfile,
  upsertProfile,
  resolveHeadlessProfileHome,
  getProfileConfigDir,
} from '../../src/main/account-profiles'

let base: string
let resourcesDir: string
let sharedRoot: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-headless-home-'))
  resourcesDir = path.join(base, 'res')
  sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true })
  fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
})
afterEach(() => {
  _setRootsForTest(null)
  fs.rmSync(base, { recursive: true, force: true })
})

describe('resolveHeadlessProfileHome', () => {
  it('uses the bare global (null home) ONLY when no profiles exist', () => {
    expect(resolveHeadlessProfileHome()).toEqual({ home: null, profileId: null })
  })

  it('uses the preferred profile when its home exists', () => {
    createProfile('Alice')
    const b = createProfile('Bob')
    const r = resolveHeadlessProfileHome(b.id)
    expect(r.profileId).toBe(b.id)
    expect(r.home).toBe(getProfileConfigDir(b.id))
  })

  it('falls back to the captured primary when no preferred id is given', () => {
    createProfile('Alice')
    const b = createProfile('Bob')
    setPrimaryProfile(b.id)
    expect(resolveHeadlessProfileHome().profileId).toBe(b.id)
  })

  it('never falls back to the bare global login when profiles exist but none is primary', () => {
    const a = createProfile('Alice')
    const b = createProfile('Bob')
    const r = resolveHeadlessProfileHome() // no preferred, no primary
    expect(r.home).not.toBeNull()
    expect([a.id, b.id]).toContain(r.profileId)
  })

  it('prefers a signed-in profile (has accountEmail) over a never-signed-in one when no primary', () => {
    createProfile('Alice') // never signed in -> empty accountEmail
    const b = createProfile('Bob')
    upsertProfile({ ...b, accountEmail: 'bob@example.com' })
    expect(resolveHeadlessProfileHome().profileId).toBe(b.id)
  })

  it('uses the bare global when profile metadata persists but its home dir was deleted', () => {
    // homeExists() must exclude stale-metadata profiles so we never hand back a
    // home dir that no longer exists -- the branch that distinguishes this from
    // a naive "first profile in metadata" pick.
    const a = createProfile('Alice')
    fs.rmSync(getProfileConfigDir(a.id), { recursive: true, force: true })
    expect(resolveHeadlessProfileHome()).toEqual({ home: null, profileId: null })
  })
})
