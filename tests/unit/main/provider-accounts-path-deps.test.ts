// The accounts service at runtime gets the four install deps (owner
// decisions D3 and D4, and the PATH finding of the first-run test,
// 2026-10-10; ADR-024): Node.js is looked for before an npm recipe is
// offered to run, PATH is brought up to date before a check the user asked
// for, a check that finds nothing says what helps, and Add it to PATH for me
// reaches main's own folder rule. The REAL provider-accounts runtime and the
// REAL accounts service; the package list is one stand-in provider and the
// four helpers are stand-ins, so nothing is read and no process starts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => [] as string[])
const FAKE = vi.hoisted(() => [{
  id: 'claude', displayName: 'Claude Code', capabilities: {},
  setup: {
    discover: async () => ({ state: 'missing', compatibility: 'unknown', checkedAt: 1 }),
    installRecipes: () => [{
      id: 'claude-npm-install', providerId: 'claude', purpose: 'install', platform: 'win32', publisher: 'Anthropic', sourceUrl: 'https://example.invalid/setup',
      method: 'package-manager', command: ['npm', 'install', '-g', '@anthropic-ai/claude-code'], displayCommand: 'npm.cmd install -g @anthropic-ai/claude-code',
      needsNetwork: true, mayElevate: false, autoRunAllowed: true,
    }],
  },
}])
vi.mock('../../../src/main/providers/core', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/providers/core')>()),
  listProviderPackages: () => FAKE,
  tryGetProviderPackage: (id: string) => FAKE.find((p) => p.id === id) ?? null,
}))
vi.mock('../../../src/main/config-manager', () => ({
  readConfigChecked: () => ({ value: {}, outcome: 'ok' }),
  readConfig: () => null,
}))
vi.mock('../../../src/main/provider-account-registry', async () => {
  const core = await vi.importActual<typeof import('../../../src/main/providers/core')>('../../../src/main/providers/core')
  const leases = new core.ConsumerLeaseRegistry()
  return {
    accountRegistryLoadSettled: () => true,
    getAccountRegistry: () => null,
    getAccountRegistryResourcesDir: () => null,
    getConsumerLeases: () => leases,
    initAccountRegistry: vi.fn(),
    reconcileLegacyAccountStore: vi.fn(async () => {}),
    reconcileLegacyAccountStores: vi.fn(async () => {}),
    sameDirectory: () => false,
  }
})
vi.mock('../../../src/main/node-tools-probe', () => ({ nodeToolsFound: vi.fn(async () => { calls.push('nodeToolsFound'); return false }) }))
vi.mock('../../../src/main/windows-path-refresh', () => ({ refreshWindowsPath: vi.fn(async () => { calls.push('refreshPath'); return [] }) }))
vi.mock('../../../src/main/install-folder-path', () => ({
  pathHintFor: vi.fn(async (id: string) => { calls.push(`pathHint ${id}`); return { kind: 'add-to-path', folder: '%USERPROFILE%\\.local\\bin' } }),
  addToolFolderToPath: vi.fn(async (id: string) => { calls.push(`addToPath ${id}`); return { outcome: 'added' } }),
}))

const { initProviderAccounts, _resetProviderAccountsForTest } = await import('../../../src/main/provider-accounts')

beforeEach(() => {
  _resetProviderAccountsForTest()
  calls.length = 0
})

describe('the accounts service is built with the install helpers', () => {
  it('Check again brings PATH up to date first, then looks, then says what helps', async () => {
    const r = await initProviderAccounts().checkAgain('claude')
    expect(calls).toEqual(['refreshPath', 'pathHint claude'])
    expect(r).toMatchObject({ ok: true, pathHint: { kind: 'add-to-path' } })
  })

  it('the recipes it offers ask whether Node.js is there first, and mark npm when it is not', async () => {
    const recipes = await initProviderAccounts().installRecipesChecked('claude')
    expect(calls).toEqual(['nodeToolsFound'])
    expect(recipes[0]).toMatchObject({ id: 'claude-npm-install', needsNode: true })
  })

  it('Add it to PATH for me reaches main\'s own folder rule with the provider id alone, then checks again', async () => {
    const r = await initProviderAccounts().addToPath('claude')
    expect(calls).toEqual(['addToPath claude', 'refreshPath', 'pathHint claude'])
    expect(r).toMatchObject({ ok: true, added: 'added' })
  })
})
