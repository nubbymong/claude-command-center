// Sentinel's deterministic Codex check (P3.9, row 42): the installed Codex
// CLI's version against the range the app's managed flows support. Pure, as
// minVersionFindings is for Claude Code; the caller runs the version check
// (the accounts service's discovery, a `codex --version` in an empty home)
// and upserts. Finding ids name the version, so a dismissed finding stays
// dismissed for that version and a new version is said afresh.
//
// Too old is a severe break: a Codex session will not start with it. Newer
// than tested is a notice: it runs, and nobody has checked it yet (design 8.4:
// warned and allowed, never silently called compatible); the analysis of its
// release notes, where one runs, says whether anything in it breaks the app.
// A CLI that was not found or whose version could not be read is the
// Accounts row's business (it says so and offers Check again), not a drift.
import type { SentinelFinding } from '../../shared/sentinel-types'
import type { Compatibility, DiscoveryState } from '../../shared/providers'

export interface CodexVersionFacts {
  discoveryState: DiscoveryState
  version?: string
  compatibility: Compatibility
}

export interface SupportedVersions {
  minimum: string
  maximumTested: string
}

/** A version as the version check parsed it: digits, dots and a plain
 *  pre-release tag, nothing else (it lands in a finding's text). */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/

export function codexVersionFindings(
  facts: CodexVersionFacts | null | undefined,
  range: SupportedVersions | null | undefined,
  now: number = Date.now(),
): SentinelFinding[] {
  if (!facts || facts.discoveryState !== 'found' || typeof facts.version !== 'string' || !VERSION_RE.test(facts.version)) return []
  const v = facts.version
  const min = range && VERSION_RE.test(range.minimum) ? range.minimum : null
  const max = range && VERSION_RE.test(range.maximumTested) ? range.maximumTested : null
  const span = min && max ? `${min} to ${max}` : null
  if (facts.compatibility === 'too-old') {
    return [{
      id: `codex-version:too-old:${v}`,
      kind: 'compat',
      severity: 'high',
      title: `Codex ${v} is older than AI Code Conductor supports`,
      evidence: `The installed Codex CLI reports version ${v}.${span ? ` AI Code Conductor supports Codex ${span}.` : ''} Codex sessions and sign-ins will not start with it until Codex is updated (Settings, Accounts lists the update command).`,
      affectedFeature: 'sessions',
      badgeText: min ? `Needs Codex ${min} or newer, currently ${v}` : `Codex ${v} is too old`,
      surface: 1,
      provider: 'codex',
      status: 'open',
      createdAt: now,
    }]
  }
  if (facts.compatibility === 'too-new') {
    return [{
      id: `codex-version:too-new:${v}`,
      kind: 'compat',
      severity: 'warn',
      title: `Codex ${v} is newer than AI Code Conductor was tested with`,
      evidence: `The installed Codex CLI reports version ${v}.${max ? ` AI Code Conductor was tested with Codex up to ${max}.` : ''} It still runs; if something stops working, the Codex version is the first thing to check.`,
      affectedFeature: 'sessions',
      badgeText: max ? `Tested up to Codex ${max}, currently ${v}` : `Codex ${v} is untested`,
      provider: 'codex',
      status: 'open',
      createdAt: now,
    }]
  }
  return []
}
