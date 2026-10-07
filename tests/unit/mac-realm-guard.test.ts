// @vitest-environment node
//
// Decision aicc_planning#172 item 4 (2026-10-07): a NON-primary macOS realm
// launch is refused unless `claude auth status`, run under that realm's own
// environment, reports the realm folder as its configDirectory.
//
//  - realmVerdictFromAuthStatus: the pure compare;
//  - the SYNCHRONOUS gate in withProfileHome / profileRealmLaunch: every
//    launch context refuses without a positive verdict (fail closed for a
//    caller that never asked), except the verdict probe itself;
//  - the async check (mac-realm-guard): probes under the realm env, caches a
//    positive verdict per (folder, CLI path, CLI file identity), re-probes on
//    a CLI change, refuses on mismatch / missing field / no JSON, refuses
//    retryably on a timeout or a probe that could not start;
//  - every launch path awaits the check before its choke point (source scan).
// The CLI is never run: the probe runner and the CLI resolver are seams.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { composeProviders } from '../../src/main/providers/compose'
import { buildClaudeLaunchCommand } from '../../src/main/spawn-claude-command'
import { realmShellPinLines, shellOnlyOpeningLines } from '../../src/main/mac-realm-shell'
import {
  _resetMacRealmVerdictsForTest, ensureMacRealmVerdict, macRealmVerdictPending, hasMacRealmVerdict,
  MAC_REALM_UNVERIFIED, MAC_REALM_NOT_ISOLATED, CLI_RESOLVE_TTL_MS, setMacRealmVerdictHooks,
  macRealmLaunchBinary, macRealmExecutableRefusal, MAC_REALM_UNSAFE_PATH,
} from '../../src/main/mac-realm-verdict'
import {
  installMacRealmGuard, _setMacRealmGuardSeamsForTest, realmVerdictFromAuthStatus, macRealmCheckRetryable,
  MAC_REALM_UNREADABLE, _settleBackgroundResolveForTest,
  type RealmProbeResult,
} from '../../src/main/mac-realm-guard'

describe('realmVerdictFromAuthStatus (pure)', () => {
  const dir = path.resolve('/Users/someone/res/account-profiles/p1/.claude').normalize('NFC')
  const out = (o: unknown) => JSON.stringify(o)
  it('isolated only when configDirectory is the realm folder (normalised the same way)', () => {
    expect(realmVerdictFromAuthStatus(out({ loggedIn: true, configDirectory: dir, projectsDirectory: `${dir}/projects` }), dir)).toBe('isolated')
    expect(realmVerdictFromAuthStatus(out({ configDirectory: `${dir}${path.sep}` }), dir)).toBe('isolated')
    expect(realmVerdictFromAuthStatus(`some banner\n${out({ configDirectory: dir })}\n`, dir)).toBe('isolated')
  })
  it('not isolated: another folder (the real ~/.claude), missing field, relative', () => {
    expect(realmVerdictFromAuthStatus(out({ configDirectory: path.resolve('/Users/someone/.claude') }), dir)).toBe('not-isolated')
    expect(realmVerdictFromAuthStatus(out({ loggedIn: true }), dir)).toBe('not-isolated')
    expect(realmVerdictFromAuthStatus(out({ configDirectory: 'relative/.claude' }), dir)).toBe('not-isolated')
  })

  // Re-attack r3, MINOR 4: no JSON object at all is UNREADABLE (its own
  // message), not "does not isolate".
  it('r3 MINOR 4: unreadable when there is no JSON object at all', () => {
    expect(realmVerdictFromAuthStatus('{not json', dir)).toBe('unreadable')
    expect(realmVerdictFromAuthStatus('', dir)).toBe('unreadable')
    expect(realmVerdictFromAuthStatus(out([dir]), dir)).toBe('unreadable')
    expect(realmVerdictFromAuthStatus('error: unknown command auth', dir)).toBe('unreadable')
  })

  it('r3 MINOR 4: a warning line with a brace before the JSON, trailing text after it, or pretty-printed JSON still reads', () => {
    expect(realmVerdictFromAuthStatus(`warning: {deprecated} option\n${out({ configDirectory: dir })}\nsee docs {here}\n`, dir)).toBe('isolated')
    expect(realmVerdictFromAuthStatus(`{ not json at all\n${JSON.stringify({ loggedIn: false, configDirectory: dir }, null, 2)}\ntrailing note`, dir)).toBe('isolated')
    // The LAST object carrying the field decides.
    expect(realmVerdictFromAuthStatus(`{"configDirectory":"/Users/someone/.claude"}\n${out({ configDirectory: dir })}`, dir)).toBe('isolated')
  })
})

