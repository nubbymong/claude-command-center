/// <reference types="vite/client" />
// Usage track MP10 (owner decision Q1.4): Claude usage is attributed to the
// account whose profile it runs under (the transcript path decides), from
// now on. Host-safe: pure functions,
// the supervisor over a fake worker transport, the accounts service over the
// in-memory harness, and main's wiring read as source. No process starts and
// no database opens (the database side is the native
// tests/unit/native/tokenomics-attribution.native.test.ts).
import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { transcriptSessionId, transcriptProfile, createTranscriptAttribution } from '../../../src/main/tokenomics/tk-attribution'
import type { TkAttributionDeps } from '../../../src/main/tokenomics/tk-attribution'
import { TokenomicsSupervisor } from '../../../src/main/tokenomics/tk-supervisor'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'
import type { ToTkWorker } from '../../../src/main/tokenomics/tk-worker-transport'
import { harness, claudeSnapshot } from '../../wp1/accounts-harness'
import indexSource from '../../../src/main/index.ts?raw'
import ptyManagerSource from '../../../src/main/pty-manager.ts?raw'
import { isValidProfileId } from '../../../src/shared/profile-id'

const U1 = '0b6f3c2e-9d41-4f8a-a1c2-3e4d5f607182'
const U2 = '7d2a9e10-4b3c-4d5e-8f60-718293a4b5c6'
const U3 = 'c0ffee00-1111-4222-8333-944455566677'
const ACCT = 'acct-' + 'a'.repeat(32)
const WIN = (u: string) => `C:\\Users\\u\\.claude-profiles\\p1\\projects\\F--work-app\\${u}.jsonl`

describe('the transcript path names its session (MP10, strict)', () => {
  it('only a last segment that is exactly <lower-case uuid>.jsonl names a session', () => {
    expect(transcriptSessionId(WIN(U1))).toBe(U1)
    expect(transcriptSessionId(`/home/u/.claude/projects/-work-app/${U2}.jsonl`)).toBe(U2)
    expect(transcriptSessionId(`C:/mixed\\sep/${U1}.jsonl`)).toBe(U1)
    for (const bad of [
      `C:\\p\\${U1.toUpperCase()}.jsonl`, // upper case
      `C:\\p\\agent-a1b2c3.jsonl`, // a subagent's transcript
      `C:\\p\\${U1}.jsonl.bak`,
      `C:\\p\\${U1}.json`,
      `C:\\p\\${U1}`,
      `C:\\p\\x${U1}.jsonl`,
      `C:\\p\\${U1}\\sub.jsonl`, // the id in a folder name only
      `C:\\p\\${U1}.jsonl\\`, // a folder
      `C:\\sessions\\rollout-2026-09-27T10-00-00-${U1}.jsonl`,
      `C:\\p\\${U1.slice(0, -1)}.jsonl`,
      '',
      'x'.repeat(4097 - `${U1}.jsonl`.length) + `${U1}.jsonl`, // too long
    ]) expect(transcriptSessionId(bad), bad).toBeNull()
    for (const bad of [undefined, null, 42, {}, [WIN(U1)]]) expect(transcriptSessionId(bad)).toBeNull()
    // The longest path looked at still names its session.
    expect(transcriptSessionId('x'.repeat(4096 - `${U1}.jsonl`.length - 1) + '/' + `${U1}.jsonl`)).toBe(U1)
  })
})

