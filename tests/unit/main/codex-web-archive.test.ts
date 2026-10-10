// [host] WP2 PR 4, P4.6 second half (row 58): archiving an account clears its
// web session before anything of the archive changes, and a clear that fails
// refuses the archive (Claude's account delete is the precedent:
// account-profiles-handlers runs its read-only refusals, then clears the
// claude.ai partition before anything destructive, and refuses the delete when
// the wipe fails). The accounts service calls a provider-neutral seam inside
// provider core (archive-hooks); the Codex web session registers its clear
// there at start. An archive commits only through a path that ran the hook,
// whatever lifecycle change lands beside it. PURE: the in-memory accounts
// harness of tests/wp1.
import { describe, it, expect, beforeEach } from 'vitest'
import { harness, addCodexAccount, EXT_HOME } from '../../wp1/accounts-harness'
import { onBeforeAccountArchive, prepareAccountArchive, _resetAccountArchiveHooksForTest } from '../../../src/main/providers/core'
import { setAccountLifecycle } from '../../../src/shared/providers/registry'

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
  it('a managed archive runs the hook after its read-only status check and before anything changes, then releases it', async () => {
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
    // Only the read-only status check had run when the hook ran: nothing
    // was signed out or removed yet.
    expect(runsAtHook).toEqual([before + 1])
    expect(h.args().slice(before, before + 1)).toEqual(['login status'])
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
    expect(h.args().slice(before)).toEqual(['login status'])
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

  it('an archive whose read-only status check fails never runs the hook', async () => {
    let failStatus = false
    let signed: Map<string, unknown> | null = null
    const h = await harness({ script: { 'login status': (r) => (failStatus
      ? { exitCode: null, timedOut: true }
      : signed?.get(r.home.toLowerCase()) ? { exitCode: 0, stderr: 'Logged in using ChatGPT\n' } : { exitCode: 1, stderr: 'Not logged in\n' }) } })
    signed = h.signedIn
    const a = await addCodexAccount(h, 'A')
    await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })
    failStatus = true
    let ran = 0
    onBeforeAccountArchive(async () => { ran++ })
    const r = await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })
    expect(r.ok).toBe(false)
    expect(ran).toBe(0)
    expect(h.doc().accounts.find((x) => x.id === a)).toMatchObject({ lifecycle: 'inactive' })
  })
})

