// What the managed-launch hardening DID to one profile, recorded where both
// halves of the app can read it.
//
// Two facts are produced in one place and wanted in another:
//   - the settings sanitiser runs when a profile home is BUILT, and its result
//     is wanted when a launch is composed;
//   - the ambient strip happens while the launch environment is composed, and
//     its result is wanted by the preflight that reports on that launch.
//
// They live here rather than in `account-profiles.ts` for a structural reason.
// The preflight recorder needs to read them, and the choke point
// (`withProfileHome`) needs to call the recorder -- so with the state inside
// `account-profiles.ts` those two modules import each other. A cycle between
// the launch path and its own diagnostics is exactly the kind of import graph
// that resolves differently under a bundler than under vitest, so the shared
// state is its own module and both sides import DOWN into it.
//
// Keyed by the profile HOME path: both writers know that, and only one of them
// knows the profile id.

/** What the sanitiser removed from a profile's app-owned settings copy. */
export interface SettingsSanitiseRecord {
  removed: readonly string[]
  /** Set when nothing could be written -- the copy was refused, not emptied. */
  refused?: string
}

const lastSettingsSanitise = new Map<string, SettingsSanitiseRecord>()
const lastAmbientStrip = new Map<string, readonly string[]>()

export function recordSettingsSanitise(home: string, record: SettingsSanitiseRecord): void {
  lastSettingsSanitise.set(home, record)
}

/**
 * Drop this profile's sanitise record, so the next launch reports what THAT
 * launch found rather than what an earlier one did.
 *
 * The record is per-process and was never invalidated, so `'not-evaluated'`
 * only ever fired for a home's FIRST launch. Any later launch whose home build
 * threw before the settings block reused the previous verdict verbatim and
 * stamped it with the new launch's session and time -- and if that verdict was
 * `{removed: []}`, the Accounts panel showed a clean isolation report for a
 * launch that had checked nothing.
 *
 * It is reachable: `ensureLink` ends at an unguarded `symlinkSync(..., 'junction')`
 * and the orphan recovery covers only `projects`, so a profile that once span
 * up cleanly and later acquires an orphaned real `.claude/memory` throws there
 * on every subsequent spawn (adversarial round 4).
 *
 * Called at the TOP of the home build, so the window in which a stale record
 * could be read does not exist rather than being made small.
 */
export function clearSettingsSanitise(home: string): void {
  lastSettingsSanitise.delete(home)
}

/** The last sanitise result for a profile home, or null if none was written. */
export function lastSettingsSanitiseFor(home: string): SettingsSanitiseRecord | null {
  return lastSettingsSanitise.get(home) ?? null
}

export function recordAmbientStrip(home: string, names: readonly string[]): void {
  lastAmbientStrip.set(home, names)
}

/** What the last managed launch for this profile home stripped, or null. */
export function lastAmbientStripFor(home: string): readonly string[] | null {
  return lastAmbientStrip.get(home) ?? null
}

export function _resetManagedLaunchStateForTest(): void {
  lastSettingsSanitise.clear()
  lastAmbientStrip.clear()
}
