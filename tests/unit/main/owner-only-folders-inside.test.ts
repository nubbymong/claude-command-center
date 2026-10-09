// What is already inside a folder the owner-only rule makes owner-only in
// place gets the folder's rights, and the folder passes only when the read of
// what is inside holds them: every entry directly inside it (the sign-in files
// among them) and any entry deeper that does not, each owned by this user or
// the Administrators group and giving rights to nobody but the user, SYSTEM
// and the Administrators group. A folder whose own rights read back
// owner-only is still refused when an entry inside keeps another account's
// entry -- an entry the Administrators group owns with another group's
// inherited read -- when an entry
// is another account's, when a link to a file is inside, when what is inside
// could not be read or put right, and when the answer does not say what is
// inside at all. A clean tree passes; a link to a folder is not followed and
// not judged.
//
// The script writes the folder's owner and its rights separately (owner
// first), so that the rights alone are what Windows passes on to what is
// inside; it never goes through a link
// and writes only an entry this user or the Administrators group owns. The
// rule with Windows' own programs (where Constrained Language Mode refuses the
// script) never uses /restore, which needs a privilege only an elevated
// process has, and removes every other account's own entry by SID.
//
// Host-safe: no process starts and no file or folder is touched. The script's
// answers are fakes in the shape it prints; the real round trip is
// owner-only-folders-real.test.ts (CI and the VM).
import { describe, it, expect, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const no = (file: unknown) => { throw new Error(`no process in this test: ${String(file)}`) }
  return { ...real, execFile: vi.fn(no), execFileSync: vi.fn(no), spawn: vi.fn(no), spawnSync: vi.fn(no), execSync: vi.fn(no) }
})

import * as rule from '../../../src/main/owner-only-folders'

const { secureFoldersWindows, OWNER_ONLY_SCRIPT, OWNER_ONLY_SYSTEM_SID, OWNER_ONLY_ADMINISTRATORS_SID } = rule

const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1005'
/** A local group of this machine (synthetic). */
const OTHER_GROUP = 'S-1-5-21-1111111111-2222222222-3333333333-1007'
const FULL = 2032127
const READ_EXECUTE = 1179817
const rule1 = (sid: string, extra: Partial<{ rights: number; allow: boolean; inherited: boolean; flags: number }> = {}) =>
  ({ sid, rights: FULL, allow: true, inherited: false, flags: 3, ...extra })
/** A folder's own read, owner-only, with what is inside it. */
const folder = (dir: string, inside: unknown, insideError: unknown = null) =>
  ({ dir, error: null, owner: USER, protected: true, rules: [rule1(USER), rule1(OWNER_ONLY_SYSTEM_SID)], inside, insideError })
/** An entry inside, as the script prints it. */
const entry = (name: string, owner: string, rules: unknown[], folderToo = false) => ({ name, link: false, folder: folderToo, owner, rules })
/** What a file inside an owner-only folder reads once it takes the folder's rights. */
const inherits = (name: string, owner = USER) => entry(name, owner, [rule1(OWNER_ONLY_SYSTEM_SID, { inherited: true, flags: 0 }), rule1(USER, { inherited: true, flags: 0 })])
/** A file the Administrators group owns with another group's inherited read. */
const keptGroupRead = (name: string) => entry(name, OWNER_ONLY_ADMINISTRATORS_SID, [
  rule1(OTHER_GROUP, { rights: READ_EXECUTE, inherited: true, flags: 0 }),
  rule1(USER, { inherited: true, flags: 0 }), rule1(OWNER_ONLY_ADMINISTRATORS_SID, { inherited: true, flags: 0 }), rule1(OWNER_ONLY_SYSTEM_SID, { inherited: true, flags: 0 }),
])
const answer = (folders: unknown[]) => async () => JSON.stringify({ user: USER, folders })
const HOME = 'C:\\profiles\\profile-a'
const DIRS = [HOME, `${HOME}\\.claude`, `${HOME}\\identity`]

