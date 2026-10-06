// WP1.22 -- WP2 commit 3 (design 9.2, 12; plan A6): the one-shot secret
// channel behind API-key sign-in. A handle is main-issued, bound to one
// pending sign-in and one renderer, single-use and short-lived; a deposit is
// accepted once, from that renderer only, within a length bound; the sign-in
// refuses a handle bound elsewhere and burns any handle it was given, so none
// is ever left parked.
//
// PURE.
import { describe, it, expect } from 'vitest'
import { SecretHandleStore, SECRET_HANDLE_TTL_MS, SECRET_HANDLES_PER_RENDERER } from '../../src/main/providers/core'
import { SECRET_HANDLE_RE, SECRET_MAX } from '../../src/shared/providers'
import { harness, KEY } from './accounts-harness'

function clockStore() {
  let t = 1000
  const store = new SecretHandleStore({ now: () => t })
  return { store, advance: (ms: number) => { t += ms } }
}

describe('secret handles (WP1.22)', () => {
  it('are random, well formed, single-use and bound to one account and renderer', () => {
    const { store } = clockStore()
    const h = store.issue({ accountId: 'acct-a', senderId: 1 })!
    expect(h).toMatch(SECRET_HANDLE_RE)
    expect(store.issue({ accountId: 'acct-a', senderId: 1 })).not.toBe(h)
    expect(store.isBoundTo(h, 'acct-a', 1)).toBe(true)
    expect(store.isBoundTo(h, 'acct-b', 1)).toBe(false)
    expect(store.isBoundTo(h, 'acct-a', 2)).toBe(false)
    // Another renderer cannot deposit into it.
    expect(store.deposit(h, 2, KEY)).toBe(false)
    expect(store.deposit(h, 1, KEY)).toBe(true)
    expect(store.take(h)).toBe(KEY)
    expect(store.take(h)).toBeNull()
    expect(store.isBoundTo(h, 'acct-a', 1)).toBe(false)
  })

  it('a second deposit burns the handle; an empty, oversized or non-string key is refused and burns it too', () => {
    const { store } = clockStore()
    const h1 = store.issue({ accountId: 'a', senderId: 1 })!
    expect(store.deposit(h1, 1, KEY)).toBe(true)
    expect(store.deposit(h1, 1, 'another')).toBe(false)
    expect(store.take(h1)).toBeNull()
    for (const bad of ['', 'x'.repeat(SECRET_MAX + 1), 42, null, { k: KEY }]) {
      const h = store.issue({ accountId: 'a', senderId: 1 })!
      expect(store.deposit(h, 1, bad), JSON.stringify(bad)?.slice(0, 20)).toBe(false)
      expect(store.take(h)).toBeNull()
    }
    const edge = store.issue({ accountId: 'a', senderId: 1 })!
    expect(store.deposit(edge, 1, 'y'.repeat(SECRET_MAX))).toBe(true)
  })

  it('a handle that was never deposited gives nothing; unknown and malformed handles give nothing', () => {
    const { store } = clockStore()
    const h = store.issue({ accountId: 'a', senderId: 1 })!
    expect(store.take(h)).toBeNull()
    expect(store.take('sec-' + '0'.repeat(32))).toBeNull()
    for (const bad of [undefined, 7, 'sec-XYZ', '../etc']) {
      expect(store.deposit(bad, 1, KEY)).toBe(false)
      expect(store.take(bad)).toBeNull()
    }
  })

  it('expires, deposited or not, and a destroyed renderer loses its handles', () => {
    const { store, advance } = clockStore()
    const h = store.issue({ accountId: 'a', senderId: 1 })!
    store.deposit(h, 1, KEY)
    advance(SECRET_HANDLE_TTL_MS)
    expect(store.take(h)).toBeNull()
    const h2 = store.issue({ accountId: 'a', senderId: 1 })!
    const h3 = store.issue({ accountId: 'a', senderId: 2 })!
    store.deposit(h2, 1, KEY)
    store.deposit(h3, 2, KEY)
    store.discardForRenderer(1)
    expect(store.take(h2)).toBeNull()
    expect(store.take(h3)).toBe(KEY)
    expect(store.size()).toBe(0)
  })

  it('one renderer may hold only a few at once', () => {
    const { store } = clockStore()
    for (let i = 0; i < SECRET_HANDLES_PER_RENDERER; i++) expect(store.issue({ accountId: 'a', senderId: 1 })).not.toBeNull()
    expect(store.issue({ accountId: 'a', senderId: 1 })).toBeNull()
    expect(store.issue({ accountId: 'a', senderId: 2 })).not.toBeNull()
  })
})

