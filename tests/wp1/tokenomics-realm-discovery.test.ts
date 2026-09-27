// WP1.2 / WP1.38 -- WP2 commit 4 (plan A13, design D10): the usage index
// reads every realm a Codex session can write to -- the user's own ~/.codex
// and each live Codex account's managed folder -- and follows accounts as
// they are added, retired or moved to a new resources directory. A retired
// account's folder is left out: nothing is read on its old record's behalf.
//
// PURE: the in-memory accounts harness, and the tokenomics service with its
// supervisor and worker replaced (the worker's own folder walk is covered by
// the native tokenomics suites, which run on CI and the VM only).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { harness, addCodexAccount, managedHome, EXT_HOME } from './accounts-harness'
import type { Harness } from './accounts-harness'

const realmOf = (h: Harness, accountId: string) => h.doc().accounts.find((a) => a.id === accountId)!.authRealmId

describe('the Codex transcript folders of the live accounts (AccountsService.sessionsDirs)', () => {
  it('lists the folder of each active realm, once; a retired account\'s is left out; other providers have none', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    const ext = await h.service.adoptExternalDefault({ providerId: 'codex' })
    if (!ext.ok) throw new Error(ext.code)
    const dirs = await h.service.sessionsDirs('codex')
    expect(dirs.sort()).toEqual([`${managedHome(realmOf(h, a))}\\sessions`, `${managedHome(realmOf(h, b))}\\sessions`, `${EXT_HOME}\\sessions`].sort())
    expect(await h.service.sessionsDirs('claude')).toEqual([])
    // An inactive account keeps its folder in the index (its history is real);
    // archiving retires the realm.
    expect((await h.service.setLifecycle({ accountId: b, lifecycle: 'inactive' })).ok).toBe(true)
    expect(await h.service.sessionsDirs('codex')).toContain(`${managedHome(realmOf(h, b))}\\sessions`)
    expect((await h.service.setLifecycle({ accountId: b, lifecycle: 'archived' })).ok).toBe(true)
    expect(await h.service.sessionsDirs('codex')).not.toContain(`${managedHome(realmOf(h, b))}\\sessions`)
  })

  it('lists nothing while the registry is unavailable, and leaves out a realm that cannot be located', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    h.useStore(null)
    expect(await h.service.sessionsDirs('codex')).toEqual([])
    h.useStore(h.store)
    const launchOps = h.codex.launch!
    const real = launchOps.sessionsDir
    ;(launchOps as { sessionsDir: unknown }).sessionsDir = async () => { throw new Error('boom') }
    expect(await h.service.sessionsDirs('codex')).toEqual([])
    ;(launchOps as { sessionsDir: unknown }).sessionsDir = real
    expect(await h.service.sessionsDirs('codex')).toEqual([`${managedHome(realmOf(h, a))}\\sessions`])
  })
})

