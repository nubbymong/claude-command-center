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
  _icaclsCallsForTest,
  _resetAclStateForTest,
  aclRemovalProvesUnnameable,
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
/** Authenticated Users: every account that logged in, i.e. the broad grant this
 *  hardening exists to remove. By SID because the display name is localized. */
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
const principalsOf = (target: string): string[] => aces(target).map(principalOf)

/**
 * Set `target`'s DACL to EXACTLY `grants` — inheritance off, every principal
 * already there removed first.
 *
 * A fixture cannot build this with `/inheritance:r /grant:r`, which is the point
 * of the change under test: that leaves every explicit entry in place, so a
 * "parent that grants nothing inheritable" built with it silently keeps whatever
 * inheritable entries the host put there. The first version of these fixtures
 * did exactly that and passed here while failing on CI, whose temp tree has a
 * different shape. The fixture assertions below check what this produced rather
 * than trusting it.
 */
function setExactAcl(target: string, grants: string[]): boolean {
  const removals = principalsOf(target).flatMap((p) => ['/remove', p])
  if (icacls([target, '/inheritance:r', ...removals, '/grant:r', ...grants])) return true
  // A principal the DACL NAMES but icacls cannot resolve BACK fails the whole
  // batch (exit 1332). `NT AUTHORITY\LogonSessionId_0_<n>` is the one that turns
  // up in practice — it lands in the creator token's default DACL under some
  // logon types, and measured here it is un-nameable. Remove what can be
  // removed, one at a time, and let the fixture assertions below decide whether
  // what is left is the shape this case needs. Grants last, always.
  for (const p of principalsOf(target)) icacls([target, '/remove', p])
  return icacls([target, '/inheritance:r', '/grant:r', ...grants])
}

/**
 * Which of `principals` this machine cannot resolve BACK from the name icacls
 * printed for it — asked, not assumed, by trying to remove each from a scratch
 * directory that has none of them. Removing an absent-but-nameable principal
 * succeeds (measured), so a failure here is the name resolution and nothing
 * else.
 *
 * These are the entries `hardenDirAclWindows` provably cannot take off a DACL,
 * so they are the entries the assertions below have to allow for. Machines
 * differ: this box's token default DACL carries an un-nameable
 * `NT AUTHORITY\LogonSessionId_0_<n>` and CI's does not, and a test that
 * assumed either one would be testing the machine.
 */
function unnameable(principals: string[]): string[] {
  const scratch = fs.mkdtempSync(path.join(testRoot, 'probe-'))
  made.push(scratch)
  return principals.filter((p) => !icacls([scratch, '/remove', p]))
}

/** Grant Authenticated Users on `target` and return the name icacls prints for
 *  it here — learned rather than hard-coded, so the assertions do not depend on
 *  the runner's display language. */
