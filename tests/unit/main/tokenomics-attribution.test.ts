/// <reference types="vite/client" />
// Usage track MP10 (owner decision Q1.4): Claude usage is attributed to the
// account its session launched under, from now on. Host-safe: pure functions,
// the supervisor over a fake worker transport, the accounts service over the
// in-memory harness, and main's wiring read as source. No process starts and
// no database opens (the database side is the native
// tests/unit/native/tokenomics-attribution.native.test.ts).
import { describe, it, expect } from 'vitest'
import { transcriptSessionId, createTranscriptAttribution } from '../../../src/main/tokenomics/tk-attribution'
import type { TkAttributionDeps } from '../../../src/main/tokenomics/tk-attribution'
import { TokenomicsSupervisor } from '../../../src/main/tokenomics/tk-supervisor'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'
import type { ToTkWorker } from '../../../src/main/tokenomics/tk-worker-transport'
import { harness, claudeSnapshot } from '../../wp1/accounts-harness'
import indexSource from '../../../src/main/index.ts?raw'

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

describe('attributing a transcript to its launch account (MP10)', () => {
  function sink(over: Partial<TkAttributionDeps> = {}) {
    const recorded: Array<[string, string]> = []
    const asked = { profile: 0, account: 0 }
    const profiles: Record<string, string | undefined> = { 'app-1': 'profile-a1', 'app-2': 'profile-b2', 'app-ssh': undefined }
    const links: Record<string, string | null> = { 'profile-a1': ACCT, 'profile-b2': 'acct-' + 'b'.repeat(32) }
    const deps: TkAttributionDeps = {
      profileOf: (id) => { asked.profile++; return profiles[id] },
      accountOf: (p) => { asked.account++; return links[p] ?? null },
      record: (s, k) => { recorded.push([s, k]); return true },
      ...over,
    }
    return { attribute: createTranscriptAttribution(deps), recorded, asked }
  }

  it('records the session id with its launch profile\'s account, once', () => {
    const t = sink()
    t.attribute('app-1', WIN(U1))
    expect(t.recorded).toEqual([[U1, `claude:${ACCT}`]])
    // Every later report of it (the statusline reports continuously) is
    // dropped before any lookup.
    const asked = { ...t.asked }
    for (let i = 0; i < 5; i++) t.attribute('app-1', WIN(U1))
    expect(t.recorded).toHaveLength(1)
    expect(t.asked).toEqual(asked)
  })

  it('the first attribution of a session id wins: another app session reporting it later changes nothing', () => {
    const t = sink()
    t.attribute('app-1', WIN(U1))
    t.attribute('app-2', WIN(U1))
    expect(t.recorded).toEqual([[U1, `claude:${ACCT}`]])
    // A new transcript of the second session is its own.
    t.attribute('app-2', WIN(U2))
    expect(t.recorded[1]).toEqual([U2, 'claude:acct-' + 'b'.repeat(32)])
  })

  it('a session with no launch profile (SSH, default home) or no linked account is never attributed', () => {
    const t = sink()
    t.attribute('app-ssh', `/home/u/.claude/projects/-srv/${U1}.jsonl`)
    t.attribute('app-unknown', WIN(U1))
    expect(t.recorded).toEqual([])
    // Whatever a lookup would answer for no profile.
    const anyLink = sink({ accountOf: () => ACCT })
    anyLink.attribute('app-ssh', WIN(U1))
    expect(anyLink.recorded).toEqual([])
    expect(anyLink.asked.account).toBe(0)
    const unlinked = sink({ accountOf: () => null })
    unlinked.attribute('app-1', WIN(U1))
    expect(unlinked.recorded).toEqual([])
    // An account id that does not make a well-formed key is not recorded.
    const odd = sink({ accountOf: () => 'not an id' })
    odd.attribute('app-1', WIN(U1))
    expect(odd.recorded).toEqual([])
    // And it is tried again once the link exists.
    let link: string | null = null
    const later = sink({ accountOf: () => link })
    later.attribute('app-1', WIN(U1))
    link = ACCT
    later.attribute('app-1', WIN(U1))
    expect(later.recorded).toEqual([[U1, `claude:${ACCT}`]])
  })

  it('a path that names no session, or no app session, looks nothing up', () => {
    const t = sink({ profileOf: () => 'profile-a1' })
    t.attribute('app-1', 'C:\\p\\agent-1.jsonl')
    t.attribute('', WIN(U1))
    t.attribute(undefined as unknown as string, WIN(U1))
    expect(t.recorded).toEqual([])
    expect(t.asked.profile).toBe(0)
  })

  it('when the usage index is not running the session id is tried again on its next report', () => {
    let up = false
    const recorded: string[] = []
    const attribute = createTranscriptAttribution({
      profileOf: () => 'profile-a1', accountOf: () => ACCT,
      record: (s) => { if (!up) return false; recorded.push(s); return true },
    })
    attribute('app-1', WIN(U1))
    up = true
    attribute('app-1', WIN(U1))
    attribute('app-1', WIN(U1))
    expect(recorded).toEqual([U1])
  })

  it('never throws, whatever a lookup or the index does', () => {
    for (const broken of [
      { profileOf: () => { throw new Error('x') } },
      { accountOf: () => { throw new Error('x') } },
      { record: () => { throw new Error('x') } },
    ] as Array<Partial<TkAttributionDeps>>) {
      const t = sink(broken)
      expect(() => t.attribute('app-1', WIN(U1))).not.toThrow()
    }
  })

  it('remembers a bounded number of session ids, the oldest forgotten first', () => {
    const t = sink({ remember: 2 })
    t.attribute('app-1', WIN(U1))
    t.attribute('app-1', WIN(U2))
    t.attribute('app-1', WIN(U2))
    expect(t.recorded.map(([s]) => s)).toEqual([U1, U2])
    t.attribute('app-1', WIN(U3))
    // U1 was forgotten, so it is sent again (the index keeps the first); U3 is remembered.
    t.attribute('app-1', WIN(U1))
    t.attribute('app-1', WIN(U3))
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

  it('sends a well-formed attribution once; the first wins; anything else is dropped', () => {
    const f = fake()
    f.sup.start()
    f.sup.setSessionAccount(U1, `claude:${ACCT}`)
    f.sup.setSessionAccount(U1, 'claude:acct-' + 'b'.repeat(32))
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
    // A link whose account is gone from the record names nothing.
    const doc = h.doc()
    const gone = idOf('profile-b2')
    h.store.current = () => ({ ...doc, accounts: doc.accounts.filter((a) => a.id !== gone) })
    expect(h.service.accountIdForLegacy('claude', 'profile-b2')).toBeNull()
    expect(h.service.accountIdForLegacy('claude', 'profile-a1')).toBe(idOf('profile-a1'))
  })
})

/** main's source with its comments removed, so a commented-out line fails. */
const code = indexSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n')

describe('main composes the attribution beside the transcript binder (MP10)', () => {
  it('both transcript-path sources reach the attribution, whether logging is on or off', () => {
    expect(code).toMatch(/import \{ createTranscriptAttribution \} from '\.\/tokenomics\/tk-attribution'/)
    expect(code).toMatch(/import \{ getClaudeProfileId \} from '\.\/claude-account-identity'/)
    // The route calls the attribution first, then the binder (which is null
    // with logging off, so it cannot gate the attribution).
    const route = /const routeTranscriptPath = \(sessionId: string, path: string\) => \{\s*attributeTranscript\(sessionId, path\)\s*getTranscriptBinder\(\)\?\.notifyTranscriptPath\(sessionId, path\)\s*\}/
    expect(code).toMatch(route)
    // The hooks gateway and the statusline both feed the route.
    expect(code).toMatch(/onTranscriptPath: routeTranscriptPath/)
    expect(code).toMatch(/setTranscriptPathSink\(routeTranscriptPath\)/)
    expect(code.indexOf('const attributeTranscript = createTranscriptAttribution(')).toBeGreaterThan(-1)
    expect(code.indexOf('const attributeTranscript = createTranscriptAttribution(')).toBeLessThan(code.indexOf('const routeTranscriptPath'))
  })

  it('the attribution is the launch profile, its registry link and the usage index; nothing else', () => {
    expect(code).toMatch(/profileOf: \(sessionId\) => getClaudeProfileId\(sessionId\)/)
    expect(code).toMatch(/accountOf: \(profileId\) => getAccountsService\(\)\?\.accountIdForLegacy\('claude', profileId\) \?\? null/)
    expect(code).toMatch(/const tokenomics = getTokenomicsSupervisor\(\)\s*if \(!tokenomics\) return false\s*tokenomics\.setSessionAccount\(sessionId, accountKey\)\s*return true/)
    // No manual attribution: nothing else in main records one.
    expect(code.split('setSessionAccount(').length).toBe(2)
    expect(code.split('createTranscriptAttribution(').length).toBe(2)
  })
})
