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

// The service side: tokenomics-service follows the accounts service and hands
// the supervisor each changed set, once per change.
const tk = vi.hoisted(() => ({
  dirs: [] as string[][],
  listeners: [] as Array<() => void>,
  current: [] as string[],
  sessionsDirs: vi.fn(async (_id: string) => [] as string[]),
}))
vi.mock('../../src/main/tokenomics/tk-supervisor', () => ({
  TokenomicsSupervisor: class {
    start() {}
    shutdown() {}
    setPricing() {}
    setConfigs() {}
    setCodexRealmSessionsDirs(d: string[]) { tk.dirs.push([...d]) }
  },
}))
vi.mock('../../src/main/tokenomics/fork-tokenomics-worker', () => ({ forkTokenomicsWorker: () => null }))
vi.mock('../../src/main/tokenomics/tk-pricing', () => ({ getAllPricing: () => ({}), fetchModelPricing: async () => {} }))
vi.mock('../../src/main/model-registry-service', () => ({ onRegistryReload: () => () => {} }))
vi.mock('../../src/main/data-paths', () => ({ getDataDirectory: () => 'C:\\data', getResourcesDirectory: () => 'C:\\res' }))
vi.mock('../../src/main/config-manager', () => ({ readConfig: () => [] }))
vi.mock('../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    sessionsDirs: tk.sessionsDirs,
    subscribe: (l: () => void) => { tk.listeners.push(l); return () => { tk.listeners.splice(tk.listeners.indexOf(l), 1) } },
  }),
}))

describe('tokenomics follows the accounts (tokenomics-service)', () => {
  beforeEach(() => {
    tk.dirs = []
    tk.listeners = []
    tk.current = []
    tk.sessionsDirs.mockReset()
    tk.sessionsDirs.mockImplementation(async () => [...tk.current])
  })

  it('hands the supervisor the folders at start and each CHANGED set after, and stops following on shutdown', async () => {
    const { initTokenomics, shutdownTokenomics } = await import('../../src/main/tokenomics/tokenomics-service')
    tk.current = ['C:\\res\\codex-realms\\r1\\sessions']
    initTokenomics({ emit: () => {} })
    await vi.waitFor(() => expect(tk.dirs).toEqual([['C:\\res\\codex-realms\\r1\\sessions']]))
    // A change the index does not care about (a lease) sends nothing new.
    tk.listeners.forEach((l) => l())
    await new Promise((r) => setTimeout(r, 0))
    expect(tk.dirs).toHaveLength(1)
    tk.current = ['C:\\res\\codex-realms\\r1\\sessions', 'C:\\res\\codex-realms\\r2\\sessions']
    tk.listeners.forEach((l) => l())
    await vi.waitFor(() => expect(tk.dirs.at(-1)).toEqual(['C:\\res\\codex-realms\\r1\\sessions', 'C:\\res\\codex-realms\\r2\\sessions']))
    shutdownTokenomics()
    expect(tk.listeners).toHaveLength(0)
  })
})
