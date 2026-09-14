import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The resources directory is USER-CHOSEN, so it inherits whatever ACL its parent
// grants -- typically Users:(RX) + Authenticated Users:(M). Every writer beneath
// it must harden the directories it creates; `hardenCredentialFile` cannot do it
// (chmod is a no-op on Windows) and `mkdirSecure` does not touch the DACL, it
// only refuses a reparse point. These two writers were missed.

const h = vi.hoisted(() => ({ hardened: [] as string[] }))

vi.mock('../../src/main/account-profiles', async (importOriginal) => {
  const real = await importOriginal<any>()
  return {
    ...real,
    hardenCredentialDir: (dir: string) => {
      h.hardened.push(String(dir))
      return real.hardenCredentialDir(dir)
    }
  }
})

import { ensureHelpWorkspace } from '../../src/main/help-workspace'
import { backupRealClaudeOnce } from '../../src/main/claude-backup'

let tmp = ''
let resourcesDir = ''
let homeDir = ''

beforeEach(() => {
  h.hardened = []
  tmp = mkdtempSync(join(tmpdir(), 'ccc-resharden-'))
  resourcesDir = join(tmp, 'resources')
  homeDir = join(tmp, 'home')
  mkdirSync(resourcesDir, { recursive: true })
  mkdirSync(join(homeDir, '.claude'), { recursive: true })
  writeFileSync(join(homeDir, '.claude.json'), '{}')
  writeFileSync(join(homeDir, '.claude', '.credentials.json'), '{"token":"x"}')
})

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best-effort */ }
})

describe('the help workspace', () => {
  it('hardens the directory it creates', () => {
    const dir = ensureHelpWorkspace(resourcesDir)
    expect(dir).toBe(join(resourcesDir, 'help'))
    expect(h.hardened).toContain(join(resourcesDir, 'help'))
  })

  it('refuses to write the agent instruction file through a planted reparse point', () => {
    const elsewhere = join(tmp, 'attacker')
    mkdirSync(elsewhere, { recursive: true })
    try {
      symlinkSync(elsewhere, join(resourcesDir, 'help'), 'junction')
    } catch {
      return // unprivileged/unsupported FS: nothing to assert
    }

    expect(() => ensureHelpWorkspace(resourcesDir)).toThrow(/reparse point/i)
    // and the write did NOT land in the redirected directory
    expect(existsSync(join(elsewhere, 'CLAUDE.md'))).toBe(false)
  })
})

describe('the one-time Claude config snapshot', () => {
  it('hardens every directory it creates, including the published one', () => {
    const dest = backupRealClaudeOnce({ homeDir, resourcesDir })
    expect(dest).toBe(join(resourcesDir, 'claude-config-backups', 'initial'))

    const root = join(resourcesDir, 'claude-config-backups')
    // the root, the staging dir, the dir that RECEIVES .credentials.json, and the
    // published name after the rename
    expect(h.hardened).toContain(root)
    expect(h.hardened).toContain(join(root, 'initial.tmp'))
    expect(h.hardened).toContain(join(root, 'initial.tmp', '.claude'))
    expect(h.hardened).toContain(join(root, 'initial'))
  })
})