describe('the profile a transcript path names (MP10: the path decides, in the real profile layout)', () => {
  const ROOT_W = 'C:\\res\\account-profiles'
  const ok = (n: string) => /^profile-[a-z0-9]+$/.test(n)
  // As index.ts composes it: the profile home (getProfileConfigDir) holds
  // Claude's own folder, .claude, and its projects folder.
  const winProjects = (id: string) => path.win32.join(ROOT_W, id, '.claude', 'projects')
  const posixProjects = (root: string) => (id: string) => path.posix.join(root, id, '.claude', 'projects')
  it('a transcript under <profiles root>/<profile id>/.claude/projects/ is that profile\'s', () => {
    expect(transcriptProfile(`${ROOT_W}\\profile-a1\\.claude\\projects\\F--app\\${U1}.jsonl`, ROOT_W, ok, winProjects, 'win32')).toBe('profile-a1')
    // Windows compares without case, and either separator.
    expect(transcriptProfile(`c:/RES/Account-Profiles/profile-a1/.Claude/Projects/F--app/${U1}.jsonl`, ROOT_W, ok, winProjects, 'win32')).toBe('profile-a1')
    // A subagent's transcript deeper in the project folder still counts.
    expect(transcriptProfile(`/home/u/res/account-profiles/profile-b2/.claude/projects/-app/sub/${U1}.jsonl`, '/home/u/res/account-profiles', ok, posixProjects('/home/u/res/account-profiles'), 'linux')).toBe('profile-b2')
  })
  // Windows compares paths without case, and the app's id check takes lower
  // case only: the folder name is lowered first, or the case-free account
  // lookup would never be reached. POSIX compares with case.
  it('on Windows a profile folder reported in other case is still the profile\'s', () => {
    expect(isValidProfileId('PROFILE-A1')).toBe(false)
    expect(transcriptProfile(`${ROOT_W}\\PROFILE-A1\\.claude\\projects\\F--app\\${U1}.jsonl`, ROOT_W, isValidProfileId, winProjects, 'win32')).toBe('profile-a1')
    expect(transcriptProfile(`/res/account-profiles/PROFILE-A1/.claude/projects/-app/${U1}.jsonl`, '/res/account-profiles', isValidProfileId, posixProjects('/res/account-profiles'), 'linux')).toBeUndefined()
  })
  // [host] Only ASCII letters are lowered: a profile id is ASCII, so no other
  // letter may fold onto one (KELVIN SIGN lowers to k under Unicode rules).
  it('on Windows a folder that matches a profile id only under Unicode case rules is none', () => {
    const KELVIN = String.fromCodePoint(0x212a)
    expect(`profile-${KELVIN}a1`.toLowerCase()).toBe('profile-ka1')
    expect(transcriptProfile(`${ROOT_W}\\profile-${KELVIN}a1\\.claude\\projects\\F--app\\${U1}.jsonl`, ROOT_W, isValidProfileId, winProjects, 'win32')).toBeUndefined()
    expect(transcriptProfile(`${ROOT_W}\\PROFILE-KA1\\.claude\\projects\\F--app\\${U1}.jsonl`, ROOT_W, isValidProfileId, winProjects, 'win32')).toBe('profile-ka1')
  })
  it('the old layout, with no .claude folder, is not a profile\'s', () => {
    expect(transcriptProfile(`${ROOT_W}\\profile-a1\\projects\\F--app\\${U1}.jsonl`, ROOT_W, ok, winProjects, 'win32')).toBeUndefined()
    expect(transcriptProfile(`/r/account-profiles/profile-a1/projects/-app/${U1}.jsonl`, '/r/account-profiles', ok, posixProjects('/r/account-profiles'), 'linux')).toBeUndefined()
  })
  it('anything else names no profile', () => {
    for (const bad of [
      `C:\\Users\\u\\.claude\\projects\\F--app\\${U1}.jsonl`, // the default home
      `${ROOT_W}\\profile-a1\\.claude\\projects\\${U1}.jsonl`, // no project folder
      `${ROOT_W}\\profile-a1\\.claude\\other\\F--app\\${U1}.jsonl`,
      `${ROOT_W}\\not a profile\\.claude\\projects\\F--app\\${U1}.jsonl`,
      `${ROOT_W}\\..\\profile-a1\\.claude\\projects\\F--app\\${U1}.jsonl`, // out of the root
      `${ROOT_W}-other\\profile-a1\\.claude\\projects\\F--app\\${U1}.jsonl`, // a sibling folder
      `profile-a1\\.claude\\projects\\F--app\\${U1}.jsonl`, // relative
      `/home/u/.claude-profiles/profile-a1/.claude/projects/-app/${U1}.jsonl`, // a remote host's
    ]) expect(transcriptProfile(bad, ROOT_W, ok, winProjects, 'win32'), bad).toBeUndefined()
    // Out of the root, whatever the id check would take.
    for (const out of [`${ROOT_W}\\..\\.claude\\projects\\F--app\\${U1}.jsonl`, `${ROOT_W}-other\\x\\.claude\\projects\\F--app\\${U1}.jsonl`]) {
      expect(transcriptProfile(out, ROOT_W, () => true, winProjects, 'win32'), out).toBeUndefined()
    }
    // A profile whose projects folder lies outside the root is none.
    expect(transcriptProfile(`${ROOT_W}\\profile-a1\\.claude\\projects\\F--app\\${U1}.jsonl`, ROOT_W, ok, () => 'D:\\elsewhere\\projects', 'win32')).toBeUndefined()
    // Case counts on POSIX.
    expect(transcriptProfile(`/res/account-profiles/profile-a1/.claude/Projects/-app/${U1}.jsonl`, '/res/account-profiles', ok, posixProjects('/res/account-profiles'), 'linux')).toBeUndefined()
  })
  it('a transcript reported through the root\'s real path matches when the root is reached through a link', () => {
    const real = 'D:\\data\\account-profiles'
    const file = `${real}\\profile-a1\\.claude\\projects\\F--app\\${U1}.jsonl`
    expect(transcriptProfile(file, ROOT_W, ok, winProjects, 'win32')).toBeUndefined()
    expect(transcriptProfile(file, ROOT_W, ok, winProjects, 'win32', real)).toBe('profile-a1')
    // The configured root still matches too.
    expect(transcriptProfile(`${ROOT_W}\\profile-a1\\.claude\\projects\\F--app\\${U1}.jsonl`, ROOT_W, ok, winProjects, 'win32', real)).toBe('profile-a1')
  })
})

