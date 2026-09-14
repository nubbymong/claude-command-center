/**
 * Splash build line (#384) — what the main process hands the static splash
 * page so it can print "v2.1.0-beta.17 · beta · build 3a1b2e2 · 2026-08-22".
 *
 * The splash is a self-contained file:// page with a strict CSP (no inline
 * script, no preload), so the values travel as the loadFile query string and
 * resources/splash/splash-info.js reads them back with URLSearchParams and
 * sets textContent. Only main ever constructs this URL.
 *
 * Electron-free and pure so the unit test can pin the exact query without a
 * BrowserWindow; src/main/index.ts spreads it into loadFile(html, { query }).
 */
import { formatBuildIdentity } from '../shared/build-identity'

export const SPLASH_BUILD_QUERY_KEY = 'build'

export interface SplashBuildInput {
  version: string
  sha?: string | null
  buildTime?: string | null
}

/** `{ build: "<identity line>" }` — the query object for loadFile. */
export function splashBuildQuery(input: SplashBuildInput): Record<string, string> {
  return { [SPLASH_BUILD_QUERY_KEY]: formatBuildIdentity(input) }
}
