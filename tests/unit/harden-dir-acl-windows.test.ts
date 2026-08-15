// `hardenCredentialDir` was `if (!IS_POSIX) return` — a no-op on this app's
// PRIMARY platform. Every directory it "hardened" on Windows simply kept
// whatever its parent's ACL granted, and the resources dir is user-chosen, so
// that inherited grant routinely reaches principals other than the owner. The
// POSIX branch has forced owner-only (0700) on these directories for releases;
// this is the Windows half of the same policy.
//
// WHY THE FIXTURES SEED THEIR OWN PARENT ACL. The first version of these tests
// took a fresh `mkdtemp` directory and asserted against whatever the host's
// temp tree happened to grant. That held on a developer box and did not hold on
// GitHub's windows-2025 runner, whose temp tree has NO inheritable ACEs — so a
// directory created there gets the creator token's default DACL (user,
// Administrators, SYSTEM) as EXPLICIT entries and inherits nothing.
//
// That is not a quirk to skip past: `/inheritance:r` removes INHERITED entries
// only, so on exactly that shape the shipped strip-and-grant left every
// explicit entry in place — including a planted `Authenticated Users`, which is
// the entry this whole change exists to remove. The runner was right and the
// fixture was wrong. Both parent shapes are now built explicitly, so each case
// is a case rather than an accident of the machine the suite runs on.
//
// The DACL assertions are locale-independent on purpose: they count entries,
// look for the `(I)` inherited marker (a fixed icacls flag), and — where a
// specific principal has to be named — use the spelling icacls itself printed
// for a SID, never an English account name.

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  hardenCredentialDir,
  hardenDirAclWindows,
  windowsAclEntries,
  windowsAclIsOwnerOnly,
  windowsAclPrincipals,
  windowsAclRemovalArgs,
} from '../../src/main/account-profiles'

const IS_WINDOWS = process.platform === 'win32'
const ICACLS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe')
const USER = (() => { try { return os.userInfo().username } catch { return '' } })()
/** Authenticated Users: every account that logged in, i.e. the grant the
 *  advisory is about. By SID because the display name is localized. */
const AUTHENTICATED_USERS = '*S-1-5-11'

function icacls(args: string[]): boolean {
  try {
    execFileSync(ICACLS, args, { stdio: 'ignore', windowsHide: true })
    return true
  } catch { return false }
}

/** The DACL entries icacls reports for `target`, one `principal:(flags)` each.
 *  Deliberately a second implementation of the parse in the module under test:
 *  if the two ever disagree the assertions here stop meaning anything. */
