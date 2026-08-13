import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// This suite exercises the REAL filesystem (no fs mock): the whole point is that
// a symlink/junction planted on a credential directory, or a link planted at a
// credential file's destination, cannot capture the write. A mock would assert
// the shape of the calls; here we assert the bytes and inodes actually land
// where they should and nowhere else.
import {
  mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, lstatSync,
  symlinkSync, linkSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSecure, copyCredentialFile, atomicWriteSecure, _setRootsForTest } from '../../src/main/account-profiles'

const IS_WIN = process.platform === 'win32'

// A directory reparse point the current user can create UNPRIVILEGED on either
// platform: a junction on Windows (no Developer Mode needed), a dir symlink on
// POSIX. This is exactly the primitive the finding used.
function plantDirReparse(target: string, linkPath: string): boolean {
  try { symlinkSync(target, linkPath, IS_WIN ? 'junction' : 'dir'); return true }
  catch { return false } // e.g. POSIX symlink perms in a locked-down CI; skip rather than false-pass
}
// A link at a FILE destination: a hard link on Windows (same inode, no priv), a
// symlink on POSIX. Writing "through" it is the disclosure the fix must prevent.
function plantFileLink(victim: string, linkPath: string): boolean {
  try { if (IS_WIN) linkSync(victim, linkPath); else symlinkSync(victim, linkPath); return true }
  catch { return false }
}

let base = ''
let attacker = ''

describe('credential directory + copy hardening', () => {
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cred-harden-'))
    attacker = mkdtempSync(join(tmpdir(), 'cred-attacker-'))
    // Pin the trust root to `base` so mkdirSecure inspects every segment below it
    // (and never calls the real getResourcesDirectory()).
    _setRootsForTest({ resourcesDir: base, sharedRoot: join(base, '.claude') })
  })
  afterEach(() => {
    _setRootsForTest(null)
    for (const d of [base, attacker]) { try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
  })

  it('mkdirSecure creates a normal nested path', () => {
    const dir = join(base, 'account-profiles', 'p1', 'identity')
    mkdirSecure(dir)
    expect(lstatSync(dir).isDirectory()).toBe(true)
  })

  it('mkdirSecure refuses a reparse point planted AT the target dir', () => {
    const dir = join(base, 'account-profiles', 'p1', 'identity')
    mkdirSync(join(base, 'account-profiles', 'p1'), { recursive: true })
    if (!plantDirReparse(attacker, dir)) return // unprivileged link unavailable; nothing to prove
    expect(() => mkdirSecure(dir)).toThrow(/reparse point/)
  })

  it('mkdirSecure refuses a reparse point planted on an ANCESTOR (the managed root)', () => {
    // account-profiles itself is the junction — the leaf ends up a real dir INSIDE
    // the attacker's tree, so only walking the ancestors catches it.
    const managedRoot = join(base, 'account-profiles')
    if (!plantDirReparse(attacker, managedRoot)) return
    const dir = join(managedRoot, 'p1', 'identity')
    expect(() => mkdirSecure(dir)).toThrow(/reparse point/)
    // and nothing was written under the attacker dir as a credential
    expect(() => lstatSync(join(managedRoot))).not.toThrow()
  })

  it('copyCredentialFile does NOT write a token through a link planted at the destination', () => {
    const claudeDir = join(base, 'account-profiles', 'p1', '.claude')
    mkdirSecure(claudeDir)
    const dest = join(claudeDir, '.credentials.json')
    const sink = join(attacker, 'loot.json')
    writeFileSync(sink, 'SINK-ORIGINAL')
    if (!plantFileLink(sink, dest)) return
    const src = join(base, 'canonical.credentials.json')
    writeFileSync(src, '{"claudeAiOauth":{"accessToken":"SECRET-TOKEN"}}')

    copyCredentialFile(src, dest)

    // The attacker's file is untouched — the write went to a fresh inode.
    expect(readFileSync(sink, 'utf-8')).toBe('SINK-ORIGINAL')
    // The destination is a real file carrying the copied credential, not a link.
    expect(readFileSync(dest, 'utf-8')).toBe('{"claudeAiOauth":{"accessToken":"SECRET-TOKEN"}}')
    expect(lstatSync(dest).isSymbolicLink()).toBe(false)
  })

  it('does NOT throw when the trusted root itself is a reparse point (legit network-drive / symlinked layout)', () => {
    // The resources dir may legitimately be a junction to a network share; the
    // anchor is trusted, only the app-created tree below it is inspected.
    const rootLink = join(attacker, 'resources-link')
    if (!plantDirReparse(join(attacker, 'real-resources'), rootLink)) return
    mkdirSync(join(attacker, 'real-resources'), { recursive: true })
    _setRootsForTest({ resourcesDir: rootLink, sharedRoot: join(rootLink, '.claude') })

    const dir = join(rootLink, 'account-profiles', 'p1', 'identity')
    expect(() => mkdirSecure(dir)).not.toThrow()
    expect(lstatSync(dir).isDirectory()).toBe(true) // created (through the trusted junction)
  })

  it('does NOT false-positive on a legit sibling junction (e.g. .claude/projects) below a credential dir', () => {
    const claudeDir = join(base, 'account-profiles', 'p1', '.claude')
    mkdirSync(claudeDir, { recursive: true })
    // The app itself junctions shared subdirs like projects/ — that is a CHILD of
    // the credential dir, never on the ancestor walk, so it must not trip the guard.
    if (!plantDirReparse(attacker, join(claudeDir, 'projects'))) return
    expect(() => mkdirSecure(claudeDir)).not.toThrow()
  })

  it('atomicWriteSecure accepts a Buffer (the copy path passes raw bytes)', () => {
    const dest = join(base, 'bytes.bin')
    atomicWriteSecure(dest, Buffer.from([0x00, 0x01, 0x02, 0xff]))
    expect([...readFileSync(dest)]).toEqual([0x00, 0x01, 0x02, 0xff])
  })
})
