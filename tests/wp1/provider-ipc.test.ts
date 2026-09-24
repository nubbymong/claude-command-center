// WP1.42 / WP1.29 -- WP2 commit 3 (design 12; plan A6): the Accounts IPC
// boundary. Only the app's own window, top frame, is served. Every payload is
// validated by a strict schema BEFORE the service sees it -- an identity id
// where an account id belongs, an unknown provider, an unknown key, a
// malformed handle: all refused with `invalid-request`, the service never
// called, the input never echoed. Replies and pushes carry views only: no
// path, environment value, executable or key. A renderer that goes away
// takes its sign-ins and their leases with it.
//
// PURE: ipcMain is the suite's mock; the service is the real one over the
// fake-CLI harness.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ipcMain } from 'electron'
import { registerProviderAccountsHandlers } from '../../src/main/ipc/provider-accounts-handlers'
import { IPC } from '../../src/shared/ipc-channels'
import type { AccountsService } from '../../src/main/providers/core'
import { createGroup } from '../../src/shared/providers'
import type { AccountsSnapshot } from '../../src/shared/providers'
import { harness, claudeSnapshot, KEY, RES, EXE, EXT_HOME } from './accounts-harness'

type Handler = (e: unknown, payload?: unknown) => unknown
const ACC = 'acct-' + 'a'.repeat(32)
const IDN = 'idn-' + 'b'.repeat(32)
const GRP = 'grp-' + 'c'.repeat(32)

function fakeContents(id: number) {
  const events: Record<string, Array<() => void>> = {}
  const sent: Array<[string, unknown]> = []
  const mainFrame = { parent: null }
  let destroyed = false
  return {
    id, mainFrame, sent,
    isDestroyed: () => destroyed,
    send: (channel: string, data: unknown) => { sent.push([channel, data]) },
    once: (ev: string, fn: () => void) => { (events[ev] ??= []).push(fn) },
    on: (ev: string, fn: () => void) => { (events[ev] ??= []).push(fn) },
    destroy: () => { destroyed = true; for (const fn of events.destroyed ?? []) fn() },
    emit: (ev: string) => { for (const fn of events[ev] ?? []) fn() },
  }
}

function wire(service: AccountsService | null) {
  vi.mocked(ipcMain.handle).mockClear()
  vi.mocked(ipcMain.on).mockClear()
  const wc = fakeContents(1)
  const win = { isDestroyed: () => false, webContents: wc }
  registerProviderAccountsHandlers(() => win as never, () => service)
  const invoke = new Map<string, Handler>(vi.mocked(ipcMain.handle).mock.calls.map(([c, f]) => [c as string, f as Handler]))
  const on = new Map<string, Handler>(vi.mocked(ipcMain.on).mock.calls.map(([c, f]) => [c as string, f as Handler]))
  const top = { sender: wc, senderFrame: wc.mainFrame }
  return { wc, invoke, on, top, call: (channel: string, payload?: unknown, e: unknown = top) => invoke.get(channel)!(e, payload) }
}