describe('attributing a transcript to its profile\'s account (MP10)', () => {
  const ROOT = 'C:\\res\\account-profiles'
  const AT = (profile: string, u: string) => `${ROOT}\\${profile}\\.claude\\projects\\F--work-app\\${u}.jsonl`
  const ACCT_B = 'acct-' + 'b'.repeat(32)
  const ACCT_K = 'acct-' + 'c'.repeat(32)
  // The profile each app session runs under now (an SSH session has none).
  const launched = (): Record<string, string | undefined> => ({ 'app-1': 'profile-a1', 'app-2': 'profile-b2', 'app-ssh': undefined })
  function sink(over: Partial<TkAttributionDeps> = {}, launch: Record<string, string | undefined> = launched()) {
    const recorded: Array<[string, string]> = []
    const asked = { launch: 0, account: 0 }
    const links: Record<string, string | null> = { 'profile-a1': ACCT, 'profile-b2': ACCT_B, 'profile-k1': ACCT_K }
    const deps: TkAttributionDeps = {
      launchProfile: (id) => { asked.launch++; return launch[id] },
      profilesRoot: () => ROOT,
      isProfileId: (n) => /^profile-[a-z0-9]+$/.test(n),
      projectsDirOf: (id) => path.win32.join(ROOT, id, '.claude', 'projects'),
      accountOf: (p) => { asked.account++; return links[p] ?? null },
      record: (s, k) => { recorded.push([s, k]); return true },
      platform: 'win32',
      ...over,
    }
    return { attribute: createTranscriptAttribution(deps), recorded, asked }
  }

  it('records the session id with its profile\'s account, once while it stays', () => {
    const t = sink()
    t.attribute('app-1', AT('profile-a1', U1))
    expect(t.recorded).toEqual([[U1, `claude:${ACCT}`]])
    // Every later report of it (the statusline reports continuously) sends nothing.
    for (let i = 0; i < 5; i++) t.attribute('app-1', AT('profile-a1', U1))
    expect(t.recorded).toHaveLength(1)
  })

  it('the path decides: the same session resumed under another profile moves on to that account', () => {
    const t = sink()
    t.attribute('app-1', AT('profile-a1', U1))
    t.attribute('app-2', AT('profile-b2', U1))
    t.attribute('app-2', AT('profile-b2', U1))
    expect(t.recorded).toEqual([[U1, `claude:${ACCT}`], [U1, `claude:${ACCT_B}`]])
    // And back again.
    t.attribute('app-1', AT('profile-a1', U1))
    expect(t.recorded.at(-1)).toEqual([U1, `claude:${ACCT}`])
  })

  // [host] A session's report attributes usage only to the account it runs
  // under: the transcript must lie in the folder of the reporting session's
  // own profile, as it runs now.
  it('only a transcript in the folder of the profile the reporting session runs under is attributed', () => {
    const t = sink()
    // app-1 runs under profile-a1: a transcript in profile-b2's folder is not its own.
    t.attribute('app-1', AT('profile-b2', U2))
    t.attribute('app-1', AT('profile-k1', U2))
    expect(t.recorded).toEqual([])
    t.attribute('app-1', AT('profile-a1', U2))
    expect(t.recorded).toEqual([[U2, `claude:${ACCT}`]])
  })

  it('a report naming another profile\'s folder never moves a session to that account', () => {
    const t = sink()
    for (let i = 0; i < 50; i++) {
      t.attribute('app-2', AT('profile-b2', U1))
      t.attribute('app-1', AT('profile-k1', U1))
      t.attribute('app-1', AT('profile-b2', U1))
    }
    expect(t.recorded).toEqual([[U1, `claude:${ACCT_B}`]])
  })

  it('the profile is the one the session runs under now: a session restarted on another profile is held to that one', () => {
    const launch = launched()
    const t = sink({}, launch)
    t.attribute('app-1', AT('profile-a1', U1))
    // Switch account restarts the same app session on profile-b2.
    launch['app-1'] = 'profile-b2'
    t.attribute('app-1', AT('profile-a1', U2))
    t.attribute('app-1', AT('profile-b2', U1))
    // Restarted on no profile (the default home): nothing is its own.
    launch['app-1'] = undefined
    t.attribute('app-1', AT('profile-b2', U3))
    expect(t.recorded).toEqual([[U1, `claude:${ACCT}`], [U1, `claude:${ACCT_B}`]])
  })

  it('on Windows the folder and the launch profile compare without case, ASCII letters only', () => {
    const t = sink({}, { 'app-1': 'PROFILE-A1', 'app-k': 'profile-k1' })
    t.attribute('app-1', `${ROOT}\\Profile-A1\\.claude\\projects\\F--work-app\\${U1}.jsonl`)
    expect(t.recorded).toEqual([[U1, `claude:${ACCT}`]])
    // A folder name that matches a profile only under Unicode case rules
    // (KELVIN SIGN folds to k there) is no profile's.
    const KELVIN = String.fromCodePoint(0x212a)
    t.attribute('app-k', `${ROOT}\\profile-${KELVIN}1\\.claude\\projects\\F--work-app\\${U2}.jsonl`)
    expect(t.recorded).toEqual([[U1, `claude:${ACCT}`]])
  })

  it('on POSIX the folder and the launch profile compare with case', () => {
    const P = '/res/account-profiles'
    const posix = { platform: 'linux' as const, profilesRoot: () => P, projectsDirOf: (id: string) => path.posix.join(P, id, '.claude', 'projects') }
    const upper = sink(posix, { 'app-1': 'PROFILE-A1' })
    upper.attribute('app-1', `${P}/profile-a1/.claude/projects/-work-app/${U1}.jsonl`)
    expect(upper.recorded).toEqual([])
    const same = sink(posix, { 'app-1': 'profile-a1' })
    same.attribute('app-1', `${P}/profile-a1/.claude/projects/-work-app/${U1}.jsonl`)
    expect(same.recorded).toEqual([[U1, `claude:${ACCT}`]])
  })

  it('an SSH session, the default home, or a profile with no linked account is never attributed', () => {
    const t = sink({ accountOf: () => ACCT })
    t.attribute('app-ssh', AT('profile-a1', U1))
    t.attribute('app-unknown', AT('profile-a1', U1))
    t.attribute('app-1', `C:\\Users\\u\\.claude\\projects\\F--app\\${U1}.jsonl`)
    expect(t.recorded).toEqual([])
    const noRoot = sink({ profilesRoot: () => null })
    noRoot.attribute('app-1', AT('profile-a1', U1))
    expect(noRoot.recorded).toEqual([])
    const unlinked = sink({ accountOf: () => null })
    unlinked.attribute('app-1', AT('profile-a1', U1))
    expect(unlinked.recorded).toEqual([])
    // An account id that does not make a well-formed key is not recorded.
    const odd = sink({ accountOf: () => 'not an id' })
    odd.attribute('app-1', AT('profile-a1', U1))
    expect(odd.recorded).toEqual([])
    // And it is tried again once the link exists.
    let link: string | null = null
    const later = sink({ accountOf: () => link })
    later.attribute('app-1', AT('profile-a1', U1))
    link = ACCT
    later.attribute('app-1', AT('profile-a1', U1))
    expect(later.recorded).toEqual([[U1, `claude:${ACCT}`]])
  })

  it('a path that names no session, or no app session, looks nothing up', () => {
    const t = sink()
    t.attribute('app-1', `${ROOT}\\profile-a1\\.claude\\projects\\F--app\\agent-1.jsonl`)
    t.attribute('', AT('profile-a1', U1))
    t.attribute(undefined as unknown as string, AT('profile-a1', U1))
    expect(t.recorded).toEqual([])
    expect(t.asked.launch).toBe(0)
    expect(t.asked.account).toBe(0)
  })

  it('when the usage index is not running the session id is tried again on its next report', () => {
    let up = false
    const recorded: string[] = []
    const t = sink({ record: (s) => { if (!up) return false; recorded.push(s); return true } })
    t.attribute('app-1', AT('profile-a1', U1))
    up = true
    t.attribute('app-1', AT('profile-a1', U1))
    t.attribute('app-1', AT('profile-a1', U1))
    expect(recorded).toEqual([U1])
  })

  it('never throws, whatever a lookup or the index does', () => {
    for (const broken of [
      { launchProfile: () => { throw new Error('x') } },
      { profilesRoot: () => { throw new Error('x') } },
      { isProfileId: () => { throw new Error('x') } },
      { projectsDirOf: () => { throw new Error('x') } },
      { realRoot: () => { throw new Error('x') } },
      { accountOf: () => { throw new Error('x') } },
      { record: () => { throw new Error('x') } },
    ] as Array<Partial<TkAttributionDeps>>) {
      const t = sink(broken)
      expect(() => t.attribute('app-1', AT('profile-a1', U1))).not.toThrow()
    }
  })

  it('remembers a bounded number of session ids, the oldest forgotten first', () => {
    const t = sink({ remember: 2 })
    t.attribute('app-1', AT('profile-a1', U1))
    t.attribute('app-1', AT('profile-a1', U2))
    t.attribute('app-1', AT('profile-a1', U2))
    expect(t.recorded.map(([s]) => s)).toEqual([U1, U2])
    t.attribute('app-1', AT('profile-a1', U3))
    // U1 was forgotten, so it is sent again (the index changes nothing); U3 is remembered.
    t.attribute('app-1', AT('profile-a1', U1))
    t.attribute('app-1', AT('profile-a1', U3))
    expect(t.recorded.map(([s]) => s)).toEqual([U1, U2, U3, U1])
  })
})

