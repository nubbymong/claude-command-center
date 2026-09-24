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
  SanitizedManagedSettings, ManagedLaunchPreflightInput, ManagedLaunchPreflight, RealmKind,
} from '../../../shared/providers'
import type { SessionProvider } from '../types'
import type { LegacyAccountsPort } from './account-registry-store'

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
  /** A first install, or an update of an existing one. */
  purpose: 'install' | 'update'
  platform: CapabilityPlatform
  publisher: string
  sourceUrl: string
  /** Structured argv, never interpolated with user data, run without a
   *  shell. Null for a recipe the app only shows (`autoRunAllowed` false):
   *  there is then nothing a careless caller could execute. */
  command: readonly string[] | null
  /** Exactly what the user is shown and may copy, character for character
   *  the provider's documented command. */
  displayCommand: string
  method: 'package-manager' | 'installer' | 'script'
  needsNetwork: boolean
  mayElevate: boolean
  /** A remote pipe-to-shell recipe is displayed/copied, never auto-run (8.4). */
  autoRunAllowed: boolean
  /** Non-secret caveat shown beside the command. */
  note?: string
}

/** An opaque realm reference resolved inside the main process. */
export interface RealmRef { authRealmId: string }

/** Why an auth operation did not succeed, for a caller that acts on it
 *  (design 13) rather than on the message's wording. */
export type AuthFailureCode =
  | 'realm-unavailable'      // not resolvable, missing, or not at its canonical path
  | 'external-overlap'       // the external home overlaps (or cannot be shown not to overlap) the managed homes
  | 'cli-unavailable'        // not proven by setup, an unusable version, or changed since
  | 'realm-env-file'         // a managed realm holds a .env
  | 'busy'                   // another sign-in or sign-out holds this realm
  | 'browser-busy'           // another browser sign-in is running (its callback port is machine-wide)
  | 'already-signed-in'
  | 'external-realm'         // no sign-in into another client's home
  | 'external-ack-required'  // an external logout needs the user's acknowledgement
  | 'method-unsupported'
  | 'secret-unavailable'     // the handle expired or was already used: enter it again
  | 'secret-channel-unavailable' // no secret-entry channel here: choose another method
  | 'secret-invalid'
  | 'cancelled'
  | 'timed-out'
  | 'not-started'            // the CLI could not be run
  | 'provider-refused'       // the CLI ran and failed
  | 'not-confirmed'          // the realm's status afterwards does not agree
  | 'status-unrecognised'
  | 'still-signed-in'        // a logout left the realm signed in

/** How a signed-in realm is signed in, when the provider says: a provider
 *  account sign-in or an API key. Never the credential itself. */
export type AuthCredentialKind = 'account' | 'api-key' | 'unknown'