function grantBroad(target: string): string {
  const before = new Set(principalsOf(target))
  expect(icacls([target, '/grant', `${AUTHENTICATED_USERS}:(OI)(CI)F`]), 'fixture broad grant').toBe(true)
  const added = principalsOf(target).filter((p) => !before.has(p))
  expect(added, 'the broad grant should add exactly one principal').toHaveLength(1)
  return added[0]
}

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

  // `inherited`: the parent hands the broad grant down. `explicit`: the parent
  // hands NOTHING down, so the child gets the creator token's default DACL as
  // explicit entries, and the broad grant is written onto the child itself.
  expect(setExactAcl(parent, broad === 'inherited' ? [`${USER}:(OI)(CI)F`] : [`${USER}:F`]), 'fixture parent ACL').toBe(true)
  const fromParent = broad === 'inherited' ? grantBroad(parent) : null

  const dir = path.join(parent, 'child')
  fs.mkdirSync(dir)
  const broadPrincipal = fromParent ?? grantBroad(dir)

  // Prove the fixture is the shape it claims to be, rather than trusting the
  // commands above to have produced it on this machine.
  const inheritedHere = aces(dir).filter((e) => e.includes('(I)')).length
  if (broad === 'inherited') expect(inheritedHere, 'fixture should inherit').toBeGreaterThan(0)
  else expect(inheritedHere, 'fixture should inherit nothing').toBe(0)
  expect(principalsOf(dir), 'fixture broad grant should be on the DACL').toContain(broadPrincipal)

  return { dir, broadPrincipal }
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
  /** What a read-back of a successful write taught the module on this machine. */
  const PAIR = new Set(['NT AUTHORITY\\SYSTEM', 'NICK_DESKTOP\\nicho'])

  it('recognises exactly the DACL this module writes', () => {
    expect(windowsAclIsOwnerOnly(OURS, PAIR)).toBe(true)
    expect(windowsAclIsOwnerOnly([...OURS].reverse(), PAIR)).toBe(true)
  })

  it('recognises NOTHING until a write has been read back', () => {
    // The unlearned state must not guess. Skipping on a guess is how the DACL
    // below came to be accepted.
    expect(windowsAclIsOwnerOnly(OURS, null)).toBe(false)
    expect(windowsAclIsOwnerOnly(OURS, new Set(['NT AUTHORITY\\SYSTEM']))).toBe(false)
  })

  // The two an adversarial pass demonstrated end-to-end against the shape-based
  // version: both were reported hardened, and the write was SKIPPED, leaving
  // Full Control where the whole branch exists to remove it.
  it('does NOT accept a broad grant sitting where SYSTEM should be', () => {
    for (const broad of ['Everyone', 'NT AUTHORITY\\Authenticated Users', 'BUILTIN\\Users']) {
      expect(windowsAclIsOwnerOnly([`${broad}:(OI)(CI)(F)`, 'NICK_DESKTOP\\nicho:(OI)(CI)(F)'], PAIR), broad).toBe(false)
    }
  })

  it('does NOT accept a same-named principal from another machine', () => {
    // The resources directory may be a network share, where `EVILPC\nicho` is a
    // different person with the same account name.
    //
    // Each line answers a different mutation, which the first two did not: a
    // comparison that strips the domain and matches on the ACCOUNT half — the
    // exact bug this block exists for — survives `EVILPC\nicho + EVILPC\bob`
    // (bob matches nothing), so the case that catches it has to have BOTH
    // account halves matching the pair's.
    expect(windowsAclIsOwnerOnly(['EVILPC\\nicho:(OI)(CI)(F)', 'EVILPC\\SYSTEM:(OI)(CI)(F)'], PAIR)).toBe(false)
    expect(windowsAclIsOwnerOnly(['EVILPC\\nicho:(OI)(CI)(F)', 'EVILPC\\bob:(OI)(CI)(F)'], PAIR)).toBe(false)
    // ...and this one catches `every` weakened to `some`: the second entry IS
    // one of the pair, so a check that accepts any overlap accepts this DACL.
    expect(windowsAclIsOwnerOnly(['EVILPC\\nicho:(OI)(CI)(F)', 'NT AUTHORITY\\SYSTEM:(OI)(CI)(F)'], PAIR)).toBe(false)
  })

  it('recognises a settled DACL of ONE entry, which is what running as SYSTEM produces', () => {
    // Measured: granting `S-1-5-18` twice in one `/grant:r` yields ONE ACE. A
    // process running as SYSTEM therefore hardens a directory into a
    // single-entry DACL, and a rigid "exactly two" here never recognises it —
    // so that process pays the full read+write sequence on every config write
    // for the life of the process.
    const SELF = new Set(['NT AUTHORITY\\SYSTEM'])
    expect(windowsAclIsOwnerOnly(['NT AUTHORITY\\SYSTEM:(OI)(CI)(F)'], SELF)).toBe(true)
    // It stays an EQUALITY: one learned principal licenses exactly one entry.
    expect(windowsAclIsOwnerOnly(
      ['NT AUTHORITY\\SYSTEM:(OI)(CI)(F)', 'NT AUTHORITY\\Authenticated Users:(OI)(CI)(F)'], SELF,
    )).toBe(false)
    expect(windowsAclIsOwnerOnly(['NICK_DESKTOP\\nicho:(OI)(CI)(F)'], SELF)).toBe(false)
    expect(windowsAclIsOwnerOnly(['NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)'], SELF)).toBe(false)
    expect(windowsAclIsOwnerOnly([], SELF)).toBe(false)
    // ...and a single entry is not accepted against a pair that has two.
    expect(windowsAclIsOwnerOnly(['NT AUTHORITY\\SYSTEM:(OI)(CI)(F)'], PAIR)).toBe(false)
  })

  it('does NOT accept one principal listed twice in place of two', () => {
    expect(windowsAclIsOwnerOnly(['NICK_DESKTOP\\nicho:(OI)(CI)(F)', 'NICK_DESKTOP\\nicho:(OI)(CI)(F)'], PAIR)).toBe(false)
  })

  it('does NOT recognise a DACL that merely contains ours', () => {
    expect(windowsAclIsOwnerOnly([...OURS, 'NT AUTHORITY\\Authenticated Users:(OI)(CI)(F)'], PAIR)).toBe(false)
  })

  it('does NOT recognise an inherited or weaker entry', () => {
    expect(windowsAclIsOwnerOnly(['NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)', 'NICK_DESKTOP\\nicho:(OI)(CI)(F)'], PAIR)).toBe(false)
    expect(windowsAclIsOwnerOnly(['NT AUTHORITY\\SYSTEM:(OI)(CI)(F)', 'NICK_DESKTOP\\nicho:(OI)(CI)(M)'], PAIR)).toBe(false)
    expect(windowsAclIsOwnerOnly(['NT AUTHORITY\\SYSTEM:(OI)(CI)(F)', 'NICK_DESKTOP\\nicho:(F)'], PAIR)).toBe(false)
  })

  it('discounts a principal proven un-nameable, in the spelling icacls PRINTS', () => {
    // The memo stores the printed form; a bare SID is only starred on the way
    // back INTO icacls. Keying the two differently made the memo inert.
    const withOrphan = [...OURS, 'S-1-5-21-1-2-3-1001:(OI)(CI)(F)']
    expect(windowsAclIsOwnerOnly(withOrphan, PAIR)).toBe(false)
    expect(windowsAclIsOwnerOnly(withOrphan, PAIR, new Set(['S-1-5-21-1-2-3-1001']))).toBe(true)
    expect(windowsAclIsOwnerOnly(withOrphan, PAIR, new Set(['*S-1-5-21-1-2-3-1001']))).toBe(false)
  })

  it('does NOT recognise two entries that are not ours, or an empty DACL', () => {
    expect(windowsAclIsOwnerOnly(['A\\x:(OI)(CI)(F)', 'B\\y:(OI)(CI)(F)'], PAIR)).toBe(false)
    expect(windowsAclIsOwnerOnly([], PAIR)).toBe(false)
  })
})