describe('the macOS realm launch guard', () => {
  let tmp = ''
  let P: typeof import('../../src/main/account-profiles')
  const realPlatform = process.platform
  let flag = true
  const asPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: p })
  let probes: Array<{ file: string; args: readonly string[]; env: Record<string, string> }> = []
  let answer: (env: Record<string, string>) => RealmProbeResult = () => ({ code: 0, stdout: '{}', timedOut: false })
  let cliPath = ''
  let resolves = 0
  let now = 1_000_000

  beforeAll(async () => {
    composeProviders()
    P = await import('../../src/main/account-profiles')
  })
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-realm-guard-'))
    P._setRootsForTest({ resourcesDir: path.join(tmp, 'resources'), sharedRoot: path.join(tmp, 'realhome', '.claude') })
    fs.mkdirSync(path.join(tmp, 'resources'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'realhome', '.claude'), { recursive: true })
    flag = true
    P.setMacMultiAccountProbe(() => flag)
    now = 1_000_000
    _resetMacRealmVerdictsForTest(() => now)
    cliPath = path.join(tmp, 'bin', 'claude')
    fs.mkdirSync(path.dirname(cliPath), { recursive: true })
    fs.writeFileSync(cliPath, 'v1')
    probes = []
    resolves = 0
    // The real CLI reports the folder it was told to use.
    answer = (env) => ({ code: 0, stdout: JSON.stringify({ loggedIn: false, configDirectory: env.CLAUDE_CONFIG_DIR ?? path.join(tmp, 'realhome', '.claude') }), timedOut: false })
    _setMacRealmGuardSeamsForTest({
      runner: async (file, args, opts) => { probes.push({ file, args, env: { ...opts.env } }); return answer(opts.env) },
      resolveCli: async () => { resolves++; return cliPath },
    })
    installMacRealmGuard()
  })
  afterEach(() => {
    asPlatform(realPlatform)
    P.setMacMultiAccountProbe(() => false)
    P._setRootsForTest(null)
    _setMacRealmGuardSeamsForTest({ runner: null, resolveCli: null })
    setMacRealmVerdictHooks(null)
    _resetMacRealmVerdictsForTest()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  function setup() {
    const primary = P.createProfile('Primary')
    const other = P.createProfile('Other')
    P.setPrimaryProfile(primary.id)
    const otherHome = P.getProfileConfigDir(other.id)
    return { primary, other, otherHome, primaryHome: P.getProfileConfigDir(primary.id), dir: path.resolve(otherHome, '.claude').normalize('NFC') }
  }
  const refusal = (fn: () => unknown): string => { try { fn(); return '' } catch (e) { return String((e as Error).message) } }

  // ---- the synchronous gate: fail closed --------------------------------------

  it('without a verdict, EVERY launch context refuses a realm launch; only the verdict probe itself is exempt', () => {
    const { other, otherHome } = setup()
    asPlatform('darwin')
    const contexts = [
      undefined,
      { launchId: 'session-1', probe: false, projectGate: null },             // pty / insights / cloud agent shape
      { launchId: 'headless', probe: true, projectGate: null },               // headless + the auth-status probe carry probe:true
      { launchId: 'session-2', probe: false, projectGate: null, pinnedCli: { version: '2.0.1', installed: true } },
    ]
    for (const c of contexts) {
      const m = refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome, c as never))
      expect(m, JSON.stringify(c)).toContain(P.MANAGED_LAUNCH_REFUSAL)
    }
    expect(refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome))).toContain(MAC_REALM_UNVERIFIED)
    expect(refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome, { launchId: 'p', probe: true, projectGate: null, pinnedCli: { version: '2.0.1', installed: false } }))).toMatch(/pinned Claude Code version that is not installed/)
    // The reviewer's launch.
    expect(P.profileRealmLaunch(other.id, { PATH: '/x' })).toEqual({ refused: MAC_REALM_UNVERIFIED })
    // The verdict probe itself is not refused (it is what produces the verdict).
    expect(refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome, { launchId: 'realm-verdict', probe: true, projectGate: null, realmVerdictProbe: true }))).toBe('')
  })

  it('the primary, the setting off (primary), win32 and linux: no verdict needed', () => {
    const { otherHome, primaryHome } = setup()
    asPlatform('darwin')
    expect(refusal(() => P.withProfileHome({ PATH: '/x' }, primaryHome))).toBe('')
    for (const p of ['win32', 'linux'] as const) {
      asPlatform(p)
      expect(refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome))).toBe('')
      expect(macRealmVerdictPending(otherHome)).toBe(false)
    }
  })

  // ---- the async check -------------------------------------------------------

  it('probes `claude auth status` with the resolved CLI under the SAME realm env; a matching folder is cached; the launch then passes', async () => {
    const { otherHome, dir } = setup()
    asPlatform('darwin')
    expect(macRealmVerdictPending(otherHome)).toBe(true)
    await ensureMacRealmVerdict(otherHome)
    expect(probes).toHaveLength(1)
    expect(probes[0].file).toBe(cliPath)
    expect(probes[0].args).toEqual(['auth', 'status'])
    expect(probes[0].env.CLAUDE_CONFIG_DIR).toBe(dir)
    expect(probes[0].env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(dir)
    expect(hasMacRealmVerdict(dir)).toBe(true)
    expect(refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome, { launchId: 's', probe: false, projectGate: null }))).toBe('')
    // Cached: the next launch does not probe again, or re-resolve the CLI.
    await ensureMacRealmVerdict(otherHome)
    expect(probes).toHaveLength(1)
    expect(resolves).toBe(1)
  })

  it('the CLI binary changes (an update in place): the verdict is dropped and the check runs again', async () => {
    const { otherHome, dir } = setup()
    asPlatform('darwin')
    await ensureMacRealmVerdict(otherHome)
    fs.writeFileSync(cliPath, 'v2 -- a different, longer binary')
    expect(hasMacRealmVerdict(dir)).toBe(false)
    expect(refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome))).toContain(P.MANAGED_LAUNCH_REFUSAL)
    await ensureMacRealmVerdict(otherHome)
    expect(probes).toHaveLength(2)
    expect(hasMacRealmVerdict(dir)).toBe(true)
  })

  it('the CLI is re-resolved after the TTL (in the background); a PATH that now finds another claude is checked on the next launch', async () => {
    const { otherHome, dir } = setup()
    asPlatform('darwin')
    await ensureMacRealmVerdict(otherHome)
    now += CLI_RESOLVE_TTL_MS + 1
    expect(hasMacRealmVerdict(dir)).toBe(false)
    const other2 = path.join(tmp, 'bin2', 'claude')
    fs.mkdirSync(path.dirname(other2), { recursive: true })
    fs.writeFileSync(other2, 'another')
    cliPath = other2
    // This launch keeps the unchanged previous binary (no wait on the lookup)...
    await ensureMacRealmVerdict(otherHome)
    expect(hasMacRealmVerdict(dir)).toBe(true)
    await _settleBackgroundResolveForTest()
    expect(resolves).toBe(2)
    // ...and the next one checks the binary the lookup now finds.
    await ensureMacRealmVerdict(otherHome)
    expect(probes.map((p) => p.file)).toEqual([path.join(tmp, 'bin', 'claude'), other2])
  })

  // Re-attack r3, MINOR 2: a lookup that fails after the TTL must not refuse
  // an unchanged CLI.
  it('r3 MINOR 2: after the TTL a failed CLI lookup keeps the previous, unchanged binary -- no refusal', async () => {
    const { otherHome, dir } = setup()
    asPlatform('darwin')
    await ensureMacRealmVerdict(otherHome)
    now += CLI_RESOLVE_TTL_MS + 1
    _setMacRealmGuardSeamsForTest({ resolveCli: async () => { resolves++; return null } })
    await ensureMacRealmVerdict(otherHome)
    await _settleBackgroundResolveForTest()
    expect(hasMacRealmVerdict(dir)).toBe(true)
    expect(refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome))).toBe('')
    // A CHANGED binary is not kept: then the lookup decides.
    fs.writeFileSync(cliPath, 'v2 changed, longer')
    now += CLI_RESOLVE_TTL_MS + 1
    await ensureMacRealmVerdict(otherHome)
    expect(refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome))).toMatch(/Claude Code was not found/)
  })

  // Re-attack r3, MINOR 3: within 30 s of the TTL a launch already counts as
  // pending, so the check refreshes it before the choke point reads it.
  it('r3 MINOR 3: within the last 30 s of the TTL the launch is pending and the check refreshes it', async () => {
    const { otherHome, dir } = setup()
    asPlatform('darwin')
    await ensureMacRealmVerdict(otherHome)
    now += CLI_RESOLVE_TTL_MS - 10_000
    expect(hasMacRealmVerdict(dir)).toBe(true)
    expect(macRealmVerdictPending(otherHome)).toBe(true)
    await ensureMacRealmVerdict(otherHome)
    now += 20_000 // past the ORIGINAL TTL
    expect(hasMacRealmVerdict(dir)).toBe(true)
  })

  it('a different realm folder gets its own check', async () => {
    const { otherHome } = setup()
    const third = P.createProfile('Third')
    asPlatform('darwin')
    await ensureMacRealmVerdict(otherHome)
    await ensureMacRealmVerdict(P.getProfileConfigDir(third.id))
    expect(probes).toHaveLength(2)
  })

  it('the CLI reports ~/.claude (it ignores CLAUDE_CONFIG_DIR): REFUSED, "update Claude Code"; nothing cached', async () => {
    const { otherHome, dir } = setup()
    asPlatform('darwin')
    answer = () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, configDirectory: path.join(tmp, 'realhome', '.claude') }), timedOut: false })
    await ensureMacRealmVerdict(otherHome)
    expect(hasMacRealmVerdict(dir)).toBe(false)
    const m = refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome))
    expect(m).toContain(P.MANAGED_LAUNCH_REFUSAL)
    expect(m).toContain(MAC_REALM_NOT_ISOLATED)
    expect(MAC_REALM_NOT_ISOLATED).toBe('the installed Claude Code does not keep a separate sign-in per account folder; update Claude Code')
    // Negative answers are not cached: the next launch checks again.
    await ensureMacRealmVerdict(otherHome)
    expect(probes).toHaveLength(2)
  })

  it('missing field: REFUSED (does not isolate); no JSON / non-zero exit without JSON / oversized output: REFUSED as unreadable', async () => {
    const { otherHome } = setup()
    asPlatform('darwin')
    answer = () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true }), timedOut: false })
    await ensureMacRealmVerdict(otherHome)
    expect(refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome))).toContain(MAC_REALM_NOT_ISOLATED)
    for (const a of [
      { code: 1, stdout: 'error: unknown command auth', timedOut: false },
      { code: null, stdout: '', timedOut: false, oversize: true },
    ]) {
      answer = () => a
      await ensureMacRealmVerdict(otherHome)
      const m = refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome))
      expect(m).toContain(MAC_REALM_UNREADABLE)
      expect(m).not.toMatch(/did not answer in time/)
    }
  })

  it('a timeout or a probe that could not start: REFUSED with a retryable message, never run unisolated', async () => {
    const { otherHome } = setup()
    asPlatform('darwin')
    answer = () => ({ code: null, stdout: '', timedOut: true })
    await ensureMacRealmVerdict(otherHome)
    expect(refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome))).toContain(macRealmCheckRetryable('it did not answer in time'))
    answer = () => ({ code: null, stdout: '', timedOut: false, spawnError: 'ENOENT' })
    await ensureMacRealmVerdict(otherHome)
    expect(refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome))).toMatch(/try again/)
    // Recovers once the CLI answers.
    answer = (env) => ({ code: 0, stdout: JSON.stringify({ configDirectory: env.CLAUDE_CONFIG_DIR }), timedOut: false })
    await ensureMacRealmVerdict(otherHome)
    expect(refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome))).toBe('')
  })

  it('no CLI found: refused with "install Claude Code"', async () => {
    const { otherHome } = setup()
    asPlatform('darwin')
    _setMacRealmGuardSeamsForTest({ resolveCli: async () => null })
    await ensureMacRealmVerdict(otherHome)
    expect(probes).toEqual([])
    expect(refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome))).toMatch(/Claude Code was not found/)
  })

  it('overlapping checks of one folder share one probe', async () => {
    const { otherHome } = setup()
    asPlatform('darwin')
    await Promise.all([ensureMacRealmVerdict(otherHome), ensureMacRealmVerdict(otherHome), ensureMacRealmVerdict(otherHome)])
    expect(probes).toHaveLength(1)
  })

  it('a pinned legacy CLI gets its OWN verdict (the binary the launch runs)', async () => {
    const { otherHome, dir } = setup()
    asPlatform('darwin')
    const pinned = path.join(tmp, 'legacy', 'claude')
    fs.mkdirSync(path.dirname(pinned), { recursive: true })
    fs.writeFileSync(pinned, 'legacy')
    await ensureMacRealmVerdict(otherHome)
    expect(hasMacRealmVerdict(dir, pinned)).toBe(false)
    await ensureMacRealmVerdict(otherHome, pinned)
    expect(probes.map((p) => p.file)).toEqual([cliPath, pinned])
    expect(hasMacRealmVerdict(dir, pinned)).toBe(true)
  })

  // ---- re-attack r3, MAJOR 1: the launch runs the VERIFIED binary ---------------

  it('MAJOR 1: a realm launch runs exactly the binary the verdict was taken for; the pinned one when given; none off the realm', async () => {
    const { otherHome, primaryHome } = setup()
    asPlatform('darwin')
    await ensureMacRealmVerdict(otherHome)
    expect(macRealmLaunchBinary(otherHome)).toBe(cliPath)
    expect(macRealmLaunchBinary(otherHome, '/opt/legacy/claude')).toBe('/opt/legacy/claude')
    // The command line the PTY session types: the verified absolute path, single-quoted.
    const line = buildClaudeLaunchCommand({ platform: 'posix', cwd: '/w', claudeBin: macRealmLaunchBinary(otherHome)!, extraFlags: '', agentsFlag: '', useResumePicker: false, pickerScript: null })
    expect(line).toContain(`'${cliPath}'`)
    // Off the realm: nothing -- the launch keeps its bare `claude`.
    expect(macRealmLaunchBinary(primaryHome)).toBeNull()
    for (const p of ['win32', 'linux'] as const) { asPlatform(p); expect(macRealmLaunchBinary(otherHome)).toBeNull() }
  })

  it('MAJOR 1: a verified path with spaces and a quote is quoted so the shell runs that one file', () => {
    const weird = "/Users/a b/it's/claude"
    const line = buildClaudeLaunchCommand({ platform: 'posix', cwd: '/w', claudeBin: weird, extraFlags: '', agentsFlag: '', useResumePicker: false, pickerScript: null })
    expect(line).toContain(`'/Users/a b/it'\\''s/claude'`)
    expect(realmShellPinLines(weird, '/bin/zsh', ['-l'])[1]).toBe(`claude() { '/Users/a b/it'\\''s/claude' "$@"; }`)
  })

  it('MAJOR 1: a realm shell pins its hand-typed `claude` to the verified binary (zsh, bash, an elevated shell); nothing off the realm or for an unknown shell', () => {
    // Re-attack r4, MAJOR 1: SEPARATE lines -- the unalias must be read before
    // the function definition, or an rc alias makes the definition a syntax error.
    expect(realmShellPinLines('/v/claude', '/bin/zsh', ['-l'])).toEqual(['unalias claude 2>/dev/null', `claude() { '/v/claude' "$@"; }`, 'clear'])
    expect(realmShellPinLines('/v/claude', '/bin/bash', ['-l'])).toHaveLength(3)
    expect(realmShellPinLines('/v/claude', 'sudo', ['/bin/zsh', '-l'])).toHaveLength(3)
    expect(realmShellPinLines(null, '/bin/zsh', ['-l'])).toEqual([])
    expect(realmShellPinLines('/v/claude', '/usr/local/bin/fish', ['-l'])).toEqual([])
  })

  // Re-attack r4, MAJOR 1 + MINOR 4: the base cd line is sent FIRST and
  // UNCHANGED; the pin lines are separate writes after it, then the command.
  it('r4: the opening writes are the base cd line, then each pin line, then the first-run command', () => {
    const cd = `cd '/w' 2>/dev/null; clear`
    const pins = realmShellPinLines('/v/claude', '/bin/zsh', ['-l'])
    expect(shellOnlyOpeningLines(cd, pins, 'claude /login')).toEqual([cd, 'unalias claude 2>/dev/null', `claude() { '/v/claude' "$@"; }`, 'clear', 'claude /login'])
    expect(shellOnlyOpeningLines(cd, [], null)).toEqual([cd])
  })

  // Re-attack r4, MINOR 2: a control character in the path never reaches a terminal.
  it('r4 MINOR 2: a binary path with a control character is not pinned, has no verdict, and the check refuses it', async () => {
    for (const bad of ['/v/cl\x15aude', '/v/cl\x03aude', '/v/cl\naude', '/v/cl\x7faude']) expect(realmShellPinLines(bad, '/bin/zsh', ['-l']), JSON.stringify(bad)).toEqual([])
    const { otherHome, dir } = setup()
    asPlatform('darwin')
    expect(hasMacRealmVerdict(dir, '/v/cl\x15aude')).toBe(false)
    _setMacRealmGuardSeamsForTest({ resolveCli: async () => '/v/cl\x15aude' })
    await ensureMacRealmVerdict(otherHome)
    expect(probes).toEqual([])
    const m = refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome))
    expect(m).toContain(P.MANAGED_LAUNCH_REFUSAL)
    expect(m).toContain(MAC_REALM_UNSAFE_PATH)
    await ensureMacRealmVerdict(otherHome, '/v/legacy\x03/claude')
    expect(probes).toEqual([])
  })

  // Re-attack r4, MINOR 3: a bare `claude` a child resolves (Claude's own Bash
  // tool) finds the verified binary: its folder goes first on PATH, composed in
  // the launch base -- realm launches only.
  it('r4 MINOR 3: a realm launch puts the verified binary folder FIRST on PATH; others keep PATH unchanged', async () => {
    const { otherHome, primaryHome } = setup()
    asPlatform('darwin')
    await ensureMacRealmVerdict(otherHome)
    const sep = path.delimiter
    const base = ['/usr/bin', path.dirname(cliPath), '/bin'].join(sep)
    const env = P.withProfileHome({ PATH: base }, otherHome)
    const parts = env.PATH.split(sep)
    expect(parts[0]).toBe(path.dirname(cliPath))
    expect(parts.filter((p) => p === path.dirname(cliPath))).toHaveLength(1) // deduped
    expect(parts).toContain('/usr/bin')
    // The reviewer's launch base too.
    const l = P.profileRealmLaunch(P.listProfiles().find((p) => P.getProfileConfigDir(p.id) === otherHome)!.id, { PATH: base })
    if ('refused' in l) throw new Error(l.refused)
    expect(l.baseEnv.PATH.split(sep)[0]).toBe(path.dirname(cliPath))
    // Off the realm: the base's own composition only (its .local/bin append), never a prepend.
    expect(P.withProfileHome({ PATH: base }, primaryHome).PATH.split(sep)[0]).toBe('/usr/bin')
    for (const p of ['win32', 'linux'] as const) {
      asPlatform(p)
      expect(P.withProfileHome({ PATH: base }, otherHome).PATH.split(sep)[0]).toBe('/usr/bin')
    }
  })

  // Merge with beta 1a5e9de5: the provider-neutral sign-in status and sign-out
  // (WP2 PR 4) run "the executable discovery proved"; on the macOS realm they
  // run the verified binary instead, after the check.
  it('merge: the Claude sign-in status / sign-out run the verified binary on the realm, the discovered one elsewhere', async () => {
    const { otherHome, primaryHome } = setup()
    const { claudeAuthExecutable } = await import('../../src/main/providers/compose')
    const id = (h: string) => P.listProfiles().find((p) => P.getProfileConfigDir(p.id) === h)!.id
    asPlatform('darwin')
    expect(await claudeAuthExecutable(id(otherHome), '/discovered/claude')).toBe(cliPath)
    expect(probes).toHaveLength(1) // the check ran first
    expect(await claudeAuthExecutable(id(primaryHome), '/discovered/claude')).toBe('/discovered/claude')
    asPlatform('linux')
    expect(await claudeAuthExecutable(id(otherHome), '/discovered/claude')).toBe('/discovered/claude')
  })

  it('MAJOR 1: the resume picker runs CCC_CLAUDE_BIN when the app hands it one (absolute only)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const picker = require('../../scripts/resume-picker.js') as { resolveClaudeCmd: (env?: Record<string, string | undefined>) => string }
    expect(picker.resolveClaudeCmd({ CCC_CLAUDE_BIN: '/v/claude' })).toBe('/v/claude')
    expect(picker.resolveClaudeCmd({ CCC_CLAUDE_BIN: 'relative/claude' })).not.toBe('relative/claude')
  })

  it('MAJOR 1: the reviewer refuses an executable that is not the verified file', async () => {
    const { otherHome } = setup()
    asPlatform('darwin')
    await ensureMacRealmVerdict(otherHome)
    expect(macRealmExecutableRefusal(otherHome, cliPath)).toBeNull()
    const other2 = path.join(tmp, 'elsewhere-claude')
    fs.writeFileSync(other2, 'x')
    expect(macRealmExecutableRefusal(otherHome, other2)).toMatch(/not the one checked/)
    asPlatform('linux')
    expect(macRealmExecutableRefusal(otherHome, other2)).toBeNull()
  })
  it('primary, win32 and linux: no probe ever runs', async () => {
    const { otherHome, primaryHome } = setup()
    asPlatform('darwin')
    await ensureMacRealmVerdict(primaryHome)
    for (const p of ['win32', 'linux'] as const) { asPlatform(p); await ensureMacRealmVerdict(otherHome) }
    expect(probes).toEqual([])
  })
})

