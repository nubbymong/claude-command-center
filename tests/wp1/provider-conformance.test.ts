// WP1.56 / WP1.66 / WP1.41: the same conformance suite over both concrete
// provider packages (main) and both renderer descriptors, through their
// PUBLIC entry points only, plus the two composition roots. Slice 1 covers
// declaration conformance (every capability declared and backed, main and
// renderer declarations agree, actions derive from capabilities, roots
// register exactly the two providers, idempotently). Operation conformance
// (discovery/auth/realm) is added by the slices that wire those operations;
// at the candidate phase the WP1-required capabilities must be `supported`.
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Importing the Codex entry point loads its spawn module, which reads the
// live MCP port and the resources directory at call time; keep both inert.
vi.mock('../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '' }))
vi.mock('../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => 0, mcpSessionToken: () => 'tok' }))

import { CAPABILITY_KEYS, WP1_REQUIRED_CAPABILITIES, PROVIDER_IDS, missingCapabilityKeys, isNeverOwnedLaunchVariable, NEVER_OWNED_LAUNCH_VARIABLES } from '../../src/shared/providers'
import type { CapabilityPlatform } from '../../src/shared/providers'
import { createClaudePackage } from '../../src/main/providers/claude'
import { createCodexPackage } from '../../src/main/providers/codex'
import { claudeDescriptor } from '../../src/renderer/providers/claude'
import { codexDescriptor } from '../../src/renderer/providers/codex'
import { composeProviders, composedProviderIds } from '../../src/main/providers/compose'
import { listProviderPackages, packageRegistrationProblem, tryGetProviderPackage, _resetProviderRegistryForTest } from '../../src/main/providers/core'
import { composeRendererProviders, composedRendererProviderIds } from '../../src/renderer/providers'
import { listRendererProviders, getRendererProvider, _resetRendererProviderRegistryForTest } from '../../src/renderer/providers/core'
import { resolvePhase } from './phase'

const SEMVER = /^\d+\.\d+\.\d+$/
const PLATFORMS: CapabilityPlatform[] = ['win32', 'darwin', 'linux']
const cases = [
  { id: 'claude' as const, create: createClaudePackage, descriptor: claudeDescriptor, ambientRealmVariable: 'CLAUDE_CONFIG_DIR', ownedRealmVariable: 'USERPROFILE', offeredMethods: ['browser'] },
  { id: 'codex' as const, create: createCodexPackage, descriptor: codexDescriptor, ambientRealmVariable: 'CODEX_HOME', ownedRealmVariable: 'CODEX_HOME', offeredMethods: ['browser', 'device', 'apiKey'] },
]
const SESSION_METHODS = ['resolveBinary', 'buildSpawnCommand', 'detectUiRunning', 'ingestSessionTelemetry', 'listHistorySessions', 'resumeCommand', 'configureMcpServer'] as const
const phase = resolvePhase(undefined, { eager: false })

describe.each(cases)('provider conformance: $id', ({ id, create, descriptor, ambientRealmVariable, ownedRealmVariable, offeredMethods }) => {
  const pkg = create()

  it('main package: id, display name, session surface, and a registrable declaration', () => {
    expect(PROVIDER_IDS).toContain(pkg.id)
    expect(pkg.id).toBe(id)
    expect(pkg.displayName.length).toBeGreaterThan(0)
    expect(pkg.session.id).toBe(pkg.id)
    for (const m of SESSION_METHODS) expect(typeof (pkg.session as Record<string, unknown>)[m], m).toBe('function')
    expect(packageRegistrationProblem(pkg)).toBeNull()
    expect(create()).not.toBe(pkg) // a factory, not a module-level singleton
  })

  it('main package: every WP1 capability is declared; supported/experimental keys are backed by an operation; versions are semver; every non-supported key says why', () => {
    expect(missingCapabilityKeys(pkg.capabilities)).toEqual([])
    for (const k of CAPABILITY_KEYS) {
      const d = pkg.capabilities[k]
      if (d.minTestedVersion) expect(d.minTestedVersion).toMatch(SEMVER)
      if (d.maxTestedVersion) expect(d.maxTestedVersion).toMatch(SEMVER)
      if (d.state !== 'supported') expect(d.note, `${k} (${d.state}) must carry a note`).toBeTruthy()
    }
    for (const k of WP1_REQUIRED_CAPABILITIES) {
      expect(pkg.capabilities[k].state, k).not.toBe('unsupported')
      if (phase === 'candidate') expect(pkg.capabilities[k].state, `${k} must be supported at the candidate`).toBe('supported')
    }
  })

  it('main package: ambient authentication variables include the realm-overriding variable, owned variables include the realm selector (D1/D3)', () => {
    expect(pkg.ambientAuthVariables).toContain(ambientRealmVariable)
    expect(pkg.ownedLaunchVariables).toContain(ownedRealmVariable)
    for (const list of [pkg.ambientAuthVariables, pkg.ownedLaunchVariables]) {
      expect(new Set(list).size).toBe(list.length)
      for (const v of list) expect(v).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
      // The guarantee is asserted over the SHIPPED lists. The contract-level
      // test in provider-core exercises a synthetic policy that satisfies this
      // by construction, which is how Claude came to own PATH unnoticed.
      for (const v of list) expect(isNeverOwnedLaunchVariable(v), `${pkg.id} may not own ${v}`).toBe(false)
    }
    expect(NEVER_OWNED_LAUNCH_VARIABLES).toContain('PATH')
  })

  it('renderer descriptor: identity, copy, steps and auth methods are complete and agree with the main declaration', () => {
    expect(descriptor.id).toBe(pkg.id)
    expect(descriptor.shortName.length).toBeGreaterThan(0)
    expect(descriptor.accentToken).toMatch(/^--provider-accent-/)
    for (const v of Object.values(descriptor.copy)) expect(v.length).toBeGreaterThan(0)
    expect(descriptor.setupSteps.map((s) => s.kind)).toEqual(['detect', 'install', 'auth', 'verify'])
    for (const s of descriptor.setupSteps) if (s.capability) expect(CAPABILITY_KEYS).toContain(s.capability)
    expect(descriptor.authMethods.map((m) => m.method)).toEqual(offeredMethods)
    for (const m of descriptor.authMethods) {
      expect(m.capability).toMatch(/^auth\./)
      // A method the renderer offers must be one the main package does not declare unsupported.
      expect(pkg.capabilities[m.capability].state, `${pkg.id} offers ${m.method} but declares ${m.capability} unsupported`).not.toBe('unsupported')
    }
    // And a method the main package declares unsupported is never offered.
    for (const [key, method] of [['auth.browser', 'browser'], ['auth.device', 'device'], ['auth.apiKey', 'apiKey']] as const) {
      if (pkg.capabilities[key].state === 'unsupported') expect(descriptor.authMethods.some((m) => m.method === method), `${pkg.id} must not offer ${method}`).toBe(false)
    }
  })

  it('renderer descriptor: actions derive from the main capabilities on every platform; nothing unwired is enabled; experimental stays off and labelled', () => {
    for (const platform of PLATFORMS) {
      const actions = descriptor.actions({ platform, capabilities: pkg.capabilities, installation: { enabled: true, discoveryState: 'missing', setupState: 'needs-install' } })
      expect(actions.map((a) => a.kind)).toContain('provider.install')
      // Expected values are derived from the raw declaration here. Comparing
      // against resolveCapability() would be tautological: defaultProviderActions
      // computes `enabled` by calling that same function with the same inputs,
      // so both sides move together under any mutation of it.
      const stateOn = (key: string) => {
        const d = pkg.capabilities[key as keyof typeof pkg.capabilities]
        return d.platformOverrides?.[platform] ?? d.state
      }
      for (const m of descriptor.authMethods) {
        const a = actions.find((x) => x.kind === 'account.login' && x.method === m.method)!
        const state = stateOn(m.capability)
        expect(a, `${m.method} action`).toBeDefined()
        // No experimental key is owner-enabled in this context, so only a
        // plainly supported capability may be enabled.
        expect(a.enabled, `${m.method} on ${platform} (${state})`).toBe(state === 'supported')
        expect(a.labelExperimental, `${m.method} on ${platform}`).toBe(state === 'experimental')
      }
      for (const kind of ['provider.recheck', 'provider.install', 'account.logout'] as const) {
        const a = actions.find((x) => x.kind === kind)!
        const key = kind === 'provider.recheck' ? 'cli.discovery' : kind === 'provider.install' ? 'install.recipes' : 'auth.logout'
        expect(a.enabled, `${kind} on ${platform} (${stateOn(key)})`).toBe(stateOn(key) === 'supported')
      }
      for (const a of actions) { expect(a.providerId).toBe(pkg.id); expect(a.label.length).toBeGreaterThan(0) }
    }
  })

  it('renderer descriptor: the owner-enabled experimental list is provider-scoped', () => {
    // Driven from a SYNTHETIC declaration. Neither shipped provider declares
    // auth.device experimental today, so the original form of this test only
    // ever ran its else branch and guarded nothing -- while being named as the
    // regression guard for provider scoping. The descriptor and the resolver
    // are the code under test, not the current declaration.
    const caps = { ...pkg.capabilities, 'auth.device': { state: 'experimental' as const, note: 'beta at the provider' } }
    const other = pkg.id === 'claude' ? 'codex' : 'claude'
    const act = (experimentalEnabled: string[]) => descriptor.actions({ platform: 'linux', capabilities: caps, experimentalEnabled: experimentalEnabled as never })
    const device = (list: ReturnType<typeof descriptor.actions>) => list.find((a) => a.kind === 'account.login' && a.method === 'device')
    if (!descriptor.authMethods.some((m) => m.method === 'device')) {
      // A method the provider does not offer stays absent however the owner
      // flag is set -- the scoped key must not conjure an action.
      expect(device(act([`${pkg.id}:auth.device`]))).toBeUndefined()
      return
    }
    expect(device(act([])), `${pkg.id} device off by default`).toMatchObject({ enabled: false, labelExperimental: true })
    expect(device(act([`${pkg.id}:auth.device`]))).toMatchObject({ enabled: true, labelExperimental: true })
    expect(device(act([`${other}:auth.device`])), `${other} flag must not enable ${pkg.id}`).toMatchObject({ enabled: false })
    expect(device(act(['auth.device'])), 'an unscoped key never enables').toMatchObject({ enabled: false })
    expect(device(act([`${pkg.id}:auth.browser`])), `a different key on ${pkg.id} never enables device`).toMatchObject({ enabled: false })
  })
})

describe('composition roots (WP1.66)', () => {
  beforeEach(() => { _resetProviderRegistryForTest(); _resetRendererProviderRegistryForTest() })

  it('main: composeProviders registers exactly the two packages, idempotently against the registry itself', () => {
    composeProviders()
    composeProviders()
    expect(composedProviderIds()).toEqual([...PROVIDER_IDS])
    expect(listProviderPackages().map((p) => p.displayName)).toEqual(['Claude Code', 'Codex'])
    _resetProviderRegistryForTest()
    expect(tryGetProviderPackage('claude')).toBeNull()
    composeProviders() // a reset registry is recomposed; no stale flag can make this a silent no-op
    expect(composedProviderIds()).toEqual([...PROVIDER_IDS])
  })

  it('renderer: composeRendererProviders registers exactly the two descriptors, idempotently against the registry itself', () => {
    composeRendererProviders()
    composeRendererProviders()
    expect(composedRendererProviderIds()).toEqual([...PROVIDER_IDS])
    expect(listRendererProviders().map((d) => d.maturity)).toEqual(['stable', 'beta'])
    expect(getRendererProvider('codex').shortName).toBe('Codex')
    _resetRendererProviderRegistryForTest()
    composeRendererProviders()
    expect(composedRendererProviderIds()).toEqual([...PROVIDER_IDS])
  })
})
