// WP1 provider core (main): the provider package contract (design 7.1).
//
// A concrete provider package exports exactly one factory of this shape from
// its public entry point. Provider core and the composition root see
// providers only through it; nothing outside a package reaches into its
// internals (tests/wp1/dependency-boundaries.test.ts).
//
// The rule that keeps declarations honest: a capability may be declared
// `supported` or `experimental` only when the package exposes the operation
// object that backs it (CAPABILITY_OPERATION); registration fails otherwise.
// An operation that is not wired yet leaves its capability `unknown`.
import type { ProviderId } from '../../../shared/providers'
import type {
  ProviderCapabilities, CapabilityPlatform, RealmEnvPatch, AuthMethod, KnownAuthState, DiscoveryState, Compatibility,
} from '../../../shared/providers'
import type { SessionProvider } from '../types'

export interface DiscoveryResult {
  state: DiscoveryState
  /** Canonical resolved executable path, when found. Main-process only. */
  executable?: string
  version?: string
  compatibility: Compatibility
  /** Non-secret detail for the diagnostic surface ("probe failed: ..."). */
  detail?: string
  checkedAt: number
}

export interface InstallRecipe {
  id: string
  providerId: ProviderId
  platform: CapabilityPlatform
  publisher: string
  sourceUrl: string
  /** Structured argv; never a shell string, never interpolated with user data. */
  command: readonly string[]
  method: 'package-manager' | 'installer' | 'script'
  needsNetwork: boolean
  mayElevate: boolean
  /** A remote pipe-to-shell recipe is displayed/copied, never auto-run (8.4). */
  autoRunAllowed: boolean
}

/** An opaque realm reference resolved inside the main process. */
export interface RealmRef { authRealmId: string }

export interface AuthOperationResult {
  ok: boolean
  /** Redacted, user-safe message. Never contains tokens or full login URLs. */
  message?: string
  /** Provider-supplied stable subject + authority when observable (5.3). */
  providerSubject?: string
  providerAuthorityId?: string
  providerLabel?: string
  planLabel?: string
}

export interface ProviderSetupOperations {
  discover(): Promise<DiscoveryResult>
  installRecipes(platform: CapabilityPlatform): readonly InstallRecipe[]
}

export interface ProviderAuthOperations {
  status(realm: RealmRef): Promise<{ state: KnownAuthState } & AuthOperationResult>
  logout(realm: RealmRef): Promise<AuthOperationResult>
  /** Browser/device flows run the genuine CLI in a Conductor surface; the
   *  api-key flow takes a one-shot non-TTY stdin pipe (9.2). Inputs are
   *  opaque handles, never the secret itself. */
  login(realm: RealmRef, method: AuthMethod, input?: { secretHandle?: string }): Promise<AuthOperationResult>
}

export interface ProviderRealmOperations {
  /** The exact environment patch for a bound realm (D1): Claude = the existing
   *  profile-home mechanism; Codex = CODEX_HOME. */
  realmEnvPatch(realm: RealmRef): RealmEnvPatch
}

export interface ProviderPackage {
  readonly id: ProviderId
  readonly displayName: string
  /** The existing runtime surface (spawn, telemetry, resume). Unchanged in WP1. */
  readonly session: SessionProvider
  readonly capabilities: ProviderCapabilities
  /** Ambient authentication variables that could override the bound realm
   *  (D3). Removed from every managed launch before the realm patch is applied. */
  readonly ambientAuthVariables: readonly string[]
  /** Variables the provider's realm patch may set or unset (the realm
   *  selector plus what the existing mechanism already touches). */
  readonly ownedLaunchVariables: readonly string[]
  readonly setup?: ProviderSetupOperations
  readonly auth?: ProviderAuthOperations
  readonly realms?: ProviderRealmOperations
}

/** Packages are created by the composition root, never at module load, so
 *  importing an entry point has no side effects and no import cycle can
 *  instantiate a provider early. */
export type ProviderPackageFactory = () => ProviderPackage