const CHANNELS: Array<[string, unknown]> = [
  [IPC.PROVIDER_ACCOUNTS_DISCOVER, { providerId: 'codex' }],
  [IPC.PROVIDER_ACCOUNTS_INSTALL_RECIPES, { providerId: 'codex' }],
  [IPC.PROVIDER_ACCOUNTS_SET_ENABLED, { providerId: 'codex', enabled: true }],
  [IPC.PROVIDER_ACCOUNTS_BEGIN_SETUP, { providerId: 'codex', method: 'browser' }],
  [IPC.PROVIDER_ACCOUNTS_ISSUE_SECRET_HANDLE, { accountId: ACC }],
  [IPC.PROVIDER_ACCOUNTS_SIGN_IN, { accountId: ACC, method: 'browser' }],
  [IPC.PROVIDER_ACCOUNTS_CANCEL_SIGN_IN, { accountId: ACC }],
  [IPC.PROVIDER_ACCOUNTS_COMPLETE_SETUP, { accountId: ACC, identity: { mode: 'link', identityId: IDN } }],
  [IPC.PROVIDER_ACCOUNTS_ABANDON_SETUP, { accountId: ACC }],
  [IPC.PROVIDER_ACCOUNTS_REFRESH_STATUS, { accountId: ACC }],
  [IPC.PROVIDER_ACCOUNTS_LOGOUT, { accountId: ACC }],
  [IPC.PROVIDER_ACCOUNTS_SET_LIFECYCLE, { accountId: ACC, lifecycle: 'inactive' }],
  [IPC.PROVIDER_ACCOUNTS_SET_DEFAULT, { accountId: ACC }],
  [IPC.PROVIDER_ACCOUNTS_UPDATE_IDENTITY, { identityId: IDN, friendlyName: 'x' }],
  [IPC.PROVIDER_ACCOUNTS_CREATE_GROUP, { name: 'Work' }],
  [IPC.PROVIDER_ACCOUNTS_RENAME_GROUP, { groupId: GRP, name: 'Home' }],
  [IPC.PROVIDER_ACCOUNTS_DELETE_GROUP, { groupId: GRP }],
  [IPC.PROVIDER_ACCOUNTS_LINK_IDENTITY, { accountId: ACC, identityId: IDN }],
  [IPC.PROVIDER_ACCOUNTS_UNLINK_IDENTITY, { accountId: ACC }],
  [IPC.PROVIDER_ACCOUNTS_ADOPT_EXTERNAL, { providerId: 'codex' }],
  [IPC.PROVIDER_ACCOUNTS_RUN_MIGRATION, { providerId: 'codex' }],
  [IPC.PROVIDER_ACCOUNTS_RECONCILE_SIGN_IN, { accountId: ACC }],
  [IPC.PROVIDER_ACCOUNTS_RESOLVE_CONFLICT, { identityId: IDN, field: 'friendlyName', providerId: 'claude', legacyId: 'profile-a1', keep: 'registry' }],
  [IPC.PROVIDER_ACCOUNTS_SET_REVIEWER_DEFAULT, { providerId: 'codex', accountId: ACC }],
  [IPC.PROVIDER_ACCOUNTS_SET_REVIEWER_DEFAULT, { providerId: 'codex', accountId: null }],
]

/** A service whose every method records that it was reached. */
function spyService(): { svc: AccountsService; reached: string[] } {
  const reached: string[] = []
  const svc = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'subscribe') return () => () => {}
      if (prop === 'then') return undefined
      return (...args: unknown[]) => { reached.push(String(prop)); return prop === 'snapshot' ? { revision: 0 } : { ok: true, args } }
    },
  }) as unknown as AccountsService
  return { svc, reached }
}

beforeEach(() => { vi.mocked(ipcMain.handle).mockClear(); vi.mocked(ipcMain.on).mockClear() })