describe('a folder made owner-only in place passes only when what is inside it reads back owner-only too', () => {
  it('a clean tree passes: every entry this user\'s or the Administrators group\'s, rights for the user, SYSTEM and the Administrators group only; a link to a folder is not judged', async () => {
    const out = await secureFoldersWindows(DIRS, answer([
      folder(DIRS[0], [inherits('.claude.json'), { name: '.ssh', link: true, folder: true }, inherits('.gitconfig', OWNER_ONLY_ADMINISTRATORS_SID)]),
      folder(DIRS[1], [inherits('.credentials.json'), entry('todos', OWNER_ONLY_ADMINISTRATORS_SID, [rule1(OWNER_ONLY_SYSTEM_SID, { inherited: true }), rule1(USER, { inherited: true }), rule1(OWNER_ONLY_ADMINISTRATORS_SID)], true), { name: 'projects', link: true, folder: true }]),
      folder(DIRS[2], []),
    ]))
    expect(out.map((r) => [r.dir, r.ok, r.detail])).toEqual(DIRS.map((d) => [d, true, 'owner-only']))
  })

  it('an entry the Administrators group owns with another group\'s inherited read refuses its folder: never passed', async () => {
    const out = await secureFoldersWindows(DIRS, answer([
      folder(DIRS[0], [keptGroupRead('.claude.json')]),
      folder(DIRS[1], [keptGroupRead('.credentials.json')]),
      folder(DIRS[2], [keptGroupRead('.credentials.json'), keptGroupRead('.claude.json')]),
    ]))
    expect(out.map((r) => [r.ok, r.detail])).toEqual(DIRS.map(() => [false, 'an entry inside it is not owner-only']))
  })

  it('any one entry, at any depth, that is not owner-only refuses the folder; the folders beside it keep their own verdict', async () => {
    const cases: Array<[string, unknown, string]> = [
      ['another account\'s own entry', entry('a.json', USER, [rule1(USER, { inherited: true }), rule1(OTHER, { rights: READ_EXECUTE })]), 'an entry inside it is not owner-only'],
      ['everyone, inherited', entry('a.json', USER, [rule1(USER, { inherited: true }), rule1('S-1-1-0', { inherited: true })]), 'an entry inside it is not owner-only'],
      ['a deny entry', entry('a.json', USER, [rule1(USER, { inherited: true }), rule1(OTHER, { allow: false })]), 'an entry inside it is not owner-only'],
      ['deeper, the Administrators group\'s with another group\'s inherited read', keptGroupRead('todos\\deep\\t1.json'), 'an entry inside it is not owner-only'],
      ['another account the owner', entry('a.json', OTHER, [rule1(USER, { inherited: true })]), "an entry inside it is another account's"],
      ['SYSTEM the owner', entry('a.json', OWNER_ONLY_SYSTEM_SID, [rule1(USER, { inherited: true })]), "an entry inside it is another account's"],
      ['a link to a file', { name: '.credentials.json', link: true, folder: false }, 'a link to a file is inside it'],
      ['an entry that could not be read', { name: 'a.json', error: 'denied' }, 'what is inside it was not read'],
      ['an entry with no owner', entry('a.json', '', []), 'what is inside it was not read'],
      ['an entry whose rights could not be read', entry('a.json', USER, [{ sid: USER }]), 'what is inside it was not read'],
      ['an entry that does not say whether it is a link', { name: 'a.json', owner: USER, rules: [] }, 'what is inside it was not read'],
    ]
    for (const [name, bad, detail] of cases) {
      const out = await secureFoldersWindows(DIRS, answer([folder(DIRS[0], [inherits('.claude.json')]), folder(DIRS[1], [inherits('.credentials.json'), bad]), folder(DIRS[2], [])]))
      expect(out.map((r) => [r.ok, r.detail]), name).toEqual([[true, 'owner-only'], [false, detail], [true, 'owner-only']])
    }
  })

  it('an answer that does not say what is inside, or says it could not be read or made owner-only, is never a pass', async () => {
    const shapes: Array<[string, unknown, string]> = [
      ['no read of what is inside (an answer of the earlier shape)', { dir: DIRS[0], error: null, owner: USER, protected: true, rules: [rule1(USER), rule1(OWNER_ONLY_SYSTEM_SID)] }, 'what is inside it was not read'],
      ['what is inside could not be made owner-only', folder(DIRS[0], [], 'what is inside it could not be made owner-only'), 'what is inside it could not be made owner-only'],
      ['an error with a list', folder(DIRS[0], [inherits('.claude.json')], 'anything'), 'what is inside it could not be made owner-only'],
      ['an entry that is not an object', folder(DIRS[0], ['x']), 'what is inside it was not read'],
    ]
    for (const [name, read, detail] of shapes) {
      const out = await secureFoldersWindows([DIRS[0]], answer([read]))
      expect(out.map((r) => [r.ok, r.detail, r.unread]), name).toEqual([[false, detail, undefined]])
    }
    // A single entry printed as one object (not a list) is still read.
    expect((await secureFoldersWindows([DIRS[0]], answer([folder(DIRS[0], inherits('.claude.json'))])))[0]).toMatchObject({ ok: true })
    expect((await secureFoldersWindows([DIRS[0]], answer([folder(DIRS[0], keptGroupRead('.claude.json'))])))[0]).toMatchObject({ ok: false })
  })

  it('a folder whose own read is refused keeps that reason', async () => {
    const out = await secureFoldersWindows([DIRS[0]], answer([{ ...folder(DIRS[0], [keptGroupRead('.claude.json')]), protected: false }]))
    expect(out[0]).toMatchObject({ ok: false, detail: 'it inherits rights from above' })
  })
})