export interface AuthOperationResult {
  ok: boolean
  /** Set when `ok` is false. */
  code?: AuthFailureCode
  /** The realm's sign-in state as last observed, when the operation read it
   *  (also after a failure: a cancelled sign-in may have completed anyway). */
  state?: KnownAuthState
  /** Set with `state: 'signed-in'` when the provider says how. */
  credential?: AuthCredentialKind
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

export interface AuthLoginInput {
  /** API key: a main-issued single-use handle, never the secret itself. */
  secretHandle?: string
  /** The sign-in process's output as it arrives, redacted and display-only. */
  onOutput?: (text: string) => void
  /** Cancels this sign-in, and nothing else. */
  signal?: AbortSignal
}

export interface AuthLogoutOptions {
  /** An external realm is shared with other local clients: logging it out
   *  needs the user's explicit acknowledgement of that wider effect (5.4). */
  acknowledgeExternalRealm?: boolean
}

export interface ProviderAuthOperations {
  status(realm: RealmRef): Promise<{ state: KnownAuthState } & AuthOperationResult>
  logout(realm: RealmRef, opts?: AuthLogoutOptions): Promise<AuthOperationResult>
  /** Browser/device flows run the genuine CLI in a Conductor surface; the
   *  api-key flow takes a one-shot non-TTY stdin pipe (9.2). Inputs are
   *  opaque handles, never the secret itself. */
  login(realm: RealmRef, method: AuthMethod, input?: AuthLoginInput): Promise<AuthOperationResult>
}

/** Why a realm folder operation did not succeed (design 13: a realm
 *  permission or path failure, an orphaned app-managed realm). */
export type RealmFolderFailureCode =
  | 'realm-unavailable'      // not resolvable in the registry
  | 'not-managed'            // an external home: the app never creates or removes it
  | 'lifecycle'              // not in a state that allows it (only a pending setup's folder)
  | 'resources-unavailable'  // the app's data folder cannot be resolved
  | 'overlaps-external'      // the external home overlaps (or cannot be shown not to overlap) the managed folders
  | 'unsafe-path'            // a link, junction or reparse point, or not where the app put it
  | 'permissions'            // it could not be made owner-only
  | 'busy'                   // a sign-in or sign-out holds the realm
  | 'credentials-present'    // a removal found a stored sign-in: sign out through the provider first
  | 'not-empty'              // an empty-only removal found something inside
  | 'unsafe-contents'        // a removal found a link, another volume or too much: nothing removed
  | 'changed'                // the folder changed while in use, and the operation stopped
  | 'io-failed'

export interface RealmFolderResult {
  ok: boolean
  code?: RealmFolderFailureCode
  /** User-safe; never a path. */
  message?: string
  /** prepare: the folder was made by this call (false: an earlier attempt's, re-verified). */
  created?: boolean
  /** remove: something was removed (false: it was already gone). */
  removed?: boolean
}

/** The app-managed folder behind a realm, for providers whose managed
 *  accounts each get one (design 5.4, 9.3). Main-process only; realms are
 *  named by opaque reference, never by path. */
export interface ProviderRealmFolderOperations {
  /** Create a pending setup's folder before any sign-in, or re-verify the one
   *  an earlier attempt left. */
  prepare(realm: RealmRef): Promise<RealmFolderResult>
  /** Remove a pending (abandoned) setup's folder: `empty-only` only when
   *  nothing is inside, `all` after proving the whole tree is plain files and
   *  folders inside the managed root. `all` proves the tree's SHAPE, not who
   *  wrote it. The caller signs the realm out through the provider first (a
   *  stored sign-in is refused, never deleted; one kept in an OS keyring is
   *  invisible here), and removes the folder BEFORE it abandons the setup,
   *  keeping the journal when this fails: the folder is only ever found
   *  through its realm record. `removed: false` means nothing was there. */
  remove(realm: RealmRef, opts: { contents: 'empty-only' | 'all' }): Promise<RealmFolderResult>
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
  /** Present when the provider has managed-launch hardening to offer.
   *  Absent means the app applies no settings sanitiser, runs no project gate
   *  and enforces no CLI floor for it -- which is only honest while that
   *  provider has no app-owned settings file. */
  readonly managedLaunch?: ProviderManagedLaunchOperations
  readonly setup?: ProviderSetupOperations
  readonly auth?: ProviderAuthOperations
  readonly realms?: ProviderRealmOperations
  /** Present when the provider's managed accounts each get an app-managed
   *  folder (Codex); absent for providers that keep their own (Claude). */
  readonly realmFolders?: ProviderRealmFolderOperations
  /** Present when the provider keeps its own account store the registry must
   *  mirror (Claude's profiles.json during 2.1.1). Creating it does no I/O;
   *  only the registry store calls it. */
  readonly legacyAccounts?: LegacyAccountsPort
  /** Present when the provider has a default sign-in location of its own that
   *  other local clients share (Codex's ~/.codex), which an upgrade registers
   *  once, when it is signed in, as a realm-only external account (design
   *  6.3). Absent: nothing to adopt (Claude's accounts come from its legacy
   *  store). */
  readonly externalDefaultRealm?: ExternalDefaultRealmSpec
  /** Where the user's on/off for this provider is saved, and what no saved
   *  value means (A4): data, so no provider-name condition decides it. */
  readonly enablement?: ProviderEnablementSpec
}

export interface ProviderEnablementSpec {
  /** A boolean settings key: true is on, false is off. */
  readonly settingsKey: string
  /** What an absent value means: on, or not answered yet. */
  readonly absent: 'on' | 'undecided'
}

export interface ExternalDefaultRealmSpec {
  readonly kind: RealmKind
  /** The private identity's name: says the account is unverified. */
  readonly identityLabel: string
}

/** Packages are created by the composition root, never at module load, so
 *  importing an entry point has no side effects and no import cycle can
 *  instantiate a provider early. */
export type ProviderPackageFactory = () => ProviderPackage
