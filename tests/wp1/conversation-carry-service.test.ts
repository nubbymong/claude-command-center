// WP1.16 / WP1.42 -- P3.6 (row 22): a running session switched to another
// account of its provider carries the conversation it is on into that
// account: the copy holds both accounts (WP1.16) and a destination a launch
// could not bind is refused before anything is held (WP1.42). The accounts
// service decides whether and holds both accounts: the conversation and the
// account it ran under are main's own record (the caller passes them, never
// the renderer); both accounts are leased under the registry lock for the
// whole copy and released on every path; the destination must be one a launch
// could run on now. This computer's own sign-in is carried to and from under
// the same rules (settled by parity: every Claude profile shares one
// conversations folder).
//
// PURE: the real Codex package on a fake CLI and an in-memory folder tree;
// the file work (conversation-carry.ts) is a stub that records what it was
// asked and what was held while it ran.
import { describe, it, expect } from 'vitest'
import { harness, addCodexAccount, managedHome, EXT_HOME, claudeSnapshot } from './accounts-harness'
import type { Harness } from './accounts-harness'
import { findAccount } from '../../src/shared/providers'
import type { CodexCarryInput, CodexCarryResult } from '../../src/main/providers/codex'

const CID = '019dd000-0006-7000-8000-0000000000c1'

interface Seen { input: CodexCarryInput; operations: Record<string, number> }
async function world(answer: (i: CodexCarryInput) => CodexCarryResult | Promise<CodexCarryResult> = () => ({ ok: true, carried: 'copied', bytes: 42 })) {
  const seen: Seen[] = []
  let h!: Harness
  h = await harness({
    claude: [claudeSnapshot('profile-a1')],
    conversationCarry: async (input) => {
      const operations: Record<string, number> = {}
      for (const a of h.doc().accounts) operations[a.id] = h.leases.describe(a.id).operation
      seen.push({ input, operations })
      return answer(input)
    },
  })
  const a = await addCodexAccount(h, 'A')
  const b = await addCodexAccount(h, 'B')
  const realm = (id: string) => findAccount(h.doc(), id)!.authRealmId
  const leftOver = () => h.doc().accounts.reduce((n, x) => n + h.leases.count(x.id), 0)
  return { h, a, b, realm, seen, leftOver }
}
const on = (accountId: string) => ({ uuid: CID, cwd: 'C:\\p\\demo', accountId })

