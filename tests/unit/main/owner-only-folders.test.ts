// P3.10 round 4 (P1, P2): folders made this user's and owner-only off the main
// thread, and read back before use. On Windows one Windows PowerShell call
// (started asynchronously from the system folder by its full path) makes each
// missing folder inside the one before it, sets its owner to the user and its
// rights to the user and SYSTEM with inheritance off, and reads owner and
// rights back by SID; the app uses a folder only when that read holds exactly
// the user and SYSTEM (the Administrators group accepted), owned by the user,
// inheritance off. No process starts here: the runner is injected, and
// child_process is replaced for the runner's own case. The real resulting
// rights are owner-only-folders-real.test.ts (CI and the VM).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const started: Array<{ file: string; args: string[]; opts: { env?: Record<string, string | undefined>; timeout?: number; windowsHide?: boolean } }> = []
let answer: { err: Error | null; stdout: string } = { err: null, stdout: '' }
const syncCalls: string[] = []
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    execFile: vi.fn((file: string, args: string[], opts: never, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      started.push({ file, args, opts })
      cb(answer.err, answer.stdout, '')
    }),
    execFileSync: vi.fn((file: string) => { syncCalls.push(file); return '' }),
  }
})

import {
  ownerOnlyVerdict, secureFoldersWindows, secureFoldersPosix, runWindowsPowerShell,
  OWNER_ONLY_DIRS_ENV, OWNER_ONLY_SYSTEM_SID, OWNER_ONLY_ADMINISTRATORS_SID,
} from '../../../src/main/owner-only-folders'

const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const FULL = 2032127
/** ReadAndExecute, Synchronize; and a local group of this machine (synthetic). */
const READ_EXECUTE = 1179817
const LOCAL_GROUP = 'S-1-5-21-1111111111-2222222222-3333333333-1005'
const CI_OI = 3
const rule = (sid: string, extra: Partial<{ rights: number; allow: boolean; inherited: boolean; flags: number }> = {}) =>
  ({ sid, rights: FULL, allow: true, inherited: false, flags: CI_OI, ...extra })
const good = (dir: string) => ({ dir, error: null, owner: USER, protected: true, rules: [rule(USER), rule(OWNER_ONLY_SYSTEM_SID)] })

beforeEach(() => {
  started.length = 0
  syncCalls.length = 0
  answer = { err: null, stdout: '' }
})

describe('ownerOnlyVerdict: exactly the user and SYSTEM (Administrators accepted), owned by the user, inheritance off', () => {
  it('passes the owner-only read, with or without the Administrators group', () => {
    expect(ownerOnlyVerdict(good('C:\\a'), USER).ok).toBe(true)
    expect(ownerOnlyVerdict({ ...good('C:\\a'), rules: [rule(USER), rule(OWNER_ONLY_SYSTEM_SID), rule(OWNER_ONLY_ADMINISTRATORS_SID)] }, USER).ok).toBe(true)
  })

  it('refuses any other shape', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['an error', { ...good('C:\\a'), error: 'link' }],
      ['another owner', { ...good('C:\\a'), owner: OWNER_ONLY_ADMINISTRATORS_SID }],
      ['no owner read', { ...good('C:\\a'), owner: null }],
      ['inheritance on', { ...good('C:\\a'), protected: false }],
      ['an inherited entry', { ...good('C:\\a'), rules: [rule(USER), rule(OWNER_ONLY_SYSTEM_SID, { inherited: true })] }],
      ['another principal', { ...good('C:\\a'), rules: [rule(USER), rule(OWNER_ONLY_SYSTEM_SID), rule('S-1-1-0')] }],
      ['another local group, inherited, with read rights', { ...good('C:\\a'), rules: [rule(USER), rule(OWNER_ONLY_SYSTEM_SID), rule(LOCAL_GROUP, { rights: READ_EXECUTE, inherited: true })] }],
      ['another local group, its own entry, with read rights', { ...good('C:\\a'), rules: [rule(USER), rule(OWNER_ONLY_SYSTEM_SID), rule(LOCAL_GROUP, { rights: READ_EXECUTE })] }],
      ['a deny entry', { ...good('C:\\a'), rules: [rule(USER), rule(OWNER_ONLY_SYSTEM_SID), rule(USER, { allow: false })] }],
      ['no SYSTEM', { ...good('C:\\a'), rules: [rule(USER)] }],
      ['the user without full control', { ...good('C:\\a'), rules: [rule(USER, { rights: 1179817 }), rule(OWNER_ONLY_SYSTEM_SID)] }],
      ['the user not inherited by what is inside', { ...good('C:\\a'), rules: [rule(USER, { flags: 0 }), rule(OWNER_ONLY_SYSTEM_SID)] }],
      ['no rules', { ...good('C:\\a'), rules: [] }],
      ['rules not a list', { ...good('C:\\a'), rules: 'x' }],
    ]
    for (const [name, read] of cases) expect(ownerOnlyVerdict(read as never, USER).ok, name).toBe(false)
    expect(ownerOnlyVerdict(good('C:\\a'), '').ok).toBe(false)
    expect(ownerOnlyVerdict(undefined, USER).ok).toBe(false)
  })
})