describe('the Accounts IPC boundary (WP1.42)', () => {
  it('registers every channel once, and the key channel as one-way', () => {
    const { invoke, on } = wire(spyService().svc)
    for (const [c] of CHANNELS) expect(invoke.has(c), c).toBe(true)
    expect(invoke.has(IPC.PROVIDER_ACCOUNTS_SNAPSHOT)).toBe(true)
    expect(invoke.has(IPC.PROVIDER_ACCOUNTS_SECRET)).toBe(false)
    expect([...on.keys()]).toEqual([IPC.PROVIDER_ACCOUNTS_SECRET])
  })

  it('a valid request from the app window reaches the service', async () => {
    const { svc, reached } = spyService()
    const w = wire(svc)
    for (const [c, p] of CHANNELS) expect(await w.call(c, p), c).toMatchObject({ ok: true })
    expect(reached.length).toBe(CHANNELS.length)
  })

  it('any other sender is refused before validation and the service is never reached', async () => {
    const { svc, reached } = spyService()
    const w = wire(svc)
    const other = fakeContents(2)
    const senders = [
      { sender: other, senderFrame: other.mainFrame },                  // another window or a webview
      { sender: w.wc, senderFrame: { parent: w.wc.mainFrame } },        // an embedded frame
      { sender: w.wc, senderFrame: null },                              // a frame that went away
    ]
    for (const e of senders) {
      for (const [c, p] of CHANNELS) expect(await w.call(c, p, e), c).toMatchObject({ ok: false, code: 'untrusted-sender' })
      expect(await w.call(IPC.PROVIDER_ACCOUNTS_SNAPSHOT, undefined, e)).toBeNull()
      w.on.get(IPC.PROVIDER_ACCOUNTS_SECRET)!(e, { handle: 'sec-' + '0'.repeat(32), secret: KEY })
    }
    expect(reached).toEqual([])
  })

  it('a malformed request is refused with invalid-request, never echoed, and never reaches the service', async () => {
    const { svc, reached } = spyService()
    const w = wire(svc)
    const IDN_AS_ACC = IDN
    const bad: Array<[string, unknown]> = [
      // Ids of the wrong kind, the wrong shape, or a path.
      [IPC.PROVIDER_ACCOUNTS_SET_DEFAULT, { accountId: IDN_AS_ACC }],
      [IPC.PROVIDER_ACCOUNTS_SET_DEFAULT, { accountId: 'acct-' + 'A'.repeat(32) }],
      [IPC.PROVIDER_ACCOUNTS_SET_DEFAULT, { accountId: '..\\..\\Windows' }],
      [IPC.PROVIDER_ACCOUNTS_SET_DEFAULT, { accountId: 42 }],
      [IPC.PROVIDER_ACCOUNTS_LINK_IDENTITY, { accountId: ACC, identityId: ACC }],
      [IPC.PROVIDER_ACCOUNTS_RENAME_GROUP, { groupId: IDN, name: 'x' }],
      [IPC.PROVIDER_ACCOUNTS_COMPLETE_SETUP, { accountId: ACC, identity: { mode: 'link', identityId: GRP } }],
      // Unknown provider, method, lifecycle, mode.
      [IPC.PROVIDER_ACCOUNTS_DISCOVER, { providerId: 'gemini' }],
      [IPC.PROVIDER_ACCOUNTS_BEGIN_SETUP, { providerId: 'codex', method: 'password' }],
      [IPC.PROVIDER_ACCOUNTS_SET_LIFECYCLE, { accountId: ACC, lifecycle: 'deleted' }],
      [IPC.PROVIDER_ACCOUNTS_COMPLETE_SETUP, { accountId: ACC, identity: { mode: 'adopt', identityId: IDN } }],
      // Unknown keys: strict, including a __proto__ key and a smuggled path.
      [IPC.PROVIDER_ACCOUNTS_REFRESH_STATUS, { accountId: ACC, extra: 1 }],
      [IPC.PROVIDER_ACCOUNTS_REFRESH_STATUS, JSON.parse(`{"accountId":"${ACC}","__proto__":{"admin":true}}`)],
      [IPC.PROVIDER_ACCOUNTS_BEGIN_SETUP, { providerId: 'codex', method: 'browser', home: 'C:\\Users\\victim\\.codex' }],
      [IPC.PROVIDER_ACCOUNTS_COMPLETE_SETUP, { accountId: ACC, identity: { mode: 'new', colourKey: 'pink', realmPath: 'x' } }],
      [IPC.PROVIDER_ACCOUNTS_LOGOUT, { accountId: ACC, acknowledgeExternal: 'yes' }],
      // A secret handle must be a handle; a key must never ride on a request.
      [IPC.PROVIDER_ACCOUNTS_SIGN_IN, { accountId: ACC, method: 'apiKey', secretHandle: KEY }],
      [IPC.PROVIDER_ACCOUNTS_SIGN_IN, { accountId: ACC, method: 'apiKey', apiKey: KEY }],
      // A conflict names a legacy record by its own id rule, one of two fields, and one of two answers.
      [IPC.PROVIDER_ACCOUNTS_RESOLVE_CONFLICT, { identityId: IDN, field: 'friendlyName', providerId: 'claude', legacyId: '..\\..\\x', keep: 'registry' }],
      [IPC.PROVIDER_ACCOUNTS_RESOLVE_CONFLICT, { identityId: IDN, field: 'email', providerId: 'claude', legacyId: 'profile-a1', keep: 'registry' }],
      [IPC.PROVIDER_ACCOUNTS_RESOLVE_CONFLICT, { identityId: IDN, field: 'friendlyName', providerId: 'claude', legacyId: 'profile-a1', keep: 'both' }],
      [IPC.PROVIDER_ACCOUNTS_RESOLVE_CONFLICT, { identityId: ACC, field: 'friendlyName', providerId: 'claude', legacyId: 'profile-a1', keep: 'legacy' }],
      [IPC.PROVIDER_ACCOUNTS_RESOLVE_CONFLICT, { identityId: IDN, field: 'friendlyName', providerId: 'claude', legacyId: 'profile-a1', keep: 'legacy', value: 'x' }],
      // A reviewer default names an account (or null) explicitly, of a known provider.
      [IPC.PROVIDER_ACCOUNTS_SET_REVIEWER_DEFAULT, { providerId: 'codex' }],
      [IPC.PROVIDER_ACCOUNTS_SET_REVIEWER_DEFAULT, { providerId: 'codex', accountId: IDN }],
      [IPC.PROVIDER_ACCOUNTS_SET_REVIEWER_DEFAULT, { providerId: 'gemini', accountId: ACC }],
      [IPC.PROVIDER_ACCOUNTS_SET_REVIEWER_DEFAULT, { providerId: 'codex', accountId: ACC, kind: 'review' }],
      [IPC.PROVIDER_ACCOUNTS_RECONCILE_SIGN_IN, { accountId: ACC, acknowledge: true }],
      // Oversized labels.
      [IPC.PROVIDER_ACCOUNTS_CREATE_GROUP, { name: 'x'.repeat(10_000) }],
      [IPC.PROVIDER_ACCOUNTS_UPDATE_IDENTITY, { identityId: IDN, friendlyName: 'y'.repeat(10_000) }],
      // Not objects at all.
      [IPC.PROVIDER_ACCOUNTS_ABANDON_SETUP, undefined],
      [IPC.PROVIDER_ACCOUNTS_ABANDON_SETUP, [ACC]],
      [IPC.PROVIDER_ACCOUNTS_ABANDON_SETUP, ACC],
    ]
    for (const [c, p] of bad) {
      const r = await w.call(c, p)
      expect(r, `${c} ${JSON.stringify(p)?.slice(0, 60)}`).toEqual({ ok: false, code: 'invalid-request', message: 'That request was not valid.' })
      expect(JSON.stringify(r)).not.toContain(KEY)
    }
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_SNAPSHOT, { anything: 1 })).toBeNull()
    expect(reached).toEqual([])
  })

  it('an unexpected failure is reported without the payload, and logged without it', async () => {
    const svc = new Proxy({}, { get: (_t, p) => (p === 'subscribe' ? () => () => {} : p === 'then' ? undefined : () => { throw new Error('boom') }) }) as unknown as AccountsService
    const w = wire(svc)
    const r = await w.call(IPC.PROVIDER_ACCOUNTS_UPDATE_IDENTITY, { identityId: IDN, friendlyName: KEY.slice(0, 30) })
    expect(r).toMatchObject({ ok: false, code: 'internal' })
    expect(JSON.stringify(r)).not.toContain(KEY.slice(0, 30))
  })

  it('without a service the list is reported unavailable', async () => {
    const w = wire(null)
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_SET_DEFAULT, { accountId: ACC })).toMatchObject({ ok: false, code: 'registry-unavailable' })
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_SNAPSHOT)).toBeNull()
  })
})