describe('carrying a switched session\'s conversation (P3.6, row 22)', () => {
  it('copies from the account the session ran under into the one it moves to, holding both for the copy, then releasing them', async () => {
    const { h, a, b, realm, seen, leftOver } = await world()
    const r = await h.service.carryConversation({ accountId: b }, on(a))
    expect(r).toEqual({ ok: true, carried: 'copied' })
    expect(seen).toHaveLength(1)
    expect(seen[0].input).toEqual({ fromSessionsDir: `${managedHome(realm(a))}\\sessions`, toHome: managedHome(realm(b)), id: CID, preferCwd: 'C:\\p\\demo', shouldStop: expect.any(Function) })
    expect(seen[0].operations[a]).toBe(1)
    expect(seen[0].operations[b]).toBe(1)
    expect(leftOver()).toBe(0)
  })

  it('the conversation already there is present; an earlier copy brought up to date is extended; a different copy there is refused in plain words; all release', async () => {
    const present = await world(() => ({ ok: true, carried: 'present', bytes: 1 }))
    expect(await present.h.service.carryConversation({ accountId: present.b }, on(present.a))).toEqual({ ok: true, carried: 'present' })
    const extended = await world(() => ({ ok: true, carried: 'extended', bytes: 1 }))
    expect(await extended.h.service.carryConversation({ accountId: extended.b }, on(extended.a))).toEqual({ ok: true, carried: 'extended' })
    expect(extended.leftOver()).toBe(0)
    const differs = await world(() => ({ ok: false, code: 'exists-different' }))
    const r = await differs.h.service.carryConversation({ accountId: differs.b }, on(differs.a))
    expect(r).toMatchObject({ ok: false, code: 'conversation-differs' })
    expect(!r.ok && r.message).toMatch(/already holds a different copy/)
    expect(differs.leftOver()).toBe(0)
    const thrown = await world(() => { throw new Error('disk') })
    // In the copy's own words (quality round 1, item 6).
    const failed = await thrown.h.service.carryConversation({ accountId: thrown.b }, on(thrown.a))
    expect(failed).toMatchObject({ ok: false, code: 'io-failed' })
    expect(!failed.ok && failed.message).toMatch(/could not be copied into the other Codex account's folder, so it was not carried over/)
    expect(thrown.leftOver()).toBe(0)
  })

  it('a respawn that no longer wants the copy (superseded, closed or out of time): cancelled once the realms are held, nothing copied, everything let go (ADR-009 round 1, B2)', async () => {
    const { h, a, b, seen, leftOver } = await world()
    expect(await h.service.carryConversation({ accountId: b }, on(a), { current: () => false })).toMatchObject({ ok: false, code: 'cancelled' })
    expect(seen).toEqual([])
    expect(leftOver()).toBe(0)
    let wanted = true
    expect(await h.service.carryConversation({ accountId: b }, on(a), { current: () => wanted })).toEqual({ ok: true, carried: 'copied' })
    expect(seen[0].input.shouldStop!()).toBe(false)
    wanted = false
    expect(seen[0].input.shouldStop!()).toBe(true)
  })

  it('nothing to carry: no conversation on record, or it is already on that account', async () => {
    const { h, a, b, seen } = await world()
    expect(await h.service.carryConversation({ accountId: b }, undefined)).toEqual({ ok: true, carried: 'none' })
    expect(await h.service.carryConversation({ accountId: a }, on(a))).toEqual({ ok: true, carried: 'none' })
    expect(seen).toEqual([])
  })

  it('never into an account a launch could not run on now: inactive, archived, unknown, another provider\'s', async () => {
    const { h, a, b, seen, leftOver } = await world()
    expect((await h.service.setLifecycle({ accountId: b, lifecycle: 'inactive' })).ok).toBe(true)
    expect(await h.service.carryConversation({ accountId: b }, on(a))).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(await h.service.carryConversation({ accountId: 'acct-' + 'f'.repeat(32) }, on(a))).toMatchObject({ ok: false, code: 'not-found' })
    const claudeAccount = h.doc().accounts.find((x) => x.providerId === 'claude')!.id
    expect(await h.service.carryConversation({ accountId: claudeAccount }, on(a))).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(await h.service.carryConversation({ accountId: a }, on(claudeAccount))).toMatchObject({ ok: false, code: 'invalid-request' })
    const c = await addCodexAccount(h, 'C')
    expect((await h.service.setLifecycle({ accountId: c, lifecycle: 'inactive' })).ok).toBe(true)
    expect((await h.service.setLifecycle({ accountId: c, lifecycle: 'archived' })).ok).toBe(true)
    expect(await h.service.carryConversation({ accountId: c }, on(a))).toMatchObject({ ok: false, code: 'lifecycle' })
    // Nor FROM an archived account.
    const fromArchived = await h.service.carryConversation({ accountId: a }, on(c))
    expect(fromArchived).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(!fromArchived.ok && fromArchived.message).toMatch(/ran under is archived/)
    expect(seen).toEqual([])
    expect(leftOver()).toBe(0)
  })

  it('this computer\'s own sign-in (ADR-009 thesis 14, settled by parity): switching to it carries the conversation into its folder, and away from it reads it, both accounts held', async () => {
    const { h, a, seen, leftOver } = await world()
    h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    const adopted = await h.service.adoptExternalDefault({ providerId: 'codex' })
    if (!adopted.ok) throw new Error(adopted.code)
    const ext = adopted.accountId
    expect(await h.service.carryConversation({ accountId: ext }, on(a))).toEqual({ ok: true, carried: 'copied' })
    expect(seen[0].input.toHome).toBe(EXT_HOME)
    expect(seen[0].operations[a]).toBe(1)
    expect(seen[0].operations[ext]).toBe(1)
    expect(await h.service.carryConversation({ accountId: a }, on(ext))).toEqual({ ok: true, carried: 'copied' })
    expect(seen[1].input.fromSessionsDir).toBe(`${EXT_HOME}\\sessions`)
    expect(leftOver()).toBe(0)
  })

  it('a destination blocked by a changed sign-in (ADR-009 thesis 15): refused before anything is held or copied', async () => {
    const { h, a, b, realm, seen, leftOver } = await world()
    h.signedIn.set(managedHome(realm(b)).toLowerCase(), 'api-key')
    await h.service.refreshStatus({ accountId: b })
    expect(findAccount(h.doc(), b)!.operationalState).toBe('blocked')
    expect(await h.service.carryConversation({ accountId: b }, on(a))).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(seen).toEqual([])
    expect(leftOver()).toBe(0)
  })

  it('a sign-in running on either account (ADR-009 thesis 15): busy, nothing copied, and nothing left held', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let hold = false
    const seen: CodexCarryInput[] = []
    let h!: Harness
    h = await harness({
      conversationCarry: async (i) => { seen.push(i); return { ok: true, carried: 'copied', bytes: 1 } },
      script: {
        login: async (r) => {
          if (hold) await gate
          h.signedIn.set(r.home.toLowerCase(), 'chatgpt')
          return { exitCode: 0, stdout: 'Successfully logged in\n' }
        },
      },
    })
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    hold = true
    const again = h.service.signInAgain({ sameAccount: true, accountId: b, method: 'browser' }, 1)
    for (let i = 0; i < 50 && h.leases.describe(b)['sign-in'] === 0; i++) await new Promise((r) => setTimeout(r, 5))
    expect(h.leases.describe(b)['sign-in']).toBeGreaterThan(0)
    expect(await h.service.carryConversation({ accountId: b }, on(a))).toMatchObject({ ok: false, code: 'busy' })
    expect(await h.service.carryConversation({ accountId: a }, on(b))).toMatchObject({ ok: false, code: 'busy' })
    expect(h.leases.describe(a).operation).toBe(0)
    release()
    await again
    expect(seen).toEqual([])
  })

  it('two sessions switched opposite ways at once (ADR-009 thesis 13): both conversations are carried', async () => {
    const order: string[] = []
    const { h, a, b, seen, leftOver } = await world(async (i) => {
      order.push('start')
      await new Promise((r) => setTimeout(r, 30))
      order.push('end')
      return { ok: true, carried: 'copied', bytes: i.id.length }
    })
    const [one, two] = await Promise.all([
      h.service.carryConversation({ accountId: b }, on(a)),
      h.service.carryConversation({ accountId: a }, on(b)),
    ])
    expect(one).toEqual({ ok: true, carried: 'copied' })
    expect(two).toEqual({ ok: true, carried: 'copied' })
    expect(seen).toHaveLength(2)
    expect(order).toEqual(['start', 'end', 'start', 'end'])
    expect(leftOver()).toBe(0)
  })

  it('a sign-out or archive holding either account: busy, and the lease already taken is let go', async () => {
    const { h, a, b, seen, leftOver } = await world()
    const holdB = h.leases.hold(b, 'codex')!
    expect(await h.service.carryConversation({ accountId: b }, on(a))).toMatchObject({ ok: false, code: 'busy' })
    expect(h.leases.count(a)).toBe(0)
    holdB()
    const holdA = h.leases.hold(a, 'codex')!
    expect(await h.service.carryConversation({ accountId: b }, on(a))).toMatchObject({ ok: false, code: 'busy' })
    holdA()
    expect(seen).toEqual([])
    expect(leftOver()).toBe(0)
  })

  it('with the provider off nothing is carried', async () => {
    let pref: 'on' | 'off' = 'on'
    const seen: CodexCarryInput[] = []
    const h = await harness({ preference: { codex: () => pref }, conversationCarry: async (i) => { seen.push(i); return { ok: true, carried: 'copied', bytes: 1 } } })
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    pref = 'off'
    expect((await h.service.carryConversation({ accountId: b }, on(a))).ok).toBe(false)
    expect(seen).toEqual([])
  })

  it('a malformed record or request is refused before anything is held', async () => {
    const { h, a, b, seen, leftOver } = await world()
    for (const bad of [{ uuid: 42, cwd: 'x', accountId: a }, { uuid: CID, cwd: null, accountId: a }, { uuid: CID, cwd: 'x', accountId: 7 }]) {
      expect(await h.service.carryConversation({ accountId: b }, bad as never)).toMatchObject({ ok: false, code: 'invalid-request' })
    }
    expect(await h.service.carryConversation({} as never, on(a))).toMatchObject({ ok: false, code: 'invalid-request' })
    expect(seen).toEqual([])
    expect(leftOver()).toBe(0)
  })
})