// The read is compared by full SID, whatever account the user is: the
// built-in Administrator (RID 500, which SDDL writes as LA; CI's runner
// account) passes as any user does, and an SDDL abbreviation or an account
// name in place of a SID is never taken for the user, SYSTEM or the
// Administrators group.
describe('owner-only reads compare full SIDs, never names or SDDL abbreviations', () => {
  const ADMIN_500 = 'S-1-5-21-1111111111-2222222222-3333333333-500'
  const asRead = (owner: string, sids: string[]) => ({ dir: 'C:\\a', error: null, owner, protected: true, rules: sids.map((s) => rule(s)) })

  it('the built-in Administrator passes as any user', async () => {
    const out = await secureFoldersWindows(['C:\\Data\\hooks'], async () => JSON.stringify({ user: ADMIN_500, folders: [asRead(ADMIN_500, [ADMIN_500, OWNER_ONLY_SYSTEM_SID])] }))
    expect(out.map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only']])
  })

  it('an abbreviation or a name where a SID belongs is refused', () => {
    const cases: Array<[string, string, ReturnType<typeof asRead>]> = [
      ['the user as LA', 'LA', asRead('LA', ['LA', OWNER_ONLY_SYSTEM_SID])],
      ['the owner as LA', ADMIN_500, asRead('LA', [ADMIN_500, OWNER_ONLY_SYSTEM_SID])],
      ['the user\'s entry as LA', ADMIN_500, asRead(ADMIN_500, ['LA', OWNER_ONLY_SYSTEM_SID])],
      ['SYSTEM as SY', ADMIN_500, asRead(ADMIN_500, [ADMIN_500, 'SY'])],
      ['an extra SY entry', ADMIN_500, asRead(ADMIN_500, [ADMIN_500, OWNER_ONLY_SYSTEM_SID, 'SY'])],
      ['Administrators as BA', ADMIN_500, asRead(ADMIN_500, [ADMIN_500, OWNER_ONLY_SYSTEM_SID, 'BA'])],
      ['SYSTEM by name', ADMIN_500, asRead(ADMIN_500, [ADMIN_500, 'NT AUTHORITY\\SYSTEM'])],
      ['the user by name', 'WINBOX\\Administrator', asRead('WINBOX\\Administrator', ['WINBOX\\Administrator', OWNER_ONLY_SYSTEM_SID])],
    ]
    for (const [name, user, read] of cases) expect(ownerOnlyVerdict(read, user).ok, name).toBe(false)
  })

  it('the script reads the user, the owner and every entry as SecurityIdentifier values, never names or SDDL', async () => {
    let script = ''
    await secureFoldersWindows(['C:\\x'], async (s) => { script = s; return '' })
    expect(script).toMatch(/\$user = \[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.User\n/)
    expect(script).toMatch(/\$r\.owner = \$a\.GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)\.Value/)
    expect(script).toMatch(/\$a\.GetAccessRules\(\$true, \$true, \[Security\.Principal\.SecurityIdentifier\]\)/)
    expect(script).toMatch(/sid = \$x\.IdentityReference\.Value/)
    expect(script).toMatch(/user = \$user\.Value/)
    expect(script).not.toMatch(/NTAccount|Sddl|Translate/i)
  })
})

describe('secureFoldersWindows: one PowerShell call for every folder, in order', () => {
  it('hands the folders to one call through the environment, never inside the script, and reads each verdict', async () => {
    const dirs = ['C:\\Data\\hooks', 'C:\\Lad\\app-folder', 'C:\\Lad\\app-folder\\copy-abc']
    const calls: Array<{ script: string; env: Record<string, string> }> = []
    const run = async (script: string, env: Record<string, string>) => {
      calls.push({ script, env })
      return JSON.stringify({ user: USER, folders: [good(dirs[0]), { ...good(dirs[1]), rules: [rule(USER), rule(OWNER_ONLY_SYSTEM_SID), rule('S-1-5-11')] }, { dir: dirs[2], error: 'its parent was refused' }] })
    }
    const out = await secureFoldersWindows(dirs, run)
    expect(calls).toHaveLength(1)
    expect(calls[0].env[OWNER_ONLY_DIRS_ENV]).toBe(dirs.join('\n'))
    for (const d of dirs) expect(calls[0].script).not.toContain(d)
    expect(out.map((r) => [r.dir, r.ok])).toEqual([[dirs[0], true], [dirs[1], false], [dirs[2], false]])
    expect(out[1].detail).toMatch(/S-1-5-11/)
    expect(out[2].detail).toMatch(/parent/)
  })

  it('the script makes a missing folder only inside an existing parent, refuses a link, sets the owner and inheritance-off rights, then reads them back by SID', async () => {
    let script = ''
    await secureFoldersWindows(['C:\\x'], async (s) => { script = s; return '' })
    expect(script).toMatch(/ReparsePoint/)
    expect(script).toMatch(/CreateDirectory/)
    expect(script).toMatch(/SetOwner\(\$user\)/)
    expect(script).toMatch(/SetAccessRuleProtection\(\$true, \$false\)/)
    expect(script).toMatch(/S-1-5-18/)
    expect(script).toMatch(/SetAccessControl/)
    expect(script).toMatch(/GetAccessControl/)
    expect(script).toMatch(/SecurityIdentifier/)
    // A folder is made or changed only once its parent passed in this same call,
    // and that parent is still not a link.
    expect(script.indexOf('GetDirectoryName')).toBeLessThan(script.indexOf('CreateDirectory'))
    expect(script).toMatch(/\$failed\.ContainsKey\(\$parent\)/)
    expect(script).toMatch(/\$done\.ContainsKey\(\$parent\) -and \(\(\[IO\.File\]::GetAttributes\(\$parent\) -band \$reparse\) -ne 0\)/)
    expect(script.indexOf('$done.ContainsKey($parent)')).toBeLessThan(script.indexOf('CreateDirectory'))
  })

  it('a failed or unreadable call leaves every folder refused; nothing is sent for an empty list or a folder that cannot be named safely', async () => {
    const dirs = ['C:\\a', 'C:\\a\\b']
    for (const run of [async () => { throw new Error('timed out') }, async () => 'not json', async () => JSON.stringify({ user: USER })]) {
      const out = await secureFoldersWindows(dirs, run)
      expect(out.map((r) => r.ok)).toEqual([false, false])
    }
    let n = 0
    expect(await secureFoldersWindows([], async () => { n++; return '' })).toEqual([])
    let sentLines: string[] = []
    const bad = await secureFoldersWindows(['relative\\x', 'C:\\a' + String.fromCharCode(10) + 'b', 'C:\\ok'], async (_s, env) => {
      n++
      sentLines = env[OWNER_ONLY_DIRS_ENV].split('\n')
      return JSON.stringify({ user: USER, folders: sentLines.map(good) })
    })
    expect(bad.map((r) => r.ok)).toEqual([false, false, true])
    expect(n).toBe(1)
    // Only the folder that can be named safely reaches the script: one line each.
    expect(sentLines).toEqual(['C:\\ok'])
  })

  it('a single folder read back as one object (not a list) still counts', async () => {
    const out = await secureFoldersWindows(['C:\\a'], async () => JSON.stringify({ user: USER, folders: good('C:\\a') }))
    expect(out.map((r) => r.ok)).toEqual([true])
  })
})

// Round 5 (G1, G2): any Unicode folder name makes the round trip exactly: the
// folders reach the script whole through the environment, the script writes
// its answer in ASCII only (every other character escaped), and each answer
// is matched to its folder by its place in the call. A folder whose name ends
// in a dot or a space (which Windows reads as another folder) is refused.
describe('secureFoldersWindows: any Unicode folder name (round 5)', () => {
  const U = (c: number) => String.fromCharCode(c)
  const NAMES: Array<[string, string]> = [
    ['e acute', 'caf' + U(0xe9)],
    ['CJK', U(0x4e2d) + U(0x6587)],
    ['emoji (a surrogate pair)', String.fromCodePoint(0x1f600)],
    ['U+2018 and U+2019', U(0x2018) + 'x' + U(0x2019)],
    ['U+201A and U+201B', U(0x201a) + 'x' + U(0x201b)],
    ['U+201C and U+201D', U(0x201c) + 'x' + U(0x201d)],
    ['U+201E', U(0x201e) + 'x'],
    ['U+0085', 'nel' + U(0x85) + 'next'],
    ['U+2028', 'ls' + U(0x2028) + 'next'],
    ['apostrophe', "o'brien"],
    ['spaces', 'a b  c'],
    ['brackets and braces', 'w[ab]{0}'],
    ['percent, hash, tilde, bang', 'p%x%#h~t!b'],
    // Gate 3 (spec item 1, F1): the rest of the ASCII set the round-5 verifier
    // used, each a literal folder name: what PowerShell would read as a
    // variable, a subexpression, a statement break, an escape, a call, an
    // array, a quote break, a wildcard range or a parameter.
    ['semicolon', 'sem;i'],
    ['dollar variables', 'dollar$pwd$HOME'],
    ['dollar subexpression', 'sub$(x)'],
    ['backtick escape', 'tick`n'],
    ['ampersand call', 'amp&(x)'],
    ['quote break', "'+(x)+'"],
    ['wildcard range', 'rng[a-z]x'],
    ['array subexpression', 'at@(x)'],
    ['a leading dash', '-Recurse'],
  ]
  /** An answer as the script writes it: JSON with every character past ASCII escaped. */
  const asciiJson = (v: unknown): string => JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))

  it('each name reaches the script whole, and its answer counts for it', async () => {
    for (const [label, name] of NAMES) {
      const dir = 'C:\\t\\' + name
      let got = ''
      const out = await secureFoldersWindows([dir], async (_s, env) => {
        got = env[OWNER_ONLY_DIRS_ENV]
        return asciiJson({ user: USER, folders: [good(got)] })
      })
      expect(got, label).toBe(dir)
      expect(out.map((r) => [r.dir, r.ok]), label).toEqual([[dir, true]])
    }
  })

  it('answers are matched to folders by their place in the call, never by the text that comes back', async () => {
    const dirs = ['C:\\t\\caf' + U(0xe9), 'C:\\t\\' + U(0x4e2d)]
    const out = await secureFoldersWindows(dirs, async () => JSON.stringify({ user: USER, folders: [good('C:\\t\\caf?'), good('C:\\t\\?')] }))
    expect(out.map((r) => r.ok)).toEqual([true, true])
    // An answer whose count is not what was asked: nothing counts.
    const short = await secureFoldersWindows(dirs, async () => JSON.stringify({ user: USER, folders: [good(dirs[0])] }))
    expect(short.map((r) => r.ok)).toEqual([false, false])
    // Nor one with more entries than folders asked for.
    const long = await secureFoldersWindows(dirs, async () => JSON.stringify({ user: USER, folders: [good(dirs[0]), good(dirs[1]), good('C:\\t\\other')] }))
    expect(long.map((r) => [r.ok, r.detail])).toEqual([[false, 'the answer does not match what was asked'], [false, 'the answer does not match what was asked']])
  })

  it('the script writes its answer in ASCII only, every other character escaped', async () => {
    let script = ''
    await secureFoldersWindows(['C:\\x'], async (s) => { script = s; return '' })
    expect(script).toMatch(/ConvertTo-Json -Compress -Depth 6/)
    expect(script).toMatch(/-gt 126/)
    expect(script).toMatch(/ToString\('x4'\)/)
    expect(script.indexOf('ConvertTo-Json')).toBeLessThan(script.indexOf('-gt 126'))
    // What it writes is the escaped text, nothing else.
    expect(script.trim().split('\n').at(-1)).toBe('$sb.ToString()')
  })

  it('refuses a folder whose name ends in a dot or a space; nothing of it reaches the script', async () => {
    const bad = ['C:\\a.\\b', 'C:\\a \\b', 'C:\\a\\b.', 'C:\\a\\b ', 'C:\\a\\..\\b', 'C:\\a\\.\\b', '\\\\server\\share.\\b']
    let sent: string[] = []
    const out = await secureFoldersWindows([...bad, 'C:\\ok', '\\\\server\\share\\ok'], async (_s, env) => {
      sent = env[OWNER_ONLY_DIRS_ENV].split('\n')
      return JSON.stringify({ user: USER, folders: sent.map(good) })
    })
    expect(out.map((r) => r.ok)).toEqual([...bad.map(() => false), true, true])
    expect(sent).toEqual(['C:\\ok', '\\\\server\\share\\ok'])
    for (const r of out.slice(0, bad.length)) expect(r.detail, r.dir).toMatch(/ends in a dot or a space/)
  })
})

