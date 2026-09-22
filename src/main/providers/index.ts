// The session-provider registry lives in provider core since WP1. This module
// keeps the import path the runtime already uses (`getProvider`,
// `registerProvider`, `tryGetProvider`) and re-exports the core entry point.
// It imports no concrete provider; registration happens only in `./compose`.
//
// It is also the ONLY route by which a shared main module (the launch paths,
// the profile-home builder) reaches provider knowledge: the dependency
// boundary forbids importing a package entry point from anywhere but the
// composition root, so "which variables are stripped", "which host control is
// applied" and "how the app-owned settings copy is sanitised" all arrive here
// from the registered package rather than being restated at each call site.
export { registerProvider, getProvider, tryGetProvider } from './core'
export {
  realmEnvForProvider, ambientAuthVariablesForProvider,
  sanitizeManagedSettingsFor, authoritySettingsKeysFor, managedLaunchPreflightFor, minimumManagedCliVersionFor,
} from './core'
