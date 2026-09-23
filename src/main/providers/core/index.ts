// WP1 provider core (main): public entry point. Provider-neutral only; the
// dependency-boundary test fails this package on any concrete-provider import.
export type {
  ProviderPackage, ProviderPackageFactory, ProviderSetupOperations, ProviderAuthOperations, ProviderRealmOperations,
  ProviderManagedLaunchOperations,
  DiscoveryResult, InstallRecipe, RealmRef, AuthOperationResult,
} from './package'
export {
  registerProvider, getProvider, tryGetProvider,
  registerProviderPackage, packageRegistrationProblem, getProviderPackage, tryGetProviderPackage, listProviderPackages,
  providerCapability, realmEnvForProvider, _resetProviderRegistryForTest,
  ambientAuthVariablesForProvider,
  sanitizeManagedSettingsFor, authoritySettingsKeysFor, managedLaunchPreflightFor, minimumManagedCliVersionFor,
} from './registry'