describe('what crosses back (WP1.29)', () => {
  it('a whole API-key setup through IPC returns views only: no path, executable, environment value or key, in any reply or push', async () => {
    const h = await harness()
    const w = wire(h.service)
    const replies: unknown[] = []
    const call = async (c: string, p?: unknown) => { const r = await w.call(c, p); replies.push(r); return r as { ok: boolean; [k: string]: unknown } }
    const begun = await call(IPC.PROVIDER_ACCOUNTS_BEGIN_SETUP, { providerId: 'codex', method: 'apiKey' })
    const accountId = begun.accountId as string
    const issued = await call(IPC.PROVIDER_ACCOUNTS_ISSUE_SECRET_HANDLE, { accountId })
    w.on.get(IPC.PROVIDER_ACCOUNTS_SECRET)!(w.top, { handle: issued.handle, secret: KEY })
    expect(await call(IPC.PROVIDER_ACCOUNTS_SIGN_IN, { accountId, method: 'apiKey', secretHandle: issued.handle })).toEqual({ ok: true, state: 'signed-in' })
    expect(await call(IPC.PROVIDER_ACCOUNTS_COMPLETE_SETUP, { accountId, identity: { mode: 'new', friendlyName: 'K', colourKey: 'violet' } })).toMatchObject({ ok: true })
    await call(IPC.PROVIDER_ACCOUNTS_REFRESH_STATUS, { accountId })
    await call(IPC.PROVIDER_ACCOUNTS_DISCOVER, { providerId: 'codex' })
    await call(IPC.PROVIDER_ACCOUNTS_INSTALL_RECIPES, { providerId: 'codex' })
    replies.push(await w.call(IPC.PROVIDER_ACCOUNTS_SNAPSHOT))
    await new Promise((r) => setImmediate(r))
    const everything = JSON.stringify({ replies, sent: w.wc.sent })
    expect(w.wc.sent.some(([c]) => c === IPC.PROVIDER_ACCOUNTS_SIGN_IN_OUTPUT)).toBe(true)
    expect(w.wc.sent.some(([c]) => c === IPC.PROVIDER_ACCOUNTS_CHANGED)).toBe(true)
    for (const needle of [RES, 'codex-realms', EXE, EXT_HOME, 'Users', 'sk-ambient', 'OPENAI_API_KEY', 'CODEX_HOME', 'managed:', 'external-default"', '"command"']) {
      expect(everything.includes(needle.replace(/\\/g, '\\\\')) || everything.includes(needle), needle).toBe(false)
    }
    for (let i = 0; i + 16 <= KEY.length; i++) expect(everything.includes(KEY.slice(i, i + 16)), `key fragment at ${i}`).toBe(false)
  })

  it('changes are pushed to the window as one coalesced snapshot', async () => {
    const h = await harness()
    const w = wire(h.service)
    await w.call(IPC.PROVIDER_ACCOUNTS_CREATE_GROUP, { name: 'A' })
    w.wc.sent.length = 0
    await Promise.all([w.call(IPC.PROVIDER_ACCOUNTS_CREATE_GROUP, { name: 'B' }), w.call(IPC.PROVIDER_ACCOUNTS_CREATE_GROUP, { name: 'C' })])
    await new Promise((r) => setImmediate(r))
    const pushes = w.wc.sent.filter(([c]) => c === IPC.PROVIDER_ACCOUNTS_CHANGED)
    expect(pushes.length).toBe(1)
    expect((pushes[0][1] as { groups: unknown[] }).groups).toHaveLength(3)
  })

  it('a window that goes away stops its sign-ins and releases their leases', async () => {
    let started: () => void = () => {}
    const running = new Promise<void>((r) => { started = r })
    const h = await harness({ script: { 'login': (r) => new Promise((resolve) => { started(); r.opts.signal?.addEventListener('abort', () => resolve({ spawnError: 'cancelled', stopped: 'cancel' })) }) } })
    const w = wire(h.service)
    const begun = await w.call(IPC.PROVIDER_ACCOUNTS_BEGIN_SETUP, { providerId: 'codex', method: 'browser' }) as { accountId: string }
    const signing = w.call(IPC.PROVIDER_ACCOUNTS_SIGN_IN, { accountId: begun.accountId, method: 'browser' })
    await running
    expect(h.leases.count(begun.accountId)).toBe(1)
    w.wc.destroy()
    expect(await signing).toMatchObject({ ok: false, code: 'cancelled' })
    expect(h.leases.count(begun.accountId)).toBe(0)
  })
})