describe('runWindowsPowerShell: asynchronous, from the system folder by its full path', () => {
  it('starts Windows PowerShell with execFile (never the synchronous form), no profile, the extra variables added', async () => {
    answer = { err: null, stdout: 'out' }
    await expect(runWindowsPowerShell('$x', { A_VAR: 'v' })).resolves.toBe('out')
    expect(started).toHaveLength(1)
    expect(started[0].file).toMatch(/^[A-Za-z]:\\(?:[^\\]+\\)*System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
    expect(started[0].args.slice(0, 3)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive'])
    expect(started[0].args.at(-1)).toBe('$x')
    expect(started[0].opts.env?.A_VAR).toBe('v')
    expect(started[0].opts.windowsHide).toBe(true)
    expect(started[0].opts.timeout).toBeGreaterThan(0)
    expect(syncCalls).toEqual([])
    answer = { err: new Error('failed'), stdout: '' }
    await expect(runWindowsPowerShell('$x', {})).rejects.toThrow()
  })
})

describe.runIf(process.platform !== 'win32')('secureFoldersPosix: 0700 and the user\'s own, in order', () => {
  const PREFIX = 'p310r4-owner-only-'
  it('makes each missing folder inside the one before it, owner-only; refuses a link and what is below a refused folder', async () => {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
    try {
      const a = path.join(top, 'a')
      const b = path.join(a, 'b')
      const out = await secureFoldersPosix([a, b])
      expect(out.map((r) => r.ok)).toEqual([true, true])
      expect(fs.statSync(b).mode & 0o777).toBe(0o700)
      fs.symlinkSync(a, path.join(top, 'l'))
      const linked = await secureFoldersPosix([path.join(top, 'l'), path.join(top, 'l', 'c')])
      expect(linked.map((r) => r.ok)).toEqual([false, false])
      expect(fs.existsSync(path.join(a, 'c'))).toBe(false)
    } finally {
      // TEST CLEANUP GUARD: the suite's own folder only.
      if (path.basename(top).startsWith(PREFIX) && path.dirname(top) === os.tmpdir()) fs.rmSync(top, { recursive: true, force: true })
    }
  })
})