describe('every launch path asks for the verdict before its choke point (source scan)', () => {
  const root = path.resolve(__dirname, '../../src/main')
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')
  it('each withProfileHome / profileRealmLaunch caller awaits the check', () => {
    expect(read('pty-manager.ts')).toMatch(/await ensureMacRealmVerdict\(getProfileConfigDir\(resolvedProfileId\)/)
    expect(read('claude-headless.ts')).toMatch(/macRealmVerdictPending\(home\)[\s\S]*ensureMacRealmVerdict\(home\)/)
    expect(read('insights-runner.ts')).toMatch(/await ensureMacRealmVerdict\(home\)/)
    expect(read('cloud-agent-manager.ts')).toMatch(/await ensureMacRealmVerdict\(/)
    expect(read('account-web/claude-cli-auth.ts')).toMatch(/await ensureMacRealmVerdict\(home\)/)
    expect(read('providers/claude/review-launch.ts')).toMatch(/await ports\.ensureLaunchVerdict\(profileId\)[\s\S]*ports\.profileRealmLaunch\(profileId\)/)
    expect(read('providers/compose.ts')).toMatch(/ensureLaunchVerdict: \(profileId\) => ensureMacRealmVerdict\(/)
  })

  // Re-attack r3, MAJOR 1: and each runs the verified binary on the realm.
  it('MAJOR 1: each launch path runs macRealmLaunchBinary on the realm (and the bare name otherwise)', () => {
    expect(read('pty-manager.ts')).toMatch(/const realmLaunchBin = macRealmLaunchBinary\(home/)
    expect(read('pty-manager.ts')).toMatch(/const cmd = realmLaunchBin \?\? resolveClaudeForPty\(/)
    expect(read('pty-manager.ts')).toMatch(/finalSpawnEnv\.CCC_CLAUDE_BIN = realmLaunchBin/)
    expect(read('pty-manager.ts')).toMatch(/shellOnlyOpeningLines\(cdCmd, isWin \? \[\] : realmShellPinLines\(realmLaunchBin, spawnCmd, spawnArgs\), launchLine\)/)
    // The base cd line carries no realm prefix (re-attack r4).
    expect(read('pty-manager.ts')).toMatch(/: `cd \$\{quoteArgForShell\(resolvedCwd, false\)\} 2>\/dev\/null; clear`/)
    expect(read('insights-runner.ts')).toMatch(/const cmd = macRealmLaunchBinary\(home\) \?\? resolveClaudeForPty\(\)\.cmd/)
    expect(read('claude-headless.ts')).toMatch(/spawn\(realmBin, args, \{ shell: false/)
    expect(read('account-web/claude-cli-auth.ts')).toMatch(/execFileAsync\(realmBin \?\? 'claude'[\s\S]*shell: !realmBin/)
    expect(read('cloud-agent-manager.ts')).toMatch(/macRealmLaunchBinary\(agentHome/)
    expect(read('providers/claude/review-launch.ts')).toMatch(/realmExecutableRefusal\(profileId, exe\.executable\)/)
  })

  // Re-attack r3, MINOR 5: the exemption flag stays in the two modules that own it.
  it('MINOR 5: realmVerdictProbe appears only in account-profiles.ts and mac-realm-guard.ts', () => {
    const users: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name)
        if (e.isDirectory()) walk(full)
        else if (/\.(ts|tsx|js)$/.test(e.name) && fs.readFileSync(full, 'utf8').includes('realmVerdictProbe')) users.push(path.relative(root, full).split(path.sep).join('/'))
      }
    }
    walk(path.resolve(root, '..'))
    expect(users.sort()).toEqual(['main/account-profiles.ts', 'main/mac-realm-guard.ts'].map((p) => path.relative(root, path.resolve(root, '..', p)).split(path.sep).join('/')).sort())
  })
  it('no other module calls withProfileHome (a new caller still meets the synchronous gate, but must be listed here)', () => {
    const callers: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.endsWith('.ts') && /\bwithProfileHome\(/.test(fs.readFileSync(full, 'utf8'))) callers.push(path.relative(root, full).split(path.sep).join('/'))
      }
    }
    walk(root)
    expect(callers.sort()).toEqual(['account-profiles.ts', 'account-web/claude-cli-auth.ts', 'claude-headless.ts', 'cloud-agent-manager.ts', 'insights-runner.ts', 'mac-realm-guard.ts', 'pty-manager.ts'].sort())
  })
})