describe('the sign-in and its handle (WP1.22)', () => {
  it('a handle for another setup, or from another renderer, is refused and burned; nothing runs', async () => {
    const h = await harness()
    const a = await h.service.beginSetup({ providerId: 'codex', method: 'apiKey' })
    const b = await h.service.beginSetup({ providerId: 'codex', method: 'apiKey' })
    const aId = (a as { accountId: string }).accountId
    const bId = (b as { accountId: string }).accountId
    const issued = h.service.issueSecretHandle({ accountId: aId }, 1)
    if (!issued.ok) throw new Error(issued.code)
    h.service.depositSecret(issued.handle, 1, KEY)
    expect(await h.service.signIn({ accountId: bId, method: 'apiKey', secretHandle: issued.handle }, 1)).toMatchObject({ ok: false, code: 'secret-unavailable' })
    expect(h.secrets.size()).toBe(0)
    const again = h.service.issueSecretHandle({ accountId: aId }, 1)
    if (!again.ok) throw new Error(again.code)
    h.service.depositSecret(again.handle, 1, KEY)
    expect(await h.service.signIn({ accountId: aId, method: 'apiKey', secretHandle: again.handle }, 2)).toMatchObject({ ok: false, code: 'secret-unavailable' })
    expect(h.secrets.size()).toBe(0)
    expect(h.runs.filter((r) => r.args === 'login --with-api-key')).toEqual([])
  })

  it('a handle with another method is refused and burned; a missing key is "not received"', async () => {
    const h = await harness()
    const a = await h.service.beginSetup({ providerId: 'codex', method: 'browser' })
    const aId = (a as { accountId: string }).accountId
    const issued = h.service.issueSecretHandle({ accountId: aId }, 1)
    if (!issued.ok) throw new Error(issued.code)
    h.service.depositSecret(issued.handle, 1, KEY)
    expect(await h.service.signIn({ accountId: aId, method: 'browser', secretHandle: issued.handle }, 1)).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(h.secrets.size()).toBe(0)
    const empty = h.service.issueSecretHandle({ accountId: aId }, 1)
    if (!empty.ok) throw new Error(empty.code)
    expect(await h.service.signIn({ accountId: aId, method: 'apiKey', secretHandle: empty.handle }, 1)).toMatchObject({ ok: false, code: 'secret-unavailable' })
    expect(await h.service.signIn({ accountId: aId, method: 'apiKey' }, 1)).toMatchObject({ ok: false, code: 'secret-unavailable' })
    expect(h.secrets.size()).toBe(0)
  })

  it('handles are issued only for a pending managed setup whose provider allows API keys', async () => {
    const h = await harness()
    expect(h.service.issueSecretHandle({ accountId: 'acct-' + 'a'.repeat(32) }, 1)).toMatchObject({ ok: false, code: 'not-found' })
    const off = await harness({ preference: { codex: 'off' } })
    expect(off.service.issueSecretHandle({ accountId: 'acct-' + 'a'.repeat(32) }, 1)).toMatchObject({ ok: false, code: 'not-found' })
  })
})

describe('ADR-009 round 1 regressions: a handle is gone after its time, and with its setup', () => {
  it('a timer drops a handle at expiry even when nothing touches the store again', () => {
    const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = []
    const store = new SecretHandleStore({ now: () => 0, schedule: (ms, fn) => { const t = { ms, fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true } } })
    const h = store.issue({ accountId: 'acct-a', senderId: 1 })!
    expect(store.deposit(h, 1, KEY)).toBe(true)
    expect(timers.map((t) => t.ms)).toEqual([SECRET_HANDLE_TTL_MS])
    timers[0].fn()
    expect(store.size()).toBe(0)
    expect(store.take(h)).toBeNull()
    // A handle used in time cancels its timer.
    const h2 = store.issue({ accountId: 'acct-a', senderId: 1 })!
    store.discard(h2)
    expect(timers[1].cancelled).toBe(true)
  })

  it('abandoning or completing a setup drops its handles, deposited or not', async () => {
    const h = await harness()
    const b = await h.service.beginSetup({ providerId: 'codex', method: 'apiKey' }) as { accountId: string }
    const issued = h.service.issueSecretHandle({ accountId: b.accountId }, 1) as { handle: string }
    h.service.depositSecret(issued.handle, 1, KEY)
    expect(h.secrets.size()).toBe(1)
    expect((await h.service.abandonSetup({ accountId: b.accountId })).ok).toBe(true)
    expect(h.secrets.size()).toBe(0)

    const c = await h.service.beginSetup({ providerId: 'codex', method: 'browser' }) as { accountId: string }
    await h.service.signIn({ accountId: c.accountId, method: 'browser' }, 1)
    h.service.issueSecretHandle({ accountId: c.accountId }, 1)
    expect(h.secrets.size()).toBe(1)
    expect((await h.service.completeSetup({ accountId: c.accountId, identity: { mode: 'new', colourKey: 'violet' } })).ok).toBe(true)
    expect(h.secrets.size()).toBe(0)
  })
})
