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
  SanitizedManagedSettings, ManagedLaunchPreflightInput, ManagedLaunchPreflight,
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

/** Managed-launch hardening a provider supplies for launches the APP owns.
 *
 *  Separate from `realms` on purpose. `realmEnvPatch` answers "which identity
 *  does this process use"; this answers "what does the host do so that nothing
 *  else can change that answer after the fact". */
export interface ProviderManagedLaunchOperations {
  /** The oldest CLI version on which this provider's host controls have been
   *  PROVEN. Not a guess at the oldest that might work: a floor of evidence. */
  readonly minimumCliVersion: string
  /** Sanitise a settings file the APP ITSELF writes into a managed realm.
   *  Pure: takes text, returns text. It never sees, and therefore can never
   *  modify, the user's own settings or any repository-owned file. */
  sanitizeManagedSettings(raw: string): SanitizedManagedSettings
  /** The authority-bearing keys a settings payload CONTAINS, canonically named
   *  and with no copy produced. For a file the app does NOT own -- a project's
   *  or a repository's -- where the only question is what the host control is
   *  suppressing. Separate from `sanitizeManagedSettings` because producing the
   *  sanitised TEXT is the expensive half and this caller discards it. */
  authoritySettingsKeys(raw: string): readonly string[]
  /** Report on one composed launch. A diagnostic, never the boundary. */
  preflight(input: ManagedLaunchPreflightInput): ManagedLaunchPreflight
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
  /** HOST-MANAGED CONTROLS applied LAST on every app-managed launch of this
   *  provider, after the ambient removal and after the realm patch.
   *
   *  Required, not optional: a provider with nothing to declare says so with
   *  `{}`, which is a decision on the record rather than a field someone
   *  forgot. The realm patch cannot set, unset or overwrite any key here --
   *  applyRealmEnvPatch refuses -- so "the host wins" is enforced by the
   *  mechanism rather than by call order. */
  readonly hostManagedEnv: Readonly<Record<string, string>>
  /** Present when the provider has managed-launch hardening to offer.
   *  Absent means the app applies no settings sanitiser and enforces no CLI
   *  floor for it -- which is only honest while that provider has no
   *  app-owned settings file and no proven host control. */
  readonly managedLaunch?: ProviderManagedLaunchOperations
  readonly setup?: ProviderSetupOperations
  readonly auth?: ProviderAuthOperations
  readonly realms?: ProviderRealmOperations
}

/** Packages are created by the composition root, never at module load, so
 *  importing an entry point has no side effects and no import cycle can
 *  instantiate a provider early. */
export type ProviderPackageFactory = () => ProviderPackage
