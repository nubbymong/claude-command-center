// @vitest-environment node
//
// P3.4 (row 45): providerOnNow, the on/off the status pages are read by.
// On only when the provider is answered on: an unanswered Codex is off (and
// its status page is never asked for), and settings that cannot be read are
// off, even when the accounts service still holds an earlier "on" (fail
// closed: no answer is never a yes). A start-up whose settings cannot be
// read yet makes no request at all. ADR-009 pass (lens G): only an ok read
// that says on counts, so a missing settings file is off (a fresh first
// launch reads no status page until its first save, and the refresh after
// that save reads it); each decision is made from one read, and the
// service's answer must agree; a switch-off made in the accounts service
// (no settings save) reaches the poller through its change subscription.
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
const disk = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  outcome: 'ok' as 'ok' | 'absent' | 'failed',
  script: null as null | (() => { value: unknown; outcome: string }),
}))
vi.mock('../../../src/main/config-manager', () => ({
  readConfigChecked: () => (disk.script ? disk.script() : disk.outcome === 'ok' ? { value: disk.settings, outcome: 'ok' } : { value: null, outcome: disk.outcome }),
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
const destroyed = vi.hoisted(() => [] as string[])
vi.mock('https', () => {
  // Never answers: every read stays in flight until destroyed.
  const get = (url: string) => {
    requested.push(url)
    const req: any = { on: () => req, destroy: () => { destroyed.push(url) } }
    return req
  }
  return { default: { get }, get }
})

const { providerOnNow, initProviderAccounts, getAccountsService, _resetProviderAccountsForTest } = await import('../../../src/main/provider-accounts')
const ANTHROPIC = 'https://status.claude.com/api/v2/components.json'
const OPENAI = 'https://status.openai.com/api/v2/components.json'
const ok = (value: Record<string, unknown>) => ({ value, outcome: 'ok' })

beforeEach(() => {
  _resetProviderAccountsForTest()
  disk.settings = {}
  disk.outcome = 'ok'
  disk.script = null
  requested.length = 0
  destroyed.length = 0
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

describe('providerOnNow: the ADR-009 pass (lens G)', () => {
  it('G1: a missing settings file is off for every provider, before and after the service exists', () => {
    disk.outcome = 'absent'
    expect(providerOnNow('claude')).toBe(false)
    expect(providerOnNow('codex')).toBe(false)
    initProviderAccounts()
    expect(providerOnNow('claude')).toBe(false)
    // An ok read with no Claude key is Claude's effective enablement: on.
    disk.outcome = 'ok'
    disk.settings = { theme: 'dark' }
    expect(providerOnNow('claude')).toBe(true)
  })

  it('G2: one read decides; settings saying off are off even when a second read would fail and the service last read on', () => {
    initProviderAccounts()
    disk.settings = { claudeEnabled: true, codexEnabled: true, codexAnswered: true }
    expect(getAccountsService()!.preferenceOf('claude')).toBe('on')
    expect(getAccountsService()!.preferenceOf('codex')).toBe('on')
    let i = 0
    disk.script = () => (i++ % 2 === 0 ? ok({ claudeEnabled: false, codexEnabled: false, codexAnswered: true }) : { value: null, outcome: 'failed' })
    expect(providerOnNow('claude')).toBe(false)
    i = 0
    expect(providerOnNow('codex')).toBe(false)
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

  it('G1: a fresh first launch (no settings file) reads no status page until the first save; the refresh after it reads Claude Code status', async () => {
    vi.useFakeTimers()
    disk.outcome = 'absent'
    initProviderAccounts()
    const m = await import('../../../src/main/service-status')
    m.startServiceStatusPoller(() => null, { providerOn: providerOnNow })
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 50)
    expect(requested).toEqual([])
    disk.outcome = 'ok'
    disk.settings = { theme: 'dark' }
    void m.refreshServiceStatus()
    await vi.advanceTimersByTimeAsync(50)
    expect(requested).toEqual([ANTHROPIC])
  })

  it('G1: Claude Code saved off, then the settings file briefly missing at a poll: Anthropic is never asked', async () => {
    vi.useFakeTimers()
    disk.settings = { claudeEnabled: false, codexEnabled: true, codexAnswered: true }
    initProviderAccounts()
    const m = await import('../../../src/main/service-status')
    m.startServiceStatusPoller(() => null, { providerOn: providerOnNow })
    await vi.advanceTimersByTimeAsync(50)
    expect(requested).toEqual([OPENAI])
    disk.outcome = 'absent'
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 50)
    expect(requested).not.toContain(ANTHROPIC)
  })

  it('G3: a switch-off made in the accounts service (no settings save) aborts the read in flight for that provider', async () => {
    vi.useFakeTimers()
    disk.settings = { claudeEnabled: true, codexEnabled: true, codexAnswered: true }
    initProviderAccounts()
    const svc = getAccountsService()!
    const m = await import('../../../src/main/service-status')
    m.startServiceStatusPoller(() => null, { providerOn: providerOnNow, subscribe: (l: () => void) => svc.subscribe(l) })
    await vi.advanceTimersByTimeAsync(50)
    expect([...requested].sort()).toEqual([ANTHROPIC, OPENAI].sort())
    expect(destroyed).toEqual([])
    const r = await svc.setProviderEnabled('codex', false)
    expect(r.ok).toBe(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(destroyed).toEqual([OPENAI])
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
