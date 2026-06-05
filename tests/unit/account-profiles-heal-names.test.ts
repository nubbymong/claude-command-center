import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import {
  _setRootsForTest, upsertProfile, listProfiles, createProfile, healPlaceholderNames,
} from '../../src/main/account-profiles'

let base: string; let resourcesDir: string; let sharedRoot: string
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-heal-'))
  resourcesDir = path.join(base, 'res'); sharedRoot = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true }); fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
})
afterEach(() => { _setRootsForTest(null); fs.rmSync(base, { recursive: true, force: true }) })

describe('healPlaceholderNames', () => {
  it('clears "New account" name on profiles that have a real email', () => {
    const p = createProfile()
    // Force it to have the placeholder name and a real email (simulates old capture)
    upsertProfile({ ...p, name: 'New account', accountEmail: 'test@example.com' })

    healPlaceholderNames()

    const healed = listProfiles().find((x) => x.id === p.id)
    expect(healed?.name).toBe('')
  })

  it('leaves a custom name unchanged', () => {
    const p = createProfile('iCloud')
    upsertProfile({ ...p, accountEmail: 'user@icloud.com' })

    healPlaceholderNames()

    const after = listProfiles().find((x) => x.id === p.id)
    expect(after?.name).toBe('iCloud')
  })

  it('leaves "New account" unchanged when accountEmail is empty (in-progress add)', () => {
    const p = createProfile()
    // Force placeholder name but NO email (add-account flow, not yet logged in)
    upsertProfile({ ...p, name: 'New account', accountEmail: '' })

    healPlaceholderNames()

    const after = listProfiles().find((x) => x.id === p.id)
    expect(after?.name).toBe('New account')
  })

  it('is idempotent: calling twice does not change anything on the second call', () => {
    const p = createProfile()
    upsertProfile({ ...p, name: 'New account', accountEmail: 'a@b.com' })

    healPlaceholderNames()
    healPlaceholderNames()

    const after = listProfiles().find((x) => x.id === p.id)
    expect(after?.name).toBe('')
  })
})
