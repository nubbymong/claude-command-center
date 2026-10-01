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
import { createCodexLiveUsage, createCodexCarryMarks, CODEX_DEFAULT_LIMIT_ID } from '../../../src/main/providers/codex'
import type { CodexUsageFsPort, CodexCarryMarks, CodexCarryMarksPort } from '../../../src/main/providers/codex'
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
    /** A rollout of conversation `id` with exactly this text (a carried copy, P3.14 round 1). */
    rolloutText: (sessions: string, id: string, text: string) => {
      const d = `${sessions}\\2026\\09\\20`
      const parts = norm(d).split('\\')
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('\\'))
      files.set(norm(`${d}\\rollout-2026-09-20T09-00-00-${id}.jsonl`), text)
    },
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

// P3.14 round 1, C2 (ADR-023): Switch Account carries a conversation into the
// account it moves to, and the copy holds the earlier account's events. The
// accounts service's carry marks it, and the page's card for the new account
// counts only what that account writes after the carry. Through the real
// accounts service, the real Codex package and its realm folders, a stub for
// the file work, and an in-memory usage filesystem.
describe('a conversation carried by Switch Account (P3.14 round 1, C2; ADR-023)', () => {
  const CID = '0198a0b0-1c2d-7e3f-8a4b-5c6d7e8f9a0b'
  const ev = (ts: string, pct: number, plan: string, credits: unknown) => JSON.stringify({
    timestamp: ts, type: 'event_msg',
    payload: { type: 'token_count', info: null, rate_limits: { limit_id: CODEX_DEFAULT_LIMIT_ID, primary: { used_percent: pct, window_minutes: 300 }, plan_type: plan, credits } },
  })
  const A_PRO = { has_credits: true, unlimited: false, balance: '1250.0000000000' }
  // Account A (Pro, 1250 credits) ran the conversation; account B (Plus, no credits) takes it over.
  const A_EVENT = ev('2026-09-20T09:00:00Z', 40, 'pro', A_PRO)
  const B_EVENT = ev('2026-09-20T10:00:00Z', 5, 'plus', null)
  const SWITCH_TO_B = Date.parse('2026-09-20T09:30:00Z')

  async function carryWorld(opts: { newestStamp?: (dir: string, id: string) => number | null } = {}) {
    const fs = usageFs()
    const live = createCodexLiveUsage('win32')
    // The marks' file, in memory, and a store that can be "restarted" over it.
    const box: { text: string | null; kind: null | 'unavailable' | 'corrupt'; asides: number } = { text: null, kind: null, asides: 0 }
    const port: CodexCarryMarksPort = {
      read: () => (box.kind === 'unavailable' ? { kind: 'unavailable' } : box.kind === 'corrupt' ? { kind: 'corrupt' } : box.text === null ? { kind: 'missing' } : { kind: 'ok', text: box.text }),
      write: (text) => { box.text = text },
      setAside: (replacement) => { box.asides++; box.text = replacement; box.kind = null; return true },
    }
    // The marks' own clock (the wait before an unreadable file is read again, the floor of a lost one).
    let markNow = SWITCH_TO_B
    const fresh = () => createCodexCarryMarks({ platform: 'win32', port, now: () => markNow })
    let marks = fresh()
    const store: CodexCarryMarks = {
      record: (...a) => marks.record(...a), markOf: (...a) => marks.markOf(...a), remove: (...a) => marks.remove(...a), cutoff: (...a) => marks.cutoff(...a),
      dropRealm: (r) => marks.dropRealm(r), adopt: (...a) => marks.adopt(...a), markIfNone: (...a) => marks.markIfNone(...a),
    }
    let now = SWITCH_TO_B
    let carried: 'copied' | 'extended' = 'copied'
    const h = await harness({
      usageFs: fs.port, liveUsage: live, preference: { codex: () => 'on' },
      carryMarks: store, carryNow: () => now,
      ...(opts.newestStamp ? { newestCopiedStamp: opts.newestStamp } : {}),
      conversationCarry: async () => ({ ok: true, carried, bytes: 1 }),
    })
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    const text = (...lines: string[]) => lines.join('\n') + '\n'
    return {
      h, fs, live, a, b, box, marks: () => marks, text,
      restart: () => { marks = fresh() },
      setMarkClock: (t: number) => { markNow = t },
      /** The switch: the conversation is carried from `from` into `to` at `at`. */
      carry: async (from: string, to: string, at: number, how: 'copied' | 'extended' = 'copied') => {
        now = at
        carried = how
        return h.service.carryConversation({ accountId: to }, { uuid: CID, cwd: 'C:\\p\\demo', accountId: from })
      },
      card: async (accountId: string) => {
        const r = await h.service.readAccountUsage({ accountId }, { read: true })
        if (!r.ok) throw new Error(r.code)
        return r.usage
      },
    }
  }

  it('B\'s card shows nothing of A\'s bars, plan or credits after the carry, and after an app restart; then B\'s own event shows', async () => {
    const w = await carryWorld()
    // The carry put A's rollout into B's folder.
    w.fs.rolloutText(sessionsOf(w.h, w.b), CID, w.text(A_EVENT))
    expect(await w.carry(w.a, w.b, SWITCH_TO_B)).toEqual({ ok: true, carried: 'copied' })
    const before = await w.card(w.b)
    expect(before).toMatchObject({ status: 'no-session-yet', buckets: [] })
    for (const key of ['credits', 'planLabel', 'source', 'readingAt']) expect(Object.prototype.hasOwnProperty.call(before, key), key).toBe(false)
    // After an app restart the marks are read back from their file.
    w.restart()
    expect(await w.card(w.b)).toMatchObject({ status: 'no-session-yet', buckets: [] })
    // B reports its own event: its own bars and plan, and no credits.
    w.fs.rolloutText(sessionsOf(w.h, w.b), CID, w.text(A_EVENT, B_EVENT))
    const after = await w.card(w.b)
    expect(after).toMatchObject({ status: 'ok', source: 'last-seen', planLabel: 'Plus', readingAt: Date.parse('2026-09-20T10:00:00Z') })
    expect(after.buckets.map((b) => b.percent)).toEqual([5])
    expect(Object.prototype.hasOwnProperty.call(after, 'credits')).toBe(false)
    // And again after a restart.
    w.restart()
    expect((await w.card(w.b)).buckets.map((b) => b.percent)).toEqual([5])
  })

  it('an account with a session open shows none of A\'s figures either: the live figure is none, so its history answers, from the carry on', async () => {
    const w = await carryWorld()
    w.fs.rolloutText(sessionsOf(w.h, w.b), CID, w.text(A_EVENT))
    await w.carry(w.a, w.b, SWITCH_TO_B)
    expect(w.h.leases.add(w.b, 'codex', { kind: 'session', ownerId: 'sess-1' }).ok).toBe(true)
    const r = await w.h.service.readAccountUsage({ accountId: w.b })
    expect(r).toMatchObject({ ok: true, usage: { status: 'no-session-yet', buckets: [] } })
  })

  it('without a carry the same rollout is the account\'s own (the control)', async () => {
    const w = await carryWorld()
    w.fs.rolloutText(sessionsOf(w.h, w.b), CID, w.text(A_EVENT))
    const own = await w.card(w.b)
    expect(own).toMatchObject({ status: 'ok', planLabel: 'Pro', credits: { hasCredits: true, unlimited: false, balance: 1250 } })
  })

  it('A, then B, then back to A: A\'s card shows A\'s own events after the return, not B\'s', async () => {
    const w = await carryWorld()
    w.fs.rolloutText(sessionsOf(w.h, w.b), CID, w.text(A_EVENT))
    await w.carry(w.a, w.b, SWITCH_TO_B)
    // B ran it for an hour, then it comes back: A's folder now holds the whole conversation.
    const BACK_TO_A = Date.parse('2026-09-20T11:00:00Z')
    w.fs.rolloutText(sessionsOf(w.h, w.a), CID, w.text(A_EVENT, B_EVENT))
    expect(await w.carry(w.b, w.a, BACK_TO_A, 'extended')).toEqual({ ok: true, carried: 'extended' })
    expect(await w.card(w.a)).toMatchObject({ status: 'no-session-yet', buckets: [] })
    // A reports its own event after coming back.
    w.fs.rolloutText(sessionsOf(w.h, w.a), CID, w.text(A_EVENT, B_EVENT, ev('2026-09-20T12:00:00Z', 14, 'pro', A_PRO)))
    const r = await w.card(w.a)
    expect(r).toMatchObject({ status: 'ok', planLabel: 'Pro', credits: { hasCredits: true, unlimited: false, balance: 1250 } })
    expect(r.buckets.map((b) => b.percent)).toEqual([14])
    // B's own mark stands beside it.
    expect(w.marks().cutoff(sessionsOf(w.h, w.b), CID)).toBe(SWITCH_TO_B)
  })

  it('removing an account (archive) drops its marks, and not the other account\'s', async () => {
    const w = await carryWorld()
    w.fs.rolloutText(sessionsOf(w.h, w.b), CID, w.text(A_EVENT))
    w.fs.rolloutText(sessionsOf(w.h, w.a), CID, w.text(A_EVENT))
    await w.carry(w.a, w.b, SWITCH_TO_B)
    await w.carry(w.b, w.a, SWITCH_TO_B + 1000, 'extended')
    expect(w.marks().cutoff(sessionsOf(w.h, w.b), CID)).toBe(SWITCH_TO_B)
    expect((await w.h.service.setLifecycle({ accountId: w.b, lifecycle: 'inactive' })).ok).toBe(true)
    expect(w.marks().cutoff(sessionsOf(w.h, w.b), CID)).toBe(SWITCH_TO_B)
    expect(await w.h.service.setLifecycle({ accountId: w.b, lifecycle: 'archived' })).toEqual({ ok: true })
    expect(w.marks().cutoff(sessionsOf(w.h, w.b), CID)).toBeNull()
    expect(w.marks().cutoff(sessionsOf(w.h, w.a), CID)).toBe(SWITCH_TO_B + 1000)
    // The drop is in the file too: a restart finds the same.
    w.restart()
    expect(w.marks().cutoff(sessionsOf(w.h, w.b), CID)).toBeNull()
    expect(w.marks().cutoff(sessionsOf(w.h, w.a), CID)).toBe(SWITCH_TO_B + 1000)
  })

  it('a provider that fails to forget an archived account\'s marks never fails the archive', async () => {
    const w = await carryWorld()
    const folders = w.h.codex.realmFolders as unknown as { forget: (ref: unknown) => void }
    folders.forget = () => { throw new Error('forget') }
    expect((await w.h.service.setLifecycle({ accountId: w.b, lifecycle: 'inactive' })).ok).toBe(true)
    expect(await w.h.service.setLifecycle({ accountId: w.b, lifecycle: 'archived' })).toEqual({ ok: true })
  })

  it('a carry that failed marks nothing: the destination\'s own earlier history still reads whole', async () => {
    const w = await carryWorld()
    w.fs.rolloutText(sessionsOf(w.h, w.b), CID, w.text(A_EVENT))
    // The stub's answer is a refusal this time.
    const refusing = await harness({
      usageFs: w.fs.port, liveUsage: w.live, preference: { codex: () => 'on' }, carryMarks: w.marks(),
      conversationCarry: async () => ({ ok: false, code: 'io-failed' }),
    })
    const a = await addCodexAccount(refusing, 'A')
    const b = await addCodexAccount(refusing, 'B')
    const r = await refusing.service.carryConversation({ accountId: b }, { uuid: CID, cwd: 'C:\\p\\demo', accountId: a })
    expect(r.ok).toBe(false)
    expect(w.marks().cutoff(sessionsOf(refusing, b), CID)).toBeNull()
  })

  // ------------------------------------------------------------------
  // Round 2 (D1, D2, D4, D6, D7)
  // ------------------------------------------------------------------

  it('D1: a clock stepped back since A wrote its events cannot let A\'s later-dated events count for B', async () => {
    // The carry is stamped 09:30, but A's newest event in the copy is dated 09:40 (A's clock was ahead).
    const A_AHEAD = ev('2026-09-20T09:40:00Z', 77, 'pro', A_PRO)
    const w = await carryWorld({ newestStamp: () => Date.parse('2026-09-20T09:40:00Z') })
    w.fs.rolloutText(sessionsOf(w.h, w.b), CID, w.text(A_EVENT, A_AHEAD))
    expect(await w.carry(w.a, w.b, SWITCH_TO_B)).toEqual({ ok: true, carried: 'copied' })
    expect(w.marks().markOf(sessionsOf(w.h, w.b), CID)).toBe(Date.parse('2026-09-20T09:40:00Z'))
    expect(await w.card(w.b)).toMatchObject({ status: 'no-session-yet', buckets: [] })
    // B's own event after that shows.
    w.fs.rolloutText(sessionsOf(w.h, w.b), CID, w.text(A_EVENT, A_AHEAD, B_EVENT))
    expect(await w.card(w.b)).toMatchObject({ status: 'ok', planLabel: 'Plus' })
    // Without the newest time, the same copy would have shown A's later event.
    const plain = await carryWorld()
    plain.fs.rolloutText(sessionsOf(plain.h, plain.b), CID, plain.text(A_EVENT, A_AHEAD))
    await plain.carry(plain.a, plain.b, SWITCH_TO_B)
    expect(await plain.card(plain.b)).toMatchObject({ status: 'ok', planLabel: 'Pro' })
  })

  // Round 3 (H1): the harm guarded against is a temporary display of the
  // other account's figures, so an unreadable marks file stops no carry and no
  // Sign in again and makes no card an error. A carry made meanwhile is held in
  // memory and written when the file reads.
  it('H1: while the marks file cannot be read no card is an error: an account nothing was carried into shows its own figure', async () => {
    const w = await carryWorld()
    w.fs.rollout(sessionsOf(w.h, w.a), 30, 'plus')
    w.box.kind = 'unavailable'
    w.restart()
    expect(await w.card(w.a)).toMatchObject({ status: 'ok', planLabel: 'Plus' })
    expect(await w.card(w.b)).toMatchObject({ status: 'no-session-yet', buckets: [] })
  })

  it('H1: a Switch Account carry goes on while the marks file cannot be read, B shows nothing of A until its own report, and the mark is written when the file reads', async () => {
    const w = await carryWorld()
    w.box.kind = 'unavailable'
    w.restart()
    w.fs.rolloutText(sessionsOf(w.h, w.b), CID, w.text(A_EVENT))
    w.fs.rollout(sessionsOf(w.h, w.a), 30, 'plus')
    expect(await w.carry(w.a, w.b, SWITCH_TO_B)).toEqual({ ok: true, carried: 'copied' })
    expect(await w.card(w.b)).toMatchObject({ status: 'no-session-yet', buckets: [] })
    expect(await w.card(w.a)).toMatchObject({ status: 'ok', planLabel: 'Plus' })
    expect(w.box.text).toBeNull()
    // B's own report shows.
    w.fs.rolloutText(sessionsOf(w.h, w.b), CID, w.text(A_EVENT, B_EVENT))
    expect(await w.card(w.b)).toMatchObject({ status: 'ok', planLabel: 'Plus' })
    // The file reads after the wait: the mark is written, and a restart keeps B's card as it was.
    w.box.kind = null
    w.setMarkClock(SWITCH_TO_B + 120_000)
    expect(await w.card(w.b)).toMatchObject({ status: 'ok', planLabel: 'Plus' })
    expect((JSON.parse(w.box.text!) as { marks: Array<{ id: string; at: number }> }).marks.map((m) => [m.id, m.at])).toEqual([[CID, SWITCH_TO_B]])
    w.restart()
    expect(await w.card(w.b)).toMatchObject({ status: 'ok', planLabel: 'Plus' })
  })

  it('D2: a marks file that is not what was written is set aside and nothing dated before then counts, never A\'s events in a carried copy; B\'s own later event does', async () => {
    const w = await carryWorld()
    w.fs.rolloutText(sessionsOf(w.h, w.b), CID, w.text(A_EVENT))
    await w.carry(w.a, w.b, SWITCH_TO_B)
    // The file is damaged before the next start.
    w.box.text = 'not what was written'
    w.setMarkClock(Date.parse('2026-09-20T12:00:00Z'))
    w.restart()
    expect(await w.card(w.b)).toMatchObject({ status: 'no-session-yet', buckets: [] })
    expect(w.box.asides).toBe(1)
    expect(JSON.parse(w.box.text!)).toMatchObject({ schema: 1, floor: Date.parse('2026-09-20T12:00:00Z'), marks: [] })
    // B's own report after that shows; another restart keeps the floor.
    w.fs.rolloutText(sessionsOf(w.h, w.b), CID, w.text(A_EVENT, ev('2026-09-20T13:00:00Z', 5, 'plus', null)))
    w.restart()
    expect(await w.card(w.b)).toMatchObject({ status: 'ok', planLabel: 'Plus' })
  })

  it('H1: a carry is never refused for the marks file: unreadable, it is made and marked in memory', async () => {
    const w = await carryWorld()
    w.box.kind = 'unavailable'
    w.restart()
    let copies = 0
    const h = await harness({
      usageFs: w.fs.port, liveUsage: w.live, preference: { codex: () => 'on' }, carryMarks: w.marks(),
      conversationCarry: async () => { copies++; return { ok: true, carried: 'copied', bytes: 1 } },
    })
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    const r = await h.service.carryConversation({ accountId: b }, { uuid: CID, cwd: 'C:\\p\\demo', accountId: a })
    expect(r).toEqual({ ok: true, carried: 'copied' })
    expect(copies).toBe(1)
    expect(w.marks().markOf(sessionsOf(h, b), CID)).not.toBeNull()
  })

  it('D6: archiving this computer\'s own Codex account (external) forgets its marks too', async () => {
    const w = await carryWorld()
    w.h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    const adopted = await w.h.service.adoptExternalDefault({ providerId: 'codex' })
    if (!adopted.ok) throw new Error(adopted.code)
    const ext = adopted.accountId
    expect(await w.carry(w.a, ext, SWITCH_TO_B)).toEqual({ ok: true, carried: 'copied' })
    const marked = () => (JSON.parse(w.box.text!) as { marks: Array<{ realm: string }> }).marks.map((m) => m.realm)
    const extRealm = w.h.doc().accounts.find((x) => x.id === ext)!.authRealmId
    expect(marked()).toEqual([extRealm])
    expect((await w.h.service.setLifecycle({ accountId: ext, lifecycle: 'inactive' })).ok).toBe(true)
    expect(await w.h.service.setLifecycle({ accountId: ext, lifecycle: 'archived', acknowledgeExternal: true })).toEqual({ ok: true })
    expect(marked()).toEqual([])
  })

  it('D4: a sign in again carries the history into a replacement folder, and the marks go with it', async () => {
    const w = await carryWorld()
    w.fs.rolloutText(sessionsOf(w.h, w.b), CID, w.text(A_EVENT))
    await w.carry(w.a, w.b, SWITCH_TO_B)
    const oldDir = sessionsOf(w.h, w.b)
    expect(await w.h.service.signInAgain({ sameAccount: true, accountId: w.b, method: 'browser' }, 1)).toMatchObject({ ok: true })
    const newDir = sessionsOf(w.h, w.b)
    expect(newDir).not.toBe(oldDir)
    expect(w.marks().cutoff(newDir, CID)).toBe(SWITCH_TO_B)
    // The replacement's copy of the carried conversation shows nothing of A's.
    w.fs.rolloutText(newDir, CID, w.text(A_EVENT))
    expect(await w.card(w.b)).toMatchObject({ status: 'no-session-yet', buckets: [] })
  })

  it('H1: a sign in again is never refused for the marks file: unreadable, it goes on, and the old folder\'s marks follow to the new one once the file reads', async () => {
    const w = await carryWorld()
    w.fs.rolloutText(sessionsOf(w.h, w.b), CID, w.text(A_EVENT))
    await w.carry(w.a, w.b, SWITCH_TO_B)
    const before = sessionsOf(w.h, w.b)
    w.box.kind = 'unavailable'
    w.restart()
    const r = await w.h.service.signInAgain({ sameAccount: true, accountId: w.b, method: 'browser' }, 1)
    expect(r).toMatchObject({ ok: true })
    const after = sessionsOf(w.h, w.b)
    expect(after).not.toBe(before)
    // The replacement's copy of the carried conversation is held while the file cannot be read: nothing of A's shows.
    w.fs.rolloutText(after, CID, w.text(A_EVENT))
    w.setMarkClock(SWITCH_TO_B + 60_000)
    expect(await w.card(w.b)).toMatchObject({ status: 'no-session-yet', buckets: [] })
    // Once it reads, the carried conversation's own mark is on the new folder.
    w.box.kind = null
    w.setMarkClock(SWITCH_TO_B + 180_000)
    expect(w.marks().cutoff(after, CID)).toBe(SWITCH_TO_B)
    expect(await w.card(w.b)).toMatchObject({ status: 'no-session-yet', buckets: [] })
  })

  it('H1: a sign in again goes on whatever the marks do: an adoption that throws, or says no, never stops it', async () => {
    for (const adopt of [(): boolean => { throw new Error('marks') }, () => false]) {
      const w = await carryWorld()
      const marks = { record: () => true, markOf: () => null, remove: () => {}, cutoff: (): number | null => null, dropRealm: () => {}, adopt, markIfNone: () => {} }
      const h = await harness({ usageFs: w.fs.port, liveUsage: w.live, preference: { codex: () => 'on' }, carryMarks: marks })
      const b = await addCodexAccount(h, 'B')
      const r = await h.service.signInAgain({ sameAccount: true, accountId: b, method: 'browser' }, 1)
      expect(r).toMatchObject({ ok: true })
    }
  })

  it('D6: archiving an account forgets the marks of every realm it has had, the ones a sign in again moved it off too', async () => {
    const w = await carryWorld()
    w.fs.rolloutText(sessionsOf(w.h, w.b), CID, w.text(A_EVENT))
    await w.carry(w.a, w.b, SWITCH_TO_B)
    const currentDir = sessionsOf(w.h, w.b)
    // A realm the account was moved off (retired), whose folder and marks are still there.
    const retiredId = 'realm-' + '9'.repeat(32)
    const accountId = w.b
    const owner = w.h.doc().accounts.find((x) => x.id === accountId)!
    const realm = w.h.doc().realms.find((x) => x.id === owner.authRealmId)!
    const injected = await w.h.store.mutate((d) => ({ ok: true as const, doc: { ...d, realms: [...d.realms, { ...realm, id: retiredId, pathRef: `managed:${retiredId}`, lifecycle: 'retired' as const }] } }))
    expect(injected.ok).toBe(true)
    const retiredDir = `${managedHome(retiredId)}\\sessions`
    expect(w.marks().record(retiredId, retiredDir, CID, SWITCH_TO_B)).toBe(true)
    expect((await w.h.service.setLifecycle({ accountId, lifecycle: 'inactive' })).ok).toBe(true)
    expect(await w.h.service.setLifecycle({ accountId, lifecycle: 'archived' })).toEqual({ ok: true })
    expect(w.marks().cutoff(currentDir, CID)).toBeNull()
    expect(w.marks().cutoff(retiredDir, CID)).toBeNull()
    w.restart()
    expect(w.marks().cutoff(retiredDir, CID)).toBeNull()
    // Another account's marks stay.
    expect(w.marks().record('realm-other', 'C:\\x\\sessions', CID, SWITCH_TO_B)).toBe(true)
  })
})
