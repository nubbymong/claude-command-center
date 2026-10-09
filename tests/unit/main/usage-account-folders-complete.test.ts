// The usage index settles its first sort on the first list of account
// folders it is given, so that list names every live account's folder: one
// that cannot be found at that moment (its lookup throws or answers none)
// holds the list back, asked again after each pause; only after the last
// pause does the list go without it, saying so once. PURE: the in-memory
// accounts harness of tests/wp1, with the pauses shortened.
import { describe, it, expect } from 'vitest'
import { harness, addCodexAccount, managedHome } from '../../wp1/accounts-harness'
import type { Harness } from '../../wp1/accounts-harness'
import { ACCOUNT_FOLDER_RETRY_MS } from '../../../src/main/providers/core/accounts-service'

const PAUSES = [5, 5, 5]
const realmOf = (h: Harness, accountId: string) => h.doc().accounts.find((a) => a.id === accountId)!.authRealmId

/** Two live accounts; the first's folder lookup answered by `answer` (the
 *  real lookup otherwise), each ask of it counted. */
async function twoAccounts(answer: (n: number, real: () => Promise<string | null>) => Promise<string | null>, failing: 'a' | 'b' = 'a') {
  const h = await harness({ usageReads: { accountFolderRetryMs: PAUSES } })
  const a = await addCodexAccount(h, 'A')
  const b = await addCodexAccount(h, 'B')
  const launch = h.codex.launch as { sessionsDir: (r: { authRealmId: string }) => Promise<string | null> }
  const real = launch.sessionsDir.bind(launch)
  const asked = { a: 0 }
  launch.sessionsDir = async (ref) => {
    if (ref.authRealmId !== realmOf(h, failing === 'a' ? a : b)) return real(ref)
    asked.a++
    return answer(asked.a, () => real(ref))
  }
  const dirOf = (id: string) => `${managedHome(realmOf(h, id))}\\sessions`
  return { h, a, b, asked, dirOf, launch, real }
}

const dirs = (roots: Array<{ dir: string }> | null) => (roots ?? []).map((r) => r.dir).sort()

describe('an account folder that cannot be found yet holds the list back', () => {
  it('a lookup that throws once: the list waits and names both folders', async () => {
    const t = await twoAccounts(async (n, real) => { if (n === 1) throw new Error('EBUSY'); return real() })
    expect(dirs(await t.h.service.sessionsRoots('codex'))).toEqual([t.dirOf(t.a), t.dirOf(t.b)].sort())
    expect(t.asked.a).toBe(2)
    expect(t.h.logs.filter((l) => /account folder/.test(l))).toEqual([])
  })

  it('a lookup that answers none twice: the list waits and names both folders', async () => {
    const t = await twoAccounts(async (n, real) => (n <= 2 ? null : real()))
    expect(dirs(await t.h.service.sessionsRoots('codex'))).toEqual([t.dirOf(t.a), t.dirOf(t.b)].sort())
    expect(t.asked.a).toBe(3)
  })

  it('the paths-only list follows the same rule', async () => {
    const t = await twoAccounts(async (n, real) => { if (n === 1) throw new Error('EBUSY'); return real() })
    expect((await t.h.service.sessionsDirs('codex')).sort()).toEqual([t.dirOf(t.a), t.dirOf(t.b)].sort())
  })
})

describe('the wait is bounded: after the last pause the list goes without the folder and says so once', () => {
  it('a folder that never comes: asked once and once after each pause, then left out with one log line', async () => {
    const t = await twoAccounts(async () => { throw new Error('EBUSY') })
    expect(dirs(await t.h.service.sessionsRoots('codex'))).toEqual([t.dirOf(t.b)])
    expect(t.asked.a).toBe(PAUSES.length + 1)
    const said = t.h.logs.filter((l) => /account folder/.test(l))
    expect(said).toEqual(['[accounts] the usage index lists 1 account folder(s) fewer: they could not be found'])
    // No path or id in the line.
    expect(said[0]).not.toMatch(/realm-|\\|\//)
  })

  it('a later list does not wait for a folder an earlier one went without, nor say so again; once found it is named', async () => {
    let heal = false
    const t = await twoAccounts(async (_n, real) => { if (!heal) throw new Error('EBUSY'); return real() })
    await t.h.service.sessionsRoots('codex')
    const before = t.asked.a
    expect(dirs(await t.h.service.sessionsRoots('codex'))).toEqual([t.dirOf(t.b)])
    expect(t.asked.a).toBe(before + 1)
    expect(t.h.logs.filter((l) => /account folder/.test(l)).length).toBe(1)
    heal = true
    expect(dirs(await t.h.service.sessionsRoots('codex'))).toEqual([t.dirOf(t.a), t.dirOf(t.b)].sort())
    // Found again: a later failure holds the list back again.
    heal = false
    const again = t.asked.a
    expect(dirs(await t.h.service.sessionsRoots('codex'))).toEqual([t.dirOf(t.b)])
    expect(t.asked.a).toBe(again + PAUSES.length + 1)
    expect(t.h.logs.filter((l) => /account folder/.test(l)).length).toBe(2)
  })

  it('a list for another provider keeps the folders this one went without: the next list for this one neither waits nor says so again', async () => {
    const t = await twoAccounts(async () => { throw new Error('EBUSY') })
    await t.h.service.sessionsRoots('codex')
    // Another provider whose sessions launch here, with no live account of its own.
    ;(t.h.claude as { launch?: unknown }).launch = { kinds: ['session'], sessionsDir: async () => null }
    expect(await t.h.service.sessionsRoots('claude')).toEqual([])
    const before = t.asked.a
    expect(dirs(await t.h.service.sessionsRoots('codex'))).toEqual([t.dirOf(t.b)])
    expect(t.asked.a).toBe(before + 1)
    expect(t.h.logs.filter((l) => /account folder/.test(l)).length).toBe(1)
  })

  it('the shipped pauses are short and finite', () => {
    expect(ACCOUNT_FOLDER_RETRY_MS.length).toBeGreaterThan(0)
    expect(ACCOUNT_FOLDER_RETRY_MS.reduce((s, n) => s + n, 0)).toBeLessThanOrEqual(5_000)
  })

  it('an account archived while the list waits is not waited for', async () => {
    let archive: () => Promise<void> = async () => {}
    const changes: unknown[] = []
    // B (not the default account) fails its first ask while it is archived.
    const t = await twoAccounts(async (n) => { if (n === 1) await archive(); throw new Error('EBUSY') }, 'b')
    archive = async () => {
      changes.push(await t.h.service.setLifecycle({ accountId: t.b, lifecycle: 'inactive' }))
      changes.push(await t.h.service.setLifecycle({ accountId: t.b, lifecycle: 'archived' }))
    }
    // The next look finds no live account to wait for.
    expect(dirs(await t.h.service.sessionsRoots('codex'))).toEqual([t.dirOf(t.a)])
    expect(changes).toEqual([{ ok: true }, { ok: true }])
    expect(t.asked.a).toBe(1)
    expect(t.h.logs.filter((l) => /account folder/.test(l))).toEqual([])
  })
})