describe('the supervisor hands attributions to the worker (MP10)', () => {
  const baseOpts = () => ({ dbPath: ':memory:', pricing: {}, configs: [], claudeProjectsDir: '/c', codexSessionsDir: '/x', emit: () => {} })
  function fake(o: { ready?: boolean } = {}) {
    const t = new FakeTkWorkerTransport()
    const seen: ToTkWorker[] = []
    let exit: () => void = () => {}
    t.onWorker((m) => {
      seen.push(m)
      if (m.type === 'open' && o.ready !== false) t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 })
    })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: (cb: () => void) => { exit = cb } })) as any, ...baseOpts() })
    const sent = () => seen.filter((m) => m.type === 'set-session-account')
    return { t, sup, seen, sent, exit: () => exit() }
  }

  it('sends a well-formed attribution once while it stays; anything else is dropped', () => {
    const f = fake()
    f.sup.start()
    f.sup.setSessionAccount(U1, `claude:${ACCT}`)
    f.sup.setSessionAccount(U1, `claude:${ACCT}`)
    for (const [s, k] of [
      ['not-a-uuid', `claude:${ACCT}`],
      [U1.toUpperCase(), `claude:${ACCT}`],
      [U2, ''],
      [U2, `codex:${ACCT}`],
      [U2, 'claude:'],
      [U2, 'claude:bad key'],
    ]) f.sup.setSessionAccount(s, k)
    expect(f.sent()).toEqual([{ type: 'set-session-account', sessionId: U1, accountKey: `claude:${ACCT}` }])
    f.sup.shutdown()
  })

  // MP10 round 1: a session that moves on to another account is sent again,
  // and a restarted worker gets the latest.
  it('another account for the same session is sent, and kept as the latest', async () => {
    const f = fake()
    f.sup.start()
    f.sup.setSessionAccount(U1, `claude:${ACCT}`)
    f.sup.setSessionAccount(U1, 'claude:acct-' + 'b'.repeat(32))
    expect(f.sent().map((m) => (m as { accountKey: string }).accountKey)).toEqual([`claude:${ACCT}`, 'claude:acct-' + 'b'.repeat(32)])
    f.exit()
    for (let i = 0; i < 100 && f.seen.filter((m) => m.type === 'open').length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    expect(f.sent().at(-1)).toEqual({ type: 'set-session-account', sessionId: U1, accountKey: 'claude:acct-' + 'b'.repeat(32) })
    f.sup.shutdown()
  })

  it('buffers until the worker is ready, then sends it once', () => {
    const f = fake({ ready: false })
    f.sup.start()
    f.sup.setSessionAccount(U1, `claude:${ACCT}`)
    expect(f.sent()).toEqual([])
    f.t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 })
    expect(f.sent()).toEqual([{ type: 'set-session-account', sessionId: U1, accountKey: `claude:${ACCT}` }])
    f.sup.shutdown()
  })

  it('a restarted worker is sent every attribution again, after its open', async () => {
    const f = fake()
    f.sup.start()
    f.sup.setSessionAccount(U1, `claude:${ACCT}`)
    f.sup.setSessionAccount(U2, `claude:${ACCT}`)
    expect(f.sent()).toHaveLength(2)
    f.exit()
    for (let i = 0; i < 100 && f.seen.filter((m) => m.type === 'open').length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    const afterOpen = f.seen.slice(f.seen.lastIndexOf(f.seen.filter((m) => m.type === 'open').at(-1)!))
    expect(afterOpen.filter((m) => m.type === 'set-session-account')).toEqual([
      { type: 'set-session-account', sessionId: U1, accountKey: `claude:${ACCT}` },
      { type: 'set-session-account', sessionId: U2, accountKey: `claude:${ACCT}` },
    ])
    f.sup.shutdown()
  })

  it('an attribution made while no worker listens reaches the restarted one once, not twice', async () => {
    const f = fake()
    f.sup.start()
    f.exit()
    f.sup.setSessionAccount(U1, `claude:${ACCT}`)
    for (let i = 0; i < 100 && f.seen.filter((m) => m.type === 'open').length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    expect(f.sent()).toEqual([{ type: 'set-session-account', sessionId: U1, accountKey: `claude:${ACCT}` }])
    f.sup.shutdown()
  })

  it('nothing is sent or kept after shutdown', () => {
    const f = fake()
    f.sup.start()
    f.sup.shutdown()
    f.sup.setSessionAccount(U1, `claude:${ACCT}`)
    expect(f.sent()).toEqual([])
    expect((f.sup as unknown as { sessionAccounts: Map<string, string> }).sessionAccounts.size).toBe(0)
  })

  it('keeps a bounded number of attributions for a restarted worker, the oldest dropped first', () => {
    const f = fake()
    f.sup.start()
    const id = (i: number) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
    for (let i = 0; i <= 4096; i++) f.sup.setSessionAccount(id(i), `claude:${ACCT}`)
    const kept = (f.sup as unknown as { sessionAccounts: Map<string, string> }).sessionAccounts
    expect(kept.size).toBe(4096)
    expect(kept.has(id(0))).toBe(false)
    expect(kept.has(id(1))).toBe(true)
    expect(kept.has(id(4096))).toBe(true)
    f.sup.shutdown()
  })
})

