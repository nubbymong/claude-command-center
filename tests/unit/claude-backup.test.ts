// tests/unit/claude-backup.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { backupRealClaudeOnce } from '../../src/main/claude-backup'

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

let tmp: string
let homeDir: string
let resourcesDir: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-backup-'))
  homeDir = path.join(tmp, 'home')
  resourcesDir = path.join(tmp, 'resources')
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(resourcesDir, { recursive: true })

  // Fake ~/.claude.json
  fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'test@example.com' } }))

  // Fake ~/.claude/ with top-level files + a big subdir
  const claudeDir = path.join(homeDir, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ token: 'abc123' }))
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ effortLevel: 'high' }))

  // A big subdir (projects) with a file — should NOT be copied
  const projectsDir = path.join(claudeDir, 'projects')
  fs.mkdirSync(projectsDir, { recursive: true })
  fs.writeFileSync(path.join(projectsDir, 'proj.md'), '# my project')
})

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('backupRealClaudeOnce', () => {
  it('returns the dest dir path on first run', () => {
    const result = backupRealClaudeOnce({ homeDir, resourcesDir })
    expect(result).toBeTruthy()
    expect(result).toContain('initial')
  })

  it('copies .claude.json to the backup root', () => {
    const dest = backupRealClaudeOnce({ homeDir, resourcesDir })!
    const backedUp = path.join(dest, '.claude.json')
    expect(fs.existsSync(backedUp)).toBe(true)
    const content = JSON.parse(fs.readFileSync(backedUp, 'utf8'))
    expect(content.oauthAccount.emailAddress).toBe('test@example.com')
  })

  it('copies top-level files in ~/.claude/ (.credentials.json, settings.json)', () => {
    const dest = backupRealClaudeOnce({ homeDir, resourcesDir })!
    expect(fs.existsSync(path.join(dest, '.claude', '.credentials.json'))).toBe(true)
    expect(fs.existsSync(path.join(dest, '.claude', 'settings.json'))).toBe(true)

    const creds = JSON.parse(fs.readFileSync(path.join(dest, '.claude', '.credentials.json'), 'utf8'))
    expect(creds.token).toBe('abc123')

    const settings = JSON.parse(fs.readFileSync(path.join(dest, '.claude', 'settings.json'), 'utf8'))
    expect(settings.effortLevel).toBe('high')
  })

  it('does NOT copy the projects/ subdir (big subdirs skipped)', () => {
    const dest = backupRealClaudeOnce({ homeDir, resourcesDir })!
    expect(fs.existsSync(path.join(dest, '.claude', 'projects'))).toBe(false)
  })

  it('source files are byte-identical after backup (read-only proof)', () => {
    const claudeJsonSrc = path.join(homeDir, '.claude.json')
    const credsSrc = path.join(homeDir, '.claude', '.credentials.json')

    const hashBefore = {
      claudeJson: sha256(claudeJsonSrc),
      creds: sha256(credsSrc),
    }

    backupRealClaudeOnce({ homeDir, resourcesDir })

    expect(sha256(claudeJsonSrc)).toBe(hashBefore.claudeJson)
    expect(sha256(credsSrc)).toBe(hashBefore.creds)
  })

  it('is idempotent: second call returns null and leaves the backup unchanged', () => {
    const dest = backupRealClaudeOnce({ homeDir, resourcesDir })!
    expect(dest).toBeTruthy()

    // Mutate the source AFTER first backup
    fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'MUTATED@example.com' } }))
    fs.writeFileSync(path.join(homeDir, '.claude', '.credentials.json'), JSON.stringify({ token: 'MUTATED' }))

    // Second call must return null (backup already exists)
    const result2 = backupRealClaudeOnce({ homeDir, resourcesDir })
    expect(result2).toBeNull()

    // Backup still holds the ORIGINAL values, not the mutated ones
    const backedUpJson = JSON.parse(fs.readFileSync(path.join(dest, '.claude.json'), 'utf8'))
    expect(backedUpJson.oauthAccount.emailAddress).toBe('test@example.com')

    const backedUpCreds = JSON.parse(fs.readFileSync(path.join(dest, '.claude', '.credentials.json'), 'utf8'))
    expect(backedUpCreds.token).toBe('abc123')
  })

  it('works gracefully when ~/.claude.json does not exist', () => {
    fs.unlinkSync(path.join(homeDir, '.claude.json'))
    const dest = backupRealClaudeOnce({ homeDir, resourcesDir })!
    expect(dest).toBeTruthy()
    // No .claude.json in backup — that is fine
    expect(fs.existsSync(path.join(dest, '.claude.json'))).toBe(false)
    // Top-level files from ~/.claude/ still backed up
    expect(fs.existsSync(path.join(dest, '.claude', 'settings.json'))).toBe(true)
  })

  it('works gracefully when ~/.claude/ dir does not exist', () => {
    fs.rmSync(path.join(homeDir, '.claude'), { recursive: true, force: true })
    const dest = backupRealClaudeOnce({ homeDir, resourcesDir })!
    expect(dest).toBeTruthy()
    // Only .claude.json backed up, no .claude/ subdir
    expect(fs.existsSync(path.join(dest, '.claude.json'))).toBe(true)
    expect(fs.existsSync(path.join(dest, '.claude'))).toBe(false)
  })

  it('writes a completion marker recording what was captured', () => {
    const dest = backupRealClaudeOnce({ homeDir, resourcesDir })!
    const marker = path.join(dest, '.backup-complete.json')
    expect(fs.existsSync(marker)).toBe(true)
    const m = JSON.parse(fs.readFileSync(marker, 'utf8'))
    expect(m.present).toContain('.claude.json')
    expect(m.present).toContain('.claude/.credentials.json')
    expect(typeof m.capturedAt).toBe('number')
  })

  it('only publishes the snapshot via the atomic initial/ dir (no bare half-written dir)', () => {
    backupRealClaudeOnce({ homeDir, resourcesDir })
    // staging dir must be gone after a successful publish
    expect(fs.existsSync(path.join(resourcesDir, 'claude-config-backups', 'initial.tmp'))).toBe(false)
    expect(fs.existsSync(path.join(resourcesDir, 'claude-config-backups', 'initial'))).toBe(true)
  })

  it('clears a stale initial.tmp from a prior crashed attempt and still succeeds', () => {
    // Simulate a half-written staging dir left by a crash before the rename.
    const staging = path.join(resourcesDir, 'claude-config-backups', 'initial.tmp')
    fs.mkdirSync(staging, { recursive: true })
    fs.writeFileSync(path.join(staging, 'garbage'), 'leftover')

    const dest = backupRealClaudeOnce({ homeDir, resourcesDir })!
    expect(dest).toBeTruthy()
    // The garbage from the stale attempt must NOT survive into the snapshot.
    expect(fs.existsSync(path.join(dest, 'garbage'))).toBe(false)
    expect(fs.existsSync(path.join(dest, '.claude.json'))).toBe(true)
    expect(fs.existsSync(staging)).toBe(false)
  })

  it('refuses to back up through a reparse point pre-planted at the staging dir, and copies no token into it', () => {
    const attacker = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-backup-evil-'))
    const backupsRoot = path.join(resourcesDir, 'claude-config-backups')
    fs.mkdirSync(backupsRoot, { recursive: true })
    const staging = path.join(backupsRoot, 'initial.tmp')
    try { fs.symlinkSync(attacker, staging, process.platform === 'win32' ? 'junction' : 'dir') }
    catch { fs.rmSync(attacker, { recursive: true, force: true }); return } // unprivileged link unavailable; skip

    const result = backupRealClaudeOnce({ homeDir, resourcesDir })

    expect(result).toBeNull() // refused; retries next boot rather than copying through the plant
    expect(fs.existsSync(path.join(attacker, '.claude', '.credentials.json'))).toBe(false)
    expect(fs.existsSync(path.join(attacker, '.claude.json'))).toBe(false)
    fs.rmSync(attacker, { recursive: true, force: true })
  })

  it.runIf(process.platform !== 'win32')('hardens the backed-up credential copy to 0600', () => {
    const dest = backupRealClaudeOnce({ homeDir, resourcesDir })!
    const cred = path.join(dest, '.claude', '.credentials.json')
    expect(fs.statSync(cred).mode & 0o777).toBe(0o600)
  })
})
