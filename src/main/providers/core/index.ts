// WP1 provider core (main): public entry point. Provider-neutral only; the
// dependency-boundary test fails this package on any concrete-provider import.
export type {
  ProviderPackage, ProviderPackageFactory, ProviderSetupOperations, ProviderAuthOperations, ProviderRealmOperations,
  ProviderManagedLaunchOperations, ProviderRealmFolderOperations, RealmFolderResult, RealmFolderFailureCode, ExternalDefaultRealmSpec,
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
