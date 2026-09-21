// Layer 4 of the managed-launch hardening: the visible preflight.
//
// READ THIS BEFORE TRUSTING ANYTHING HERE. The preflight is a DIAGNOSTIC, not
// the security boundary, and a clean result does NOT mean a session is
// isolated. It reports what is locally observable at the moment a launch is
// composed. The sources that matter most are not locally observable:
//
//   - remote / organizationally managed settings, which the CLI fetches from
//     the server for a signed-in account;
//   - settings changed AFTER the process started;
//   - anything a future CLI version reads that this version does not.
//
// The boundary is the host control itself -- applied last by
// applyRealmEnvPatch, refused to providers, and proven to fail closed. What
// this module adds is that a MISSING control becomes loud instead of silent,
// and that the user can see what the sanitiser took out of their settings copy.
import { logInfo, logWarn } from './debug-logger'
import { managedLaunchPreflightFor } from './providers'
import { peekClaudeCliVersion, ensureClaudeCliVersion } from './claude-cli-version'
import { lastSettingsSanitiseFor, lastAmbientStripFor } from './account-profiles'
import type { ManagedLaunchPreflight } from '../shared/providers'

export interface ManagedLaunchReport {
  /** The profile home the launch was bound to. */
  home: string
  sessionId: string
  at: number
  preflight: ManagedLaunchPreflight
}

/** Bounded so a long-running app cannot accumulate one entry per session for
 *  the life of the process. The newest are the ones anybody looks at. */
const MAX_REPORTS = 50
const reports: ManagedLaunchReport[] = []

/**
 * Run the preflight for one composed managed launch and record it.
 *
 * Never throws and never blocks: it is called on the spawn path, and a
 * diagnostic that can break a launch is worse than no diagnostic. The control
 * it reports on has already been applied (and asserted) by `withProfileHome` --
 * that assertion, not this function, is what refuses a launch.
 */
export function recordManagedLaunchPreflight(
  sessionId: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): ManagedLaunchPreflight | null {
  try {
    // If the boot probe never answered (the CLI was installed after launch, or
    // one probe failed), start another now. Fire-and-forget: this launch still
    // reports `unknown`, the next one will not.
    ensureClaudeCliVersion()
    const preflight = managedLaunchPreflightFor('claude', {
      env,
      cliVersion: peekClaudeCliVersion(),
      sanitizedSettings: lastSettingsSanitiseFor(home) ?? undefined,
      strippedAmbient: lastAmbientStripFor(home) ?? undefined,
    })
    if (!preflight) return null
    reports.push({ home, sessionId, at: Date.now(), preflight })
    if (reports.length > MAX_REPORTS) reports.splice(0, reports.length - MAX_REPORTS)
    for (const f of preflight.findings) {
      const line = `[managed-launch] session ${sessionId}: ${f.id} -- ${f.title}: ${f.detail}${f.action ? ` -> ${f.action}` : ''}`
      if (f.severity === 'blocked') logWarn(line)
      else logInfo(line)
    }
    if (preflight.findings.length === 0) {
      logInfo(`[managed-launch] session ${sessionId}: preflight clean (Claude Code ${preflight.compatibility.found ?? 'unknown'}) -- diagnostics only, not a claim of isolation`)
    }
    return preflight
  } catch (e) {
    logWarn(`[managed-launch] preflight failed for session ${sessionId}: ${(e as Error)?.message ?? e}`)
    return null
  }
}

/** Newest first. For the diagnostics surface and for tests. */
export function listManagedLaunchReports(): readonly ManagedLaunchReport[] {
  return [...reports].reverse()
}

export function _resetManagedLaunchReportsForTest(): void {
  reports.length = 0
}