describe('conflicts, reconcile and the reviewer default over IPC (WP1.42; design 5.3, 5.5, 6.2)', () => {
  it('an identity conflict is shown in the snapshot and settled by the user: keep this app\'s value, or the provider\'s', async () => {
    for (const keep of ['registry', 'legacy'] as const) {
      const h = await harness({ claude: [claudeSnapshot('profile-a1', { isDefault: true })] })
      const w = wire(h.service)
      const identityId = h.doc().accounts[0].identityId
      h.setClaude([claudeSnapshot('profile-a1', { isDefault: true, friendlyName: 'Theirs' })])
      expect(await w.call(IPC.PROVIDER_ACCOUNTS_UPDATE_IDENTITY, { identityId, friendlyName: 'Mine' })).toEqual({ ok: true })
      const snap = await w.call(IPC.PROVIDER_ACCOUNTS_SNAPSHOT) as AccountsSnapshot
      expect(snap.conflicts).toEqual([expect.objectContaining({ identityId, field: 'friendlyName', providerId: 'claude', legacyId: 'profile-a1', legacyValue: 'Theirs', registryValue: 'Mine' })])
      expect(Object.keys(snap.conflicts[0]).sort()).toEqual(['detectedAt', 'field', 'identityId', 'legacyId', 'legacyValue', 'providerId', 'registryValue'])
      const r = await w.call(IPC.PROVIDER_ACCOUNTS_RESOLVE_CONFLICT, { identityId, field: 'friendlyName', providerId: 'claude', legacyId: 'profile-a1', keep })
      expect(r, keep).toEqual({ ok: true })
      expect(h.doc().conflicts, keep).toEqual([])
      expect(h.doc().identities.find((i) => i.id === identityId)?.friendlyName, keep).toBe(keep === 'registry' ? 'Mine' : 'Theirs')
      // This app's value goes to Claude's own list now, not at the next start.
      if (keep === 'registry') expect(h.legacyWrites).toContainEqual({ providerId: 'claude', legacyId: 'profile-a1', field: 'friendlyName', value: 'Mine' })
      // Settled once: a second answer finds nothing to settle.
      expect(await w.call(IPC.PROVIDER_ACCOUNTS_RESOLVE_CONFLICT, { identityId, field: 'friendlyName', providerId: 'claude', legacyId: 'profile-a1', keep }), keep).toMatchObject({ ok: false, code: 'not-found' })
    }
  })

  it('reconcile and the reviewer default reach the service through their own strict channels', async () => {
    const h = await harness()
    const w = wire(h.service)
    const begun = await w.call(IPC.PROVIDER_ACCOUNTS_BEGIN_SETUP, { providerId: 'codex', method: 'browser' }) as { accountId: string }
    await w.call(IPC.PROVIDER_ACCOUNTS_SIGN_IN, { accountId: begun.accountId, method: 'browser' })
    await w.call(IPC.PROVIDER_ACCOUNTS_COMPLETE_SETUP, { accountId: begun.accountId, identity: { mode: 'new', colourKey: 'violet' } })
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_SET_REVIEWER_DEFAULT, { providerId: 'codex', accountId: begun.accountId })).toEqual({ ok: true })
    expect(h.doc().accounts[0].isReviewerDefault).toBe(true)
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_SET_REVIEWER_DEFAULT, { providerId: 'codex', accountId: null })).toEqual({ ok: true })
    expect(h.doc().accounts[0].isReviewerDefault).toBeUndefined()
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_RECONCILE_SIGN_IN, { accountId: begun.accountId })).toEqual({ ok: true, state: 'signed-in' })
  })

  it('a re-created registry (a new resources directory) is followed: reads, writes and pushes come from it, never the old one', async () => {
    const h = await harness()
    const w = wire(h.service)
    await w.call(IPC.PROVIDER_ACCOUNTS_CREATE_GROUP, { name: 'Old' })
    const old = h.store
    const next = h.newStore()
    h.useStore(next)
    expect((await w.call(IPC.PROVIDER_ACCOUNTS_SNAPSHOT) as AccountsSnapshot).groups).toEqual([])
    await w.call(IPC.PROVIDER_ACCOUNTS_CREATE_GROUP, { name: 'New' })
    expect(next.current()!.groups.map((g) => g.name)).toEqual(['New'])
    expect(old.current()!.groups.map((g) => g.name)).toEqual(['Old'])
    await new Promise((r) => setImmediate(r))
    w.wc.sent.length = 0
    // The replaced store is no longer listened to.
    await old.mutate((d, t) => createGroup(d, { id: 'grp-' + 'd'.repeat(32), name: 'Stray' }, t))
    await new Promise((r) => setImmediate(r))
    expect(w.wc.sent.filter(([c]) => c === IPC.PROVIDER_ACCOUNTS_CHANGED)).toEqual([])
    // And no store at all reads as unavailable, not as an empty list.
    h.useStore(null)
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_CREATE_GROUP, { name: 'X' })).toMatchObject({ ok: false, code: 'registry-unavailable' })
    expect((await w.call(IPC.PROVIDER_ACCOUNTS_SNAPSHOT) as AccountsSnapshot).registry).toEqual({ mode: 'unavailable' })
  })
})

