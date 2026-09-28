// WP1.42 / WP1.29 / WP1.52 -- WP2 commit 3 (design 12; plan A6): the Accounts IPC
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
import { isIpcStreamEnd } from '../../src/shared/ipc-stream'
import type { AccountsService } from '../../src/main/providers/core'
import { createGroup } from '../../src/shared/providers'
import type { AccountsSnapshot } from '../../src/shared/providers'
import { harness, addCodexAccount, claudeSnapshot, memoryFs, KEY, RES, EXE, EXT_HOME } from './accounts-harness'

type Handler = (e: unknown, payload?: unknown) => unknown
const ACC = 'acct-' + 'a'.repeat(32)
const IDN = 'idn-' + 'b'.repeat(32)
const GRP = 'grp-' + 'c'.repeat(32)
// A usage stream's private reply channel, as the preload names it.
const USAGE_CH = 'providerAccounts:usageResult:' + 'a'.repeat(24)

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
    removeListener: (ev: string, fn: () => void) => { const at = (events[ev] ?? []).indexOf(fn); if (at >= 0) events[ev].splice(at, 1) },
    count: (ev: string) => (events[ev] ?? []).length,
    destroy: () => { destroyed = true; for (const fn of events.destroyed ?? []) fn() },
    emit: (ev: string) => { for (const fn of events[ev] ?? []) fn() },
    emitWith: (ev: string, ...args: unknown[]) => { for (const fn of events[ev] ?? []) (fn as (...a: unknown[]) => void)(...args) },
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
  [IPC.PROVIDER_ACCOUNTS_SIGN_IN_AGAIN, { accountId: ACC, method: 'device', sameAccount: true }],
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
  [IPC.PROVIDER_ACCOUNTS_PROBE_EXTERNAL, { providerId: 'codex' }],
  [IPC.PROVIDER_ACCOUNTS_RECONCILE_SIGN_IN, { accountId: ACC }],
  [IPC.PROVIDER_ACCOUNTS_RESOLVE_CONFLICT, { identityId: IDN, field: 'friendlyName', providerId: 'claude', legacyId: 'profile-a1', keep: 'registry' }],
  [IPC.PROVIDER_ACCOUNTS_SET_REVIEWER_DEFAULT, { providerId: 'codex', accountId: ACC }],
  [IPC.PROVIDER_ACCOUNTS_SET_REVIEWER_DEFAULT, { providerId: 'codex', accountId: null }],
  [IPC.PROVIDER_ACCOUNTS_USAGE_ONE, { accountId: ACC }],
  [IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH }],
  [IPC.PROVIDER_ACCOUNTS_CARRY_CONVERSATION, { sessionId: 'sess_01-a', accountId: ACC }],
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
      [IPC.PROVIDER_ACCOUNTS_SIGN_IN_AGAIN, { accountId: ACC, method: 'apiKey', secretHandle: KEY }],
      [IPC.PROVIDER_ACCOUNTS_SIGN_IN_AGAIN, { accountId: ACC, method: 'apiKey', apiKey: KEY }],
      [IPC.PROVIDER_ACCOUNTS_SIGN_IN_AGAIN, { accountId: ACC, method: 'browser', home: 'C:/Users/victim/.codex' }],
      // WP1.52 (P3.3 review round 1, T1): the user's answer is required, and only a yes.
      [IPC.PROVIDER_ACCOUNTS_SIGN_IN_AGAIN, { accountId: ACC, method: 'browser' }],
      [IPC.PROVIDER_ACCOUNTS_SIGN_IN_AGAIN, { accountId: ACC, method: 'browser', sameAccount: false }],
      [IPC.PROVIDER_ACCOUNTS_SIGN_IN_AGAIN, { accountId: ACC, method: 'browser', sameAccount: 'yes' }],
      [IPC.PROVIDER_ACCOUNTS_SIGN_IN_AGAIN, { accountId: ACC, method: 'browser', sameAccount: true, acknowledgeExternal: false }],
      [IPC.PROVIDER_ACCOUNTS_SIGN_IN_AGAIN, { accountId: ACC, method: 'browser', sameAccount: true, separate: true }],
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
      // Usage (MP3): an account id of the right kind; a stream names a known
      // provider and a private reply channel of exactly the preload's shape.
      [IPC.PROVIDER_ACCOUNTS_USAGE_ONE, { accountId: IDN }],
      [IPC.PROVIDER_ACCOUNTS_USAGE_ONE, { accountId: ACC, refresh: true }],
      [IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'gemini', channel: USAGE_CH }],
      [IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex' }],
      [IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: 'pty:data:' + 'a'.repeat(24) }],
      [IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: IPC.PROVIDER_ACCOUNTS_CHANGED }],
      [IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: 'providerAccounts:usageResult:' + 'A'.repeat(24) }],
      [IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: 'providerAccounts:usageResult:' + 'a'.repeat(200) }],
      [IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH + ':x' }],
      [IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: 42 }],
      [IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH, accountId: ACC }],
      // MP8 round 2: `read` is a boolean, nothing else.
      [IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH, read: 'yes' }],
      [IPC.PROVIDER_ACCOUNTS_USAGE_ONE, { accountId: ACC, read: 1 }],
      // MP8: a stop names a known provider and nothing else.
      [IPC.PROVIDER_ACCOUNTS_USAGE_STREAM_STOP, { providerId: 'gemini' }],
      [IPC.PROVIDER_ACCOUNTS_USAGE_STREAM_STOP, { providerId: 'codex', channel: USAGE_CH }],
      [IPC.PROVIDER_ACCOUNTS_USAGE_STREAM_STOP, undefined],
      // P3.6: a switch names the session (the pty session id's own rule) and
      // an account; the conversation and where it came from are never sent.
      [IPC.PROVIDER_ACCOUNTS_CARRY_CONVERSATION, { sessionId: '..\\..\\x', accountId: ACC }],
      [IPC.PROVIDER_ACCOUNTS_CARRY_CONVERSATION, { sessionId: 'a b', accountId: ACC }],
      [IPC.PROVIDER_ACCOUNTS_CARRY_CONVERSATION, { sessionId: 's'.repeat(201), accountId: ACC }],
      [IPC.PROVIDER_ACCOUNTS_CARRY_CONVERSATION, { sessionId: '', accountId: ACC }],
      [IPC.PROVIDER_ACCOUNTS_CARRY_CONVERSATION, { sessionId: 's1', accountId: IDN }],
      [IPC.PROVIDER_ACCOUNTS_CARRY_CONVERSATION, { sessionId: 's1' }],
      [IPC.PROVIDER_ACCOUNTS_CARRY_CONVERSATION, { accountId: ACC }],
      [IPC.PROVIDER_ACCOUNTS_CARRY_CONVERSATION, { sessionId: 's1', accountId: ACC, uuid: '019dd000-0006-7000-8000-0000000000c1' }],
      [IPC.PROVIDER_ACCOUNTS_CARRY_CONVERSATION, { sessionId: 's1', accountId: ACC, fromAccountId: ACC }],
      [IPC.PROVIDER_ACCOUNTS_CARRY_CONVERSATION, { sessionId: 's1', accountId: ACC, cwd: 'C:\\Users\\victim' }],
      [IPC.PROVIDER_ACCOUNTS_CARRY_CONVERSATION, { sessionId: 42, accountId: ACC }],
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

