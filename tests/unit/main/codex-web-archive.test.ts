// [host] WP2 PR 4, P4.6 second half (row 58): archiving an account clears its
// web session FIRST, and a clear that fails refuses the archive (Claude's
// account delete is the precedent: account-profiles-handlers clears the
// claude.ai partition before anything destructive and refuses the delete when
// the wipe fails). The accounts service calls a provider-neutral seam
// (account-archive-hooks); the Codex web session registers its clear there at
// start. PURE: the in-memory accounts harness of tests/wp1.
import { describe, it, expect, beforeEach } from 'vitest'
import { harness, addCodexAccount, EXT_HOME } from '../../wp1/accounts-harness'
import { onBeforeAccountArchive, prepareAccountArchive, _resetAccountArchiveHooksForTest } from '../../../src/main/account-archive-hooks'

beforeEach(() => _resetAccountArchiveHooksForTest())

describe('[host] the archive seam (pure)', () => {
  it('runs every hook in order and returns one release that runs every hook\'s own', async () => {
    const seen: string[] = []
    onBeforeAccountArchive(async (id, p) => { seen.push(`a ${id} ${p}`); return () => seen.push('release a') })
    onBeforeAccountArchive(async (id) => { seen.push(`b ${id}`) })
    const release = await prepareAccountArchive('acct-0123456789abcdef', 'codex')
    expect(seen).toEqual(['a acct-0123456789abcdef codex', 'b acct-0123456789abcdef'])
    release()
    expect(seen.at(-1)).toBe('release a')
  })

  it('a hook that fails releases the ones that ran and rethrows', async () => {
    const seen: string[] = []
    onBeforeAccountArchive(async () => () => seen.push('release a'))
    onBeforeAccountArchive(async () => { throw new Error('could not clear') })
    await expect(prepareAccountArchive('acct-0123456789abcdef', 'codex')).rejects.toThrow(/could not clear/)
    expect(seen).toEqual(['release a'])
  })

  it('no hooks: a no-op release', async () => {
    const release = await prepareAccountArchive('acct-0123456789abcdef', 'codex')
    expect(() => release()).not.toThrow()
  })
})

describe('[host] the accounts service archive', () => {
  it('a managed archive runs the hook first, before its sign-out, then releases it', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })
    const order: string[] = []
    const runsAtHook: number[] = []
    onBeforeAccountArchive(async (id, providerId) => {
      order.push(`hook ${id === a} ${providerId}`)
      runsAtHook.push(h.runs.length)
      return () => order.push('release')
    })
    const before = h.runs.length
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })).toEqual({ ok: true })
    expect(order).toEqual(['hook true codex', 'release'])
    // Nothing of the archive had run when the hook ran.
    expect(runsAtHook).toEqual([before])
    expect(h.args().slice(before)).toEqual(['login status', 'logout', 'login status'])
    expect(h.doc().accounts.find((x) => x.id === a)).toMatchObject({ lifecycle: 'archived' })
  })

  it('a clear that fails refuses the archive: no sign-out ran, the account stays inactive and signed in', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })
    onBeforeAccountArchive(async () => { throw new Error('simulated wipe failure') })
    const before = h.runs.length
    const r = await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })
    expect(r).toMatchObject({ ok: false, code: 'lifecycle' })
    expect((r as { message?: string }).message).toMatch(/web sign-in could not be cleared/)
    expect(h.runs.length).toBe(before)
    expect(h.doc().accounts.find((x) => x.id === a)).toMatchObject({ lifecycle: 'inactive', lastKnownAuthState: 'signed-in' })
  })

  it('an external home\'s archive is refused the same way when the clear fails', async () => {
    const h = await harness()
    h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    const adopted = await h.service.adoptExternalDefault({ providerId: 'codex' })
    expect(adopted.ok).toBe(true)
    const ext = h.doc().accounts.find((x) => x.providerId === 'codex')!.id
    await h.service.setLifecycle({ accountId: ext, lifecycle: 'inactive' })
    onBeforeAccountArchive(async () => { throw new Error('simulated wipe failure') })
    const r = await h.service.setLifecycle({ accountId: ext, lifecycle: 'archived', acknowledgeExternal: true })
    expect(r).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(h.doc().accounts.find((x) => x.id === ext)).toMatchObject({ lifecycle: 'inactive' })
  })

  it('an archive the rules refuse anyway (an active account) never runs the hook', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    let ran = 0
    onBeforeAccountArchive(async () => { ran++ })
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(ran).toBe(0)
  })
})
