import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// Fixtures use the 'fs' specifier; only 'node:fs' is mocked, so setup writes
// never land in the recorded copy list.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, constants } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The backup copies the REAL ~/.claude.json and ~/.claude/.credentials.json into
// a staging dir. Plain copyFileSync opens the destination through whatever is
// there and writes the token into it, so both call sites pass COPYFILE_EXCL to
// fail closed instead. Nothing asserted that flag: removing it left the suite
// green, which is how a guard gets quietly deleted later.

const h = vi.hoisted(() => ({
  copies: [] as Array<{ src: string; dest: string; flags: unknown }>
}))

vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<any>()
  const real = mod.default ?? mod
  const patched = {
    ...real,
    copyFileSync: (src: any, dest: any, flags?: any) => {
      h.copies.push({ src: String(src), dest: String(dest), flags })
      return real.copyFileSync(src, dest, flags)
    }
  }
  return { ...patched, default: patched }
})

import { backupRealClaudeOnce } from '../../src/main/claude-backup'

let tmp = ''
let homeDir = ''
let resourcesDir = ''

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccc-backup-flags-'))
  homeDir = join(tmp, 'home')
  resourcesDir = join(tmp, 'resources')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(resourcesDir, { recursive: true })

  writeFileSync(join(homeDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 't@example.com' } }))
  const claudeDir = join(homeDir, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(join(claudeDir, '.credentials.json'), JSON.stringify({ token: 'abc123' }))
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ effortLevel: 'high' }))

  h.copies = []
})

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('backupRealClaudeOnce copies fail closed on an occupied destination', () => {
  it('passes COPYFILE_EXCL on every copy it makes', () => {
    const dest = backupRealClaudeOnce({ homeDir, resourcesDir })
    expect(dest).toBeTruthy()

    // Both call sites: the identity file at the staging root, and each top-level
    // file in ~/.claude. Asserting "every copy" rather than a count keeps this
    // honest if another file is added later.
    expect(h.copies.length).toBeGreaterThanOrEqual(2)
    for (const c of h.copies) {
      expect(c.flags, `copy of ${c.dest} was not exclusive`).toBe(constants.COPYFILE_EXCL)
    }
  })

  it('covers the credential file specifically, not just the cheap ones', () => {
    backupRealClaudeOnce({ homeDir, resourcesDir })

    const cred = h.copies.find((c) => c.dest.endsWith('.credentials.json'))
    expect(cred, 'the credential file was never copied').toBeTruthy()
    expect(cred!.flags).toBe(constants.COPYFILE_EXCL)
  })

  // Why the flag matters, asserted on the primitive so the reason survives even
  // if the call sites are refactored.
  it('COPYFILE_EXCL is what refuses an occupied destination, and its absence does not', () => {
    const src = join(tmp, 'src')
    const occupied = join(tmp, 'occupied')
    writeFileSync(src, 'SECRET-TOKEN')
    writeFileSync(occupied, 'PLANTED')

    const fsReal = require('fs')
    expect(() => fsReal.copyFileSync(src, occupied, constants.COPYFILE_EXCL)).toThrow(/EEXIST/)
    expect(readFileSync(occupied, 'utf-8')).toBe('PLANTED')

    // Unflagged, the same call writes the secret straight into it.
    fsReal.copyFileSync(src, occupied)
    expect(readFileSync(occupied, 'utf-8')).toBe('SECRET-TOKEN')
  })
})