describe('a Switch account\'s carry takes the conversation from main\'s own record (P3.6, row 22)', () => {
  it('the service gets the record main keeps for that session, never anything from the request; none when main has none or cannot say', async () => {
    const calls: unknown[][] = []
    const svc = new Proxy({}, {
      get: (_t, prop) => (prop === 'subscribe' ? () => () => {} : prop === 'then' ? undefined : (...args: unknown[]) => { calls.push([prop, ...args]); return { ok: true, carried: 'copied' } }),
    }) as unknown as AccountsService
    const record = { uuid: '019dd000-0006-7000-8000-0000000000c1', cwd: 'C:\\p\\demo', accountId: 'acct-' + 'b'.repeat(32) }
    const asked: string[] = []
    const sessionConversation = (id: string) => { asked.push(id); if (id === 'broken') throw new Error('x'); return id === 's1' ? record : undefined }
    vi.mocked(ipcMain.handle).mockClear()
    const wc = fakeContents(1)
    registerProviderAccountsHandlers(() => ({ isDestroyed: () => false, webContents: wc }) as never, () => svc, { sessionConversation })
    const handler = new Map(vi.mocked(ipcMain.handle).mock.calls.map(([c, f]) => [c as string, f as Handler])).get(IPC.PROVIDER_ACCOUNTS_CARRY_CONVERSATION)!
    const top = { sender: wc, senderFrame: wc.mainFrame }
    expect(await handler(top, { sessionId: 's1', accountId: ACC })).toEqual({ ok: true, carried: 'copied' })
    expect(calls).toEqual([['carryConversation', { accountId: ACC }, record]])
    await handler(top, { sessionId: 's2', accountId: ACC })
    await handler(top, { sessionId: 'broken', accountId: ACC })
    expect(calls.slice(1)).toEqual([['carryConversation', { accountId: ACC }, undefined], ['carryConversation', { accountId: ACC }, undefined]])
    expect(asked).toEqual(['s1', 's2', 'broken'])
    // Another sender is refused before main's record is even read.
    const other = fakeContents(2)
    expect(await handler({ sender: other, senderFrame: other.mainFrame }, { sessionId: 's1', accountId: ACC })).toMatchObject({ ok: false, code: 'untrusted-sender' })
    expect(asked).toHaveLength(3)
  })
})

