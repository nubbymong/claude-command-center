// Sentinel model-registry check (#385).
//
// The owner's rule: the model/effort options we offer follow Anthropic's Claude
// Code model configuration support article, and the list must be GUARDED so a
// model Anthropic retired never stays selectable and a new one is not missed.
//
// This is the runtime half of that guard. The release-gate half
// (scripts/release-gate.mjs) refuses to cut a build whose registry disagrees;
// this one tells a user whose *installed* app has drifted — a registry shipped
// weeks ago against an article that has moved since.
//
// NO NETWORK. Every other Sentinel input that leaves the machine
// (sentinel-changelog) has to degrade to "analysis unavailable" when offline,
// and a check that silently stops running is not a guard. The comparison
// instead runs against resources/claude-code-model-configuration.json — a
// snapshot of the article's Supported models table, refreshed by hand at
// release time and enforced by the release gate. Its `fetchedAt` is what goes
// stale, so staleness itself is reported rather than hidden.
import { evaluateModelCoverage, type ModelRegistry, type ExpectedModelSet } from '../../shared/model-registry'
import type { SentinelFinding } from '../../shared/sentinel-types'
import expectedJson from '../../../resources/claude-code-model-configuration.json'

export const EXPECTED_MODEL_SET = expectedJson as unknown as ExpectedModelSet

/** How old the article snapshot may get before we say so. */
export const FIXTURE_STALE_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000

export function fixtureAgeDays(fetchedAt: string | undefined, now: number): number | null {
  if (!fetchedAt) return null
  const t = Date.parse(fetchedAt)
  if (!Number.isFinite(t)) return null
  return Math.floor((now - t) / DAY_MS)
}

/**
 * Compare the live (baseline + overlay) registry against the article snapshot.
 *
 * Pure — mirrors minVersionFindings(): the caller upserts. Finding ids are
 * stable and prefixed `models:` so a dismissed finding stays dismissed and a
 * repeat run never duplicates.
 *
 * Severities are deliberately not `high`: neither case breaks a running
 * session, and `high` is reserved for severe breaking changes (a `high` here
 * would light the alarm dot on every launch for a model the owner knowingly
 * carries). `warn` still surfaces in the panel.
 */
export function modelCoverageFindings(
  registry: ModelRegistry,
  expected: ExpectedModelSet | null | undefined,
  now: number = Date.now(),
): SentinelFinding[] {
  const out: SentinelFinding[] = []
  const source = expected?.source ?? 'the Claude Code model configuration article'
  const result = evaluateModelCoverage(registry, expected)

  // A torn/empty snapshot fails closed in evaluateModelCoverage. Report that
  // rather than a wall of "missing" findings for models we cannot verify.
  if (!result.ok && result.missing.length === 0) {
    out.push({
      id: 'models:fixture-unreadable',
      kind: 'compat',
      severity: 'warn',
      title: 'The Claude Code model list could not be verified',
      evidence: result.reason ?? 'the expected-models snapshot is empty or missing',
      badgeText: 'Model list unverified',
      status: 'open',
      createdAt: now,
    })
    return out
  }

  for (const m of result.missing) {
    out.push({
      id: `models:missing:${m.id}`,
      kind: 'compat',
      severity: 'warn',
      title: `Claude Code offers ${m.label ?? m.id}, but it is not in the model picker`,
      evidence: `${source} lists ${m.id}; resources/model-registry.json has no entry covering it.`,
      affectedFeature: 'sessions',
      badgeText: `New model: ${m.label ?? m.id}`,
      status: 'open',
      createdAt: now,
    })
  }

  for (const m of result.extra) {
    out.push({
      id: `models:retired:${m.id}`,
      kind: 'compat',
      severity: 'warn',
      title: `${m.label ?? m.id} is still selectable but Anthropic no longer lists it`,
      evidence: `resources/model-registry.json carries ${m.id}; ${source} does not list it — retired or renamed?`,
      affectedFeature: 'sessions',
      badgeText: `Possibly retired: ${m.label ?? m.id}`,
      status: 'open',
      createdAt: now,
    })
  }

  const age = fixtureAgeDays(expected?.fetchedAt, now)
  if (age !== null && age > FIXTURE_STALE_DAYS) {
    out.push({
      id: `models:fixture-stale:${expected?.fetchedAt}`,
      kind: 'info',
      severity: 'info',
      title: 'The published model list has not been re-checked in a while',
      evidence: `resources/claude-code-model-configuration.json was fetched ${age} days ago (${expected?.fetchedAt}). Re-read ${source} and refresh it.`,
      status: 'open',
      createdAt: now,
    })
  }

  return out
}