describe('ADR-009 round 1 regressions: the boundary', () => {
  it('a fenced frame (a root frame that is not the window\'s own) is not served', async () => {
    const { svc, reached } = spyService()
    const w = wire(svc)
    const fenced = { sender: w.wc, senderFrame: { parent: null } }
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_SET_DEFAULT, { accountId: ACC }, fenced)).toMatchObject({ ok: false, code: 'untrusted-sender' })
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_SNAPSHOT, undefined, fenced)).toBeNull()
    expect(reached).toEqual([])
  })

  it('a renderer that crashes while its sign-in waits for the registry lock never gets that sign-in run', async () => {
    const h = await harness()
    const w = wire(h.service)
    const begun = await w.call(IPC.PROVIDER_ACCOUNTS_BEGIN_SETUP, { providerId: 'codex', method: 'browser' }) as { accountId: string }
    let open: () => void = () => {}
    const gate = new Promise<void>((r) => { open = r })
    const held = h.store.exclusive(() => gate)
    const signing = w.call(IPC.PROVIDER_ACCOUNTS_SIGN_IN, { accountId: begun.accountId, method: 'browser' })
    await new Promise((r) => setTimeout(r, 0))
    w.wc.emit('render-process-gone')
    open()
    await held
    expect(await signing).toMatchObject({ ok: false, code: 'cancelled' })
    expect(h.args()).not.toContain('login')
    expect(h.leases.count(begun.accountId)).toBe(0)
  })

  it('a replaced registry refuses every later change, so an operation that captured it cannot write behind the new one', async () => {
    const h = await harness()
    const old = h.store
    old.retire()
    expect(old.current()).toBeNull()
    expect(old.status()).toMatchObject({ mode: 'recovery', reason: 'unloaded' })
    expect(await old.mutate((d, t) => createGroup(d, { id: 'grp-' + 'e'.repeat(32), name: 'Late' }, t))).toMatchObject({ ok: false, code: 'recovery' })
    expect(await h.service.createGroup({ name: 'X' })).toMatchObject({ ok: false, code: 'registry-unavailable' })
  })

  it('one folder spelled two ways is the same resources directory: no second store is made for it', async () => {
    const { sameDirectory } = await import('../../src/main/provider-account-registry')
    const base = 'C:\\zz-ccc-no-such-dir\\Res'
    expect(sameDirectory(base, 'c:\\ZZ-CCC-NO-SUCH-DIR\\res\\', 'win32')).toBe(true)
    expect(sameDirectory(base, base + '\\..\\Res', 'win32')).toBe(true)
    expect(sameDirectory(base, 'C:\\zz-ccc-no-such-dir\\Other', 'win32')).toBe(false)
    expect(sameDirectory('/zz-ccc-no-such-dir/Res', '/zz-ccc-no-such-dir/res', 'linux')).toBe(false)
  })
})
