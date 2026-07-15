import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import {
  _setRootsForTest, getPrimaryProfileId, listProfiles,
  createProfile, writeCanonicalIdentity, upsertProfile,
} from '../../src/main/account-profiles'
import { runFirstRunCapture, decideFirstRunCapture } from '../../src/main/first-run-accounts'

let base: string; let resourcesDir: string; let sharedRoot: string; let homeRoot: string
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-firstrun-'))
  resourcesDir = path.join(base, 'res')
  homeRoot = path.join(base, 'home')
  sharedRoot = path.join(homeRoot, '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true }); fs.mkdirSync(sharedRoot, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot })
})
afterEach(() => { _setRootsForTest(null); fs.rmSync(base, { recursive: true, force: true }) })

describe('decideFirstRunCapture (pure)', () => {
  it('returns none when hasPrimary is true', () => {
    expect(decideFirstRunCapture({ hasPrimary: true, hasGlobalLogin: true })).toBe('none')
    expect(decideFirstRunCapture({ hasPrimary: true, hasGlobalLogin: false })).toBe('none')
  })

  it('returns capture when no primary and a global login exists', () => {
    expect(decideFirstRunCapture({ hasPrimary: false, hasGlobalLogin: true })).toBe('capture')
  })

  it('returns none when no primary and no global login', () => {
    expect(decideFirstRunCapture({ hasPrimary: false, hasGlobalLogin: false })).toBe('none')
  })
})

describe('runFirstRunCapture (integration)', () => {
  it('captures the global login and marks it as primary when no primary exists', () => {
    // Arrange: write a global login
    fs.writeFileSync(
      path.join(homeRoot, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'me@live.co.uk' } }),
    )
    fs.writeFileSync(path.join(sharedRoot, '.credentials.json'), '{"token":"t"}')

    // Act
    runFirstRunCapture()

    // Assert
    const primaryId = getPrimaryProfileId()
    expect(primaryId).not.toBeNull()
    const profiles = listProfiles()
    const primary = profiles.find((p) => p.id === primaryId)
    expect(primary?.accountEmail).toBe('me@live.co.uk')
  })

  it('is idempotent: calling again does NOT create a second primary (same profile)', () => {
    fs.writeFileSync(
      path.join(homeRoot, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'me@live.co.uk' } }),
    )
    fs.writeFileSync(path.join(sharedRoot, '.credentials.json'), '{"token":"t"}')

    runFirstRunCapture()
    const firstId = getPrimaryProfileId()

    runFirstRunCapture() // second call
    const secondId = getPrimaryProfileId()

    expect(secondId).toBe(firstId)
    const profiles = listProfiles()
    const primaries = profiles.filter((p) => p.isPrimary)
    expect(primaries).toHaveLength(1)
  })

  it('does not create a primary when there is no global login', () => {
    // No .claude.json written
    runFirstRunCapture()
    expect(getPrimaryProfileId()).toBeNull()
  })

  it('promotes existing profile by metadata email (no duplicate)', () => {
    // Arrange: a profile with metadata email matching the global login
    const p = createProfile('existing')
    writeCanonicalIdentity(p.id, { claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'me@x.com' } }) })
    upsertProfile({ ...p, accountEmail: 'me@x.com' })
    fs.writeFileSync(
      path.join(homeRoot, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'me@x.com' } }),
    )

    // Act
    runFirstRunCapture()

    // Assert: promoted, not duplicated
    expect(getPrimaryProfileId()).toBe(p.id)
    expect(listProfiles()).toHaveLength(1)
  })

  it('promotes existing profile by canonical email when metadata email is blank (no duplicate)', () => {
    // Arrange: profile created with blank metadata email; canonical identity has the email
    const p = createProfile('migrated')
    writeCanonicalIdentity(p.id, { claudeJson: JSON.stringify({ oauthAccount: { emailAddress: 'me@x.com' } }) })
    // accountEmail left blank as createProfile sets it
    fs.writeFileSync(
      path.join(homeRoot, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'me@x.com' } }),
    )

    // Act
    runFirstRunCapture()

    // Assert: canonical-email fallback matched; no duplicate created
    expect(getPrimaryProfileId()).toBe(p.id)
    expect(listProfiles()).toHaveLength(1)
  })
})