describe('the verdict on what is inside (ownerOnlyInsideVerdict)', () => {
  it('judges the read as the folder\'s answer carries it', () => {
    const verdict = rule.ownerOnlyInsideVerdict
    expect(verdict({ inside: [inherits('a')] }, USER)).toEqual({ ok: true, detail: 'owner-only' })
    expect(verdict({ inside: [] }, USER)).toEqual({ ok: true, detail: 'owner-only' })
    expect(verdict({ inside: [keptGroupRead('a')] }, USER)).toEqual({ ok: false, detail: 'an entry inside it is not owner-only' })
    expect(verdict({ inside: [inherits('a')] }, '')).toMatchObject({ ok: false })
    expect(verdict(undefined, USER)).toMatchObject({ ok: false })
    expect(verdict({}, USER)).toEqual({ ok: false, detail: 'what is inside it was not read' })
    // The reasons it gives are the ones the app logs in its own words.
    for (const r of rule.OWNER_ONLY_INSIDE_REASONS) expect(r).not.toMatch(/[\\/:]|S-1-/)
  })
})

describe('the script: the owner and the rights written separately, then what is inside read and put right', () => {
  const lines = OWNER_ONLY_SCRIPT.split('\n')
  const at = (needle: string) => { const i = lines.findIndex((l) => l.includes(needle)); expect(i, needle).toBeGreaterThan(-1); return i }

  it('writes the folder\'s owner alone first, then its rights alone (no owner in that write)', () => {
    const ownerWrite = at('[IO.Directory]::SetAccessControl($d, $o)')
    expect(at('$o.SetOwner($user)')).toBeLessThan(ownerWrite)
    const rightsWrite = at('[IO.Directory]::SetAccessControl($d, $s)')
    expect(ownerWrite).toBeLessThan(rightsWrite)
    expect(lines.slice(ownerWrite + 1, rightsWrite).join('\n')).not.toMatch(/SetOwner/)
    expect(OWNER_ONLY_SCRIPT).not.toMatch(/\$s\.SetOwner/)
  })

  it('reads what is inside only once the folder itself was read back, never going through a link, leaving the call\'s own folders to their turn', () => {
    const walk = at('EnumerateFileSystemInfos()')
    expect(at('$done[$d] = $true')).toBeLessThan(walk)
    const linkCheck = lines.findIndex((l, i) => i > walk && l.includes('-band $reparse'))
    const firstRead = lines.findIndex((l, i) => i > walk && l.includes('GetAccessControl($p'))
    expect(linkCheck).toBeGreaterThan(walk)
    expect(linkCheck).toBeLessThan(firstRead)
    // A link is passed over (only noted, when it is a link to a file or directly inside) before anything reads it.
    expect(lines[linkCheck + 2]).toMatch(/^\s*continue$/)
    expect(at('if ($asked.ContainsKey($p)) { continue }')).toBeLessThan(linkCheck)
    // Only a real folder this user or the Administrators group owns is gone into.
    expect(OWNER_ONLY_SCRIPT).toContain('if ($isDir -and $okOwner.ContainsKey($own)) { $todo.Push($p) }')
  })

  it('puts right only an entry this user or the Administrators group owns: its own entries removed, inheritance on, the rights alone written, then read again', () => {
    const fix = at('if (-not $ok -and $okOwner.ContainsKey($own)) {')
    const body = lines.slice(fix, fix + 9).join('\n')
    expect(body).toMatch(/GetAccessControl\(\$p, \$rightsOnly\)/)
    expect(body).toMatch(/RemoveAccessRuleSpecific/)
    expect(body).toMatch(/SetAccessRuleProtection\(\$false, \$false\)/)
    expect(body).toMatch(/SetAccessControl\(\$p, \$t\)/)
    expect(body).toMatch(/GetAccessControl\(\$p, \$both\)/)
    expect(body).not.toMatch(/SetOwner/)
    expect(OWNER_ONLY_SCRIPT).toContain("$rightsOnly = [Security.AccessControl.AccessControlSections]'Access'")
  })

  it('a failure inside is that folder\'s alone, in fixed words', () => {
    expect(OWNER_ONLY_SCRIPT).toContain("$r.insideError = 'what is inside it could not be made owner-only'")
  })
})

