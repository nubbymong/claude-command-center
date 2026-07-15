// sentinel-version.ts — Deterministic half of Trigger B (spec §5).
// Version parse/compare + minCcVersion checks. No AI here.
import type { SentinelFinding } from '../../shared/sentinel-types'

export interface ManifestEntry {
  id: string
  area: string
  contract: string
  files: string[]
  failureMode: string
  severity: 'info' | 'warn' | 'high'
  configFixable: boolean
  affectedFeature?: string
  minCcVersion?: string
}

/**
 * Extract the first semver string from a raw `claude --version` line.
 * Returns null when no semver is found.
 * Examples that match:
 *   "2.0.13 (Claude Code)" → "2.0.13"
 *   "claude 2.1.0"         → "2.1.0"
 *   "2.1.0-beta.1"         → "2.1.0-beta.1"
 */
export function parseClaudeVersion(raw: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(raw)
  return m ? m[1] : null
}

/**
 * Compare two semver strings numerically on the major.minor.patch tuple.
 * Pre-release suffixes are ignored for ordering purposes (consistent with
 * how minCcVersion thresholds work in practice).
 * Returns < 0 when a < b, 0 when equal, > 0 when a > b.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number)
  const pb = b.split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}

/**
 * Deterministic backstop (severe-breaking-only): the BREAKING subset of the
 * manifest's minCcVersion guards -- entries marked severity 'high' whose
 * minCcVersion exceeds the installed Claude Code version. So a known-breaking
 * version floor still alerts even when the AI pass is unavailable. Non-breaking
 * (info/warn) guards no longer surface.
 */
export function minVersionFindings(ccVersion: string, manifest: ManifestEntry[]): SentinelFinding[] {
  return manifest
    .filter((e) => e.severity === 'high' && e.minCcVersion && compareSemver(ccVersion, e.minCcVersion) < 0)
    .map((e) => ({
      id: `minver:${e.id}`,
      kind: 'compat' as const,
      severity: e.severity,
      title: `Claude Code ${ccVersion} is older than CCC requires for: ${e.area}`,
      evidence: `${e.contract} (needs CC >= ${e.minCcVersion})`,
      affectedFeature: e.affectedFeature,
      badgeText: `Needs Claude Code ${e.minCcVersion}+ — currently ${ccVersion}`,
      status: 'open' as const,
      createdAt: Date.now(),
    }))
}