describe('[host] an archive commits only through a path that ran the hook', () => {
  type Result = Awaited<ReturnType<Awaited<ReturnType<typeof harness>>['service']['setLifecycle']>>
  /** The two changes in a fixed order: the registry lock is held while both
   *  read the account (still active) and queue their writes, `first` before
   *  `second`; then the lock goes and the writes land in that order. */
  async function inOrder(h: Awaited<ReturnType<typeof harness>>, first: () => Promise<Result>, second: () => Promise<Result>): Promise<[Result, Result]> {
    let open!: () => void
    const held = h.store.exclusive(() => new Promise<void>((r) => { open = r }))
    const one = first()
    await new Promise((r) => setTimeout(r, 20))
    const two = second()
    await new Promise((r) => setTimeout(r, 20))
    open()
    await held
    return [await one, await two]
  }
  const CHANGED = /changed while it was being archived/

  it('managed: an archive that read the account active and lands after an inactivate is refused without the hook, then archives through it', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    let ran = 0
    onBeforeAccountArchive(async () => { ran++ })
    const [r1, r2] = await inOrder(h,
      () => h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' }),
      () => h.service.setLifecycle({ accountId: a, lifecycle: 'archived' }))
    expect(r1).toEqual({ ok: true })
    // The archive's write met an inactive account it had not cleared.
    expect(r2).toMatchObject({ ok: false, code: 'lifecycle' })
    expect((r2 as { message?: string }).message).toMatch(CHANGED)
    expect(ran).toBe(0)
    expect(h.doc().accounts.find((x) => x.id === a)).toMatchObject({ lifecycle: 'inactive' })
    // Asked again, it archives through the hook.
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })).toEqual({ ok: true })
    expect(ran).toBe(1)
  })

  it('managed: an archive that lands before the inactivate is refused by the rules, without the hook', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    let ran = 0
    onBeforeAccountArchive(async () => { ran++ })
    const [r2, r1] = await inOrder(h,
      () => h.service.setLifecycle({ accountId: a, lifecycle: 'archived' }),
      () => h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' }))
    expect(r1).toEqual({ ok: true })
    expect(r2).toMatchObject({ ok: false, code: 'lifecycle' })
    expect((r2 as { message?: string }).message).not.toMatch(CHANGED)
    expect(ran).toBe(0)
    expect(h.doc().accounts.find((x) => x.id === a)).toMatchObject({ lifecycle: 'inactive' })
  })

  it('external: an archive (acknowledged) that read the account active and lands after an inactivate is refused without the hook', async () => {
    const h = await harness()
    h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    expect((await h.service.adoptExternalDefault({ providerId: 'codex' })).ok).toBe(true)
    const ext = h.doc().accounts.find((x) => x.providerId === 'codex')!.id
    let ran = 0
    onBeforeAccountArchive(async () => { ran++ })
    const [r1, r2] = await inOrder(h,
      () => h.service.setLifecycle({ accountId: ext, lifecycle: 'inactive' }),
      () => h.service.setLifecycle({ accountId: ext, lifecycle: 'archived', acknowledgeExternal: true }))
    expect(r1).toEqual({ ok: true })
    expect(r2).toMatchObject({ ok: false, code: 'lifecycle' })
    expect((r2 as { message?: string }).message).toMatch(CHANGED)
    expect(ran).toBe(0)
    expect(h.doc().accounts.find((x) => x.id === ext)).toMatchObject({ lifecycle: 'inactive' })
    expect(await h.service.setLifecycle({ accountId: ext, lifecycle: 'archived', acknowledgeExternal: true })).toEqual({ ok: true })
    expect(ran).toBe(1)
  })

  it('external: an archive (acknowledged) that lands before the inactivate is refused by the rules, without the hook', async () => {
    const h = await harness()
    h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    expect((await h.service.adoptExternalDefault({ providerId: 'codex' })).ok).toBe(true)
    const ext = h.doc().accounts.find((x) => x.providerId === 'codex')!.id
    let ran = 0
    onBeforeAccountArchive(async () => { ran++ })
    const [r2, r1] = await inOrder(h,
      () => h.service.setLifecycle({ accountId: ext, lifecycle: 'archived', acknowledgeExternal: true }),
      () => h.service.setLifecycle({ accountId: ext, lifecycle: 'inactive' }))
    expect(r1).toEqual({ ok: true })
    expect(r2).toMatchObject({ ok: false, code: 'lifecycle' })
    expect((r2 as { message?: string }).message).not.toMatch(CHANGED)
    expect(ran).toBe(0)
    expect(h.doc().accounts.find((x) => x.id === ext)).toMatchObject({ lifecycle: 'inactive' })
  })

  it('the sequential control still archives through the hook', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    let ran = 0
    onBeforeAccountArchive(async () => { ran++ })
    await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })).toEqual({ ok: true })
    expect(ran).toBe(1)
  })
})

