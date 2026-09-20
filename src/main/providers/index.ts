// The session-provider registry lives in provider core since WP1. This module
// keeps the import path the runtime already uses (`getProvider`,
// `registerProvider`, `tryGetProvider`) and re-exports the core entry point.
// It imports no concrete provider; registration happens only in `./compose`.
export { registerProvider, getProvider, tryGetProvider } from './core'