describe('the account a Claude launch profile is linked to (MP10)', () => {
  it('names the linked account by its profile, and nothing else', async () => {
    const h = await harness({ claude: [claudeSnapshot('profile-a1', { isDefault: true }), claudeSnapshot('profile-b2')] })
    const idOf = (legacyId: string) => h.doc().legacyLinks.find((l) => l.legacyId === legacyId)!.accountId
    expect(h.service.accountIdForLegacy('claude', 'profile-a1')).toBe(idOf('profile-a1'))
    expect(h.service.accountIdForLegacy('claude', 'profile-b2')).toBe(idOf('profile-b2'))
    expect(idOf('profile-a1')).not.toBe(idOf('profile-b2'))
    expect(h.service.accountIdForLegacy('claude', 'profile-zz')).toBeNull()
    expect(h.service.accountIdForLegacy('claude', '')).toBeNull()
    expect(h.service.accountIdForLegacy('codex', 'profile-a1')).toBeNull()
    // Without case only when asked (Windows paths): a profile id read back
    // from a path may differ in case from the one on record.
    expect(h.service.accountIdForLegacy('claude', 'PROFILE-A1')).toBeNull()
    expect(h.service.accountIdForLegacy('claude', 'PROFILE-A1', { ignoreCase: true })).toBe(idOf('profile-a1'))
    expect(h.service.accountIdForLegacy('claude', 'profile-zz', { ignoreCase: true })).toBeNull()
    // A link whose account is gone from the record names nothing.
    const doc = h.doc()
    const gone = idOf('profile-b2')
    h.store.current = () => ({ ...doc, accounts: doc.accounts.filter((a) => a.id !== gone) })
    expect(h.service.accountIdForLegacy('claude', 'profile-b2')).toBeNull()
    expect(h.service.accountIdForLegacy('claude', 'profile-a1')).toBe(idOf('profile-a1'))
  })

  // [host] Without case means ASCII letters only, and a link spelled exactly
  // as asked comes before one that differs only in case.
  it('without case, only ASCII letters fold, and an exact link comes first', async () => {
    const h = await harness({ claude: [claudeSnapshot('profile-ka1', { isDefault: true }), claudeSnapshot('profile-b2')] })
    const idOf = (legacyId: string) => h.doc().legacyLinks.find((l) => l.legacyId === legacyId)!.accountId
    const KELVIN = String.fromCodePoint(0x212a)
    expect(h.service.accountIdForLegacy('claude', 'PROFILE-KA1', { ignoreCase: true })).toBe(idOf('profile-ka1'))
    expect(h.service.accountIdForLegacy('claude', `profile-${KELVIN}a1`, { ignoreCase: true })).toBeNull()
    expect(h.service.accountIdForLegacy('claude', `PROFILE-${KELVIN}A1`, { ignoreCase: true })).toBeNull()
    // A record holding two links that differ only in case (the registry's
    // parser refuses such an id; this is the lookup's own rule): each
    // spelling finds its own link, whatever the order.
    const doc = h.doc()
    const A = idOf('profile-ka1')
    const B = idOf('profile-b2')
    const exact = doc.legacyLinks.find((l) => l.legacyId === 'profile-ka1')!
    const other = { ...doc.legacyLinks.find((l) => l.legacyId === 'profile-b2')!, legacyId: 'PROFILE-KA1' }
    for (const legacyLinks of [[other, exact], [exact, other]]) {
      h.store.current = () => ({ ...doc, legacyLinks })
      expect(h.service.accountIdForLegacy('claude', 'profile-ka1', { ignoreCase: true })).toBe(A)
      expect(h.service.accountIdForLegacy('claude', 'PROFILE-KA1', { ignoreCase: true })).toBe(B)
    }
  })
})