describe('[host] a lifecycle change that lands before the archive takes its hold is read again under it', () => {
  /** Hold the registry lock, queue a change behind it, start the archive (it
   *  reads the account before the change commits, and queues its hold after
   *  it), then let the lock go. */
  async function raced(h: Awaited<ReturnType<typeof harness>>, id: string, archive: () => Promise<{ ok: boolean }>) {
    let open!: () => void
    const held = h.store.exclusive(() => new Promise<void>((r) => { open = r }))
    const change = h.store.mutate((d, t) => setAccountLifecycle(d, id, 'archived', { consumers: 0 }, t))
    const result = archive()
    await new Promise((r) => setTimeout(r, 20))
    open()
    await held
    expect((await change).ok).toBe(true)
    return result
  }

  it('managed: the archive is refused and its hook never runs', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    await h.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })
    let ran = 0
    onBeforeAccountArchive(async () => { ran++ })
    const before = h.runs.length
    const r = await raced(h, a, () => h.service.setLifecycle({ accountId: a, lifecycle: 'archived' }))
    expect(r).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(ran).toBe(0)
    expect(h.args().slice(before)).toEqual([])
  })

  it('external: the archive is refused and its hook never runs', async () => {
    const h = await harness()
    h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    expect((await h.service.adoptExternalDefault({ providerId: 'codex' })).ok).toBe(true)
    const ext = h.doc().accounts.find((x) => x.providerId === 'codex')!.id
    await h.service.setLifecycle({ accountId: ext, lifecycle: 'inactive' })
    let ran = 0
    onBeforeAccountArchive(async () => { ran++ })
    const r = await raced(h, ext, () => h.service.setLifecycle({ accountId: ext, lifecycle: 'archived', acknowledgeExternal: true }))
    expect(r).toMatchObject({ ok: false, code: 'lifecycle' })
    expect(ran).toBe(0)
  })
})

describe('[host] an external archive clears only after its home is known to hold the same sign-in', () => {
  it('a home that now holds another sign-in refuses the archive before the hook runs', async () => {
    const h = await harness()
    h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    expect((await h.service.adoptExternalDefault({ providerId: 'codex' })).ok).toBe(true)
    const ext = h.doc().accounts.find((x) => x.providerId === 'codex')!.id
    await h.service.setLifecycle({ accountId: ext, lifecycle: 'inactive' })
    h.signedIn.set(EXT_HOME.toLowerCase(), 'api-key')
    let ran = 0
    onBeforeAccountArchive(async () => { ran++ })
    const r = await h.service.setLifecycle({ accountId: ext, lifecycle: 'archived', acknowledgeExternal: true })
    expect(r.ok).toBe(false)
    expect(ran).toBe(0)
    expect(h.doc().accounts.find((x) => x.id === ext)).toMatchObject({ lifecycle: 'inactive' })
  })
})

describe('[host] a provider without sign-in operations archives through the hook too', () => {
  // The same disk restarted with the provider's sign-in operations absent:
  // the archive takes the path that has no sign-out to run.
  const noAuth = { authWrap: () => undefined as never }

  it('managed: archived, the hook ran once', async () => {
    const h1 = await harness()
    const a = await addCodexAccount(h1, 'A')
    await h1.service.setLifecycle({ accountId: a, lifecycle: 'inactive' })
    const h = await harness({ port: h1.port, folders: h1.folders, ...noAuth })
    let ran = 0
    onBeforeAccountArchive(async () => { ran++ })
    expect(await h.service.setLifecycle({ accountId: a, lifecycle: 'archived' })).toEqual({ ok: true })
    expect(ran).toBe(1)
    expect(h.doc().accounts.find((x) => x.id === a)).toMatchObject({ lifecycle: 'archived' })
  })

  it('external: archived (acknowledged), the hook ran once', async () => {
    const h1 = await harness()
    h1.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    expect((await h1.service.adoptExternalDefault({ providerId: 'codex' })).ok).toBe(true)
    const ext = h1.doc().accounts.find((x) => x.providerId === 'codex')!.id
    await h1.service.setLifecycle({ accountId: ext, lifecycle: 'inactive' })
    const h = await harness({ port: h1.port, folders: h1.folders, ...noAuth })
    let ran = 0
    onBeforeAccountArchive(async () => { ran++ })
    expect(await h.service.setLifecycle({ accountId: ext, lifecycle: 'archived', acknowledgeExternal: true })).toEqual({ ok: true })
    expect(ran).toBe(1)
  })
})
