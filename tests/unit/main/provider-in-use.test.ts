/**
 * WP2: a switch-off of Claude Code is refused while anything of it runs --
 * not only its sessions, but everything else that runs the Claude CLI
 * without an account lease: cloud agents (running or pending), Insights
 * runs, Sentinel's version check and analysis, and a shell-only SSH
 * session's accepted "Launch Claude". Composed in provider-in-use.ts, which
 * main hands the accounts service (index.ts).
 *
 * The REAL composition and the REAL accounts service's switch
 * (setProviderEnabled), built from faked settings and packages as in
 * provider-launch-gate.test.ts; each counter is scripted here (each one is
 * proven against its own module in the provider-off suites).
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
vi.mock('../../../src/main/config-manager', () => ({
  readConfigChecked: () => ({ value: { claudeEnabled: true, codexEnabled: true }, outcome: 'ok' }),
  readConfig: () => null,
}))
vi.mock('../../../src/main/provider-account-registry', async () => {
  const core = await vi.importActual<typeof import('../../../src/main/providers/core')>('../../../src/main/providers/core')
  const leases = new core.ConsumerLeaseRegistry()
  return {
    getAccountRegistry: () => null, getAccountRegistryResourcesDir: () => null, getConsumerLeases: () => leases,
    initAccountRegistry: vi.fn(), reconcileLegacyAccountStore: vi.fn(async () => {}), reconcileLegacyAccountStores: vi.fn(async () => {}), sameDirectory: () => false,
  }
})
const n = vi.hoisted(() => ({ sessions: { claude: 0, codex: 0 } as Record<string, number>, agents: 0, insights: 0, sentinel: 0, ssh: 0, setup: 0, throws: false }))
vi.mock('../../../src/main/pty-manager', () => ({ countUnleasedAgentSessions: (id: string) => n.sessions[id] ?? 0 }))
vi.mock('../../../src/main/cloud-agent-manager', () => ({ countClaudeAgentsInUse: () => { if (n.throws) throw new Error('boom'); return n.agents } }))
vi.mock('../../../src/main/insights-runner', () => ({ countInsightsRunsInFlight: () => n.insights }))
vi.mock('../../../src/main/sentinel/index', () => ({ sentinelClaudeRunsInFlight: () => n.sentinel }))
vi.mock('../../../src/main/ipc/pty-handlers', () => ({ countSshClaudeLaunches: () => n.ssh }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ countCliSetupInUse: () => n.setup }))

const { providerUseWithoutLease } = await import('../../../src/main/provider-in-use')
const { initProviderAccounts, _resetProviderAccountsForTest } = await import('../../../src/main/provider-accounts')

beforeEach(() => {
  _resetProviderAccountsForTest()
  Object.assign(n, { sessions: { claude: 0, codex: 0 }, agents: 0, insights: 0, sentinel: 0, ssh: 0, setup: 0, throws: false })
})

// What main composes at start (index.ts).
const service = () => initProviderAccounts({ unleasedSessions: (id) => providerUseWithoutLease(id) })

describe('Claude Code in use, for the switch-off rule', () => {
  const cases: Array<[string, () => void]> = [
    ['a cloud agent running or pending', () => { n.agents = 1 }],
    ['an Insights run in flight', () => { n.insights = 1 }],
    ['a Sentinel version check or analysis in flight', () => { n.sentinel = 1 }],
    ["a shell-only SSH session's accepted Launch Claude", () => { n.ssh = 1 }],
    ['the first-run CLI setup terminal', () => { n.setup = 1 }],
    ['a Claude session (as before)', () => { n.sessions.claude = 1 }],
  ]
  for (const [what, setUp] of cases) {
    it(`${what}: switching Claude Code off is refused, as in use`, async () => {
      setUp()
      const r = await service().setProviderEnabled('claude', false)
      expect(r).toMatchObject({ ok: false, code: 'consumers', consumers: 1 })
    })
  }

  it('everything counts together', () => {
    Object.assign(n, { agents: 2, insights: 1, sentinel: 1, ssh: 1, setup: 1 })
    n.sessions.claude = 3
    expect(providerUseWithoutLease('claude')).toBe(9)
  })

  it('with nothing running, the switch-off goes through', async () => {
    expect(await service().setProviderEnabled('claude', false)).toEqual({ ok: true })
  })

  it("Claude Code's runs do not hold Codex: only Codex's own sessions do", async () => {
    Object.assign(n, { agents: 1, insights: 1, sentinel: 1, ssh: 1, setup: 1 })
    expect(providerUseWithoutLease('codex')).toBe(0)
    expect(await service().setProviderEnabled('codex', false)).toEqual({ ok: true })
  })

  it('a counter that cannot answer counts as in use (fail closed)', async () => {
    n.throws = true
    expect(providerUseWithoutLease('claude')).toBe(1)
    expect((await service().setProviderEnabled('claude', false)).ok).toBe(false)
  })
})
