/**
 * Owner decision 2026-09-26: "We should formally confirm the codex sign in
 * anyway." The Codex sign-in already on the computer (~/.codex, or the folder
 * CODEX_HOME names) is NEVER taken in automatically, and nothing at start even
 * asks about it: the start-up work neither adopts it nor checks it
 * (probeExternalDefault), whatever the saved answer says, at app start or
 * when the resources directory is chosen later. Only an explicit
 * adoptExternalDefault takes it in (the user's "Use this sign-in"). The old
 * one-time start-up adoption is gone from the service altogether.
 *
 * The REAL provider-accounts runtime and the REAL accounts service; only the
 * settings file, the account registry and the package list are faked (a
 * package that declares an external default home, as Codex does), so nothing
 * is read and no process starts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CODEX_ENABLEMENT } from '../../../src/main/providers/codex/enablement'

const FAKE_PACKAGES = [
  { id: 'claude', displayName: 'Claude Code', capabilities: {} },
  {
    id: 'codex', displayName: 'Codex', enablement: CODEX_ENABLEMENT, capabilities: {},
    externalDefaultRealm: { kind: 'codex-home', identityLabel: 'External Codex sign-in (account unverified)' },
  },
]
vi.mock('../../../src/main/providers/core', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/providers/core')>()),
  listProviderPackages: () => FAKE_PACKAGES,
  tryGetProviderPackage: (id: string) => FAKE_PACKAGES.find((p) => p.id === id) ?? null,
}))
const disk = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }))
vi.mock('../../../src/main/config-manager', () => ({
  readConfigChecked: () => ({ value: disk.settings, outcome: 'ok' }),
  readConfig: () => null,
}))
vi.mock('../../../src/main/provider-account-registry', async () => {
  const core = await vi.importActual<typeof import('../../../src/main/providers/core')>('../../../src/main/providers/core')
  const leases = new core.ConsumerLeaseRegistry()
  return {
    getAccountRegistry: () => null,
    getAccountRegistryResourcesDir: () => null,
    getConsumerLeases: () => leases,
    initAccountRegistry: vi.fn(),
    reconcileLegacyAccountStore: vi.fn(async () => {}),
    reconcileLegacyAccountStores: vi.fn(async () => {}),
    sameDirectory: () => false,
  }
})

const { initProviderAccounts, runStartupProviderMigrations, followResourcesDirectory, experimentalFromSettings, _resetProviderAccountsForTest } = await import('../../../src/main/provider-accounts')

beforeEach(() => {
  _resetProviderAccountsForTest()
  disk.settings = {}
})

function spied() {
  const service = initProviderAccounts()
  const probe = vi.spyOn(service, 'probeExternalDefault')
  const adopt = vi.spyOn(service, 'adoptExternalDefault')
  const clear = vi.spyOn(service, 'clearUnusableReviewerDefaults').mockResolvedValue(undefined)
  const leftover = vi.spyOn(service, 'dropLeftoverExternalReservations').mockResolvedValue(undefined)
  expect('migrateExternalDefault' in service).toBe(false)
  return { probe, adopt, clear, leftover }
}

describe('no adoption of the sign-in already on this computer at start', () => {
  for (const [what, settings] of [
    ['Codex answered yes', { codexEnabled: true, codexAnswered: true }],
    ['an earlier build\'s yes, not answered again', { codexEnabled: true }],
    ['nothing saved', {}],
  ] as const) {
    it(`${what}: the start-up work adopts nothing, and still clears unusable reviewer choices and unfinished checks`, async () => {
      disk.settings = { ...settings }
      const { probe, adopt, clear, leftover } = spied()
      await runStartupProviderMigrations()
      expect(probe).not.toHaveBeenCalled()
      expect(adopt).not.toHaveBeenCalled()
      expect(clear).toHaveBeenCalledTimes(1)
      // A check or adoption an earlier run left unfinished: dropped (Q1).
      expect(leftover).toHaveBeenCalledTimes(1)
    })
  }

  it('nor when the resources directory is chosen after start', async () => {
    disk.settings = { codexEnabled: true, codexAnswered: true }
    const { probe, adopt, clear, leftover } = spied()
    await followResourcesDirectory('D:/resources-chosen-later')
    expect(probe).not.toHaveBeenCalled()
    expect(adopt).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(leftover).toHaveBeenCalledTimes(1)
  })
})

describe('the settings as the app writes them enable no experimental capability (device-code sign-in stays off: U3; WP1.41)', () => {
  it('nothing the app saves carries the owner\'s list, so the list is empty; only a provider-scoped known key would count', () => {
    for (const settings of [{}, { codexEnabled: true, codexAnswered: true }, { claudeEnabled: false, codexEnabled: true, codexAnswered: true, conductorTools: { codexReview: true } }]) {
      expect(experimentalFromSettings(settings)).toEqual([])
    }
    expect(experimentalFromSettings(null)).toEqual([])
    expect(experimentalFromSettings({ experimentalCapabilities: 'codex:auth.device' })).toEqual([])
    expect(experimentalFromSettings({ experimentalCapabilities: ['auth.device', 'codex:nope', 7, 'codex:auth.device'] })).toEqual(['codex:auth.device'])
  })
})
