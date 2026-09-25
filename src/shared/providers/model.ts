// WP1 provider core: provider-neutral data contracts (design 5). Types only;
// persistence, migration and lifecycle transitions arrive in later slices.
// Nothing here carries a credential, a token or a raw file-system path that
// the renderer could act on.
import type { ProviderId } from '../types'

/** Global presentation metadata that helps a user recognise related accounts (5.1). */
export interface ConductorIdentity {
  id: string
  friendlyName?: string
  colourKey: string
  groupId?: string
  createdAt: number
  updatedAt: number
}

/** Optional organisation such as Work, Home or Test (5.2). Carries no policy. */
export interface AccountGroup {
  id: string
  name: string
  order: number
  createdAt: number
  updatedAt: number
}

export type AccountLifecycle = 'active' | 'inactive' | 'archived'
export type AuthMethod = 'browser' | 'device' | 'apiKey' | 'external' | 'unknown'
export type KnownAuthState = 'unknown' | 'signed-out' | 'signed-in' | 'expired' | 'error' | 'unsupported'
export type OperationalState = 'ready' | 'attention' | 'blocked'
export type IdentityAssurance = 'verified-subject' | 'realm-only' | 'user-asserted'

/** One account within one CLI provider (5.3). */
export interface ProviderAccount {
  id: string
  providerId: ProviderId
  providerAuthorityId?: string
  identityId: string
  authRealmId: string
  providerSubject?: string
  providerLabel?: string
  authMethod: AuthMethod
  planLabel?: string
  lifecycle: AccountLifecycle
  isProviderDefault: boolean
  /** The account a reviewer invocation of this provider uses when a request
   *  names none. Present only when true; at most one per provider; never an
   *  archived account. Absent everywhere means the provider default. */
  isReviewerDefault?: true
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt?: number
  lastValidatedAt?: number
  lastKnownAuthState: KnownAuthState
  operationalState: OperationalState
  identityAssurance: IdentityAssurance
}

export type RealmKind = 'claude-config-home' | 'codex-home'
export type RealmOwnership = 'conductor-managed' | 'external-default'
export type RealmLifecycle = 'pending' | 'active' | 'retiring' | 'retired' | 'recovery'
export type CredentialStoreMode = 'file' | 'keyring' | 'unknown'

/** The provider-controlled local authentication environment (5.4). `pathRef`
 *  is an application-controlled reference resolved in the main process; it
 *  is never shown as an identity and never a renderer-supplied path. */
export interface AuthRealm {
  id: string
  providerId: ProviderId
  ownerProviderAccountId: string
  kind: RealmKind
  ownership: RealmOwnership
  pathRef: string
  credentialStoreMode?: CredentialStoreMode
  lifecycle: RealmLifecycle
  createdAt: number
  lastValidatedAt?: number
}

export type DiscoveryState = 'unchecked' | 'missing' | 'found' | 'invalid' | 'error'
export type Compatibility = 'unknown' | 'supported' | 'too-old' | 'too-new' | 'unsupported'
export type SetupState = 'not-started' | 'needs-install' | 'needs-auth' | 'ready' | 'attention' | 'disabled'

/** Machine-level provider state, distinct from every account (5.6). */
export interface ProviderInstallation {
  providerId: ProviderId
  enabled: boolean
  discoveryState: DiscoveryState
  resolvedExecutable?: string
  version?: string
  compatibility: Compatibility
  installSource?: string
  lastCheckedAt?: number
  setupState: SetupState
}

/** The provider-neutral binding a session launches under (5.7). The provider
 *  account is canonical; the other three are validated against it and are
 *  never independently editable. */
export interface SessionBinding {
  providerId: ProviderId
  providerAccountId: string
  authRealmId: string
  identityId: string
}
