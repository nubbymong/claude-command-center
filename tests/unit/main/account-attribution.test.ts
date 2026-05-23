import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  canonicalEmail,
  buildAccountTimeline,
  suggestEmailForSession,
} from '../../../src/main/account-attribution'

describe('canonicalEmail', () => {
  it('lowercases and trims', () => {
    expect(canonicalEmail('  Alice@Example.COM  ')).toBe('alice@example.com')
  })

  it('returns null for non-string or empty', () => {
    expect(canonicalEmail('')).toBeNull()
    expect(canonicalEmail('   ')).toBeNull()
    // @ts-expect-error
    expect(canonicalEmail(null)).toBeNull()
  })
})

describe('buildAccountTimeline', () => {
  let sandbox: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'attr-timeline-'))
    mkdirSync(join(sandbox, '.claude', 'backups'), { recursive: true })
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    process.env.USERPROFILE = sandbox
    process.env.HOME = sandbox
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    rmSync(sandbox, { recursive: true, force: true })
  })

  function writeBackup(ts: number, email: string) {
    writeFileSync(
      join(sandbox, '.claude', 'backups', `.claude.json.backup.${ts}`),
      JSON.stringify({ oauthAccount: { emailAddress: email } }),
    )
  }

  function writeLive(email: string) {
    writeFileSync(
      join(sandbox, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email } }),
    )
  }

  it('returns empty when no backups exist and no live file', () => {
    expect(buildAccountTimeline()).toEqual([])
  })

  it('builds sorted half-open intervals from two backups + live trailing', () => {
    writeBackup(1000, 'a@x.com')
    writeBackup(2000, 'b@x.com')
    writeLive('b@x.com')
    const t = buildAccountTimeline()
    expect(t).toEqual([
      { start: 1000, end: 2000, email: 'a@x.com' },
      { start: 2000, end: Infinity, email: 'b@x.com' },
    ])
  })

  it('skips backup files with non-numeric tail segment', () => {
    writeFileSync(join(sandbox, '.claude', 'backups', '.claude.json.backup.NOTANUMBER'), JSON.stringify({ oauthAccount: { emailAddress: 'z@x.com' } }))
    writeBackup(1000, 'a@x.com')
    writeLive('a@x.com')
    const t = buildAccountTimeline()
    expect(t).toHaveLength(1)
    expect(t[0].email).toBe('a@x.com')
  })

  it('skips backups missing oauthAccount', () => {
    writeFileSync(join(sandbox, '.claude', 'backups', '.claude.json.backup.500'), JSON.stringify({ noAccount: true }))
    writeBackup(1000, 'a@x.com')
    writeLive('a@x.com')
    const t = buildAccountTimeline()
    expect(t.find(iv => iv.start === 500)).toBeUndefined()
  })
})

describe('suggestEmailForSession', () => {
  const timeline = [
    { start: 1000, end: 2000, email: 'a@x.com' },
    { start: 2000, end: Infinity, email: 'b@x.com' },
  ]

  it('returns the interval email for a timestamp inside the window', () => {
    expect(suggestEmailForSession({ lastTimestamp: new Date(1500).toISOString() } as any, timeline)).toBe('a@x.com')
  })

  it('returns the trailing interval email for a recent session', () => {
    expect(suggestEmailForSession({ lastTimestamp: new Date(5000).toISOString() } as any, timeline)).toBe('b@x.com')
  })

  it('returns null for a session before the earliest interval', () => {
    expect(suggestEmailForSession({ lastTimestamp: new Date(500).toISOString() } as any, timeline)).toBeNull()
  })
})
