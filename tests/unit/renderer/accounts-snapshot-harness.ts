// A small Accounts snapshot for the WP2 commit 6 launch tests: a Codex
// provider with a default account, a second managed account, this
// computer's own ~/.codex (external, unverified), a blocked one, an inactive
// one and an archived one. Built with the real shared types.
import type { AccountsSnapshot, AccountView, ProviderInstallationView } from '../../../src/shared/providers'

export function provider(over: Partial<ProviderInstallationView> & Pick<ProviderInstallationView, 'providerId' | 'displayName'>): ProviderInstallationView {
  const cap = { enabled: true, labelExperimental: false }
  return {
    enabled: true, preference: 'on', discoveryState: 'found', version: '0.155.1', compatibility: 'supported', managedAccounts: true,
    signInMethods: { browser: cap, device: cap, apiKey: cap }, status: cap, logout: cap,
    ...over,
  }
}

export function account(over: Partial<AccountView> & Pick<AccountView, 'id' | 'providerId' | 'identityId'>): AccountView {
  return {
    lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false, authMethod: 'browser',
    lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted', realmLifecycle: 'active',
    external: false, unverified: false, legacyLinked: false, runningSessions: 0, runningReviews: 0, consumers: 0,
    ...over,
  }
}

export const work = account({ id: 'acc-work', providerId: 'codex', identityId: 'id-work', providerLabel: 'alex@work.example', isProviderDefault: true })
export const personal = account({ id: 'acc-personal', providerId: 'codex', identityId: 'id-personal', providerLabel: 'alex@home.example' })
export const local = account({ id: 'acc-local', providerId: 'codex', identityId: 'id-ext', providerLabel: 'alex@example.com', external: true, unverified: true, authMethod: 'external', identityAssurance: 'realm-only' })
export const old = account({ id: 'acc-old', providerId: 'codex', identityId: 'id-old', operationalState: 'blocked' })
export const parked = account({ id: 'acc-parked', providerId: 'codex', identityId: 'id-parked', lifecycle: 'inactive' })
export const gone = account({ id: 'acc-gone', providerId: 'codex', identityId: 'id-gone', lifecycle: 'archived' })
export const claudeMain = account({ id: 'acc-claude-main', providerId: 'claude', identityId: 'id-claude', isProviderDefault: true })

export function snapshot(over: Partial<AccountsSnapshot> = {}): AccountsSnapshot {
  return {
    revision: 1,
    registry: { mode: 'ready' },
    providers: [
      provider({ providerId: 'claude', displayName: 'Claude Code', version: '2.1.281' }),
      provider({ providerId: 'codex', displayName: 'Codex' }),
    ],
    identities: [
      { id: 'id-work', friendlyName: 'Work', colourKey: 'indigo' },
      { id: 'id-personal', friendlyName: 'Personal', colourKey: 'pink' },
      { id: 'id-ext', friendlyName: 'External Codex sign-in (account unverified)', colourKey: 'slate-blue' },
      { id: 'id-old', friendlyName: 'Old', colourKey: 'rose' },
      { id: 'id-parked', friendlyName: 'Parked', colourKey: 'plum' },
      { id: 'id-gone', friendlyName: 'Gone', colourKey: 'plum' },
      { id: 'id-claude', friendlyName: 'Me', colourKey: 'mauve' },
    ],
    groups: [],
    // Deliberately not in picker order: the picker sorts.
    accounts: [parked, old, personal, local, work, gone, claudeMain],
    pendingSetups: [],
    externalDefaults: [],
    conflicts: [],
    reviewerNotices: [],
    ...over,
  }
}
