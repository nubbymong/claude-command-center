// @vitest-environment node
//
// P3.4 (row 45): providerOnNow, the on/off the status pages are read by.
// On only when the provider is answered on: an unanswered Codex is off (and
// its status page is never asked for), and settings that cannot be read are
// off, even when the accounts service still holds an earlier "on" (fail
// closed: no answer is never a yes). A start-up whose settings cannot be
// read yet makes no request at all.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CLAUDE_ENABLEMENT } from '../../../src/main/providers/claude/enablement'
import { CODEX_ENABLEMENT } from '../../../src/main/providers/codex/enablement'

const FAKE_PACKAGES = [
  { id: 'claude', displayName: 'Claude Code', enablement: CLAUDE_ENABLEMENT, capabilities: {} },
  { id: 'codex', displayName: 'Codex', enablement: CODEX_ENABLEMENT, capabilities: {} },
]
vi.mock('../../../src/main/providers/core', async (orig) => ({
  ...(await orig<typeof import('../../../src/main/providers/core')>()),
  listProviderPackages: () => FAKE_PACKAGES,
  tryGetProviderPackage: (id: string) => FAKE_PACKAGES.find((p) => p.id === id) ?? null,
}))
const disk = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, outcome: 'ok' as 'ok' | 'absent' | 'failed' }))
vi.mock('../../../src/main/config-manager', () => ({
  readConfigChecked: () => (disk.outcome === 'ok' ? { value: disk.settings, outcome: 'ok' } : { value: null, outcome: disk.outcome }),
  readConfig: () => null,
}))
vi.mock('../../../src/main/provider-account-registry', async () => {
  const core = await vi.importActual<typeof import('../../../src/main/providers/core')>('../../../src/main/providers/core')
  const leases = new core.ConsumerLeaseRegistry()
  return {
    accountRegistryLoadSettled: () => false,
    getAccountRegistry: () => null,
    getAccountRegistryResourcesDir: () => null,
    getConsumerLeases: () => leases,
    initAccountRegistry: vi.fn(),
    reconcileLegacyAccountStore: vi.fn(async () => {}),
    reconcileLegacyAccountStores: vi.fn(async () => {}),
    sameDirectory: () => false,
  }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
const requested = vi.hoisted(() => [] as string[])
vi.mock('https', () => {
  const get = (url: string) => {
    requested.push(url)
    const req: any = { on: () => req, destroy: () => {} }
    return req
  }
  return { default: { get }, get }
})

const { providerOnNow, initProviderAccounts, _resetProviderAccountsForTest } = await import('../../../src/main/provider-accounts')

beforeEach(() => {
  _resetProviderAccountsForTest()
  disk.settings = {}
  disk.outcome = 'ok'
  requested.length = 0
})

describe('providerOnNow', () => {
  it('Codex is on only once answered on; Claude Code is on unless turned off (before and after the accounts service exists)', () => {
    for (const withService of [false, true]) {
      _resetProviderAccountsForTest()
      if (withService) initProviderAccounts()
      disk.settings = {}
      expect(providerOnNow('claude'), `fresh, service ${withService}`).toBe(true)
      expect(providerOnNow('codex'), `fresh, service ${withService}`).toBe(false)
      disk.settings = { codexEnabled: true } // an earlier build's value, never answered here
      expect(providerOnNow('codex'), `unanswered, service ${withService}`).toBe(false)
      disk.settings = { codexEnabled: true, codexAnswered: true }
      expect(providerOnNow('codex'), `answered on, service ${withService}`).toBe(true)
      disk.settings = { codexEnabled: false, codexAnswered: true, claudeEnabled: false }
      expect(providerOnNow('codex'), `answered off, service ${withService}`).toBe(false)
      expect(providerOnNow('claude'), `turned off, service ${withService}`).toBe(false)
    }
  })

  it('settings that cannot be read are off, even when the service last read on', () => {
    initProviderAccounts()
    disk.settings = { codexEnabled: true, codexAnswered: true }
    expect(providerOnNow('codex')).toBe(true)
    expect(providerOnNow('claude')).toBe(true)
    disk.outcome = 'failed'
    expect(providerOnNow('codex')).toBe(false)
    expect(providerOnNow('claude')).toBe(false)
    _resetProviderAccountsForTest()
    expect(providerOnNow('claude')).toBe(false)
  })
})

describe('the status poller on providerOnNow', () => {
  afterEach(async () => {
    const m = await import('../../../src/main/service-status')
    m.stopServiceStatusPoller()
    vi.useRealTimers()
  })

  it('a start-up whose settings cannot be read yet makes no request', async () => {
    vi.useFakeTimers()
    disk.outcome = 'failed'
    const m = await import('../../../src/main/service-status')
    m.startServiceStatusPoller(() => null, { providerOn: providerOnNow })
    await vi.advanceTimersByTimeAsync(50)
    expect(requested).toEqual([])
  })

  it('an unanswered Codex never has its status page asked for', async () => {
    vi.useFakeTimers()
    disk.settings = { codexEnabled: true }
    const m = await import('../../../src/main/service-status')
    m.startServiceStatusPoller(() => null, { providerOn: providerOnNow })
    await vi.advanceTimersByTimeAsync(50)
    expect(requested).toEqual(['https://status.claude.com/api/v2/components.json'])
  })
})