/** A source with its comments removed, so a commented-out line fails. */
const uncommented = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n')
const code = uncommented(indexSource)
const ptyCode = uncommented(ptyManagerSource)

describe('main composes the attribution beside the transcript binder (MP10)', () => {
  it('both transcript-path sources reach the attribution, whether logging is on or off', () => {
    // P3.2: with the folder rule the live usage recorder shares.
    expect(code).toMatch(/import \{ createTranscriptAttribution, profileOfTranscript, type TkProfileFolders \} from '\.\/tokenomics\/tk-attribution'/)
    // P3.2: index also imports the sessions-only in-use check from there.
    expect(code).toMatch(/import \{[^}]*\bgetClaudeProfileId\b[^}]*\} from '\.\/claude-account-identity'/)
    expect(code).toMatch(/getProfilesRoot, getProfileConfigDir, isValidProfileId \} from '\.\/account-profiles'/)
    // The route calls the attribution first, then the binder (which is null
    // with logging off, so it cannot gate the attribution). P3.10: through
    // pty-manager's routeHookTranscriptPath, which keeps a Codex session's
    // path (its rollout) to that session and hands every other one to the
    // attribution, then the binder (behaviour: pty-codex-hooks.test.ts).
    // P3.16 (M1): first noting the transcript for the not-indexed windows,
    // which returns nothing and gates neither (pty-codex-logs.test.ts).
    expect(code).toMatch(/import \{[^}]*\brouteHookTranscriptPath\b[^}]*\} from '\.\/pty-manager'/)
    const route = /const routeTranscriptPath = \(sessionId: string, path: string\) => \{\s*routeHookTranscriptPath\(sessionId, path, \{\s*attribute: attributeTranscript,\s*bind: \(sid, p\) => \{ getTranscriptBinder\(\)\?\.notifyTranscriptPath\(sid, p\) \},\s*\}\)\s*\}/
    expect(code).toMatch(route)
    expect(ptyCode).toMatch(/export function routeHookTranscriptPath\([\s\S]*?\): void \{\s*if \(noteCodexHookTranscript\(sessionId, transcriptPath\)\) return\s*(?:\/\/[^\n]*\n\s*)*noteClaudeTranscript\(sessionId, transcriptPath\)\s*claude\.attribute\(sessionId, transcriptPath\)\s*claude\.bind\(sessionId, transcriptPath\)\s*\}/)
    // The hooks gateway and the statusline both feed the route.
    expect(code).toMatch(/onTranscriptPath: routeTranscriptPath/)
    expect(code).toMatch(/setTranscriptPathSink\(routeTranscriptPath\)/)
    expect(code.indexOf('const attributeTranscript = createTranscriptAttribution(')).toBeGreaterThan(-1)
    expect(code.indexOf('const attributeTranscript = createTranscriptAttribution(')).toBeLessThan(code.indexOf('const routeTranscriptPath'))
  })

  it('the attribution is a local session, the profile its path names, that profile\'s registry link and the usage index; nothing else', () => {
    // [host] The profile the reporting session runs under now: the one
    // captured at its latest spawn (a capture under another profile replaces
    // it: claude-account-identity.test.ts, claude-account-watch.test.ts).
    expect(code).toMatch(/launchProfile: \(sessionId\) => getClaudeProfileId\(sessionId\),/)
    expect(code).not.toMatch(/\bisLocal\b/)
    expect(code).toMatch(/profilesRoot: \(\) => \{ try \{ return getProfilesRoot\(\) \} catch \{ return null \} \}/)
    expect(code).toMatch(/isProfileId: \(name\) => isValidProfileId\(name\)/)
    // The layout from where profile homes are built (MP10 round 2).
    expect(code).toMatch(/projectsDirOf: \(profileId\) => join\(getProfileConfigDir\(profileId\), '\.claude', 'projects'\)/)
    expect(code).toMatch(/realRoot: \(root\) => \{ try \{ return realpathSync\.native\(root\) \} catch \{ return null \} \}/)
    expect(code).toMatch(/accountOf: \(profileId\) => getAccountsService\(\)\?\.accountIdForLegacy\('claude', profileId, \{ ignoreCase: process\.platform === 'win32' \}\) \?\? null/)
    expect(code).toMatch(/const tokenomics = getTokenomicsSupervisor\(\)\s*if \(!tokenomics\) return false\s*tokenomics\.setSessionAccount\(sessionId, accountKey\)\s*return true/)
    // P3.2: the live usage recorder gets the same folder rule on the same folders.
    expect(code).toMatch(/setLiveUsageTranscriptProfile\(\(path\) => profileOfTranscript\(profileFolders, path\)\)/)
    expect(code).toMatch(/launchProfile: \(sessionId\) => getClaudeProfileId\(sessionId\),\s*\.\.\.profileFolders,/)
    // No manual attribution: nothing else in main records one.
    expect(code.split('setSessionAccount(').length).toBe(2)
    expect(code.split('createTranscriptAttribution(').length).toBe(2)
  })
})
