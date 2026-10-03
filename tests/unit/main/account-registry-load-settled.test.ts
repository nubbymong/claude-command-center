/// <reference types="vite/client" />
/**
 * Usage track MP9 (394b09c7 code-quality minor): the account registry's load
 * counts as run once it has, even when it threw. The usage index waits for
 * the Codex account folders while the registry has not been read yet; a load
 * that threw leaves no registry for ever, and without this the index would
 * wait for ever and its "sorting by account" notice never clear.
 *
 * PURE: the registry store, the profile helpers, the data paths and the log
 * are faked, so nothing is read from or written to disk.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const flags = vi.hoisted(() => ({ throwOnCreate: false }))
vi.mock('../../../src/main/providers/core', async () => {
  const actual = await vi.importActual<typeof import('../../../src/main/providers/core')>('../../../src/main/providers/core')
  class FakeStore {
    constructor() { if (flags.throwOnCreate) throw new Error('the registry could not be created') }
    load() { return { mode: 'ready' as const } }
    retire() {}
  }
  return { ...actual, AccountRegistryStore: FakeStore }
})
vi.mock('../../../src/main/account-profiles', () => ({ mkdirSecure: () => {} }))
vi.mock('../../../src/main/data-paths', () => ({ getResourcesDirectory: () => 'C:/resources' }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logError: () => {} }))
vi.mock('../../../src/main/atomic-write', () => ({ atomicWriteFileSync: () => {} }))

type Registry = typeof import('../../../src/main/provider-account-registry')
const load = async (): Promise<Registry> => {
  vi.resetModules()
  return import('../../../src/main/provider-account-registry')
}

describe('the account registry load counts as run once it has (MP9)', () => {
  beforeEach(() => { flags.throwOnCreate = false })

  it('not before it has run; after a load that ran, with its registry', async () => {
    const reg = await load()
    expect(reg.accountRegistryLoadSettled()).toBe(false)
    reg.initAccountRegistry('C:/resources')
    expect(reg.accountRegistryLoadSettled()).toBe(true)
    expect(reg.getAccountRegistry()).not.toBeNull()
  })

  it('after a load that threw too, with no registry', async () => {
    const reg = await load()
    flags.throwOnCreate = true
    expect(() => reg.initAccountRegistry('C:/resources')).toThrow('the registry could not be created')
    expect(reg.getAccountRegistry()).toBeNull()
    expect(reg.accountRegistryLoadSettled()).toBe(true)
  })

  it('the runtime hands the accounts service that answer', async () => {
    const src = await import('../../../src/main/provider-accounts.ts?raw').then((m) => m.default as string)
    expect(src).toMatch(/registrySettled: \(\) => accountRegistryLoadSettled\(\),/)
  })
})
