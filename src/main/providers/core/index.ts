// WP1 provider core (main): public entry point. Provider-neutral only; the
// dependency-boundary test fails this package on any concrete-provider import.
export type {
  ProviderPackage, ProviderPackageFactory, ProviderSetupOperations, ProviderAuthOperations, ProviderRealmOperations,
  ProviderManagedLaunchOperations, ProviderRealmFolderOperations, ProviderLaunchOperations, LaunchPreparation, ProviderReviewOperations, ReviewRunInput, ReviewRunResult, ReviewUsage, RealmFolderResult, RealmFolderFailureCode, ExternalDefaultRealmSpec, ProviderEnablementSpec,
  DiscoveryResult, InstallRecipe, RealmRef, AuthOperationResult, AuthLoginInput, AuthLogoutOptions, AuthFailureCode, AuthCredentialKind,
} from './package'
export {
  registerProvider, getProvider, tryGetProvider,
  registerProviderPackage, packageRegistrationProblem, getProviderPackage, tryGetProviderPackage, listProviderPackages,
  providerCapability, realmEnvForProvider, _resetProviderRegistryForTest,
  ambientAuthVariablesForProvider,
  sanitizeManagedSettingsFor, authoritySettingsKeysFor, managedLaunchPreflightFor, minimumManagedCliVersionFor,
} from './registry'

// WP2: the account registry store (persistence behind an injected port).
export { AccountRegistryStore, deterministicOpaqueId, REGISTRY_BACKUPS_KEPT } from './account-registry-store'
export type {
  RegistryFsPort, LegacyAccountsPort, RegistryStatus, StoreResult, StoreFailureCode, LegacyReconcileOutcome, AccountRegistryStoreOptions,
} from './account-registry-store'

// WP2: adopting a provider's own default sign-in once, on upgrade (design 6.3).
export { migrateExternalDefaultRealm } from './external-default-migration'
export type { ExternalDefaultMigrationOutcome, ExternalDefaultMigrationDeps, ProviderPreference } from './external-default-migration'

// WP2 commit 3: consumer leases, the one-shot secret channel and the
// accounts service (design 9.2, 9.3, 11; plan A6, A11).
export { ConsumerLeaseRegistry, LAUNCH_LEASE_KINDS } from './consumer-leases'
export type { LeaseKind, LaunchLeaseKind, LeaseOwner, AccountLease, LeaseAddResult } from './consumer-leases'
export { SecretHandleStore, SECRET_HANDLE_TTL_MS, SECRET_HANDLES_PER_RENDERER } from './secret-handles'
export { AccountsService } from './accounts-service'
export type { AccountsServiceDeps, LaunchLeaseResult, PreparedLaunchResult } from './accounts-service'

// WP2 commit 5b: what every reviewer adapter shares (environment and output).
export {
  reviewerEnv, finishReview, redactReply, redactFailure, redactHead, redactTail, clip,
  WINDOW, MARGIN, MAX_MESSAGE, REVIEW_MAX_TEXT, DEPTH_GUARD_PREFIXES,
} from './review-support'