function aces(target: string): string[] {
  const out = execFileSync(ICACLS, [target], { encoding: 'utf8', windowsHide: true })
  return out
    .split(/\r?\n/)
    .map((line) => (line.startsWith(target) ? line.slice(target.length) : line).trim())
    .filter((line) => /:\(/.test(line))
}

const principalOf = (entry: string): string => entry.slice(0, entry.indexOf(':('))

// ── fixtures ────────────────────────────────────────────────────────────────

let testRoot = ''
const made: string[] = []

beforeAll(() => {
  if (!IS_WINDOWS) return
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-acl-'))
})

afterAll(() => {
  if (!testRoot) return
  // A hardened directory denies its own deletion to everyone the test process
  // is not; hand the tree back to inheritance before removing it.
  icacls([testRoot, '/reset', '/t', '/q', '/c'])
  try { fs.rmSync(testRoot, { recursive: true, force: true }) } catch { /* best-effort */ }
})

const savedDomain = process.env.USERDOMAIN
afterEach(() => {
  if (savedDomain === undefined) delete process.env.USERDOMAIN
  else process.env.USERDOMAIN = savedDomain
  while (made.length) {
    const dir = made.pop()!
    icacls([dir, '/reset', '/t', '/q', '/c'])
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

type BroadGrant = 'inherited' | 'explicit'

/**
 * A directory carrying a broad grant, reached the way `broad` says:
 *
 *  - `inherited` — the parent grants Authenticated Users with the container/
 *    object inherit flags, so the child holds it as an `(I)` entry. The ordinary
 *    shape below a user-chosen resources directory, which is why the strip is
 *    there at all.
 *  - `explicit` — the parent grants nothing inheritable (the CI runner's shape),
 *    so the child gets the creator token's default DACL, and the broad grant is
 *    written onto the child itself. `/inheritance:r` cannot touch it.
 *
 * Returns the directory and the principal name icacls prints for S-1-5-11 here,
 * so assertions can name it without hard-coding an English string.
 */
function dirWithBroadGrant(broad: BroadGrant): { dir: string; broadPrincipal: string } {
  const parent = fs.mkdtempSync(path.join(testRoot, `${broad}-`))
  made.push(parent)

  const parentAcl = broad === 'inherited'
    ? [parent, '/inheritance:r', '/grant:r', `${USER}:(OI)(CI)F`, `${AUTHENTICATED_USERS}:(OI)(CI)F`]
    : [parent, '/inheritance:r', '/grant:r', `${USER}:F`]
  expect(icacls(parentAcl), 'fixture parent ACL').toBe(true)

  const dir = path.join(parent, 'child')
  fs.mkdirSync(dir)
  if (broad === 'explicit') {
    expect(icacls([dir, '/grant', `${AUTHENTICATED_USERS}:(OI)(CI)F`]), 'fixture explicit grant').toBe(true)
  }

  // Learn the localized spelling from icacls rather than assuming it, and prove
  // in the same step that the fixture really is what it claims to be.
  const entries = aces(dir)
  const inheritedHere = entries.filter((e) => e.includes('(I)')).length
  if (broad === 'inherited') expect(inheritedHere, 'fixture should inherit').toBeGreaterThan(0)
  else expect(inheritedHere, 'fixture should inherit nothing').toBe(0)

  const mine = new Set(windowsAclPrincipals().map((p) => p.slice(p.lastIndexOf('\\') + 1).toLowerCase()))
  const broadPrincipal = entries
    .map(principalOf)
    .find((p) => !mine.has(p.slice(p.lastIndexOf('\\') + 1).toLowerCase()) && !/administrators|system/i.test(p))
  expect(broadPrincipal, 'fixture broad grant should be on the DACL').toBeTruthy()
  return { dir, broadPrincipal: broadPrincipal! }
}

// ── the pure halves, on every leg of the matrix ──────────────────────────────

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

describe('windowsAclRemovalArgs (runs on every leg of the matrix)', () => {
  it('names every principal on the DACL back, in icacls’ own spelling', () => {
    expect(windowsAclRemovalArgs([
      'NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)',
      'BUILTIN\\Administrators:(I)(OI)(CI)(F)',
      'NICK_DESKTOP\\nicho:(F)',
    ])).toEqual([
      '/remove', 'NT AUTHORITY\\SYSTEM',
      '/remove', 'BUILTIN\\Administrators',
      '/remove', 'NICK_DESKTOP\\nicho',
    ])
  })

  it('marks a bare SID as a SID', () => {
    // An account that no longer resolves is printed unadorned; handed back
    // without the `*` icacls would look for an ACCOUNT of that name, fail, and
    // take the whole invocation down with it.
    expect(windowsAclRemovalArgs(['S-1-5-21-1-2-3-1001:(OI)(CI)(F)']))
      .toEqual(['/remove', '*S-1-5-21-1-2-3-1001'])
  })

  it('takes a deny entry too', () => {
    // `/remove` without `:g`/`:d` covers both. A planted deny that survived
    // would be a denial of service on the app’s own credential directory.
    expect(windowsAclRemovalArgs(['NT AUTHORITY\\Authenticated Users:(OI)(CI)(DENY)(W)']))
      .toEqual(['/remove', 'NT AUTHORITY\\Authenticated Users'])
  })

  it('skips a principal that icacls would read as an OPTION rather than a name', () => {
    expect(windowsAclRemovalArgs([
      '/grant:(F)',
      '*S-1-1-0:(F)',
      'ev"il:(F)',
      `sneak${String.fromCharCode(0)}y:(F)`,
      'BUILTIN\\Administrators:(F)',
    ])).toEqual(['/remove', 'BUILTIN\\Administrators'])
  })

  it('de-duplicates, so two entries for one principal are named once', () => {
    expect(windowsAclRemovalArgs(['A\\b:(I)(F)', 'A\\b:(OI)(CI)(F)'])).toEqual(['/remove', 'A\\b'])
  })

  it('REFUSES a DACL longer than the cap rather than truncating it', () => {
    // A truncated remove list leaves whichever principals fell off the end in
    // place, while the grants that follow make the result look deliberate.
    // Refusing falls back to strip-and-grant, which is what shipped.
    const many = Array.from({ length: 33 }, (_, i) => `P${i}:(F)`)
    expect(windowsAclRemovalArgs(many)).toEqual([])
    expect(windowsAclRemovalArgs(many.slice(0, 32))).toHaveLength(64)
  })
})

describe('windowsAclIsOwnerOnly (runs on every leg of the matrix)', () => {
  const OURS = ['NT AUTHORITY\\SYSTEM:(OI)(CI)(F)', 'NICK_DESKTOP\\nicho:(OI)(CI)(F)']

  it('recognises the DACL this module writes, by either spelling of the user', () => {
    expect(windowsAclIsOwnerOnly(OURS, 'nicho')).toBe(true)
    expect(windowsAclIsOwnerOnly(OURS, 'NICHO')).toBe(true)
    expect(windowsAclIsOwnerOnly(['NT AUTHORITY\\SYSTEM:(OI)(CI)(F)', 'nicho:(OI)(CI)(F)'], 'nicho')).toBe(true)
  })

  it('does NOT recognise a DACL that merely contains ours', () => {
    expect(windowsAclIsOwnerOnly([...OURS, 'NT AUTHORITY\\Authenticated Users:(OI)(CI)(F)'], 'nicho')).toBe(false)
  })

  it('does NOT recognise an inherited or weaker entry', () => {
    expect(windowsAclIsOwnerOnly(['NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)', 'NICK_DESKTOP\\nicho:(OI)(CI)(F)'], 'nicho')).toBe(false)
    expect(windowsAclIsOwnerOnly(['NT AUTHORITY\\SYSTEM:(OI)(CI)(F)', 'NICK_DESKTOP\\nicho:(OI)(CI)(M)'], 'nicho')).toBe(false)
    expect(windowsAclIsOwnerOnly(['NT AUTHORITY\\SYSTEM:(OI)(CI)(F)', 'NICK_DESKTOP\\nicho:(F)'], 'nicho')).toBe(false)
  })

  it('does NOT recognise two entries that are not ours, or an unknown user', () => {
    expect(windowsAclIsOwnerOnly(['A\\x:(OI)(CI)(F)', 'B\\y:(OI)(CI)(F)'], 'nicho')).toBe(false)
    expect(windowsAclIsOwnerOnly(OURS, '')).toBe(false)
    expect(windowsAclIsOwnerOnly([], 'nicho')).toBe(false)
  })
})

// ── the real thing, on Windows ──────────────────────────────────────────────

describe.runIf(IS_WINDOWS)('hardenCredentialDir on Windows applies a real DACL', () => {
  it.each<BroadGrant>(['inherited', 'explicit'])(
    'replaces a %s broad grant with exactly the current user and SYSTEM',
    (broad) => {
      const { dir, broadPrincipal } = dirWithBroadGrant(broad)
      expect(aces(dir).map(principalOf)).toContain(broadPrincipal)

      expect(hardenCredentialDir(dir)).toBe(true)

      const after = aces(dir)
      expect(after.filter((a) => a.includes('(I)'))).toEqual([]) // inheritance disabled
      expect(after.map(principalOf)).not.toContain(broadPrincipal) // the grant is GONE
      expect(after).toHaveLength(2) // the current user and SYSTEM, nobody else
    },
  )

  it('leaves the directory fully usable by the app that just hardened it', () => {
    // A hardening step that locks the owner out is worse than none. icacls
    // resolves every principal BEFORE applying anything, so the strip cannot
    // land without its grants — this is that property, asserted.
    const { dir } = dirWithBroadGrant('inherited')
    hardenCredentialDir(dir)

    const file = path.join(dir, 'nested', 'secret.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{"secret":"x"}')
    expect(fs.readFileSync(file, 'utf8')).toBe('{"secret":"x"}')
  })

  it('narrows what a file created underneath it inherits', () => {
    // The files are the point: `.credentials.json`, `conductor-secret.json` and
    // the plugin's SKILL.md all get their permissions from the directory,
    // because a POSIX mode is ignored here.
    const control = dirWithBroadGrant('inherited').dir
    const { dir: hardened, broadPrincipal } = dirWithBroadGrant('inherited')
    hardenCredentialDir(hardened)

    const a = path.join(control, 'f.json')
    const b = path.join(hardened, 'f.json')
    fs.writeFileSync(a, '{}')
    fs.writeFileSync(b, '{}')

    // Named, not counted: the two directories can carry the same NUMBER of
    // entries while granting entirely different people, which is how the
    // count-based version of this assertion passed on a box where the broad
    // grant was still there.
    expect(aces(a).map(principalOf)).toContain(broadPrincipal)
    expect(aces(b).map(principalOf)).not.toContain(broadPrincipal)
  })

  it('is idempotent, and the second call does not need to write at all', () => {
    // The read-first skip is what keeps this affordable on `ensureConfigDir`,
    // which runs on every config write. It must not change the answer.
    const { dir } = dirWithBroadGrant('explicit')
    expect(hardenCredentialDir(dir)).toBe(true)
    const first = aces(dir)
    expect(hardenCredentialDir(dir)).toBe(true)
    expect(aces(dir)).toEqual(first)
    expect(windowsAclIsOwnerOnly(windowsAclEntries(dir), USER)).toBe(true)
  })

  it('re-hardens a directory that was recreated under a permissive parent', () => {
    // `ensureCanvasPlugin` deletes and recreates its tree, which puts the new
    // directory back on its parent's ACL. The skip asks the filesystem rather
    // than remembering, so this is repaired rather than reported done.
    const { dir, broadPrincipal } = dirWithBroadGrant('inherited')
    hardenCredentialDir(dir)
    fs.rmdirSync(dir)
    fs.mkdirSync(dir)
    expect(aces(dir).map(principalOf)).toContain(broadPrincipal)

    expect(hardenCredentialDir(dir)).toBe(true)
    expect(aces(dir).map(principalOf)).not.toContain(broadPrincipal)
  })

  it('falls back to the bare account name when the domain half will not resolve', () => {
    process.env.USERDOMAIN = 'NOSUCHDOMAIN12345'
    const { dir, broadPrincipal } = dirWithBroadGrant('inherited')

    expect(hardenCredentialDir(dir)).toBe(true)
    expect(aces(dir).filter((a) => a.includes('(I)'))).toEqual([])
    expect(aces(dir).map(principalOf)).not.toContain(broadPrincipal)
  })

  it('reports failure instead of throwing when there is nothing to harden', () => {
    // Every caller is on a session-spawn or config-write path. A permissions
    // failure must never be the thing that stops a session starting.
    const missing = path.join(testRoot, 'not-created')
    expect(() => hardenDirAclWindows(missing)).not.toThrow()
    expect(hardenDirAclWindows(missing)).toBe(false)
    expect(windowsAclEntries(missing)).toEqual([])
  })
})

describe.runIf(!IS_WINDOWS)('hardenDirAclWindows off Windows', () => {
  it('does nothing and says so, leaving the POSIX chmod branch untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-acl-'))
    expect(hardenDirAclWindows(dir)).toBe(false)
    // ...while the POSIX branch still does its job on the same directory.
    expect(hardenCredentialDir(dir)).toBe(true)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