describe('Sign in again needs the answer of the user at the boundary (WP1.52; P3.3 review round 1, T1)', () => {
  it('without the answer, or with anything but yes, nothing is signed in again; with it the account signs in again as itself', async () => {
    const h = await harness()
    const w = wire(h.service)
    const a = await addCodexAccount(h, 'A')
    const before = JSON.stringify(h.doc())
    const runs = h.runs.length
    for (const p of [{ accountId: a, method: 'browser' }, { accountId: a, method: 'browser', sameAccount: false }, { accountId: a, method: 'browser', sameAccount: 1 }]) {
      expect(await w.call(IPC.PROVIDER_ACCOUNTS_SIGN_IN_AGAIN, p)).toMatchObject({ ok: false, code: 'invalid-request' })
    }
    expect(h.runs.length).toBe(runs)
    expect(JSON.stringify(h.doc())).toBe(before)
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_SIGN_IN_AGAIN, { accountId: a, method: 'browser', sameAccount: true })).toEqual({ ok: true, state: 'signed-in' })
    expect(h.doc().accounts).toHaveLength(1)
    // The step with no output of its own reaches the renderer that started
    // it, on the same channel (P3.3 final review round, F3).
    expect(w.wc.sent.filter(([c]) => c === IPC.PROVIDER_ACCOUNTS_SIGN_IN_OUTPUT).map(([, e]) => e)).toContainEqual({ accountId: a, text: '', phase: 'carrying-history' })
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

  it('walk fix W7: with CODEX_HOME set, only its display string crosses: no other part of that path, and no environment value, in any reply or push', async () => {
    const ALT = 'C:\\Users\\u\\codex-alt'
    const folders = memoryFs()
    folders.dirs.add(ALT.toLowerCase())
    const h = await harness({ hostEnv: { CODEX_HOME: ALT }, folders })
    h.signedIn.set(ALT.toLowerCase(), 'chatgpt')
    const w = wire(h.service)
    const replies: unknown[] = []
    const call = async (c: string, p?: unknown) => { const r = await w.call(c, p); replies.push(r); return r as { ok: boolean; [k: string]: unknown } }
    await call(IPC.PROVIDER_ACCOUNTS_SNAPSHOT)
    await call(IPC.PROVIDER_ACCOUNTS_PROBE_EXTERNAL, { providerId: 'codex' })
    const adopted = await call(IPC.PROVIDER_ACCOUNTS_ADOPT_EXTERNAL, { providerId: 'codex' })
    expect(adopted).toMatchObject({ ok: true })
    await call(IPC.PROVIDER_ACCOUNTS_REFRESH_STATUS, { accountId: adopted.accountId })
    await call(IPC.PROVIDER_ACCOUNTS_DISCOVER, { providerId: 'codex' })
    await call(IPC.PROVIDER_ACCOUNTS_INSTALL_RECIPES, { providerId: 'codex' })
    const snap = await call(IPC.PROVIDER_ACCOUNTS_SNAPSHOT) as unknown as AccountsSnapshot
    await new Promise((r) => setImmediate(r))
    // The check really used that folder: the CLI was pointed at it ...
    expect(h.runs.some((r) => r.home === ALT)).toBe(true)
    // ... and all the renderer got of it is the display string.
    expect(snap.externalDefaults.find((e) => e.providerId === 'codex')?.home).toBe('~/codex-alt')
    const everything = JSON.stringify({ replies, sent: w.wc.sent })
    expect(everything).toContain('~/codex-alt')
    expect(everything.split('codex-alt').length, 'codex-alt only as ~/codex-alt').toBe(everything.split('~/codex-alt').length)
    for (const needle of [ALT, 'Users', 'CODEX_HOME', RES, 'codex-realms', EXE, EXT_HOME, 'sk-ambient', 'OPENAI_API_KEY', 'managed:', 'external-default"', '"command"']) {
      expect(everything.includes(needle.replace(/\\/g, '\\\\')) || everything.includes(needle), needle).toBe(false)
    }
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

// Usage track MP3 (ADR-009): the allowance stream. The reply channel names
// only a listener on the CALLER's own renderer, and must be the preload's
// exact shape; views go to the caller only; a newer stream from the same
// renderer for the same provider stops the older one at its next account (a
// stream for the other provider is left alone); a renderer that goes away
// stops its streams.
describe('the usage stream over IPC (usage track MP3)', () => {
  type View = { accountId: string }
  /** A stand-in with the real stream's shape: it gives the event loop a
   *  turn before each account and asks shouldContinue before each (the real
   *  service's yielding is proven against the real service below). */
  function streamingService(ids: string[]) {
    const produced: string[] = []
    const svc = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'subscribe') return () => () => {}
        if (prop === 'then') return undefined
        if (prop === 'streamAccountUsage') {
          return async (input: { providerId: string }, onResult: (v: View) => void, opts: { shouldContinue?: () => boolean }) => {
            let n = 0
            for (const id of ids) {
              await new Promise((r) => setTimeout(r, 0))
              if (opts?.shouldContinue && !opts.shouldContinue()) break
              produced.push(`${input.providerId}:${id}`)
              onResult({ accountId: id })
              n++
            }
            return { ok: true, provider: 'on', accounts: n }
          }
        }
        return () => ({ ok: true })
      },
    }) as unknown as AccountsService
    return { svc, produced }
  }
  /** The views on the reply channels (the end marker aside). */
  const usageSent = (w: ReturnType<typeof wire>) => w.wc.sent.filter(([c, v]) => c.startsWith('providerAccounts:usageResult:') && !isIpcStreamEnd(v))

  it('sends each view on the caller\'s own reply channel, and the result says how many', async () => {
    const { svc } = streamingService(['a', 'b'])
    const w = wire(svc)
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH })).toEqual({ ok: true, provider: 'on', accounts: 2 })
    expect(usageSent(w)).toEqual([[USAGE_CH, { accountId: 'a' }], [USAGE_CH, { accountId: 'b' }]])
  })

  it('a newer stream for the same provider stops the older one; one for the other provider is left alone', async () => {
    const { svc, produced } = streamingService(['a', 'b', 'c'])
    const w = wire(svc)
    const CH2 = 'providerAccounts:usageResult:' + 'b'.repeat(24)
    const CH3 = 'providerAccounts:usageResult:' + 'c'.repeat(24)
    const first = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH })
    const other = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'claude', channel: CH3 })
    await new Promise((r) => setTimeout(r, 0))
    const second = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: CH2 })
    await Promise.all([first, second, other])
    const on = (ch: string) => usageSent(w).filter(([c]) => c === ch).map(([, v]) => (v as View).accountId)
    // The first stream sent its first account before the newer one began,
    // and nothing after.
    expect(on(USAGE_CH)).toEqual(['a'])
    expect(on(CH2)).toEqual(['a', 'b', 'c'])
    expect(on(CH3)).toEqual(['a', 'b', 'c'])
    expect(produced.filter((p) => p.startsWith('codex:'))).toEqual(['codex:a', 'codex:a', 'codex:b', 'codex:c'])
  })

  // Review M2: stream generations never repeat. A stream held up while a
  // newer one starts and finishes, and a third begins, must stay stopped, and
  // its end must not end the third.
  it('an old stream never resumes, and never ends a newer one, once a later stream has come and gone', async () => {
    let releaseFirst: () => void = () => {}
    const firstHeld = new Promise<void>((r) => { releaseFirst = r })
    let calls = 0
    const svc = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'subscribe') return () => () => {}
        if (prop === 'then') return undefined
        if (prop === 'streamAccountUsage') {
          return async (_i: unknown, onResult: (v: View) => void, opts: { shouldContinue?: () => boolean }) => {
            const me = ++calls
            let n = 0
            for (const id of ['a', 'b', 'c']) {
              if (me === 1 && id === 'b') await firstHeld
              else await new Promise((r) => setTimeout(r, 0))
              if (opts?.shouldContinue && !opts.shouldContinue()) break
              onResult({ accountId: `${me}:${id}` })
              n++
            }
            return { ok: true, provider: 'on', accounts: n }
          }
        }
        return () => ({ ok: true })
      },
    }) as unknown as AccountsService
    const w = wire(svc)
    const CH2 = 'providerAccounts:usageResult:' + 'b'.repeat(24)
    const CH3 = 'providerAccounts:usageResult:' + 'c'.repeat(24)
    const first = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH })
    await new Promise((r) => setTimeout(r, 0))
    await w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: CH2 })
    const third = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: CH3 })
    releaseFirst()
    await Promise.all([first, third])
    const on = (ch: string) => usageSent(w).filter(([c]) => c === ch).map(([, v]) => (v as View).accountId)
    expect(on(USAGE_CH)).toEqual(['1:a'])
    expect(on(CH2)).toEqual(['2:a', '2:b', '2:c'])
    expect(on(CH3)).toEqual(['3:a', '3:b', '3:c'])
  })

  it('the real service yields before each account, so a newer stream stops the older one before it reads anything', async () => {
    const h = await harness()
    await addCodexAccount(h, 'A')
    await addCodexAccount(h, 'B')
    const w = wire(h.service)
    const CH2 = 'providerAccounts:usageResult:' + 'b'.repeat(24)
    const first = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH })
    const second = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: CH2 })
    expect(await first).toEqual({ ok: true, provider: 'on', accounts: 0 })
    expect(await second).toEqual({ ok: true, provider: 'on', accounts: 2 })
    expect(usageSent(w).map(([c]) => c)).toEqual([CH2, CH2])
  })

  it('a renderer that goes away stops its stream at the next account and is sent nothing more', async () => {
    const { svc, produced } = streamingService(['a', 'b', 'c'])
    const w = wire(svc)
    const running = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH })
    w.wc.destroy()
    await running
    expect(usageSent(w)).toEqual([])
    expect(produced).toEqual([])
  })

  // Usage track MP8: a stream may read a closed account afresh, so what
  // stops it must reach the read under way, not only the next account.
  function signalService() {
    const signals: Array<{ providerId: string; signal: AbortSignal | undefined; read?: boolean }> = []
    const ones: Array<{ accountId: string; signal: AbortSignal | undefined; read?: boolean }> = []
    const releases: Array<() => void> = []
    const svc = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'subscribe') return () => () => {}
        if (prop === 'then') return undefined
        if (prop === 'streamAccountUsage') {
          return (input: { providerId: string }, _onResult: unknown, opts: { signal?: AbortSignal; read?: boolean }) => {
            signals.push({ providerId: input.providerId, signal: opts?.signal, read: opts?.read })
            return new Promise((resolve) => {
              const done = () => resolve({ ok: true, provider: 'on', accounts: 0 })
              releases.push(done)
              opts?.signal?.addEventListener('abort', done, { once: true })
            })
          }
        }
        if (prop === 'readAccountUsage') {
          return (input: { accountId: string }, opts: { signal?: AbortSignal; read?: boolean }) => {
            ones.push({ accountId: input.accountId, signal: opts?.signal, read: opts?.read })
            return new Promise((resolve) => {
              const done = () => resolve({ ok: false, code: 'not-found' })
              releases.push(done)
              opts?.signal?.addEventListener('abort', done, { once: true })
            })
          }
        }
        return () => ({ ok: true })
      },
    }) as unknown as AccountsService
    return { svc, signals, ones, releaseAll: () => { for (const r of releases) r() } }
  }

  // MP8 round 2 (VM, V1): the end marker is the last message on the stream's
  // own channel, after every view, so the preload stops listening only once
  // every view sent has arrived.
  it('sends the end marker last on the stream\'s own channel, after every view', async () => {
    const { svc } = streamingService(['a', 'b'])
    const w = wire(svc)
    await w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH })
    const mine = w.wc.sent.filter(([c]) => c === USAGE_CH)
    expect(mine.map(([, v]) => isIpcStreamEnd(v))).toEqual([false, false, true])
  })

  // MP8 round 2 (S1): only the page's own asks read afresh.
  it('hands the service the read intent: only when asked, and never by default', async () => {
    const s = signalService()
    const w = wire(s.svc)
    const a = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH, read: true })
    const b = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'claude', channel: 'providerAccounts:usageResult:' + 'c'.repeat(24) })
    const c = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_ONE, { accountId: ACC, read: true })
    const d = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_ONE, { accountId: ACC })
    await new Promise((r) => setTimeout(r, 0))
    expect(s.signals.map((x) => x.read)).toEqual([true, false])
    expect(s.ones.map((x) => x.read)).toEqual([true, false])
    s.releaseAll()
    await Promise.all([a, b, c, d])
  })

  // MP8 round 2 (S2, Q2): a card's Retry read stops with the page, and every
  // read stops when the renderer crashes or its main frame goes elsewhere.
  // MP8 round 3: one set of leave listeners per renderer, however many reads.
  it('many Retry reads and a stream share one set of leave listeners, which come off when the last ends', async () => {
    const s = signalService()
    const w = wire(s.svc)
    // Whatever else watches the renderer, counted first.
    const warm = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_ONE, { accountId: ACC, read: true })
    await new Promise((r) => setTimeout(r, 0))
    s.releaseAll()
    await warm
    const base = { gone: w.wc.count('render-process-gone'), nav: w.wc.count('did-start-navigation'), destroyed: w.wc.count('destroyed') }
    const calls = [w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH, read: true })]
    for (let i = 0; i < 30; i++) calls.push(w.call(IPC.PROVIDER_ACCOUNTS_USAGE_ONE, { accountId: ACC, read: true }))
    await new Promise((r) => setTimeout(r, 0))
    expect(w.wc.count('render-process-gone') - base.gone).toBe(1)
    expect(w.wc.count('did-start-navigation') - base.nav).toBe(1)
    expect(w.wc.count('destroyed') - base.destroyed).toBe(1)
    // One crash stops every one of them.
    w.wc.emit('render-process-gone')
    expect(s.ones.slice(1).every((o) => o.signal?.aborted)).toBe(true)
    expect(s.signals.at(-1)?.signal?.aborted).toBe(true)
    s.releaseAll()
    await Promise.all(calls)
    expect(w.wc.count('render-process-gone')).toBe(base.gone)
    expect(w.wc.count('did-start-navigation')).toBe(base.nav)
    expect(w.wc.count('destroyed')).toBe(base.destroyed)
  })

  it('the page closing stops its cards\' Retry reads too', async () => {
    const s = signalService()
    const w = wire(s.svc)
    const one = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_ONE, { accountId: ACC, read: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(s.ones[0].signal?.aborted).toBe(false)
    await w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM_STOP, { providerId: 'codex' })
    expect(s.ones[0].signal?.aborted).toBe(true)
    await one
  })

  it('a renderer that crashes, or whose main frame navigates to another document, stops its streams and reads', async () => {
    for (const leave of [
      (w: ReturnType<typeof wire>) => w.wc.emit('render-process-gone'),
      (w: ReturnType<typeof wire>) => w.wc.emitWith('did-start-navigation', { isMainFrame: true, isSameDocument: false }),
      (w: ReturnType<typeof wire>) => w.wc.emitWith('did-start-navigation', {}, 'app://x', false, true),
    ]) {
      const s = signalService()
      const w = wire(s.svc)
      const st = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH, read: true })
      const one = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_ONE, { accountId: ACC, read: true })
      await new Promise((r) => setTimeout(r, 0))
      leave(w)
      expect(s.signals[0].signal?.aborted).toBe(true)
      expect(s.ones[0].signal?.aborted).toBe(true)
      await Promise.all([st, one])
    }
    // A same-document navigation, or a subframe's, stops nothing.
    for (const stay of [
      (w: ReturnType<typeof wire>) => w.wc.emitWith('did-start-navigation', { isMainFrame: true, isSameDocument: true }),
      (w: ReturnType<typeof wire>) => w.wc.emitWith('did-start-navigation', { isMainFrame: false, isSameDocument: false }),
      (w: ReturnType<typeof wire>) => w.wc.emitWith('did-start-navigation', {}, 'app://x', true, true),
    ]) {
      const s = signalService()
      const w = wire(s.svc)
      const st = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH, read: true })
      await new Promise((r) => setTimeout(r, 0))
      stay(w)
      expect(s.signals[0].signal?.aborted).toBe(false)
      s.releaseAll()
      await st
    }
  })

  it('the page closing (usageStreamStop) stops the caller\'s stream for that provider, the read under way included; the other provider\'s is left alone', async () => {
    const s = signalService()
    const w = wire(s.svc)
    const codex = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH })
    const claude = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'claude', channel: 'providerAccounts:usageResult:' + 'c'.repeat(24) })
    await new Promise((r) => setTimeout(r, 0))
    // Another frame of the window is refused and stops nothing.
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM_STOP, { providerId: 'codex' }, { sender: w.wc, senderFrame: { parent: null } })).toMatchObject({ ok: false, code: 'untrusted-sender' })
    expect(s.signals[0].signal?.aborted).toBe(false)
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM_STOP, { providerId: 'codex' })).toEqual({ ok: true })
    expect(s.signals.map((x) => [x.providerId, x.signal?.aborted])).toEqual([['codex', true], ['claude', false]])
    await codex
    // A stop with nothing running changes nothing.
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM_STOP, { providerId: 'codex' })).toEqual({ ok: true })
    expect(s.signals[1].signal?.aborted).toBe(false)
    s.releaseAll()
    await claude
  })

  it('after usageStreamStop the stream is no longer current: it stops at its next account and sends nothing more', async () => {
    const { svc, produced } = streamingService(['a', 'b', 'c'])
    const w = wire(svc)
    const running = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH })
    await w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM_STOP, { providerId: 'codex' })
    await running
    expect(usageSent(w)).toEqual([])
    expect(produced).toEqual([])
  })

  it('a newer stream for the same provider stops the older one\'s read, and a renderer going away stops its stream\'s', async () => {
    const s = signalService()
    const w = wire(s.svc)
    const first = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH })
    await new Promise((r) => setTimeout(r, 0))
    const second = w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: 'providerAccounts:usageResult:' + 'b'.repeat(24) })
    await new Promise((r) => setTimeout(r, 0))
    expect(s.signals.map((x) => x.signal?.aborted)).toEqual([true, false])
    await first
    w.wc.destroy()
    expect(s.signals[1].signal?.aborted).toBe(true)
    await second
  })

  it('the real service streams views with no path, and nothing for a provider that is off', async () => {
    const h = await harness()
    const w = wire(h.service)
    const begun = await w.call(IPC.PROVIDER_ACCOUNTS_BEGIN_SETUP, { providerId: 'codex', method: 'browser' }) as { accountId: string }
    await w.call(IPC.PROVIDER_ACCOUNTS_SIGN_IN, { accountId: begun.accountId, method: 'browser' })
    await w.call(IPC.PROVIDER_ACCOUNTS_COMPLETE_SETUP, { accountId: begun.accountId, identity: { mode: 'new', colourKey: 'pink' } })
    w.wc.sent.length = 0
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH })).toEqual({ ok: true, provider: 'on', accounts: 1 })
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_USAGE_ONE, { accountId: begun.accountId, read: true })).toMatchObject({ ok: true, usage: { accountId: begun.accountId, status: 'no-session-yet' } })
    const text = JSON.stringify(w.wc.sent)
    for (const needle of [RES, EXE, EXT_HOME, 'codex-realms', 'sessions', 'rollout-']) {
      expect(text.includes(needle.replace(/\\/g, '\\\\')) || text.includes(needle), needle).toBe(false)
    }
    await w.call(IPC.PROVIDER_ACCOUNTS_SET_ENABLED, { providerId: 'codex', enabled: false })
    w.wc.sent.length = 0
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'codex', channel: USAGE_CH })).toEqual({ ok: true, provider: 'off', accounts: 0 })
    expect(usageSent(w)).toEqual([])
    expect(await w.call(IPC.PROVIDER_ACCOUNTS_USAGE_STREAM, { providerId: 'claude', channel: USAGE_CH })).toMatchObject({ ok: false, code: 'unsupported' })
  })
})
