import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  canonicalEmail,
  buildAccountTimeline,
  suggestEmailForSession,
  listKnownEmails,
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

  // Copilot review on PR #31 (p9.14): the previous implementation closed
  // the last interval at `events[i].ts + 1` whenever liveEmail was absent
  // OR liveEmail disagreed with the last backup. Both cases orphaned
  // every post-backup session. The corrected logic extends the last
  // backup's interval to +Infinity regardless of liveEmail, and the
  // wizard surfaces a divergent liveEmail as an override option.
  it('extends last backup interval to Infinity when there is no live identity', () => {
    writeBackup(1000, 'a@x.com')
    writeBackup(2000, 'b@x.com')
    // No writeLive() call -- ~/.claude.json absent
    const t = buildAccountTimeline()
    expect(t).toEqual([
      { start: 1000, end: 2000, email: 'a@x.com' },
      { start: 2000, end: Infinity, email: 'b@x.com' },
    ])
  })

  it('does NOT synthesize a transition when liveEmail differs from the last backup', () => {
    writeBackup(1000, 'a@x.com')
    writeBackup(2000, 'b@x.com')
    writeLive('c@x.com')
    const t = buildAccountTimeline()
    // The last backup interval still extends to +Infinity attributed to
    // the last KNOWN email (b@x.com). The wizard must offer c@x.com as
    // an override option separately (via listKnownEmails).
    expect(t).toEqual([
      { start: 1000, end: 2000, email: 'a@x.com' },
      { start: 2000, end: Infinity, email: 'b@x.com' },
    ])
  })
})

describe('listKnownEmails', () => {
  let sandbox: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'attr-known-'))
    mkdirSync(join(sandbox, '.claude', 'backups'), { recursive: true })
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    process.env.HOME = sandbox
    process.env.USERPROFILE = sandbox
  })
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('returns the union of backup, live, and accounts.json emails (sorted)', () => {
    writeFileSync(
      join(sandbox, '.claude', 'backups', '.claude.json.backup.1000'),
      JSON.stringify({ oauthAccount: { emailAddress: 'b@x.com' } }),
    )
    writeFileSync(
      join(sandbox, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'c@x.com' } }),
    )
    // Copilot review on PR #31 (p9.16): accountsJsonPath is caller-
    // supplied -- the legacy account-manager wrote to the resources
    // CONFIG dir, NOT ~/.claude. Pass a sandbox path explicitly.
    const accountsPath = join(sandbox, 'fake-resources', 'CONFIG', 'accounts.json')
    mkdirSync(join(sandbox, 'fake-resources', 'CONFIG'), { recursive: true })
    writeFileSync(
      accountsPath,
      JSON.stringify({ accounts: [{ credentials: { oauthAccount: { emailAddress: 'a@x.com' } } }] }),
    )
    expect(listKnownEmails(accountsPath)).toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
  })

  it('returns [] when no evidence is present', () => {
    expect(listKnownEmails()).toEqual([])
  })

  it('ignores accounts.json if no path is passed (so we never read from ~/.claude/accounts.json)', () => {
    // Old (incorrect) location -- writing here should have NO effect.
    writeFileSync(
      join(sandbox, '.claude', 'accounts.json'),
      JSON.stringify({ accounts: [{ credentials: { oauthAccount: { emailAddress: 'wrong@x.com' } } }] }),
    )
    expect(listKnownEmails()).toEqual([])
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