describe('the rule with Windows\' own programs sets the rights without the restore privilege', () => {
  it('inheritance off, the user and SYSTEM granted, every other account\'s own entry removed by SID, on the folder itself', () => {
    const args = rule.nativeRightsArgs('C:\\p\\a', USER, `O:BAG:SYD:AI(A;;FR;;;${OTHER})(D;;0x100116;;;BG)(A;OICI;FA;;;BA)(A;;FA;;;${USER})(A;OICIID;FA;;;WD)(A;OICIID;FA;;;SY)`)
    expect(args).toEqual(['C:\\p\\a', '/inheritance:r', '/grant:r', `*${USER}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/remove', `*${OTHER}`, '*S-1-5-32-546', '*S-1-5-32-544', '/L'])
    expect(args).not.toContain('/restore')
    // Nothing of its own to remove: no /remove.
    expect(rule.nativeRightsArgs('C:\\p\\a', USER, 'O:BAG:SYD:AI(A;OICIID;FA;;;WD)')).toEqual(['C:\\p\\a', '/inheritance:r', '/grant:r', `*${USER}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/L'])
    expect(rule.nativeRightsArgs('C:\\p\\a', USER, null)).toEqual(['C:\\p\\a', '/inheritance:r', '/grant:r', `*${USER}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/L'])
  })

  it('the read of what is inside uses only what Constrained Language Mode allows, never recursing on its own or going through a link', () => {
    const s = rule.OWNER_ONLY_INSIDE_SCRIPT
    expect(s).toMatch(/Get-ChildItem -LiteralPath \$at\.path -Force/)
    expect(s).toMatch(/\(Get-Acl -LiteralPath \$p\)\.Sddl/)
    expect(s).toMatch(/\$attributes -band 0x400/)
    expect(s).not.toMatch(/-Recurse|New-Object|\.GetAccessControl|::|pscustomobject|\[ordered\]|\/T\b/)
    // Names come back as numbers (ASCII whatever the language).
    expect(s).toMatch(/name = \[int\[\]\]\[char\[\]\]\$rel/)
  })
})
