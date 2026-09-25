// WP2 commit 3: the Accounts surface's contract with the main process (design
// 5.6, 10, 11, 12, 13). Everything here crosses IPC, so everything here is
// renderer-safe BY CONSTRUCTION: opaque ids, states, labels and counts. No
// token, key, file path, pathRef, executable, environment value or provider
// subject ever appears in these shapes; the main process resolves all of
// those from the opaque ids and keeps them. The one exception is sign-in
// output (SignInOutputEvent): the provider CLI's own display text, redacted
// of secrets, shown to the user who started it -- it carries the login URL
// or device code they need and may name the account's folder.
import type { ProviderId } from '../types'
import type {
  AccountLifecycle, AuthMethod, KnownAuthState, OperationalState, IdentityAssurance, RealmLifecycle, DiscoveryState, Compatibility,
} from './model'
import type { CapabilityKey } from './capabilities'
import type { ProviderMigrationMarker, ProviderMigrationSkipReason, RegistryErrorCode, SetupJournalState, IdentityConflict } from './registry'

/** The user's durable yes or no for a provider, or nothing durable yet. */
export type ProviderPreference = 'on' | 'off' | 'undecided'

/** Sign-in methods a user can start from the Accounts surface. */
export type SignInMethod = 'browser' | 'device' | 'apiKey'
export const SIGN_IN_METHODS: readonly SignInMethod[] = ['browser', 'device', 'apiKey']
export const SIGN_IN_CAPABILITY: Readonly<Record<SignInMethod, CapabilityKey>> = { browser: 'auth.browser', device: 'auth.device', apiKey: 'auth.apiKey' }

export interface CapabilityView {
  enabled: boolean
  /** The surface must say "experimental" beside it. */
  labelExperimental: boolean
}

/** Machine-level provider state (5.6). Never the executable's path. */
export interface ProviderInstallationView {
  providerId: ProviderId
  displayName: string
  enabled: boolean
  preference: ProviderPreference
  discoveryState: DiscoveryState
  version?: string
  compatibility: Compatibility
  lastCheckedAt?: number
  /** Whether the provider's managed accounts can be added here (Claude's
   *  come from its own flows). */
  managedAccounts: boolean
  signInMethods: Readonly<Record<SignInMethod, CapabilityView>>
  status: CapabilityView
  logout: CapabilityView
  /** Present when this provider reviews for the other provider's sessions:
   *  whether a review could be prepared now on the account side, and on
   *  which account. The review switches and the Conductor tools switch
   *  decide the offer as well; for Claude reviews this is the account check
   *  the offer makes. */
  review?: ReviewReadinessView
}

export interface ReviewReadinessView {
  ready: boolean
  /** The account a review would use: the reviewer default, else the
   *  provider default. Absent when there is none. */
  accountId?: string
  source?: 'reviewer-default' | 'provider-default'
}

export interface IdentityView {
  id: string
  friendlyName?: string
  colourKey: string
  groupId?: string
}

export interface GroupView {
  id: string
  name: string
  order: number
}

export interface AccountView {
  id: string
  providerId: ProviderId
  identityId: string
  lifecycle: AccountLifecycle
  isProviderDefault: boolean
  /** Reviewer invocations of this provider use it when a request names none. */
  isReviewerDefault: boolean
  authMethod: AuthMethod
  providerLabel?: string
  planLabel?: string
  lastKnownAuthState: KnownAuthState
  operationalState: OperationalState
  identityAssurance: IdentityAssurance
  lastAuthenticatedAt?: number
  lastValidatedAt?: number
  realmLifecycle: RealmLifecycle | 'missing'
  /** The provider's own default home, shared with other local clients. */
  external: boolean
  /** Nobody has vouched for who is signed in (realm-only): shown as
   *  unverified, never linked, and every launch needs an acknowledgement.
   *  Derived from the registry, never from the identity's name or colour. */
  unverified: boolean
  /** Mirrored from the provider's own account list (Claude's profiles). */
  legacyLinked: boolean
  /** The provider's own id for this account when it is mirrored (Claude:
   *  the profile id), so a surface that lists the provider's own accounts
   *  can show each one's registry state. */
  legacyId?: string
  /** Sessions running on this account now. */
  runningSessions: number
  /** Reviewer invocations running on this account now. */
  runningReviews: number
  /** Everything holding the account: sessions, sign-ins, operations. */
  consumers: number
  /** Why this account cannot run this provider's reviews here. `platform`:
   *  it never can on this platform (Claude on macOS: only the normal
   *  sign-in). `unknown`: the app could not tell, so nothing is offered on
   *  it for now. Either way it cannot be made the reviewer. Absent when
   *  nothing about the platform stops it. */
  reviewRefusal?: ReviewRefusalView
}

