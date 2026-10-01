// Usage track MP3: the accounts service's allowance views (plan section 3,
// without the live read that MP8 adds). A provider that is off, not set up or
// whose setting cannot be read makes no call at all: no file read and no
// process. Archived accounts are not listed; inactive and API-key accounts
// read nothing; an account in use shows its live figure, else its last-seen
// reading; this computer's own sign-in is only ever read from its history.
// Views carry no path.
//
// PURE: the real Codex package on the fake CLI and in-memory registry of the
// WP1 harness, with an in-memory usage filesystem that logs every call.
import { describe, it, expect } from 'vitest'
import { harness, addCodexAccount, managedHome, EXT_HOME } from '../../wp1/accounts-harness'
import type { Harness } from '../../wp1/accounts-harness'
import { createCodexLiveUsage, CODEX_DEFAULT_LIMIT_ID } from '../../../src/main/providers/codex'
import type { CodexUsageFsPort } from '../../../src/main/providers/codex'
import type { ProviderAccountUsageView, ProviderPreference } from '../../../src/shared/providers'

function usageFs() {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
  const dirs = new Set<string>()
  const files = new Map<string, string>()
  const calls: string[] = []
  /** Awaited before a rollout's read returns (a test changes the registry there). */
  const hooks: { beforeTail?: (file: string) => Promise<void> } = {}
  const parent = (p: string) => norm(p).split('\\').slice(0, -1).join('\\')
  const ino = (p: string) => String([...norm(p)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7))
  const port: CodexUsageFsPort = {
    platform: 'win32',
    lstat: async (p) => {
      calls.push(`lstat ${p}`)
      const n = norm(p)
      if (dirs.has(n)) return { kind: 'dir', dev: '9', ino: ino(p), nlink: 1, size: 0, mtimeMs: 1 }
      const t = files.get(n)
      if (t !== undefined) return { kind: 'file', dev: '9', ino: ino(p), nlink: 1, size: t.length, mtimeMs: 1 }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    readdir: async (dir, visit) => {
      calls.push(`readdir ${dir}`)
      const n = norm(dir)
      if (!dirs.has(n)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      const names = [...new Set([...dirs, ...files.keys()].filter((x) => parent(x) === n).map((x) => x.slice(n.length + 1)))]
      for (const name of names) if (visit(name) === false) break
    },
    readTail: async (file) => {
      calls.push(`readTail ${file}`)
      await hooks.beforeTail?.(file)
      const t = files.get(norm(file))
      if (t === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { text: t, whole: true }
    },
  }
  return {
    port, calls, hooks,
    rollout: (sessions: string, pct: number, plan = 'plus', credits?: unknown) => {
      // A past day: a reading time later than now would be held to now.
      const d = `${sessions}\\2026\\09\\20`
      const parts = norm(d).split('\\')
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('\\'))
      files.set(norm(`${d}\\rollout-2026-09-20T09-00-00-a.jsonl`), JSON.stringify({
        timestamp: '2026-09-20T09:00:01Z', type: 'event_msg',
        payload: { type: 'token_count', info: null, rate_limits: { limit_id: CODEX_DEFAULT_LIMIT_ID, primary: { used_percent: pct, window_minutes: 300 }, plan_type: plan, ...(credits === undefined ? {} : { credits }) } },
      }) + '\n')
    },
  }
}

async function setup(pref: Partial<Record<'claude' | 'codex', ProviderPreference | (() => ProviderPreference)>> = {}) {
  const fs = usageFs()
  const live = createCodexLiveUsage('win32')
  let codexPref: ProviderPreference | (() => ProviderPreference) = 'on'
  const h = await harness({ usageFs: fs.port, liveUsage: live, preference: { codex: () => (typeof codexPref === 'function' ? codexPref() : codexPref), ...(pref.claude ? { claude: pref.claude } : {}) } })
  if (pref.codex !== undefined) codexPref = pref.codex
  return { h, fs, live, setCodex: (p: ProviderPreference | (() => ProviderPreference)) => { codexPref = p } }
}

const sessionsOf = (h: Harness, accountId: string) => {
  const realmId = h.doc().accounts.find((a) => a.id === accountId)!.authRealmId
  return `${managedHome(realmId)}\\sessions`
}

async function stream(h: Harness, opts: { shouldContinue?: () => boolean } = {}) {
  const got: ProviderAccountUsageView[] = []
  const r = await h.service.streamAccountUsage({ providerId: 'codex' }, (v) => got.push(v), opts)
  return { r, got }
}

describe('a provider that is off makes no call (D5; owner decision 2026-09-26)', () => {
  for (const [name, pref] of [['off', 'off'], ['not set up', 'undecided'], ['unreadable', () => { throw new Error('settings unreadable') }]] as const) {
    it(`Codex ${name}: no view, no file read, no process`, async () => {
      const t = await setup()
      const a = await addCodexAccount(t.h, 'A')
      t.fs.rollout(sessionsOf(t.h, a), 10)
      t.setCodex(pref as ProviderPreference | (() => ProviderPreference))
      const runs = t.h.runs.length
      const discoveries = t.h.discoveries()
      const baseEnv = t.h.baseEnvReads()
      const s = await stream(t.h)
      expect(s.r).toEqual({ ok: true, provider: 'off', accounts: 0 })
      expect(s.got).toEqual([])
      expect(await t.h.service.readAccountUsage({ accountId: a })).toEqual({ ok: true, usage: { accountId: a, providerId: 'codex', status: 'off', buckets: [] } })
      expect(t.fs.calls).toEqual([])
      expect(t.h.runs.length).toBe(runs)
      expect(t.h.discoveries()).toBe(discoveries)
      expect(t.h.baseEnvReads()).toBe(baseEnv)
    })
  }

  it('a switch-off during a stream stops it before the next account is read', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    const b = await addCodexAccount(t.h, 'B')
    t.fs.rollout(sessionsOf(t.h, a), 10)
    t.fs.rollout(sessionsOf(t.h, b), 20)
    const got: ProviderAccountUsageView[] = []
    const r = await t.h.service.streamAccountUsage({ providerId: 'codex' }, (v) => { got.push(v); t.setCodex('off') })
    expect(got).toHaveLength(1)
    expect(r).toMatchObject({ ok: true, provider: 'on', accounts: 1 })
    const second = got[0].accountId === a ? b : a
    expect(t.fs.calls.some((c) => c.toLowerCase().includes(sessionsOf(t.h, second).toLowerCase()))).toBe(false)
  })

  it('a stream nobody wants any more stops before the next account is read', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    const b = await addCodexAccount(t.h, 'B')
    t.fs.rollout(sessionsOf(t.h, a), 10)
    t.fs.rollout(sessionsOf(t.h, b), 20)
    let wanted = true
    const got: ProviderAccountUsageView[] = []
    await t.h.service.streamAccountUsage({ providerId: 'codex' }, (v) => { got.push(v); wanted = false }, { shouldContinue: () => wanted })
    expect(got).toHaveLength(1)
    const second = got[0].accountId === a ? b : a
    expect(t.fs.calls.some((c) => c.toLowerCase().includes(sessionsOf(t.h, second).toLowerCase()))).toBe(false)
  })

  it('a shouldContinue that throws stops the stream (fail closed)', async () => {
    const t = await setup()
    await addCodexAccount(t.h, 'A')
    const got: ProviderAccountUsageView[] = []
    const r = await t.h.service.streamAccountUsage({ providerId: 'codex' }, (v) => got.push(v), { shouldContinue: () => { throw new Error('gone') } })
    expect(got).toEqual([])
    expect(r).toEqual({ ok: true, provider: 'on', accounts: 0 })
    expect(t.fs.calls).toEqual([])
  })

  // Review M1: the stream gives the event loop a turn before each account, so
  // a page that closed, a newer stream or a switch-off (all delivered as
  // events) stops it before the next account is read.
  it('yields to the event loop before each account', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    const b = await addCodexAccount(t.h, 'B')
    t.fs.rollout(sessionsOf(t.h, a), 10)
    t.fs.rollout(sessionsOf(t.h, b), 20)
    let wanted = true
    const got: ProviderAccountUsageView[] = []
    await t.h.service.streamAccountUsage({ providerId: 'codex' }, (v) => { got.push(v); setImmediate(() => { wanted = false }) }, { shouldContinue: () => wanted })
    expect(got).toHaveLength(1)
  })

  // Review Q1 (MP3 round 2): each account is found again in the registry as
  // it is when its turn comes, not as it was when the stream began.
  it('an account archived while the stream runs is skipped, and nothing of it is read', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    const b = await addCodexAccount(t.h, 'B')
    t.fs.rollout(sessionsOf(t.h, a), 10)
    t.fs.rollout(sessionsOf(t.h, b), 20)
    const bSessions = sessionsOf(t.h, b).toLowerCase()
    let once = false
    t.fs.hooks.beforeTail = async () => {
      if (once) return
      once = true
      expect(await t.h.service.setLifecycle({ accountId: b, lifecycle: 'inactive' })).toEqual({ ok: true })
      expect(await t.h.service.setLifecycle({ accountId: b, lifecycle: 'archived' })).toEqual({ ok: true })
    }
    const s = await stream(t.h)
    expect(s.got.map((v) => v.accountId)).toEqual([a])
    expect(s.r).toMatchObject({ ok: true, provider: 'on', accounts: 1 })
    expect(t.fs.calls.some((c) => c.toLowerCase().includes(bSessions))).toBe(false)
  })

  it('an account made inactive while the stream runs shows as inactive, and nothing of it is read', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    const b = await addCodexAccount(t.h, 'B')
    t.fs.rollout(sessionsOf(t.h, a), 10)
    t.fs.rollout(sessionsOf(t.h, b), 20)
    const bSessions = sessionsOf(t.h, b).toLowerCase()
    let once = false
    t.fs.hooks.beforeTail = async () => {
      if (once) return
      once = true
      expect(await t.h.service.setLifecycle({ accountId: b, lifecycle: 'inactive' })).toEqual({ ok: true })
    }
    const s = await stream(t.h)
    expect(s.got.map((v) => [v.accountId, v.status])).toEqual([[a, 'ok'], [b, 'inactive']])
    expect(t.fs.calls.some((c) => c.toLowerCase().includes(bSessions))).toBe(false)
  })
})