describe('aclRemovalProvesUnnameable (runs on every leg of the matrix)', () => {
  // A principal in the un-removable memo is never removed again for the life of
  // the process AND is discounted by the skip check. Getting into it on
  // anything other than proof is how a broad grant becomes permanent while the
  // directory reports itself hardened.
  const ORPHAN = 'S-1-5-21-1-2-3-1001'
  const UNNAMEABLE = 'NT AUTHORITY\\LogonSessionId_0_411756'
  /** `ERROR_NONE_MAPPED` — "no mapping between account names and security IDs". */
  const NONE_MAPPED = 1332

  it('trusts ONLY a name-resolution failure', () => {
    // Measured on Windows 11: an un-nameable principal exits 1332 every time, a
    // directory that has gone away exits 2, and a nameable principal that is
    // simply absent from the DACL exits 0 (a success, so it never gets here).
    expect(aclRemovalProvesUnnameable(UNNAMEABLE, NONE_MAPPED)).toBe(true)
    expect(aclRemovalProvesUnnameable(ORPHAN, NONE_MAPPED)).toBe(true)
    // The transient failures, which used to memoise exactly like the above:
    expect(aclRemovalProvesUnnameable(UNNAMEABLE, 2), 'directory vanished mid-loop').toBe(false)
    expect(aclRemovalProvesUnnameable(UNNAMEABLE, 5), 'access denied').toBe(false)
    expect(aclRemovalProvesUnnameable(UNNAMEABLE, 1), 'generic failure').toBe(false)
    // …and a timeout kill, which leaves no exit status at all. The resources
    // dir may be a network share and the call is capped at 5s.
    expect(aclRemovalProvesUnnameable(UNNAMEABLE, null), 'killed on the timeout').toBe(false)
  })

  it('NEVER trusts it for a principal too broad to give up on', () => {
    // These are the grants the whole branch exists to remove. A principal is
    // only reliably identified by SID and icacls prints names — but it prints a
    // SID exactly when it could not resolve one, which is the only way a broad
    // principal can reach this at all.
    for (const broad of [
      'S-1-1-0',            // Everyone
      'S-1-5-11',           // Authenticated Users
      'S-1-5-7',            // Anonymous Logon
      'S-1-5-32-544',       // BUILTIN\Administrators
      'S-1-5-32-545',       // BUILTIN\Users
      'S-1-5-21-1-2-3-512', // Domain Admins — a DC it cannot reach prints these bare
      'S-1-5-21-1-2-3-513', // Domain Users
      'S-1-5-21-1-2-3-515', // Domain Computers
    ]) {
      expect(aclRemovalProvesUnnameable(broad, NONE_MAPPED), broad).toBe(false)
    }
    // A domain SID that is NOT one of those RIDs is an ordinary orphaned
    // account, which is the case the memo exists for.
    expect(aclRemovalProvesUnnameable('S-1-5-21-1-2-3-1105', NONE_MAPPED)).toBe(true)
  })
})