export interface ReviewRefusalView {
  reason: 'platform' | 'unknown'
  message: string
}

/** A reviewer choice the app cleared because that account can never run
 *  reviews on this platform. `message` is the platform rule; the surface
 *  says the earlier choice was cleared. Shown beside the reviewer line
 *  until a reviewer is chosen for the provider. */
export interface ReviewerNoticeView {
  providerId: ProviderId
  message: string
}

/** An account being set up, or one an interrupted setup left behind (9.3). */
export interface PendingSetupView {
  accountId: string
  providerId: ProviderId
  method: AuthMethod
  state: SetupJournalState
  external: boolean
  createdAt: number
  /** A sign-in for it is running now. */
  signingIn: boolean
}

/** What a run of the one-time adoption answered (mirrors the core outcome). */
export type ExternalDefaultOutcome =
  | 'unsupported' | 'needs-confirmation' | 'registry-unavailable' | 'already-done' | 'registered' | 'not-signed-in' | 'skipped' | 'retry-later'

/** The one-time adoption of a provider's own default sign-in (6.3). */
export interface ExternalDefaultView {
  providerId: ProviderId
  marker?: { outcome: ProviderMigrationMarker['outcome']; reason?: ProviderMigrationSkipReason; at: number }
  /** This run's result, when one ran since the app started. */
  lastRun?: ExternalDefaultOutcome
  /** The user must be asked whether they use the provider first. */
  needsConfirmation: boolean
}

export type RegistryModeView =
  | { mode: 'ready' }
  | { mode: 'recovery'; reason: 'unloaded' | 'unreadable' | 'invalid' | 'newer-schema' }
  | { mode: 'unavailable' }

/** A name or colour edited both here and in the provider's own account list
 *  since they last agreed (design 6.2). The registry value is kept until the
 *  user chooses. Values are display labels and palette keys only. */
export type IdentityConflictView = Pick<IdentityConflict, 'identityId' | 'field' | 'providerId' | 'legacyId' | 'legacyValue' | 'registryValue' | 'detectedAt'>

export interface AccountsSnapshot {
  /** Increases with every change the main process publishes. */
  revision: number
  registry: RegistryModeView
  providers: ProviderInstallationView[]
  identities: IdentityView[]
  groups: GroupView[]
  accounts: AccountView[]
  pendingSetups: PendingSetupView[]
  externalDefaults: ExternalDefaultView[]
  conflicts: IdentityConflictView[]
  reviewerNotices: ReviewerNoticeView[]
}

/** Why an Accounts operation did not succeed. The surface acts on the code
 *  (design 13); the message is user-safe and never names a path. */
export type AccountsFailureCode =
  | RegistryErrorCode
  | 'invalid-request'          // the request did not validate at the IPC boundary
  | 'untrusted-sender'         // not the app's own window
  | 'registry-unavailable'     // no registry, or recovery mode
  | 'persist-failed'
  | 'unsupported'              // the provider does not offer this here
  | 'capability-disabled'      // unknown, or experimental and not enabled
  | 'provider-disabled'
  | 'provider-state-unknown'   // the saved on/off could not be read: nothing that starts a process runs
  | 'last-provider'            // at least one provider stays enabled
  | 'consumers'                // sessions or operations hold it: `consumers` says how many
  | 'busy'                     // a sign-in or another change holds it
  | 'acknowledgement-required' // an external home's wider effect needs the user's yes
  | 'not-signed-in'
  | 'secret-unavailable'
  | 'sign-in-changed'          // the realm now holds another sign-in: reconcile it first (design 5.5)
  | 'review-unavailable'       // this account cannot run reviews here, or the app could not tell: the message says which
  | 'internal'                 // unexpected; the app log has the detail
  | AuthOperationCode
  | RealmFolderCode