describe('what each account shows (plan section 3)', () => {
  // MP8: a closed ChatGPT account is read afresh first (codex-usage-read
  // tests); the fake CLI's helper here exits at once, so the read fails and
  // the card falls to the last-seen reading.
  it('a closed managed account whose fresh read fails shows its last-seen reading, read only from its own sessions folder', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    t.fs.rollout(sessionsOf(t.h, a), 37, 'pro')
    const runs = t.h.runs.length
    const r = await t.h.service.readAccountUsage({ accountId: a }, { read: true })
    expect(r).toMatchObject({ ok: true, usage: { accountId: a, providerId: 'codex', status: 'ok', source: 'last-seen', readingAt: Date.parse('2026-09-20T09:00:01Z'), planLabel: 'Pro' } })
    if (!r.ok) throw new Error(r.code)
    expect(r.usage.buckets.map((b) => [b.label, b.percent])).toEqual([['5h', 37]])
    for (const c of t.fs.calls) expect(c.toLowerCase()).toContain(sessionsOf(t.h, a).toLowerCase())
    const realmId = t.h.doc().accounts.find((x) => x.id === a)!.authRealmId
    expect(t.h.runs.slice(runs).map((x) => [x.args, x.home])).toEqual([['app-server', managedHome(realmId)]])
  })

  it('an account with no reading yet says so', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    expect(await t.h.service.readAccountUsage({ accountId: a })).toEqual({ ok: true, usage: { accountId: a, providerId: 'codex', status: 'no-session-yet', buckets: [] } })
  })

  it('an account in use shows its live figure without reading any file; with none yet, its last-seen reading', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    t.fs.rollout(sessionsOf(t.h, a), 15)
    const lease = t.h.leases.add(a, 'codex', { kind: 'session', ownerId: 'sess-1' })
    expect(lease.ok).toBe(true)
    const fallback = await t.h.service.readAccountUsage({ accountId: a })
    expect(fallback).toMatchObject({ ok: true, usage: { status: 'ok', source: 'last-seen' } })
    t.fs.calls.length = 0
    t.live.record(sessionsOf(t.h, a), { limits: [{ limitId: 'codex', limitName: null, readingAt: 1234, primary: { windowMinutes: 300, usedPercent: 52, resetsAt: null }, secondary: null }], planType: 'plus', readingAt: 1234 })
    const r = await t.h.service.readAccountUsage({ accountId: a })
    expect(r).toMatchObject({ ok: true, usage: { status: 'ok', source: 'live', readingAt: 1234, planLabel: 'Plus' } })
    if (!r.ok) throw new Error(r.code)
    expect(r.usage.buckets.map((b) => b.percent)).toEqual([52])
    expect(t.fs.calls).toEqual([])
  })

  it('a closed account never shows another realm\'s live figure', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    const b = await addCodexAccount(t.h, 'B')
    t.live.record(sessionsOf(t.h, b), { limits: [{ limitId: 'codex', limitName: null, readingAt: 1, primary: { windowMinutes: 300, usedPercent: 90, resetsAt: null }, secondary: null }], planType: null, readingAt: 1 })
    expect(await t.h.service.readAccountUsage({ accountId: a })).toMatchObject({ ok: true, usage: { status: 'no-session-yet' } })
  })

  it('an API-key account is billed per token: nothing is read', async () => {
    const t = await setup()
    const k = await addCodexAccount(t.h, 'Key', 'apiKey')
    t.fs.rollout(sessionsOf(t.h, k), 50)
    expect(await t.h.service.readAccountUsage({ accountId: k })).toEqual({ ok: true, usage: { accountId: k, providerId: 'codex', status: 'per-token', buckets: [] } })
    expect(t.fs.calls).toEqual([])
  })

  it('an inactive account reads nothing; an archived one is not listed and not served', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    const b = await addCodexAccount(t.h, 'B')
    const c = await addCodexAccount(t.h, 'C')
    for (const id of [a, b, c]) t.fs.rollout(sessionsOf(t.h, id), 30)
    expect((await t.h.service.setLifecycle({ accountId: b, lifecycle: 'inactive' })).ok).toBe(true)
    // An archive starts from inactive (the lifecycle rules).
    expect((await t.h.service.setLifecycle({ accountId: c, lifecycle: 'inactive' })).ok).toBe(true)
    expect((await t.h.service.setLifecycle({ accountId: c, lifecycle: 'archived' })).ok).toBe(true)
    t.fs.calls.length = 0
    expect(await t.h.service.readAccountUsage({ accountId: b })).toEqual({ ok: true, usage: { accountId: b, providerId: 'codex', status: 'inactive', buckets: [] } })
    expect(t.fs.calls).toEqual([])
    expect(await t.h.service.readAccountUsage({ accountId: c })).toMatchObject({ ok: false, code: 'not-found' })
    const s = await stream(t.h)
    expect(s.got.map((v) => v.accountId).sort()).toEqual([a, b].sort())
    expect(s.r).toEqual({ ok: true, provider: 'on', accounts: 2 })
  })

  it('an account whose realm is not active shows an error and nothing of it is read', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    t.fs.rollout(sessionsOf(t.h, a), 30)
    const realmId = t.h.doc().accounts.find((x) => x.id === a)!.authRealmId
    // Retired (P3.3: an account's own realm is never "retiring", only one it moved off).
    const r = await t.h.store.mutate((d) => ({ ok: true, doc: { ...d, realms: d.realms.map((x) => (x.id === realmId ? { ...x, lifecycle: 'retired' as const } : x)) } }))
    expect(r.ok).toBe(true)
    t.fs.calls.length = 0
    expect(await t.h.service.readAccountUsage({ accountId: a })).toEqual({ ok: true, usage: { accountId: a, providerId: 'codex', status: 'error', buckets: [] } })
    const s = await stream(t.h)
    expect(s.got).toEqual([{ accountId: a, providerId: 'codex', status: 'error', buckets: [] }])
    expect(t.fs.calls).toEqual([])
  })

  it('an archived account is refused on its own record, even where its realm still reads as active', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    const b = await addCodexAccount(t.h, 'B')
    t.fs.rollout(sessionsOf(t.h, b), 30)
    // The record alone says archived; the realm is left as it was.
    const r = await t.h.store.mutate((d) => ({ ok: true, doc: { ...d, accounts: d.accounts.map((x) => (x.id === b ? { ...x, lifecycle: 'archived' as const, isProviderDefault: false } : x)) } }))
    expect(r.ok).toBe(true)
    expect(await t.h.service.readAccountUsage({ accountId: b })).toMatchObject({ ok: false, code: 'not-found' })
    const s = await stream(t.h)
    expect(s.got.map((v) => v.accountId)).toEqual([a])
    expect(t.fs.calls.some((c) => c.toLowerCase().includes(sessionsOf(t.h, b).toLowerCase()))).toBe(false)
  })

  it('a signed-out account says so, with its last-seen reading', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    t.fs.rollout(sessionsOf(t.h, a), 12)
    const realmHome = managedHome(t.h.doc().accounts.find((x) => x.id === a)!.authRealmId)
    t.h.signedIn.delete(realmHome.toLowerCase())
    expect((await t.h.service.refreshStatus({ accountId: a })).ok).toBe(true)
    expect(await t.h.service.readAccountUsage({ accountId: a })).toMatchObject({ ok: true, usage: { status: 'not-signed-in', source: 'last-seen' } })
  })

  // P3.14 (ADR-023): a Codex account's credits count comes with its allowance,
  // from whichever source shows it, and the view has no credits key at all when
  // the reading has none.
  describe('credits (P3.14)', () => {
    const CREDITS = { has_credits: true, unlimited: false, balance: '1250.0000000000' }
    const SHOWN = { hasCredits: true, unlimited: false, balance: 1250 }
    const hasKey = (v: object) => Object.prototype.hasOwnProperty.call(v, 'credits')

    it('a closed account\'s last-seen reading carries its credits', async () => {
      const t = await setup()
      const a = await addCodexAccount(t.h, 'A')
      t.fs.rollout(sessionsOf(t.h, a), 37, 'pro', CREDITS)
      const r = await t.h.service.readAccountUsage({ accountId: a }, { read: true })
      expect(r).toMatchObject({ ok: true, usage: { status: 'ok', source: 'last-seen', credits: SHOWN } })
    })

    it('an account in use shows the credits of its live figure', async () => {
      const t = await setup()
      const a = await addCodexAccount(t.h, 'A')
      expect(t.h.leases.add(a, 'codex', { kind: 'session', ownerId: 'sess-1' }).ok).toBe(true)
      t.live.record(sessionsOf(t.h, a), { limits: [{ limitId: 'codex', limitName: null, readingAt: 1234, primary: { windowMinutes: 300, usedPercent: 52, resetsAt: null }, secondary: null }], planType: 'plus', readingAt: 1234, credits: { hasCredits: true, unlimited: true, balance: null } })
      const r = await t.h.service.readAccountUsage({ accountId: a })
      expect(r).toMatchObject({ ok: true, usage: { status: 'ok', source: 'live', credits: { hasCredits: true, unlimited: true, balance: null } } })
    })

    it('a signed-out account\'s last-seen reading carries its credits', async () => {
      const t = await setup()
      const a = await addCodexAccount(t.h, 'A')
      t.fs.rollout(sessionsOf(t.h, a), 12, 'plus', CREDITS)
      const realmHome = managedHome(t.h.doc().accounts.find((x) => x.id === a)!.authRealmId)
      t.h.signedIn.delete(realmHome.toLowerCase())
      expect((await t.h.service.refreshStatus({ accountId: a })).ok).toBe(true)
      expect(await t.h.service.readAccountUsage({ accountId: a })).toMatchObject({ ok: true, usage: { status: 'not-signed-in', source: 'last-seen', credits: SHOWN } })
    })

    it('no credits key at all when the reading has none (last-seen, live, and no session yet)', async () => {
      const t = await setup()
      const a = await addCodexAccount(t.h, 'A')
      const none = await t.h.service.readAccountUsage({ accountId: a })
      expect(none.ok && hasKey(none.usage)).toBe(false)
      t.fs.rollout(sessionsOf(t.h, a), 37, 'pro')
      const seen = await t.h.service.readAccountUsage({ accountId: a }, { read: true })
      expect(seen.ok && seen.usage.source === 'last-seen' && !hasKey(seen.usage)).toBe(true)
      expect(t.h.leases.add(a, 'codex', { kind: 'session', ownerId: 'sess-1' }).ok).toBe(true)
      t.live.record(sessionsOf(t.h, a), { limits: [{ limitId: 'codex', limitName: null, readingAt: 9, primary: { windowMinutes: 300, usedPercent: 5, resetsAt: null }, secondary: null }], planType: null, readingAt: 9 })
      const live = await t.h.service.readAccountUsage({ accountId: a })
      expect(live.ok && live.usage.source === 'live' && !hasKey(live.usage)).toBe(true)
    })

    it('the view carries the three credits fields and nothing else of the reading\'s', async () => {
      const t = await setup()
      const a = await addCodexAccount(t.h, 'A')
      t.fs.rollout(sessionsOf(t.h, a), 37, 'pro', { ...CREDITS, extra: 'x-secret' })
      const r = await t.h.service.readAccountUsage({ accountId: a }, { read: true })
      if (!r.ok) throw new Error(r.code)
      expect(JSON.stringify(r.usage)).not.toContain('x-secret')
      expect(Object.keys(r.usage.credits!).sort()).toEqual(['balance', 'hasCredits', 'unlimited'])
    })
  })

  it('this computer\'s own sign-in is read only from its history, never by anything else', async () => {
    const t = await setup()
    t.h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    const adopted = await t.h.service.adoptExternalDefault({ providerId: 'codex' })
    if (!adopted.ok) throw new Error(adopted.code)
    t.fs.rollout(`${EXT_HOME}\\sessions`, 64)
    const runs = t.h.runs.length
    const r = await t.h.service.readAccountUsage({ accountId: adopted.accountId })
    expect(r).toMatchObject({ ok: true, usage: { status: 'ok', source: 'last-seen' } })
    expect(t.fs.calls.length).toBeGreaterThan(0)
    for (const c of t.fs.calls) expect(c.slice(c.indexOf(' ') + 1).toLowerCase().startsWith(`${EXT_HOME.toLowerCase()}\\sessions`), c).toBe(true)
    expect(t.h.runs.length).toBe(runs)
  })

  // Review M4: usage holds a realm to the launch's own canonical-home check. A
  // managed home that resolves to another real folder (a junction or link) is
  // refused by a launch, so it is never read here either: the card is an
  // error and no usage file is touched. (This computer's ~/.codex is resolved
  // to its canonical folder when the realm is located, for a launch and for
  // usage alike, so both use the same folder.)
  it('a managed realm whose home resolves elsewhere (a junction or link) is refused before any read, as a launch refuses it', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    t.fs.rollout(sessionsOf(t.h, a), 30)
    const home = managedHome(t.h.doc().accounts.find((x) => x.id === a)!.authRealmId)
    const realpath = t.h.folders.fs.realpath
    // The home resolves to another folder that exists: only the path check can tell.
    t.h.folders.fs.realpath = (p: string) => (p.replace(/[\\/]+$/, '').toLowerCase() === home.toLowerCase() ? 'C:\\tools' : realpath(p))
    t.fs.calls.length = 0
    expect(await t.h.service.readAccountUsage({ accountId: a })).toEqual({ ok: true, usage: { accountId: a, providerId: 'codex', status: 'error', buckets: [] } })
    expect(t.fs.calls).toEqual([])
    // The same home is refused by a launch.
    expect(await t.h.service.prepareLaunch({ kind: 'session', providerId: 'codex', providerAccountId: a, ownerId: 's-junction' })).toMatchObject({ ok: false })
  })

  it('Claude has no usage port here: the service refuses, whatever the name, and reads nothing', async () => {
    const t = await setup()
    expect(await t.h.service.streamAccountUsage({ providerId: 'claude' }, () => { throw new Error('never') })).toMatchObject({ ok: false, code: 'unsupported' })
    expect(t.fs.calls).toEqual([])
  })

  it('the capability decides: account usage turned off reads nothing', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    t.fs.rollout(sessionsOf(t.h, a), 10)
    t.h.setCapabilities({ 'account.usage': { state: 'unknown', note: 'off for this test' } })
    expect(await t.h.service.readAccountUsage({ accountId: a })).toMatchObject({ ok: false, code: 'unsupported' })
    expect(await t.h.service.streamAccountUsage({ providerId: 'codex' }, () => {})).toMatchObject({ ok: false, code: 'unsupported' })
    expect(t.fs.calls).toEqual([])
  })

  it('an unknown or malformed account id is not found', async () => {
    const t = await setup()
    expect(await t.h.service.readAccountUsage({ accountId: 'acct-' + 'f'.repeat(32) })).toMatchObject({ ok: false, code: 'not-found' })
    expect(await t.h.service.readAccountUsage({ accountId: 42 as unknown as string })).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('no view carries a path', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    t.fs.rollout(sessionsOf(t.h, a), 10)
    t.h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    await t.h.service.adoptExternalDefault({ providerId: 'codex' })
    t.fs.rollout(`${EXT_HOME}\\sessions`, 20)
    const s = await stream(t.h)
    expect(s.got).toHaveLength(2)
    const text = JSON.stringify(s.got)
    for (const bad of ['C:\\\\', 'codex-realms', '.codex', 'sessions', 'rollout-', 'realm-']) expect(text, bad).not.toContain(bad)
    for (const v of s.got) expect(Object.keys(v).sort()).toEqual(expect.arrayContaining(['accountId', 'buckets', 'providerId', 'status']))
  })
})