// Usage track MP9: the same folders with whose sessions each holds.
describe('the Codex transcript folders with their accounts (AccountsService.sessionsRoots)', () => {
  it('names each folder\'s account, marks this computer\'s own sign-in, and leaves a retired account\'s out', async () => {
    const h = await harness()
    const a = await addCodexAccount(h, 'A')
    const b = await addCodexAccount(h, 'B')
    h.signedIn.set(EXT_HOME.toLowerCase(), 'chatgpt')
    const ext = await h.service.adoptExternalDefault({ providerId: 'codex' })
    if (!ext.ok) throw new Error(ext.code)
    const byDir = (roots: Awaited<ReturnType<typeof h.service.sessionsRoots>>) => [...(roots ?? [])].sort((x, y) => x.dir.localeCompare(y.dir))
    expect(byDir(await h.service.sessionsRoots('codex'))).toEqual(byDir([
      { dir: `${managedHome(realmOf(h, a))}\\sessions`, accountId: a, external: false },
      { dir: `${managedHome(realmOf(h, b))}\\sessions`, accountId: b, external: false },
      { dir: `${EXT_HOME}\\sessions`, accountId: ext.accountId, external: true },
    ]))
    expect(await h.service.sessionsRoots('claude')).toEqual([])
    expect((await h.service.setLifecycle({ accountId: b, lifecycle: 'inactive' })).ok).toBe(true)
    expect((await h.service.setLifecycle({ accountId: b, lifecycle: 'archived' })).ok).toBe(true)
    expect((await h.service.sessionsRoots('codex'))?.map((r) => r.accountId)).not.toContain(b)
  })

  it('lists nothing while the registry is unavailable, and not a setup still under way', async () => {
    const h = await harness()
    const begun = await h.service.beginSetup({ providerId: 'codex', method: 'browser' })
    if (!begun.ok) throw new Error(begun.code)
    expect(await h.service.sessionsRoots('codex')).toEqual([])
    await addCodexAccount(h, 'A')
    // MP9 round 1 (lens B): no registry yet, or one not read yet, names
    // nothing yet (null); one that cannot be read names none.
    const store = h.store
    h.useStore(null)
    expect(await h.service.sessionsRoots('codex')).toBeNull()
    h.useStore(store)
    const status = store.status.bind(store)
    store.status = () => ({ mode: 'recovery', reason: 'unloaded', problems: [] })
    expect(await h.service.sessionsRoots('codex')).toBeNull()
    store.status = () => ({ mode: 'recovery', reason: 'invalid', problems: ['bad'] })
    expect(await h.service.sessionsRoots('codex')).toEqual([])
    store.status = status
    expect(await h.service.sessionsRoots('claude')).toEqual([])
  })
})

// The service side: tokenomics-service follows the accounts service and hands
// the supervisor each changed set, once per change, each folder with its
// account's key (MP9).
type Root = { dir: string; accountId: string | null; external: boolean }
const tk = vi.hoisted(() => ({
  dirs: [] as Array<Array<{ dir: string; accountKey: string }>>,
  listeners: [] as Array<() => void>,
  current: [] as Array<{ dir: string; accountId: string | null; external: boolean }>,
  sessionsRoots: vi.fn(async (_id: string) => [] as Array<{ dir: string; accountId: string | null; external: boolean }>),
  noService: false,
}))
vi.mock('../../src/main/tokenomics/tk-supervisor', () => ({
  TokenomicsSupervisor: class {
    start() {}
    shutdown() {}
    setPricing() {}
    setConfigs() {}
    setCodexRealmSessionsDirs(d: Array<{ dir: string; accountKey: string }>) { tk.dirs.push(d.map((x) => ({ ...x }))) }
  },
}))
vi.mock('../../src/main/tokenomics/fork-tokenomics-worker', () => ({ forkTokenomicsWorker: () => null }))
vi.mock('../../src/main/tokenomics/tk-pricing', () => ({ getAllPricing: () => ({}), fetchModelPricing: async () => {} }))
vi.mock('../../src/main/model-registry-service', () => ({ onRegistryReload: () => () => {} }))
vi.mock('../../src/main/data-paths', () => ({ getDataDirectory: () => 'C:\\data', getResourcesDirectory: () => 'C:\\res' }))
vi.mock('../../src/main/config-manager', () => ({ readConfig: () => [] }))
vi.mock('../../src/main/provider-accounts', () => ({
  getAccountsService: () => (tk.noService ? null : {
    sessionsRoots: tk.sessionsRoots,
    subscribe: (l: () => void) => { tk.listeners.push(l); return () => { tk.listeners.splice(tk.listeners.indexOf(l), 1) } },
  }),
}))