/** The provider auth codes the surface can see (mirrors the core contract). */
export type AuthOperationCode =
  | 'realm-unavailable' | 'external-overlap' | 'cli-unavailable' | 'realm-env-file' | 'browser-busy' | 'already-signed-in'
  | 'external-realm' | 'external-ack-required' | 'method-unsupported' | 'secret-channel-unavailable' | 'secret-invalid'
  | 'cancelled' | 'timed-out' | 'not-started' | 'provider-refused' | 'not-confirmed' | 'status-unrecognised' | 'still-signed-in'

/** The realm folder codes the surface can see (mirrors the core contract). */
export type RealmFolderCode =
  | 'not-managed' | 'resources-unavailable' | 'overlaps-external' | 'unsafe-path' | 'permissions' | 'credentials-present'
  | 'not-empty' | 'unsafe-contents' | 'changed' | 'io-failed'

export type AccountsFailure = {
  ok: false
  code: AccountsFailureCode
  message: string
  /** With `consumers`: how many hold it. */
  consumers?: number
  /** The sign-in state the operation observed, when it read one. */
  state?: KnownAuthState
}

export type AccountsResult<T extends object = object> = ({ ok: true } & T) | AccountsFailure

/** An install or update recipe as the surface shows it: the documented
 *  command to show and copy, never an argv. A recipe main allows to run also
 *  carries the one shell line to type for it (`runLine`). */
export interface InstallRecipeView {
  id: string
  providerId: ProviderId
  purpose: 'install' | 'update'
  publisher: string
  sourceUrl: string
  displayCommand: string
  method: 'package-manager' | 'installer' | 'script'
  needsNetwork: boolean
  mayElevate: boolean
  autoRunAllowed: boolean
  note?: string
  /** The exact line a Conductor terminal tab types to run this recipe, built
   *  by main from the recipe's argv for this computer's terminal shell (on
   *  Windows it names npm.cmd, which PowerShell's execution policy does not
   *  block). Present only for a package-manager recipe main allows to run;
   *  absent means show and copy only. Not what the user is shown: that is
   *  `displayCommand`, verbatim. */
  runLine?: string
}

/** Sign-in output, main -> the renderer that started it: the CLI's display
 *  text, redacted of secrets, display only. It carries the login URL or
 *  device code the user needs and may name the account's folder. */
export interface SignInOutputEvent {
  accountId: string
  text: string
}

// --- Requests (validated again in the main process; these are only types) ---

export interface BeginSetupRequest { providerId: ProviderId; method: SignInMethod }
export interface SignInRequest { accountId: string; method: SignInMethod; secretHandle?: string }
export type SetupIdentityChoice =
  | { mode: 'new'; friendlyName?: string; colourKey: string; groupId?: string }
  | { mode: 'link'; identityId: string }
export interface CompleteSetupRequest { accountId: string; identity: SetupIdentityChoice }
export interface LogoutRequest { accountId: string; acknowledgeExternal?: boolean }
export interface SetLifecycleRequest { accountId: string; lifecycle: AccountLifecycle; acknowledgeExternal?: boolean }
export interface UpdateIdentityRequest { identityId: string; friendlyName?: string | null; colourKey?: string; groupId?: string | null }
export interface SecretDeposit { handle: string; secret: string }
export interface ResolveConflictRequest { identityId: string; field: IdentityConflict['field']; providerId: ProviderId; legacyId: string; keep: 'registry' | 'legacy' }
/** `accountId: null` clears the choice: reviews then use the provider default. */
export interface SetReviewerDefaultRequest { providerId: ProviderId; accountId: string | null }

/** A secret handle: main-issued, single use, bound to one pending sign-in. */
export const SECRET_HANDLE_RE = /^sec-[0-9a-f]{32}$/
/** Longest secret the one-way channel accepts. */
export const SECRET_MAX = 4096