describe('windowsAclRemovalArgs honours the memo in the printed spelling', () => {
  it('drops a bare SID the memo names WITHOUT the star', () => {
    const entries = ['S-1-5-21-1-2-3-1001:(OI)(CI)(F)', 'BUILTIN\\Administrators:(F)']
    expect(windowsAclRemovalArgs(entries)).toEqual([
      '/remove', '*S-1-5-21-1-2-3-1001',
      '/remove', 'BUILTIN\\Administrators',
    ])
    expect(windowsAclRemovalArgs(entries, new Set(['S-1-5-21-1-2-3-1001'])))
      .toEqual(['/remove', 'BUILTIN\\Administrators'])
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
      // The current user and SYSTEM, nobody else — allowing only for entries
      // this machine cannot name back, which icacls cannot remove at all.
      expect(after.length - unnameable(after.map(principalOf)).length).toBe(2)
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

  it.each<BroadGrant>(['inherited', 'explicit'])(
    'is idempotent on a %s-parent directory, and settles into ONE icacls call',
    (broad) => {
      // The read-first skip is what keeps this affordable on `ensureConfigDir`,
      // which runs on every config write. COUNTING the calls is the only honest
      // way to see it: a directory that was skipped and a directory that was
      // re-written have identical DACLs, so the previous version of this test —
      // which computed the expected pair by hand and fed it straight into
      // `windowsAclIsOwnerOnly` — stayed green while the module learned nothing
      // and paid three icacls calls on every config write, forever.
      //
      // Both parent shapes are measured because they settle differently. With
      // nothing inheritable from the parent (`explicit`) the child gets the
      // creator token's default DACL, which on THIS box carries an un-nameable
      // `NT AUTHORITY\LogonSessionId_0_<n>` (measured: `/remove` exits 1332
      // every time) — so a fully hardened directory reads back as THREE entries
      // and the learning gate has to discount it to recognise anything. On a
      // machine whose default DACL has no such principal (GitHub's windows
      // runner) the two shapes coincide and this still asserts the invariant.
      // The message on the count assertion names which shape actually ran.
      _resetAclStateForTest()
      const { dir } = dirWithBroadGrant(broad)

      expect(hardenCredentialDir(dir)).toBe(true)
      const settled = aces(dir)
      const stuck = unnameable(settled.map(principalOf))

      // Bounded warm-up before the measurement. Hardening is a subprocess call
      // and the full suite runs 500+ files in parallel, so ANY single icacls
      // call can be lost to the 5s cap — and one lost call leaves the pair
      // unlearned for that round. The property under test is what a SETTLED
      // directory costs, so let it reach that state in a bounded number of
      // attempts rather than requiring the first to win the race. A module that
      // never learns — the bug this exists for — never settles, whatever the
      // budget, so this does not soften the assertion.
      let cost = 0
      for (let attempt = 0; attempt < 3 && cost !== 1; attempt++) {
        const before = _icaclsCallsForTest()
        expect(hardenCredentialDir(dir)).toBe(true)
        cost = _icaclsCallsForTest() - before
      }
      expect(
        cost,
        `a settled directory should cost ONE read and no writes; it carries ${stuck.length} un-nameable principal(s): ${stuck.join(', ') || 'none'}`,
      ).toBe(1)
      expect(aces(dir), 'and a settled call must not change the DACL').toEqual(settled)

      // A negative control on the same real entries: the settled DACL is NOT
      // recognised against another machine's pair, so the skip is an equality
      // against what THIS machine observed and not a shape.
      expect(windowsAclIsOwnerOnly(windowsAclEntries(dir), new Set(['OTHER\\a', 'OTHER\\b']), new Set(stuck))).toBe(false)
    },
  )

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