describe('tokenomics follows the accounts (tokenomics-service)', () => {
  beforeEach(() => {
    tk.dirs = []
    tk.listeners = []
    tk.current = []
    tk.noService = false
    tk.sessionsRoots.mockReset()
    tk.sessionsRoots.mockImplementation(async () => tk.current.map((r) => ({ ...r })))
  })

  const R1: Root = { dir: 'C:\\res\\codex-realms\\r1\\sessions', accountId: 'acct-1', external: false }
  const R2: Root = { dir: 'C:\\res\\codex-realms\\r2\\sessions', accountId: 'acct-2', external: false }

  it('hands the supervisor the folders at start and each CHANGED set after, and stops following on shutdown', async () => {
    const { initTokenomics, shutdownTokenomics } = await import('../../src/main/tokenomics/tokenomics-service')
    tk.current = [R1]
    initTokenomics({ emit: () => {} })
    await vi.waitFor(() => expect(tk.dirs).toEqual([[{ dir: R1.dir, accountKey: 'codex:acct-1' }]]))
    // A change the index does not care about (a lease) sends nothing new.
    tk.listeners.forEach((l) => l())
    await new Promise((r) => setTimeout(r, 0))
    expect(tk.dirs).toHaveLength(1)
    tk.current = [R1, R2]
    tk.listeners.forEach((l) => l())
    await vi.waitFor(() => expect(tk.dirs.at(-1)).toEqual([{ dir: R1.dir, accountKey: 'codex:acct-1' }, { dir: R2.dir, accountKey: 'codex:acct-2' }]))
    shutdownTokenomics()
    expect(tk.listeners).toHaveLength(0)
  })

  // MP9 round 1 (Q-4): the index is always told the folders once, so it can
  // settle its one-off attribution: none when there is nothing to ask.
  it('names nothing while the registry is not read yet, then names the folders once it is', async () => {
    const { initTokenomics, shutdownTokenomics } = await import('../../src/main/tokenomics/tokenomics-service')
    tk.sessionsRoots.mockImplementationOnce(async () => null as never)
    initTokenomics({ emit: () => {} })
    await new Promise((r) => setTimeout(r, 10))
    expect(tk.dirs).toEqual([])
    tk.current = [R1]
    tk.listeners.forEach((l) => l())
    await vi.waitFor(() => expect(tk.dirs).toEqual([[{ dir: R1.dir, accountKey: 'codex:acct-1' }]]))
    shutdownTokenomics()
  })

  it('names no folders when there is no accounts service, and none for now when the first look fails', async () => {
    const { initTokenomics, shutdownTokenomics } = await import('../../src/main/tokenomics/tokenomics-service')
    tk.noService = true
    initTokenomics({ emit: () => {} })
    expect(tk.dirs).toEqual([[]])
    shutdownTokenomics()
    tk.dirs = []
    tk.noService = false
    tk.sessionsRoots.mockImplementationOnce(async () => { throw new Error('registry busy') })
    initTokenomics({ emit: () => {} })
    await vi.waitFor(() => expect(tk.dirs).toEqual([[]]))
    // A later look names them; a later failure does not take them away.
    tk.current = [R1]
    tk.listeners.forEach((l) => l())
    await vi.waitFor(() => expect(tk.dirs.at(-1)).toEqual([{ dir: R1.dir, accountKey: 'codex:acct-1' }]))
    tk.sessionsRoots.mockImplementationOnce(async () => { throw new Error('registry busy') })
    tk.listeners.forEach((l) => l())
    await new Promise((r) => setTimeout(r, 10))
    expect(tk.dirs).toHaveLength(2)
    shutdownTokenomics()
  })

  it('names each folder\'s account: this computer\'s own sign-in as codex:external, a folder no account owns as not recorded', async () => {
    const { codexSessionsRoot } = await import('../../src/main/tokenomics/tokenomics-service')
    expect(codexSessionsRoot(R1)).toEqual({ dir: R1.dir, accountKey: 'codex:acct-1' })
    expect(codexSessionsRoot({ dir: 'C:\\Users\\u\\.codex\\sessions', accountId: 'acct-9', external: true })).toEqual({ dir: 'C:\\Users\\u\\.codex\\sessions', accountKey: 'codex:external' })
    expect(codexSessionsRoot({ dir: 'C:\\x', accountId: null, external: false })).toEqual({ dir: 'C:\\x', accountKey: '' })
    // An id that could not be a key is not recorded rather than passed on.
    expect(codexSessionsRoot({ dir: 'C:\\x', accountId: 'bad id;', external: false })).toEqual({ dir: 'C:\\x', accountKey: '' })
  })
})
