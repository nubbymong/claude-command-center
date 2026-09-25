/**
 * WP2: main's ONE launch rule (src/main/provider-launch-gate.ts), answered by
 * the REAL accounts service built by the REAL provider-accounts runtime from
 * the saved settings -- only the settings file, the account registry and the
 * package list are faked (no file is read, no process is started).
 *
 *  - Claude Code: absent means on; `claudeEnabled: false` refuses, in plain
 *    words.
 *  - Codex: absent means not answered yet, which main has always let launch
 *    (prepareLaunch's isEnabled); `codexEnabled: false` refuses.
 *  - A saved setting that cannot be read refuses (fail closed), even when an
 *    earlier read said on; so does an accounts service that does not exist.
 *  - A switch-off made in Settings refuses at once, before the saved setting
 *    catches up.
 *  - The renderer's launch rule (isConfigLaunchBlocked) agrees with main on
 *    every combination of the two saved switches, and its Claude-off sentence
 *    is main's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

// The saved settings, as config-manager reads them: an object, absent, or a
// read that failed.
const disk = vi.hoisted(() => ({ settings: {} as Record<string, unknown> | 'absent' | 'failed' }))
vi.mock('../../../src/main/config-manager', () => ({
  readConfigChecked: () => (disk.settings === 'failed' ? { value: null, outcome: 'failed' }
    : disk.settings === 'absent' ? { value: null, outcome: 'absent' }
    : { value: disk.settings, outcome: 'ok' }),
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

const { providerLaunchRefusal, providerProbeRefusal } = await import('../../../src/main/provider-launch-gate')
const { logWarn } = await import('../../../src/main/debug-logger')
const { initProviderAccounts, _resetProviderAccountsForTest } = await import('../../../src/main/provider-accounts')
const { isConfigLaunchBlocked } = await import('../../../src/renderer/hooks/useLaunchConfig')
const { CLAUDE_OFF } = await import('../../../src/renderer/lib/claudeOff')
const { launchRefusalOf, refusedTabText } = await import('../../../src/shared/providers')

beforeEach(() => {
  _resetProviderAccountsForTest()
  disk.settings = {}
})

describe('providerLaunchRefusal', () => {
  it('with no accounts service at all, refuses both providers (fail closed)', () => {
    expect(providerLaunchRefusal('claude')).toEqual({
      code: 'provider-state-unknown', providerId: 'claude',
      message: 'This app could not read whether Claude Code is on. Check Settings, Accounts.',
    })
    expect(providerLaunchRefusal('codex')?.code).toBe('provider-state-unknown')
  })

  it('a fresh install (no settings file): Claude Code is on, Codex not answered yet -- both launch', () => {
    initProviderAccounts()
    disk.settings = 'absent'
    expect(providerLaunchRefusal('claude')).toBeNull()
    expect(providerLaunchRefusal('codex')).toBeNull()
  })

  it('claudeEnabled: false refuses Claude Code with the plain sentence, and nothing else', () => {
    initProviderAccounts()
    disk.settings = { claudeEnabled: false, codexEnabled: true }
    expect(providerLaunchRefusal('claude')).toEqual({ code: 'provider-off', providerId: 'claude', message: 'Claude Code is off. Turn it on in Settings, Accounts.' })
    expect(providerLaunchRefusal('codex')).toBeNull()
  })

  it('codexEnabled: false refuses Codex with the plain sentence, and nothing else', () => {
    initProviderAccounts()
    disk.settings = { codexEnabled: false }
    expect(providerLaunchRefusal('codex')).toEqual({ code: 'provider-off', providerId: 'codex', message: 'Codex is off. Turn it on in Settings, Accounts.' })
    expect(providerLaunchRefusal('claude')).toBeNull()
  })

  it('a settings file that cannot be read refuses both, even right after a read that said on', () => {
    initProviderAccounts()
    disk.settings = { claudeEnabled: true, codexEnabled: true }
    expect(providerLaunchRefusal('claude')).toBeNull()
    disk.settings = 'failed'
    expect(providerLaunchRefusal('claude')?.code).toBe('provider-state-unknown')
    expect(providerLaunchRefusal('codex')?.code).toBe('provider-state-unknown')
  })

  it('a switch-off made in Settings refuses at once, before the saved setting catches up', async () => {
    const service = initProviderAccounts()
    disk.settings = { claudeEnabled: true, codexEnabled: true }
    expect((await service.setProviderEnabled('claude', false)).ok).toBe(true)
    expect(providerLaunchRefusal('claude')?.code).toBe('provider-off')
    // ...and once the saved setting reads back off, it still refuses.
    disk.settings = { claudeEnabled: false, codexEnabled: true }
    expect(providerLaunchRefusal('claude')?.code).toBe('provider-off')
  })
})

describe('a probe asks the same rule, but only a launch is logged', () => {
  it('a skipped probe logs nothing (it would at every start); a refused launch is logged', () => {
    initProviderAccounts()
    disk.settings = { claudeEnabled: false }
    vi.mocked(logWarn).mockClear()
    expect(providerProbeRefusal('claude')?.code).toBe('provider-off')
    expect(logWarn).not.toHaveBeenCalled()
    expect(providerLaunchRefusal('claude')?.code).toBe('provider-off')
    expect(logWarn).toHaveBeenCalledTimes(1)
  })

  it('the probe form answers exactly as the launch form', () => {
    initProviderAccounts()
    for (const s of [{}, { claudeEnabled: false }, { codexEnabled: false }, 'failed'] as const) {
      disk.settings = s as never
      for (const id of ['claude', 'codex'] as const) expect(providerProbeRefusal(id), JSON.stringify(s) + id).toEqual(providerLaunchRefusal(id))
    }
  })
})

describe('launchRefusalOf reads a refusal off an IPC answer, and nothing else', () => {
  it('the tab line: main\'s sentence once, then what to do', () => {
    expect(refusedTabText({ message: 'Claude Code is off. Turn it on in Settings, Accounts.' })).toBe('Not started. Claude Code is off. Turn it on in Settings, Accounts, then Restart this tab.')
    expect(refusedTabText({ message: 'This app could not read whether Codex is on. Check Settings, Accounts.' })).toBe('Not started. This app could not read whether Codex is on. Check Settings, Accounts, then Restart this tab.')
  })

  it('a refusal main sent', () => {
    const r = { code: 'provider-off', providerId: 'codex', message: 'Codex is off. Turn it on in Settings, Accounts.' }
    expect(launchRefusalOf({ started: false, refused: r })).toEqual(r)
    expect(launchRefusalOf({ refused: r })).toEqual(r)
  })
  it('anything else reads as no refusal', () => {
    for (const v of [undefined, null, 'run-1', { started: false }, { id: 'agent-1' }, { refused: null },
      { refused: { code: 'boom', providerId: 'claude', message: 'x' } }, { refused: { code: 'provider-off', providerId: 'claude', message: '' } },
      { refused: { code: 'provider-off', providerId: 7, message: 'x' } }]) {
      expect(launchRefusalOf(v), JSON.stringify(v)).toBeNull()
    }
  })
})

describe("the renderer's launch rule agrees with main's", () => {
  const values = [undefined, true, false] as const
  for (const claudeEnabled of values) {
    for (const codexEnabled of values) {
      it(`claudeEnabled=${String(claudeEnabled)}, codexEnabled=${String(codexEnabled)}`, () => {
        initProviderAccounts()
        const saved: Record<string, unknown> = {}
        if (claudeEnabled !== undefined) saved.claudeEnabled = claudeEnabled
        if (codexEnabled !== undefined) saved.codexEnabled = codexEnabled
        disk.settings = saved
        for (const provider of ['claude', 'codex'] as const) {
          const main = providerLaunchRefusal(provider) !== null
          const renderer = isConfigLaunchBlocked({ provider, shellOnly: false }, { claudeEnabled, codexEnabled })
          expect(renderer, `${provider}: renderer ${renderer}, main ${main}`).toBe(main)
        }
      })
    }
  }

  it("the renderer's Claude-off sentence is main's", () => {
    initProviderAccounts()
    disk.settings = { claudeEnabled: false }
    expect(providerLaunchRefusal('claude')?.message).toBe(CLAUDE_OFF)
  })
})
