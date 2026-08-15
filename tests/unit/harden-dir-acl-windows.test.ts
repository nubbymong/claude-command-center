// `hardenCredentialDir` was `if (!IS_POSIX) return` — a no-op on this app's
// PRIMARY platform. Every directory it "hardened" on Windows simply kept
// whatever its parent's ACL granted, and the resources dir is user-chosen, so
// that inherited grant routinely reaches principals other than the owner. The
// POSIX branch has forced owner-only (0700) on these directories for releases;
// this is the Windows half of the same policy.
//
// The DACL assertions are locale-independent on purpose: they count ACEs and
// look for the `(I)` inherited marker (a fixed icacls flag) rather than
// matching account names, which ARE localized.

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hardenCredentialDir, hardenDirAclWindows, windowsAclPrincipals } from '../../src/main/account-profiles'

const IS_WINDOWS = process.platform === 'win32'
const ICACLS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe')

/** The DACL entries icacls reports for `target`, one `principal:(flags)` each.
 *  `:(` only ever appears in an ACE — not in the drive letter of the echoed
 *  path, and not in the trailing "Successfully processed" summary. */
function aces(target: string): string[] {
  const out = execFileSync(ICACLS, [target], { encoding: 'utf8', windowsHide: true })
  return out
    .split(/\r?\n/)
    .map((line) => (line.startsWith(target) ? line.slice(target.length) : line).trim())
    .filter((line) => /:\(/.test(line))
}

const made: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-acl-'))
  made.push(dir)
  return dir
}

const savedDomain = process.env.USERDOMAIN
afterEach(() => {
  if (savedDomain === undefined) delete process.env.USERDOMAIN
  else process.env.USERDOMAIN = savedDomain
  while (made.length) {
    try { fs.rmSync(made.pop()!, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

describe('windowsAclPrincipals (runs on every leg of the matrix)', () => {
  it('prefers DOMAIN\\user and keeps the bare name as a fallback', () => {
    expect(windowsAclPrincipals('nicho', 'NICK_DESKTOP')).toEqual(['NICK_DESKTOP\\nicho', 'nicho'])
  })

  it('accepts a non-ASCII account name — rejecting those would silently disable hardening for whole locales', () => {
    expect(windowsAclPrincipals('Müller', 'BÜRO')).toEqual(['BÜRO\\Müller', 'Müller'])
  })

  it('drops a domain that would be RE-PARSED by icacls rather than merely fail to resolve', () => {
    // `BAD:DOMAIN\u:(OI)(CI)F` is read by icacls as principal `BAD` with a
    // permission string of `DOMAIN\u...` — a different grant than the intended
    // one, from an argument that never went near a shell. Drop the part.
    expect(windowsAclPrincipals('u', 'BAD:DOMAIN')).toEqual(['u'])
    expect(windowsAclPrincipals('u', 'A(B)')).toEqual(['u'])
    expect(windowsAclPrincipals('u', 'A,B')).toEqual(['u'])
    expect(windowsAclPrincipals('u', 'A;B')).toEqual(['u'])
    expect(windowsAclPrincipals('u', 'A\\B')).toEqual(['u'])
    expect(windowsAclPrincipals('u', '/grant')).toEqual(['u'])
    expect(windowsAclPrincipals('u', '*S-1-1-0')).toEqual(['u'])
    expect(windowsAclPrincipals('u', 'A"B')).toEqual(['u'])
    expect(windowsAclPrincipals('u', 'A\u0000B')).toEqual(['u'])
  })

  it('returns NOTHING when the account name itself is unusable', () => {
    // Empty means no icacls call at all. That is the safe direction: stripping
    // inheritance without a grant we can name would lock the app out of its
    // own data, which is worse than leaving the inherited ACL in place.
    expect(windowsAclPrincipals('', 'DOM')).toEqual([])
    expect(windowsAclPrincipals('ev:il', 'DOM')).toEqual([])
    expect(windowsAclPrincipals('a'.repeat(257), 'DOM')).toEqual([])
  })

  it('falls back to the bare name when there is no domain at all', () => {
    expect(windowsAclPrincipals('nicho', '')).toEqual(['nicho'])
  })
})

describe.runIf(IS_WINDOWS)('hardenCredentialDir on Windows applies a real DACL', () => {
  it('replaces the inherited ACL with exactly the current user and SYSTEM', () => {
    const dir = tempDir()

    // The fixture has to be meaningful: if a fresh temp dir already had no
    // inherited ACEs there would be nothing for this test to prove.
    const before = aces(dir)
    expect(before.filter((a) => a.includes('(I)')).length).toBeGreaterThan(0)

    expect(hardenCredentialDir(dir)).toBe(true)

    const after = aces(dir)
    expect(after.filter((a) => a.includes('(I)'))).toEqual([]) // inheritance disabled
    expect(after).toHaveLength(2) // the current user and SYSTEM, nobody else
  })

  it('leaves the directory fully usable by the app that just hardened it', () => {
    // A hardening step that locks the owner out is worse than none. icacls
    // resolves every principal BEFORE applying anything, so the strip cannot
    // land without its grants — this is that property, asserted.
    const dir = tempDir()
    hardenCredentialDir(dir)

    const file = path.join(dir, 'nested', 'secret.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{"secret":"x"}')
    expect(fs.readFileSync(file, 'utf8')).toBe('{"secret":"x"}')
    fs.rmSync(path.dirname(file), { recursive: true })
  })

  it('narrows what a file created underneath it inherits', () => {
    // The files are the point: `.credentials.json`, `conductor-secret.json` and
    // the plugin's SKILL.md all get their permissions from the directory,
    // because a POSIX mode is ignored here.
    const control = tempDir()
    const hardened = tempDir()
    hardenCredentialDir(hardened)

    const a = path.join(control, 'f.json')
    const b = path.join(hardened, 'f.json')
    fs.writeFileSync(a, '{}')
    fs.writeFileSync(b, '{}')

    expect(aces(b).length).toBeLessThan(aces(a).length)
  })

  it('falls back to the bare account name when the domain half will not resolve', () => {
    process.env.USERDOMAIN = 'NOSUCHDOMAIN12345'
    const dir = tempDir()

    expect(hardenCredentialDir(dir)).toBe(true)
    expect(aces(dir).filter((a) => a.includes('(I)'))).toEqual([])
  })

  it('reports failure instead of throwing when there is nothing to harden', () => {
    // Every caller is on a session-spawn or config-write path. A permissions
    // failure must never be the thing that stops a session starting.
    const missing = path.join(tempDir(), 'not-created')
    expect(() => hardenDirAclWindows(missing)).not.toThrow()
    expect(hardenDirAclWindows(missing)).toBe(false)
  })
})

describe.runIf(!IS_WINDOWS)('hardenDirAclWindows off Windows', () => {
  it('does nothing and says so, leaving the POSIX chmod branch untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-acl-'))
    made.push(dir)
    expect(hardenDirAclWindows(dir)).toBe(false)
    // ...while the POSIX branch still does its job on the same directory.
    expect(hardenCredentialDir(dir)).toBe(true)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })
})
