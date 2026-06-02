import { describe, it, expect } from 'vitest'
import { writeSessionMeta, readSessionMeta } from '../../../src/main/session-logger'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('session log account meta sidecar', () => {
  it('round-trips accountEmail + profileId via meta.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'logmeta-'))
    writeSessionMeta(dir, { accountEmail: 'me@x.com', profileId: 'profile-1', configLabel: 'vscode' })
    const meta = readSessionMeta(dir)
    expect(meta.accountEmail).toBe('me@x.com')
    expect(meta.profileId).toBe('profile-1')
    expect(meta.configLabel).toBe('vscode')
  })

  it('returns an empty object when no meta.json exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'logmeta-'))
    expect(readSessionMeta(dir)).toEqual({})
  })

  it('omits undefined fields rather than writing nulls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'logmeta-'))
    writeSessionMeta(dir, { configLabel: 'default' })
    const meta = readSessionMeta(dir)
    expect(meta.configLabel).toBe('default')
    expect('accountEmail' in meta).toBe(false)
    expect('profileId' in meta).toBe(false)
  })
})
