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
import {
  _resetMacRealmVerdictsForTest, ensureMacRealmVerdict, macRealmVerdictPending, hasMacRealmVerdict,
  MAC_REALM_UNVERIFIED, MAC_REALM_NOT_ISOLATED, CLI_RESOLVE_TTL_MS, setMacRealmVerdictHooks,
} from '../../src/main/mac-realm-verdict'
import {
  installMacRealmGuard, _setMacRealmGuardSeamsForTest, realmVerdictFromAuthStatus, macRealmCheckRetryable,
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
  it('not isolated: another folder (the real ~/.claude), missing field, relative, unparseable, empty', () => {
    expect(realmVerdictFromAuthStatus(out({ configDirectory: path.resolve('/Users/someone/.claude') }), dir)).toBe('not-isolated')
    expect(realmVerdictFromAuthStatus(out({ loggedIn: true }), dir)).toBe('not-isolated')
    expect(realmVerdictFromAuthStatus(out({ configDirectory: 'relative/.claude' }), dir)).toBe('not-isolated')
    expect(realmVerdictFromAuthStatus('{not json', dir)).toBe('not-isolated')
    expect(realmVerdictFromAuthStatus('', dir)).toBe('not-isolated')
    expect(realmVerdictFromAuthStatus(out([dir]), dir)).toBe('not-isolated')
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

  it('the CLI is re-resolved after the TTL (a PATH that now finds another claude is noticed)', async () => {
    const { otherHome, dir } = setup()
    asPlatform('darwin')
    await ensureMacRealmVerdict(otherHome)
    now += CLI_RESOLVE_TTL_MS + 1
    expect(hasMacRealmVerdict(dir)).toBe(false)
    const other2 = path.join(tmp, 'bin2', 'claude')
    fs.mkdirSync(path.dirname(other2), { recursive: true })
    fs.writeFileSync(other2, 'another')
    cliPath = other2
    await ensureMacRealmVerdict(otherHome)
    expect(resolves).toBe(2)
    expect(probes.map((p) => p.file)).toEqual([path.join(tmp, 'bin', 'claude'), other2])
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

  it('missing field / non-zero exit without JSON: REFUSED the same way', async () => {
    const { otherHome } = setup()
    asPlatform('darwin')
    for (const a of [
      { code: 0, stdout: JSON.stringify({ loggedIn: true }), timedOut: false },
      { code: 1, stdout: 'error: unknown command auth', timedOut: false },
    ]) {
      answer = () => a
      await ensureMacRealmVerdict(otherHome)
      expect(refusal(() => P.withProfileHome({ PATH: '/x' }, otherHome))).toContain(MAC_REALM_NOT_ISOLATED)
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
