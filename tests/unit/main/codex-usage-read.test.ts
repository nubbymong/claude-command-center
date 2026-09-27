// Usage track MP8 (ADR-022; the owner's scoped WP1.41 exception): the fresh
// read of a closed Codex account, wired into the usage port and the accounts
// service.
//
// Only an enabled, signed-in, managed ChatGPT account that nothing uses is
// read: never while Codex is off or unanswered, never an API-key account,
// this computer's own Codex folder, an open, signed-out or inactive account,
// and never on a CLI whose version is not `supported`. A CLI that answered
// `unsupported` is not asked again until the executable changes; a transient
// failure is. Reads run one at a time, apart, single-flight per account, a
// reading reused for a minute (a card's Retry reads again), and after three
// transient failures in one stream the rest are not tried. The page closing
// stops the read. A launch, sign-in again, sign-out or inactivate on an
// account with a read in flight stops it and waits for its process chain
// (#49), and never refuses because of it. Every failure shows the last-seen
// reading with its time. The plan a reading names is recorded when it
// changes.
//
// PURE: the port with injected seams, and the real Codex package on the WP1
// harness's fake CLI, whose scripted helper speaks the app-server protocol
// through the runner's openStdin and onChunk seams. No process starts.
import { describe, it, expect } from 'vitest'
import { harness, addCodexAccount, managedHome, EXT_HOME } from '../../wp1/accounts-harness'
import type { Harness, CliRun } from '../../wp1/accounts-harness'
import { createCodexLiveUsage, createCodexUsageOperations, codexExecutableKey, CODEX_DEFAULT_LIMIT_ID } from '../../../src/main/providers/codex'
import type { CodexUsageFsPort, CodexRunResult, CodexUsageRead, CodexUsageReadOptions } from '../../../src/main/providers/codex'
import { USAGE_READ_TRANSIENT_LIMIT } from '../../../src/main/providers/core'
import type { ProviderAccountUsageView, ProviderPreference } from '../../../src/shared/providers'
import type { AllowanceReading } from '../../../src/shared/usage-types'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${what}`)
}

// ---------------------------------------------------------------------------
// The port (codex/usage.ts read): the version rule and the verdict cache.
// ---------------------------------------------------------------------------

const EMPTY_FS: CodexUsageFsPort = {
  platform: 'win32',
  lstat: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
  readdir: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
  readTail: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
}
const READING: AllowanceReading = {
  limits: [{ limitId: 'codex', limitName: null, readingAt: 5000, primary: { windowMinutes: 300, usedPercent: 44, resetsAt: null }, secondary: null }],
  planType: 'pro', readingAt: 5000,
}

function port(o: { version?: string | null; key?: string; answers?: CodexUsageRead[]; noRead?: boolean; throws?: boolean } = {}) {
  const exe = { key: o.key ?? 'exe-1', version: o.version === undefined ? '0.155.1' : o.version }
  const calls: CodexUsageReadOptions[] = []
  const answers = [...(o.answers ?? [])]
  const ops = createCodexUsageOperations({
    sessionsDir: async () => null, fs: EMPTY_FS, live: createCodexLiveUsage('win32'),
    executable: () => exe,
    ...(o.noRead ? {} : {
      readUsage: async (_realm, opts) => {
        calls.push(opts)
        if (o.throws) throw new Error('boom')
        return answers.shift() ?? { ok: true, reading: READING }
      },
    }),
  })
  return { ops, calls, exe }
}
const REALM = { authRealmId: 'realm-' + 'a'.repeat(32) }
const UNSUPPORTED: CodexUsageRead = { ok: false, kind: 'unsupported', reason: 'method-not-found' }
const TRANSIENT: CodexUsageRead = { ok: false, kind: 'transient', reason: 'exit' }

describe('the usage port\'s fresh read (MP8)', () => {
  it('a supported CLI is asked once, with the caller\'s stop and last word; its reading comes back as the page shows it', async () => {
    const t = port()
    const stop = new AbortController()
    const mayStart = () => true
    const r = await t.ops.read!(REALM, { signal: stop.signal, mayStart })
    expect(r.outcome).toEqual({ ok: true, reading: { buckets: [expect.objectContaining({ label: '5h', percent: 44 })], readingAt: 5000, planLabel: 'Pro' } })
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0].signal).toBe(stop.signal)
    expect(t.calls[0].mayStart).toBe(mayStart)
    await expect(r.ended).resolves.toBeUndefined()
  })

  it('ended is the helper\'s own end: it settles when the auth operations say the chain has ended', async () => {
    let finish: () => void = () => {}
    const ops = createCodexUsageOperations({
      sessionsDir: async () => null, fs: EMPTY_FS, live: createCodexLiveUsage('win32'),
      executable: () => ({ key: 'k', version: '0.155.1' }),
      readUsage: async (_r, opts) => { opts.onEnded?.(new Promise<void>((res) => { finish = res })); return { ok: true, reading: READING } },
    })
    const r = await ops.read!(REALM)
    let settled = false
    void r.ended.then(() => { settled = true })
    await tick()
    expect(settled).toBe(false)
    finish()
    await tick()
    expect(settled).toBe(true)
  })

  for (const version of ['0.157.1', '0.153.3', 'banana', null]) {
    it(`a CLI whose version is ${version === null ? 'not known' : version} is never asked`, async () => {
      const t = port({ version })
      expect((await t.ops.read!(REALM)).outcome).toEqual({ ok: false, failure: 'refused' })
      expect(t.calls).toEqual([])
    })
  }

  it('no proven executable: nothing is asked; no read wired: the port has no read at all', async () => {
    let asked = 0
    const none = createCodexUsageOperations({ sessionsDir: async () => null, fs: EMPTY_FS, live: createCodexLiveUsage('win32'), executable: () => null, readUsage: async () => { asked++; return { ok: true, reading: READING } } })
    expect((await none.read!(REALM)).outcome).toEqual({ ok: false, failure: 'refused' })
    expect(asked).toBe(0)
    expect(port({ noRead: true }).ops.read).toBeUndefined()
  })

  it('unsupported is kept for that executable: it is not asked again until the executable changes', async () => {
    const t = port({ answers: [UNSUPPORTED] })
    expect((await t.ops.read!(REALM)).outcome).toEqual({ ok: false, failure: 'unsupported' })
    expect((await t.ops.read!(REALM)).outcome).toEqual({ ok: false, failure: 'unsupported' })
    expect(t.calls).toHaveLength(1)
    t.exe.key = 'exe-2'
    expect((await t.ops.read!(REALM)).outcome.ok).toBe(true)
    expect(t.calls).toHaveLength(2)
  })

  it('an executable replaced during the read keeps no verdict: the new one is asked', async () => {
    let t: ReturnType<typeof port>
    t = port()
    const ops = createCodexUsageOperations({
      sessionsDir: async () => null, fs: EMPTY_FS, live: createCodexLiveUsage('win32'),
      executable: () => t.exe,
      readUsage: async () => { t.exe.key = 'exe-new'; return UNSUPPORTED },
    })
    expect((await ops.read!(REALM)).outcome).toEqual({ ok: false, failure: 'unsupported' })
    t.exe.key = 'exe-1'
    expect((await ops.read!(REALM)).outcome).toEqual({ ok: false, failure: 'unsupported' })
    // Asked again, so the first verdict was not kept.
    expect(t.exe.key).toBe('exe-new')
  })

  it('a transient failure is not kept: the next read asks again', async () => {
    const t = port({ answers: [TRANSIENT] })
    expect((await t.ops.read!(REALM)).outcome).toEqual({ ok: false, failure: 'transient' })
    expect((await t.ops.read!(REALM)).outcome.ok).toBe(true)
    expect(t.calls).toHaveLength(2)
  })

  it('a refusal says refused; a read that throws is refused, never a rejection', async () => {
    expect((await port({ answers: [{ ok: false, kind: 'refused', reason: 'busy' }] }).ops.read!(REALM)).outcome).toEqual({ ok: false, failure: 'refused' })
    await expect(port({ throws: true }).ops.read!(REALM)).resolves.toMatchObject({ outcome: { ok: false, failure: 'refused' } })
  })

  it('the verdicts kept are bounded: the oldest executable is asked again once eight newer ones answered', async () => {
    const t = port({ answers: Array.from({ length: 10 }, () => UNSUPPORTED) })
    for (let i = 0; i < 9; i++) { t.exe.key = `exe-${i}`; await t.ops.read!(REALM) }
    expect(t.calls).toHaveLength(9)
    t.exe.key = 'exe-8'
    await t.ops.read!(REALM)
    expect(t.calls).toHaveLength(9)
    t.exe.key = 'exe-0'
    await t.ops.read!(REALM)
    expect(t.calls).toHaveLength(10)
  })

  it('the verdict key names the executable\'s identity and version, and nothing when none is proven', () => {
    const found = { state: 'found' as const, checkedAt: 1, compatibility: 'supported' as const, version: '0.155.1', identity: { path: 'C:\\Tools\\codex.exe', size: 1, mtimeMs: 2, ctimeMs: 3, dev: '4', ino: '5' } }
    const k = codexExecutableKey(found as never)!
    expect(k.version).toBe('0.155.1')
    for (const change of [{ size: 9 }, { mtimeMs: 9 }, { ctimeMs: 9 }, { ino: '9' }, { dev: '9' }, { path: 'C:\\x\\codex.exe' }]) {
      expect(codexExecutableKey({ ...found, identity: { ...found.identity, ...change } } as never)!.key, JSON.stringify(change)).not.toBe(k.key)
    }
    expect(codexExecutableKey({ ...found, version: '0.155.2' } as never)!.key).not.toBe(k.key)
    expect(codexExecutableKey(null)).toBeNull()
    expect(codexExecutableKey({ ...found, state: 'missing' } as never)).toBeNull()
    expect(codexExecutableKey({ ...found, identity: undefined } as never)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The accounts service: who is read, when, and what waits for it.
// ---------------------------------------------------------------------------

interface HelperOpts {
  percent?: number
  plan?: string
  /** Answer nothing: the read is under way until stopped. */
  hold?: boolean
  /** The read's answer is this JSON-RPC error. */
  error?: { code: number; message: string }
  /** A stopped run's kill still under way until this settles. */
  kill?: Promise<void>
  /** The read is answered only once this settles. */
  gate?: Promise<void>
  /** Stdin closed, the helper exits only once this settles (a stop ends it at once). */
  exitGate?: Promise<void>
}

/** A scripted `codex app-server`: answers initialize naming its CODEX_HOME,
 *  then the read; exits when stdin closes; a stop ends it (the kill chain). */
function appServer(o: HelperOpts = {}) {
  type Rec = { run: CliRun; at: number; endedAt?: number; stopped: boolean; stdinClosed: boolean }
  const seen: Rec[] = []
  const fn = (r: CliRun) => new Promise<Partial<CodexRunResult>>((resolve) => {
    const rec: Rec = { run: r, at: Date.now(), stopped: false, stdinClosed: false }
    seen.push(rec)
    let done = false
    const finish = (x: Partial<CodexRunResult>) => { if (!done) { done = true; rec.endedAt = Date.now(); resolve(x) } }
    const say = (obj: unknown) => { if (!done) r.opts.onChunk?.(JSON.stringify(obj) + '\n', 'stdout') }
    r.opts.signal?.addEventListener('abort', () => { rec.stopped = true; finish({ stopped: 'cancel', spawnError: 'cancelled', ...(o.kill ? { killSettled: o.kill } : {}) }) }, { once: true })
    r.opts.openStdin?.({
      write: (line: string) => {
        if (done) return false
        const m = JSON.parse(line) as { id?: number; method: string }
        if (o.hold) return true
        queueMicrotask(() => {
          if (m.method === 'initialize') say({ id: m.id, result: { codexHome: r.home, platformFamily: 'windows', platformOs: 'windows', userAgent: 'codex_cli_rs/0.155.1' } })
          if (m.method === 'account/rateLimits/read') {
            const answer = () => say(o.error ? { id: m.id, error: o.error } : { id: m.id, result: { rateLimits: { limitId: CODEX_DEFAULT_LIMIT_ID, primary: { usedPercent: o.percent ?? 21, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, planType: o.plan ?? 'pro' } } })
            if (o.gate) void o.gate.then(answer)
            else answer()
          }
        })
        return true
      },
      end: () => {
        rec.stdinClosed = true
        if (o.exitGate) void o.exitGate.then(() => finish({ exitCode: 0 }))
        else queueMicrotask(() => finish({ exitCode: 0 }))
      },
    })
  })
  return { fn, seen }
}

function rolloutFs() {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
  const dirs = new Set<string>()
  const files = new Map<string, string>()
  const parent = (p: string) => norm(p).split('\\').slice(0, -1).join('\\')
  const ino = (p: string) => String([...norm(p)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7))
  const port: CodexUsageFsPort = {
    platform: 'win32',
    lstat: async (p) => {
      const n = norm(p)
      if (dirs.has(n)) return { kind: 'dir', dev: '9', ino: ino(p), nlink: 1, size: 0, mtimeMs: 1 }
      const t = files.get(n)
      if (t !== undefined) return { kind: 'file', dev: '9', ino: ino(p), nlink: 1, size: t.length, mtimeMs: 1 }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    readdir: async (dir, visit) => {
      const n = norm(dir)
      if (!dirs.has(n)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      const names = [...new Set([...dirs, ...files.keys()].filter((x) => parent(x) === n).map((x) => x.slice(n.length + 1)))]
      for (const name of names) if (visit(name) === false) break
    },
    readTail: async (file) => {
      const t = files.get(norm(file))
      if (t === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { text: t, whole: true }
    },
  }
  return {
    port,
    rollout: (sessions: string, pct: number) => {
      const d = `${sessions}\\2026\\09\\20`
      const parts = norm(d).split('\\')
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('\\'))
      files.set(norm(`${d}\\rollout-2026-09-20T09-00-00-a.jsonl`), JSON.stringify({
        timestamp: '2026-09-20T09:00:01Z', type: 'event_msg',
        payload: { type: 'token_count', info: null, rate_limits: { limit_id: CODEX_DEFAULT_LIMIT_ID, primary: { used_percent: pct, window_minutes: 300 }, plan_type: 'plus' } },
      }) + '\n')
    },
  }
}

async function setup(o: { gapMs?: number; settleMaxMs?: number; now?: () => number } = {}) {
  let helper = appServer()
  let pref: ProviderPreference = 'on'
  const fs = rolloutFs()
  const live = createCodexLiveUsage('win32')
  const h = await harness({
    usageFs: fs.port,
    liveUsage: live,
    preference: { codex: () => pref },
    script: { 'app-server': (r) => helper.fn(r) },
    usageReads: { gapMs: o.gapMs ?? 0, ...(o.settleMaxMs !== undefined ? { settleMaxMs: o.settleMaxMs } : {}), ...(o.now ? { now: o.now } : {}) },
  })
  return {
    h, fs, live,
    helper: () => helper,
    use: (next: ReturnType<typeof appServer>) => { helper = next },
    setCodex: (p: ProviderPreference) => { pref = p },
  }
}
type T = Awaited<ReturnType<typeof setup>>

const realmOf = (h: Harness, accountId: string) => h.doc().accounts.find((a) => a.id === accountId)!.authRealmId
const sessionsOf = (h: Harness, accountId: string) => `${managedHome(realmOf(h, accountId))}\\sessions`
const helperRuns = (h: Harness) => h.runs.filter((r) => r.args === 'app-server')
/** Whether a read ever took its operation lease on the account from now on. */
function readLeases(h: Harness, accountId: string): () => boolean {
  let seen = false
  h.leases.subscribe((id) => { if (id === accountId && h.leases.countKind(accountId, 'operation') > 0) seen = true })
  return () => seen
}

async function stream(t: T, opts: { signal?: AbortSignal } = {}) {
  const got: ProviderAccountUsageView[] = []
  const r = await t.h.service.streamAccountUsage({ providerId: 'codex' }, (v) => got.push(v), opts)
  return { r, got }
}

describe('who is read (ADR-022, bound 2)', () => {
  it('a closed, signed-in ChatGPT account is read afresh, in its own folder, and its reading is shown as a fresh one', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    const before = Date.now()
    const r = await t.h.service.readAccountUsage({ accountId: a })
    expect(r).toMatchObject({ ok: true, usage: { accountId: a, status: 'ok', source: 'read', planLabel: 'Pro' } })
    if (!r.ok) throw new Error(r.code)
    expect(r.usage.buckets.map((b) => b.percent)).toEqual([21])
    expect(r.usage.readingAt).toBeGreaterThanOrEqual(before)
    expect(helperRuns(t.h).map((x) => x.home)).toEqual([managedHome(realmOf(t.h, a))])
    // Its lease is let go once the helper has ended.
    await until(() => t.h.leases.count(a) === 0, 'the read lease to go')
  })

  it('Codex off or not answered: no helper, no discovery', async () => {
    for (const pref of ['off', 'undecided'] as const) {
      const t = await setup()
      const a = await addCodexAccount(t.h, 'A')
      t.setCodex(pref)
      const discoveries = t.h.discoveries()
      await stream(t)
      await t.h.service.readAccountUsage({ accountId: a })
      expect(helperRuns(t.h), pref).toEqual([])
      expect(t.h.discoveries(), pref).toBe(discoveries)
    }
  })

  it('an API-key account and this computer\'s own Codex folder are never read', async () => {
    const t = await setup()
    const k = await addCodexAccount(t.h, 'Key', 'apiKey')
    t.h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    const adopted = await t.h.service.adoptExternalDefault({ providerId: 'codex' })
    if (!adopted.ok) throw new Error(adopted.code)
    t.fs.rollout(`${EXT_HOME}\\sessions`, 64)
    const leasedExt = readLeases(t.h, adopted.accountId)
    const leasedKey = readLeases(t.h, k)
    const s = await stream(t)
    expect(s.got.map((v) => [v.accountId, v.status, v.source])).toEqual(expect.arrayContaining([[k, 'per-token', undefined], [adopted.accountId, 'ok', 'last-seen']]))
    expect(await t.h.service.readAccountUsage({ accountId: adopted.accountId })).toMatchObject({ ok: true, usage: { source: 'last-seen' } })
    expect(helperRuns(t.h)).toEqual([])
    // Not even tried: no lease was taken for a read of either.
    expect(leasedExt()).toBe(false)
    expect(leasedKey()).toBe(false)
    // Not even when its record says it signs in with ChatGPT: the folder is
    // the user's own, whatever the method on record.
    const r = await t.h.store.mutate((d) => ({ ok: true, doc: { ...d, accounts: d.accounts.map((x) => (x.id === adopted.accountId ? { ...x, authMethod: 'browser' as const, lastKnownAuthState: 'signed-in' as const } : x)) } }))
    expect(r.ok).toBe(true)
    await t.h.service.readAccountUsage({ accountId: adopted.accountId })
    expect(leasedExt()).toBe(false)
  })

  it('an open account (a session, a review or a sign-in on it) is never read', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    for (const kind of ['session', 'review', 'sign-in'] as const) {
      const lease = t.h.leases.add(a, 'codex', { kind, ownerId: `${kind}-1` })
      if (!lease.ok) throw new Error('lease')
      await t.h.service.readAccountUsage({ accountId: a })
      await stream(t)
      lease.lease.release()
    }
    expect(helperRuns(t.h)).toEqual([])
  })

  it('a signed-out or inactive account is never read', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    const b = await addCodexAccount(t.h, 'B')
    t.h.signedIn.delete(managedHome(realmOf(t.h, a)).toLowerCase())
    expect((await t.h.service.refreshStatus({ accountId: a })).ok).toBe(true)
    expect((await t.h.service.setLifecycle({ accountId: b, lifecycle: 'inactive' })).ok).toBe(true)
    await stream(t)
    await t.h.service.readAccountUsage({ accountId: a })
    expect(helperRuns(t.h)).toEqual([])
  })

  it('an account whose new sign-in could not be recorded is never read', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    t.h.port.failWrites = [t.h.port.writes + 1]
    expect((await t.h.service.signInAgain({ accountId: a, method: 'browser' }, 1)).ok).toBe(false)
    expect(t.h.doc().accounts.find((x) => x.id === a)!.lastKnownAuthState).toBe('signed-in')
    await t.h.service.readAccountUsage({ accountId: a })
    await stream(t)
    expect(helperRuns(t.h)).toEqual([])
  })

  it('an account whose sign-in method or state is not known is never read', async () => {
    for (const over of [{ authMethod: 'unknown' as const }, { lastKnownAuthState: 'unknown' as const }, { lastKnownAuthState: 'expired' as const }]) {
      const t = await setup()
      const a = await addCodexAccount(t.h, 'A')
      const r = await t.h.store.mutate((d) => ({ ok: true, doc: { ...d, accounts: d.accounts.map((x) => (x.id === a ? { ...x, ...over } : x)) } }))
      expect(r.ok).toBe(true)
      await t.h.service.readAccountUsage({ accountId: a })
      expect(helperRuns(t.h), JSON.stringify(over)).toEqual([])
    }
  })

  it('a package with no read is never asked (the port decides, not the provider\'s name)', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    delete (t.h.codex.usage as { read?: unknown }).read
    const leased = readLeases(t.h, a)
    expect(await t.h.service.readAccountUsage({ accountId: a })).toMatchObject({ ok: true, usage: { status: 'no-session-yet' } })
    expect(helperRuns(t.h)).toEqual([])
    expect(leased()).toBe(false)
  })

  it('a blocked account is never read', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    const blocked = await t.h.store.mutate((d) => ({ ok: true, doc: { ...d, accounts: d.accounts.map((x) => (x.id === a ? { ...x, operationalState: 'blocked' as const } : x)) } }))
    expect(blocked.ok).toBe(true)
    await t.h.service.readAccountUsage({ accountId: a })
    expect(helperRuns(t.h)).toEqual([])
  })

  it('a too-new or unknown CLI is never read: the last-seen reading, with its time', async () => {
    for (const version of ['codex-cli 0.157.1', 'codex-cli banana']) {
      const t = await setup()
      const a = await addCodexAccount(t.h, 'A')
      t.fs.rollout(sessionsOf(t.h, a), 33)
      t.h.state.cliVersion = version
      await t.h.service.discover('codex')
      const r = await t.h.service.readAccountUsage({ accountId: a })
      expect(r, version).toMatchObject({ ok: true, usage: { status: 'ok', source: 'last-seen', readingAt: Date.parse('2026-09-20T09:00:01Z') } })
      expect(helperRuns(t.h), version).toEqual([])
    }
  })

  it('the rule is asked once more right before the helper starts: Codex switched off meanwhile starts nothing', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    const has = t.h.state.envFile.has.bind(t.h.state.envFile)
    t.h.state.envFile.has = (home: string) => { t.setCodex('off'); return has(home) }
    await t.h.service.readAccountUsage({ accountId: a })
    expect(helperRuns(t.h)).toEqual([])
  })

  it('the rule is asked once more right before the helper starts: an account opened meanwhile is not read', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    // The package's own checks run between the lease and the spawn; a
    // session takes the account there.
    const has = t.h.state.envFile.has.bind(t.h.state.envFile)
    let taken = false
    t.h.state.envFile.has = (home: string) => {
      if (!taken) { taken = true; t.h.leases.add(a, 'codex', { kind: 'session', ownerId: 'late' }) }
      return has(home)
    }
    const r = await t.h.service.readAccountUsage({ accountId: a })
    expect(taken).toBe(true)
    expect(r).toMatchObject({ ok: true, usage: { status: 'no-session-yet' } })
    expect(helperRuns(t.h)).toEqual([])
  })
})

describe('how often (ADR-022, bound 7)', () => {
  it('a stream reuses a reading under a minute old; a card\'s Retry reads again', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    await stream(t)
    await until(() => t.h.leases.count(a) === 0, 'the first read to end')
    const again = await stream(t)
    expect(again.got.map((v) => v.source)).toEqual(['read'])
    expect(helperRuns(t.h)).toHaveLength(1)
    await t.h.service.readAccountUsage({ accountId: a })
    expect(helperRuns(t.h)).toHaveLength(2)
  })

  it('a reading older than a minute is read again', async () => {
    let now = 1_000_000
    const helper = appServer()
    const h = await harness({ script: { 'app-server': (r) => helper.fn(r) }, usageReads: { gapMs: 0, now: () => now } })
    const a = await addCodexAccount(h, 'A')
    const run = () => h.service.streamAccountUsage({ providerId: 'codex' }, () => {})
    await run()
    await until(() => h.leases.count(a) === 0, 'the read to end')
    now += 59_999
    await run()
    expect(helper.seen).toHaveLength(1)
    now += 1
    await run()
    expect(helper.seen).toHaveLength(2)
  })

  it('a clock that went back never shows a kept reading, and never makes a read wait more than one gap', async () => {
    let now = 5_000_000
    const t = await setup({ gapMs: 40, now: () => now })
    const a = await addCodexAccount(t.h, 'A')
    await t.h.service.readAccountUsage({ accountId: a })
    await until(() => t.h.leases.count(a) === 0, 'the read to end')
    now -= 1_000_000
    const started = Date.now()
    const s = await stream(t)
    expect(s.got.map((v) => v.source)).toEqual(['read'])
    expect(helperRuns(t.h)).toHaveLength(2)
    expect(Date.now() - started).toBeLessThan(1500)
  }, 3000)

  it('reads run one after another, the next one only after the gap since the last one ended', async () => {
    const t = await setup({ gapMs: 150 })
    await addCodexAccount(t.h, 'A')
    await addCodexAccount(t.h, 'B')
    await stream(t)
    const [first, second] = t.helper().seen
    expect(first.endedAt).toBeDefined()
    expect(second.at - first.endedAt!).toBeGreaterThanOrEqual(140)
  })

  it('two asks for one account share one read', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    const [x, y] = await Promise.all([t.h.service.readAccountUsage({ accountId: a }), t.h.service.readAccountUsage({ accountId: a })])
    expect(x).toMatchObject({ ok: true, usage: { source: 'read' } })
    expect(y).toMatchObject({ ok: true, usage: { source: 'read' } })
    expect(helperRuns(t.h)).toHaveLength(1)
  })

  it(`after ${USAGE_READ_TRANSIENT_LIMIT} transient failures in one stream, the rest show their last-seen reading without trying`, async () => {
    const t = await setup()
    t.use(appServer({ error: { code: -32000, message: 'failed to fetch codex rate limits' } }))
    const ids: string[] = []
    for (const n of ['A', 'B', 'C', 'D', 'E']) ids.push(await addCodexAccount(t.h, n))
    for (const id of ids) t.fs.rollout(sessionsOf(t.h, id), 12)
    const s = await stream(t)
    expect(s.got.map((v) => v.source)).toEqual(ids.map(() => 'last-seen'))
    expect(helperRuns(t.h)).toHaveLength(USAGE_READ_TRANSIENT_LIMIT)
    // The next stream tries again.
    await stream(t)
    expect(helperRuns(t.h)).toHaveLength(USAGE_READ_TRANSIENT_LIMIT * 2)
  })

  it('a CLI that answered unsupported is not asked again; a transient failure is', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    t.use(appServer({ error: { code: -32000, message: 'chatgpt authentication required to read rate limits' } }))
    await t.h.service.readAccountUsage({ accountId: a })
    await t.h.service.readAccountUsage({ accountId: a })
    expect(helperRuns(t.h)).toHaveLength(2)
    t.use(appServer({ error: { code: -32601, message: 'method not found' } }))
    await t.h.service.readAccountUsage({ accountId: a })
    await t.h.service.readAccountUsage({ accountId: a })
    await stream(t)
    expect(helperRuns(t.h)).toHaveLength(3)
  })
})

describe('what stops a read, and what waits for one (#49)', () => {
  async function inFlight(o: HelperOpts = {}) {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    t.fs.rollout(sessionsOf(t.h, a), 18)
    let releaseKill: () => void = () => {}
    const kill = new Promise<void>((r) => { releaseKill = r })
    t.use(appServer({ hold: true, kill, ...o }))
    const stop = new AbortController()
    const streaming = stream(t, { signal: stop.signal })
    await until(() => t.helper().seen.length === 1, 'the helper to start')
    return { t, a, stop, streaming, releaseKill, run: t.helper().seen[0] }
  }

  it('the page closing stops the read under way, and the stream with it', async () => {
    const f = await inFlight()
    f.stop.abort()
    f.releaseKill()
    const s = await f.streaming
    expect(f.run.stopped).toBe(true)
    expect(s.got).toEqual([])
    expect(s.r).toEqual({ ok: true, provider: 'on', accounts: 0 })
    await until(() => f.t.h.leases.count(f.a) === 0, 'the read lease to go')
  })

  it('a launch stops the read and starts only once its process chain has ended', async () => {
    const f = await inFlight()
    let launched = false
    const launch = f.t.h.service.prepareLaunch({ kind: 'session', providerId: 'codex', providerAccountId: f.a, ownerId: 'sess-1' }).then((r) => { launched = true; return r })
    await until(() => f.run.stopped, 'the read to be stopped')
    for (let i = 0; i < 20; i++) await tick()
    expect(launched).toBe(false)
    f.releaseKill()
    const r = await launch
    expect(r.ok).toBe(true)
    // The read's lease went before the launch went on: only the session's is left.
    expect(f.t.h.leases.describe(f.a)).toMatchObject({ session: 1, operation: 0 })
    await f.streaming
  })

  it('a sign-out stops the read, waits for it, and is never refused as in use', async () => {
    const f = await inFlight()
    const out = f.t.h.service.logout({ accountId: f.a })
    await until(() => f.run.stopped, 'the read to be stopped')
    f.releaseKill()
    expect(await out).toEqual({ ok: true, state: 'signed-out' })
    await f.streaming
  })

  it('an inactivate stops the read, waits for it, and is never refused as in use', async () => {
    const f = await inFlight()
    const parked = f.t.h.service.setLifecycle({ accountId: f.a, lifecycle: 'inactive' })
    await until(() => f.run.stopped, 'the read to be stopped')
    f.releaseKill()
    expect(await parked).toEqual({ ok: true })
    await f.streaming
    // Made active again, it is read again: nothing is left settling it.
    expect(await f.t.h.service.setLifecycle({ accountId: f.a, lifecycle: 'active' })).toEqual({ ok: true })
    f.t.use(appServer())
    expect(await f.t.h.service.readAccountUsage({ accountId: f.a })).toMatchObject({ ok: true, usage: { source: 'read' } })
  })

  it('signing in again stops the read and waits for it', async () => {
    const f = await inFlight()
    const again = f.t.h.service.signInAgain({ accountId: f.a, method: 'browser' }, 1)
    await until(() => f.run.stopped, 'the read to be stopped')
    f.releaseKill()
    expect(await again).toMatchObject({ ok: true, state: 'signed-in' })
    await f.streaming
  })

  it('no read starts on an account while a sign-out settles it, and a kept reading is dropped', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    await t.h.service.readAccountUsage({ accountId: a })
    await until(() => t.h.leases.count(a) === 0, 'the read to end')
    expect(await t.h.service.logout({ accountId: a })).toEqual({ ok: true, state: 'signed-out' })
    // Signed in again: the reading kept from before is not shown again.
    t.h.signedIn.set(managedHome(realmOf(t.h, a)).toLowerCase(), 'chatgpt')
    expect((await t.h.service.refreshStatus({ accountId: a })).ok).toBe(true)
    const runs = helperRuns(t.h).length
    await stream(t)
    expect(helperRuns(t.h)).toHaveLength(runs + 1)
  })
})

describe('a read that waits its turn', () => {
  /** A's read answers only once `openA` is called; B's is asked meanwhile. */
  async function queued(o: { bSignal?: AbortSignal } = {}) {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    const b = await addCodexAccount(t.h, 'B')
    let openA: () => void = () => {}
    t.use(appServer({ gate: new Promise<void>((r) => { openA = r }) }))
    let bLeased = false
    t.h.leases.subscribe((id) => { if (id === b && t.h.leases.countKind(b, 'operation') > 0) bLeased = true })
    const waiting = () => (t.h.service as unknown as { usageReads: Map<string, unknown> }).usageReads.has(b)
    const readA = t.h.service.readAccountUsage({ accountId: a })
    await until(() => t.helper().seen.length === 1, 'A to start')
    t.use(appServer())
    const readB = o.bSignal
      ? t.h.service.streamAccountUsage({ providerId: 'codex' }, () => {}, { signal: o.bSignal })
      : t.h.service.readAccountUsage({ accountId: b })
    await until(waiting, 'B to wait its turn')
    return { t, a, b, readA, readB, openA, bLeased: () => bLeased, resetB: () => { bLeased = false } }
  }

  it('waits for the read before it, and then runs', async () => {
    const q = await queued()
    expect(helperRuns(q.t.h)).toHaveLength(1)
    q.openA()
    await q.readA
    expect(await q.readB).toMatchObject({ ok: true, usage: { source: 'read' } })
    expect(helperRuns(q.t.h).map((r) => r.home)).toEqual([managedHome(realmOf(q.t.h, q.a)), managedHome(realmOf(q.t.h, q.b))])
  })

  it('stopped while it waits (the page closed): no lease, nothing started', async () => {
    const stop = new AbortController()
    const q = await queued({ bSignal: stop.signal })
    stop.abort()
    q.openA()
    await q.readA
    await q.readB
    for (let i = 0; i < 10; i++) await tick()
    expect(q.bLeased()).toBe(false)
    expect(helperRuns(q.t.h)).toHaveLength(1)
  })

  it('signed out while it waited: its record is asked again under the lock, and no lease is taken', async () => {
    const q = await queued()
    q.t.h.signedIn.delete(managedHome(realmOf(q.t.h, q.b)).toLowerCase())
    expect((await q.t.h.service.refreshStatus({ accountId: q.b })).ok).toBe(true)
    // The status check took its own lease; the read's is what counts here.
    q.resetB()
    q.openA()
    await q.readA
    await q.readB
    for (let i = 0; i < 10; i++) await tick()
    expect(q.bLeased()).toBe(false)
    expect(helperRuns(q.t.h)).toHaveLength(1)
  })

  it('Codex switched off, or the account opened, while it waited: no lease, nothing started', async () => {
    for (const change of ['off', 'open'] as const) {
      const q = await queued()
      if (change === 'off') q.t.setCodex('off')
      else q.t.h.leases.add(q.b, 'codex', { kind: 'session', ownerId: 'sess-late' })
      q.openA()
      await q.readA
      await q.readB
      for (let i = 0; i < 10; i++) await tick()
      expect(q.bLeased(), change).toBe(false)
      expect(helperRuns(q.t.h), change).toHaveLength(1)
    }
  })
})

describe('settling an account (#49): what is kept, what is bounded', () => {
  it('a read asked for while a sign-out settles the account is not started, so the sign-out is never refused as in use', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    const exclusive = t.h.store.exclusive.bind(t.h.store)
    let first = true
    t.h.store.exclusive = (<R>(fn: () => R | Promise<R>) => {
      if (!first) return exclusive(fn)
      first = false
      // The sign-out's hold: a read is asked for first, with the lock free.
      const asked = t.h.service.readAccountUsage({ accountId: a })
      return asked.then(() => exclusive(fn))
    }) as typeof t.h.store.exclusive
    expect(await t.h.service.logout({ accountId: a })).toEqual({ ok: true, state: 'signed-out' })
    expect(helperRuns(t.h)).toEqual([])
  })

  it('a reading that lands while a sign-out settles the account is shown once and never kept', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    let letExit: () => void = () => {}
    t.use(appServer({ exitGate: new Promise<void>((r) => { letExit = r }) }))
    const retry = t.h.service.readAccountUsage({ accountId: a })
    await until(() => t.helper().seen[0]?.stdinClosed === true, 'the read to be answered')
    const out = t.h.service.logout({ accountId: a })
    expect(await retry).toMatchObject({ ok: true, usage: { source: 'read' } })
    expect(await out).toEqual({ ok: true, state: 'signed-out' })
    letExit()
    t.h.signedIn.set(managedHome(realmOf(t.h, a)).toLowerCase(), 'chatgpt')
    expect((await t.h.service.refreshStatus({ accountId: a })).ok).toBe(true)
    t.use(appServer())
    await stream(t)
    expect(helperRuns(t.h)).toHaveLength(2)
  })

  it('a package read that never answers, even when stopped, never holds a launch forever', async () => {
    const t = await setup({ settleMaxMs: 60 })
    const a = await addCodexAccount(t.h, 'A')
    let asked = false
    ;(t.h.codex.usage as { read?: unknown }).read = () => { asked = true; return new Promise(() => {}) }
    void t.h.service.readAccountUsage({ accountId: a })
    await until(() => asked, 'the read to be asked')
    const launched = await t.h.service.prepareLaunch({ kind: 'session', providerId: 'codex', providerAccountId: a, ownerId: 'sess-1' })
    expect(launched.ok).toBe(true)
  })

  it('a helper whose kill never finishes holds nothing forever: the launch goes on at the bound, and the read\'s lease is let go', async () => {
    const t = await setup({ settleMaxMs: 60 })
    const a = await addCodexAccount(t.h, 'A')
    t.use(appServer({ hold: true, kill: new Promise<void>(() => {}) }))
    const reading = t.h.service.readAccountUsage({ accountId: a })
    await until(() => t.helper().seen.length === 1, 'the helper to start')
    const launched = await t.h.service.prepareLaunch({ kind: 'session', providerId: 'codex', providerAccountId: a, ownerId: 'sess-1' })
    expect(launched.ok).toBe(true)
    await reading
    await until(() => t.h.leases.countKind(a, 'operation') === 0, 'the read lease to go')
  })
})

describe('the plan a reading names', () => {
  it('an open session\'s figure records its plan too', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    t.h.leases.add(a, 'codex', { kind: 'session', ownerId: 'sess-1' })
    t.live.record(sessionsOf(t.h, a), { limits: [{ limitId: 'codex', limitName: null, readingAt: 1234, primary: { windowMinutes: 300, usedPercent: 52, resetsAt: null }, secondary: null }], planType: 'team', readingAt: 1234 })
    expect(await t.h.service.readAccountUsage({ accountId: a })).toMatchObject({ ok: true, usage: { source: 'live', planLabel: 'Team' } })
    expect(t.h.doc().accounts.find((x) => x.id === a)!.planLabel).toBe('Team')
    expect(helperRuns(t.h)).toEqual([])
  })

  it('the same plan, or none, does not take the registry lock to write', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    await t.h.service.readAccountUsage({ accountId: a })
    await until(() => t.h.leases.count(a) === 0, 'the read to end')
    const mutate = t.h.store.mutate.bind(t.h.store)
    let writes = 0
    t.h.store.mutate = ((fn) => { writes++; return mutate(fn) }) as typeof t.h.store.mutate
    await t.h.service.readAccountUsage({ accountId: a })
    await until(() => t.h.leases.count(a) === 0, 'the read to end')
    t.use(appServer({ plan: 'not-a-known-plan' }))
    await t.h.service.readAccountUsage({ accountId: a })
    expect(writes).toBe(0)
  })

  it('is recorded when it changes, and not written again when it does not', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    await t.h.service.readAccountUsage({ accountId: a })
    expect(t.h.doc().accounts.find((x) => x.id === a)!.planLabel).toBe('Pro')
    const writes = t.h.port.writes
    await until(() => t.h.leases.count(a) === 0, 'the read to end')
    await t.h.service.readAccountUsage({ accountId: a })
    expect(t.h.port.writes).toBe(writes)
    t.use(appServer({ plan: 'plus' }))
    await until(() => t.h.leases.count(a) === 0, 'the read to end')
    await t.h.service.readAccountUsage({ accountId: a })
    expect(t.h.doc().accounts.find((x) => x.id === a)!.planLabel).toBe('Plus')
  })

  it('a last-seen reading never writes it', async () => {
    const t = await setup()
    const a = await addCodexAccount(t.h, 'A')
    t.fs.rollout(sessionsOf(t.h, a), 40)
    t.use(appServer({ error: { code: -32000, message: 'offline' } }))
    const r = await t.h.service.readAccountUsage({ accountId: a })
    expect(r).toMatchObject({ ok: true, usage: { source: 'last-seen', planLabel: 'Plus' } })
    expect(t.h.doc().accounts.find((x) => x.id === a)!.planLabel).toBeUndefined()
  })
})
