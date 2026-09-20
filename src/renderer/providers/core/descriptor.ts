// WP1 renderer provider core: the RendererProviderDescriptor contract
// (design 7.1). A concrete renderer provider supplies identity/badge metadata,
// setup-step descriptors, provider-specific copy and capability-derived
// actions as provider-neutral requests. Shared Accounts/Setup/Settings
// components consume these view models; they never import a concrete store
// or a provider-specific IPC identifier.
import type { ProviderId, CapabilityKey, CapabilityPlatform, ProviderCapabilities, ProviderInstallation, ScopedCapabilityKey } from '../../../shared/providers'
import { resolveCapability } from '../../../shared/providers'

export type SetupStepKind = 'detect' | 'install' | 'auth' | 'verify'
export interface SetupStepDescriptor {
  id: string
  kind: SetupStepKind
  title: string
  /** The capability that must resolve enabled for the step to be offered. */
  capability?: CapabilityKey
}

export type RendererAuthMethod = 'browser' | 'device' | 'apiKey'
export interface AuthMethodDescriptor {
  method: RendererAuthMethod
  label: string
  capability: CapabilityKey
}

export interface ProviderCopy {
  enableQuestion: string
  enabledSubtitle: string
  cliMissing: string
  cliMissingHint: string
  notSignedIn: string
  signedInHint: string
}

export interface ProviderActionContext {
  platform: CapabilityPlatform
  capabilities?: Partial<ProviderCapabilities>
  /** Owner-enabled experimental capabilities, provider-scoped (`codex:auth.device`). */
  experimentalEnabled?: readonly ScopedCapabilityKey[]
  installation?: Pick<ProviderInstallation, 'enabled' | 'discoveryState' | 'setupState'>
}

export type ProviderActionKind =
  | 'provider.recheck' | 'provider.install' | 'provider.enable' | 'provider.disable'
  | 'account.add' | 'account.login' | 'account.logout'

/** A provider-neutral request the shared UI can render and dispatch. It
 *  names an operation by kind and provider id; it carries no IPC channel,
 *  no path and no credential. */
export interface ProviderActionRequest {
  kind: ProviderActionKind
  providerId: ProviderId
  label: string
  method?: RendererAuthMethod
  enabled: boolean
  labelExperimental: boolean
  reason?: string
}

export interface RendererProviderDescriptor {
  readonly id: ProviderId
  readonly displayName: string
  readonly shortName: string
  readonly maturity: 'stable' | 'beta'
  /** CSS custom property that carries the provider's accent colour. */
  readonly accentToken: string
  readonly copy: ProviderCopy
  readonly setupSteps: readonly SetupStepDescriptor[]
  readonly authMethods: readonly AuthMethodDescriptor[]
  /** A plain function (safe to pass as a prop); never depends on `this`. */
  readonly actions: (ctx: ProviderActionContext) => readonly ProviderActionRequest[]
}

/** The one capability-derived action rule every descriptor shares, so a
 *  provider cannot offer an action its declared capabilities do not back. */
export function defaultProviderActions(d: RendererProviderDescriptor, ctx: ProviderActionContext): ProviderActionRequest[] {
  const out: ProviderActionRequest[] = []
  const res = (key: CapabilityKey) => resolveCapability(ctx.capabilities, key, { providerId: d.id, platform: ctx.platform, experimentalEnabled: ctx.experimentalEnabled })
  const enabled = ctx.installation?.enabled !== false
  out.push({ kind: enabled ? 'provider.disable' : 'provider.enable', providerId: d.id, label: enabled ? `Turn ${d.shortName} off` : `Turn ${d.shortName} on`, enabled: true, labelExperimental: false })
  const discovery = res('cli.discovery')
  out.push({ kind: 'provider.recheck', providerId: d.id, label: `Re-check the ${d.shortName} CLI`, enabled: discovery.enabled, labelExperimental: discovery.labelExperimental, reason: discovery.reason })
  if (ctx.installation?.discoveryState === 'missing' || ctx.installation?.setupState === 'needs-install') {
    const install = res('install.recipes')
    out.push({ kind: 'provider.install', providerId: d.id, label: `Install the ${d.shortName} CLI`, enabled: install.enabled, labelExperimental: install.labelExperimental, reason: install.reason })
  }
  for (const m of d.authMethods) {
    const r = res(m.capability)
    out.push({ kind: 'account.login', providerId: d.id, method: m.method, label: m.label, enabled: r.enabled, labelExperimental: r.labelExperimental, reason: r.reason })
  }
  const logout = res('auth.logout')
  out.push({ kind: 'account.logout', providerId: d.id, label: 'Sign out', enabled: logout.enabled, labelExperimental: logout.labelExperimental, reason: logout.reason })
  return out
}
