// Sentinel model-registry check (#385).
//
// The owner's rule: the model options we offer follow Anthropic's Claude Code
// model configuration support article, and the list must be GUARDED so a model
// Anthropic retired never stays selectable and a new one is not missed.
//
// This is the runtime half. The release-gate half (scripts/release-gate.mjs)
// refuses to cut a build whose registry disagrees with the shipped snapshot;
// this one watches an INSTALLED build, where the article can move underneath a
// registry that is frozen in the package.
//
// Two modes, because the snapshot alone cannot answer the owner's question
// (review S1). The snapshot and the registry ship together and the gate
// guarantees the registry covers it at cut time, so "Anthropic added a model"
// is empty by construction from the snapshot. That arm therefore reads the LIVE
// article when the network allows:
//
//   live      article fetched and parsed -> "Anthropic lists X, we don't offer it"
//   snapshot  offline/unreadable         -> compare against the frozen snapshot
//             and let the staleness note carry the uncertainty
//
// Every finding says which mode produced it, so a user is never shown a claim
// about "currently" that came from a file baked in months ago.
//
// The RETIRED arm always uses the snapshot: it is human-verified, whereas a
// thin HTML parse that silently stops matching would otherwise accuse every
// model we ship of having been retired.
import { evaluateModelCoverage, evaluateCodexModelCoverage, type ModelRegistry, type ExpectedModelSet } from '../../shared/model-registry'
import type { SentinelFinding } from '../../shared/sentinel-types'
import expectedJson from '../../../resources/claude-code-model-configuration.json'
import codexExpectedJson from '../../../resources/codex-model-catalogue.json'

export const EXPECTED_MODEL_SET = expectedJson as unknown as ExpectedModelSet

/** The models the supported Codex CLI lists in its own model picker, shipped
 *  with this build (P3.8, row 39): the Codex half's reference, as the article
 *  snapshot is the Claude half's. `cliVersions` names the CLIs it was read from. */
export type CodexExpectedModelSet = ExpectedModelSet & { cliVersions?: string[] }
export const CODEX_EXPECTED_MODEL_SET = codexExpectedJson as unknown as CodexExpectedModelSet

/** How old the article snapshot may get before we say so. */
export const FIXTURE_STALE_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000

export type CoverageMode = 'live' | 'snapshot'

export function fixtureAgeDays(fetchedAt: string | undefined, now: number): number | null {
  if (!fetchedAt) return null
  const t = Date.parse(fetchedAt)
  if (!Number.isFinite(t)) return null
  return Math.floor((now - t) / DAY_MS)
}

/**
 * Compare the live (baseline + overlay) registry against what the article
 * offers.
 *
 * Pure — mirrors minVersionFindings(): the caller fetches and upserts. Finding
 * ids are stable and prefixed `models:` so a dismissed finding stays dismissed
 * and a repeat run never duplicates.
 *
 * @param liveIds ids read from the article just now, or null when it could not
 *                be read (offline). Null selects snapshot mode.
 *
 * Severities are deliberately not `high`: neither arm breaks a running session,
 * and `high` would light the alarm dot on every launch for a model the owner
 * knowingly carries. `warn` still surfaces in the panel.
 */
export function modelCoverageFindings(
  registry: ModelRegistry,
  expected: ExpectedModelSet | null | undefined,
  now: number = Date.now(),
  liveIds: string[] | null = null,
): SentinelFinding[] {
  const out: SentinelFinding[] = []
  const source = expected?.source ?? 'the Claude Code model configuration article'
  const snapshotResult = evaluateModelCoverage(registry, expected)

  // A torn/empty snapshot fails closed in evaluateModelCoverage. Report that
  // rather than a wall of "missing" findings for models we cannot verify.
  if (!snapshotResult.ok && snapshotResult.missing.length === 0) {
    out.push({
      id: 'models:fixture-unreadable',
      kind: 'compat',
      severity: 'warn',
      title: 'The Claude Code model list could not be verified',
      evidence: snapshotResult.reason ?? 'the expected-models snapshot is empty or missing',
      badgeText: 'Model list unverified',
      status: 'open',
      createdAt: now,
    })
    return out
  }

  // ── "Anthropic offers it, we don't" — live when we could read the article.
  const mode: CoverageMode = liveIds && liveIds.length ? 'live' : 'snapshot'
  const addedResult = mode === 'live'
    ? evaluateModelCoverage(registry, { ...expected, models: liveIds!.map((id) => ({ id })) })
    : snapshotResult
  const provenance = mode === 'live'
    ? `read from ${source} just now`
    : `from the model list shipped with this build (${expected?.fetchedAt ?? 'undated'}) — the article could not be read`

  for (const m of addedResult.missing) {
    out.push({
      id: `models:missing:${m.id}`,
      kind: 'compat',
      severity: 'warn',
      title: `Claude Code offers ${m.label ?? m.id}, but it is not in the model picker`,
      evidence: `${m.id} is listed by the Claude Code model configuration (${provenance}); resources/model-registry.json has no entry covering it.`,
      affectedFeature: 'sessions',
      badgeText: `New model: ${m.label ?? m.id}`,
      status: 'open',
      createdAt: now,
    })
  }

  // ── "We offer it, the article doesn't" — always the human-verified snapshot.
  for (const m of snapshotResult.extra) {
    out.push({
      id: `models:retired:${m.id}`,
      kind: 'compat',
      severity: 'warn',
      title: `${m.label ?? m.id} is still selectable but Anthropic no longer lists it`,
      evidence: `resources/model-registry.json carries ${m.id}; the model list shipped with this build (${expected?.fetchedAt ?? 'undated'}) does not — retired or renamed?`,
      affectedFeature: 'sessions',
      badgeText: `Possibly retired: ${m.label ?? m.id}`,
      status: 'open',
      createdAt: now,
    })
  }

  // ── The snapshot itself going stale. Only meaningful when we had to rely on
  //    it: a successful live read has just answered the question first-hand.
  const age = fixtureAgeDays(expected?.fetchedAt, now)
  if (mode === 'snapshot' && age !== null && age > FIXTURE_STALE_DAYS) {
    out.push({
      id: `models:fixture-stale:${expected?.fetchedAt}`,
      kind: 'info',
      severity: 'info',
      title: 'The published model list has not been re-checked in a while',
      evidence: `resources/claude-code-model-configuration.json was fetched ${age} days ago (${expected?.fetchedAt}), and the live article could not be read to confirm it. Re-read ${source} and refresh it.`,
      status: 'open',
      createdAt: now,
    })
  }

  return out
}

/**
 * The Codex half (P3.8, row 39): the registry's Codex models against the list
 * the supported Codex CLI offers, shipped with this build. Pure, as
 * modelCoverageFindings; finding ids are stable and prefixed `models:codex-`.
 *
 * Snapshot only: the build carries the one reference there is (the CLI's own
 * catalogue, read from the supported versions), so every finding names that
 * list and its date, and a list older than FIXTURE_STALE_DAYS says so.
 */
export function codexModelCoverageFindings(
  registry: ModelRegistry,
  expected: CodexExpectedModelSet | null | undefined,
  now: number = Date.now(),
): SentinelFinding[] {
  const out: SentinelFinding[] = []
  const result = evaluateCodexModelCoverage(registry, expected)
  if (!result.ok && result.missing.length === 0) {
    out.push({
      id: 'models:codex-list-unreadable',
      kind: 'compat',
      severity: 'warn',
      title: 'The Codex model list could not be verified',
      evidence: result.reason ?? 'the Codex model list is empty or missing',
      badgeText: 'Codex model list unverified',
      status: 'open',
      createdAt: now,
    })
    return out
  }
  const versions = Array.isArray(expected?.cliVersions) && expected!.cliVersions.length ? `Codex ${expected!.cliVersions.join(' and ')}, ` : ''
  const shipped = `the Codex model list shipped with this build (${versions}${expected?.fetchedAt ?? 'undated'})`
  for (const m of result.missing) {
    const name = m.label ?? m.id
    out.push({
      id: `models:codex-missing:${m.id}`,
      kind: 'compat',
      severity: 'warn',
      title: `Codex offers ${name}, but it is not in the model picker`,
      evidence: `${m.id} is in ${shipped}; resources/model-registry.json has no Codex entry for it.`,
      affectedFeature: 'sessions',
      badgeText: `New Codex model: ${name}`,
      status: 'open',
      createdAt: now,
    })
  }
  for (const m of result.extra) {
    const name = m.label ?? m.id
    out.push({
      id: `models:codex-retired:${m.id}`,
      kind: 'compat',
      severity: 'warn',
      title: `${name} is still selectable but Codex no longer lists it`,
      evidence: `resources/model-registry.json carries ${m.id} as a Codex model; ${shipped} does not. Retired or renamed?`,
      affectedFeature: 'sessions',
      badgeText: `Possibly retired: ${name}`,
      status: 'open',
      createdAt: now,
    })
  }
  const age = fixtureAgeDays(expected?.fetchedAt, now)
  if (age !== null && age > FIXTURE_STALE_DAYS) {
    out.push({
      id: `models:codex-list-stale:${expected?.fetchedAt}`,
      kind: 'info',
      severity: 'info',
      title: 'The Codex model list has not been re-checked in a while',
      evidence: `resources/codex-model-catalogue.json was read ${age} days ago (${expected?.fetchedAt}). Read the model catalogue of the supported Codex CLI again and refresh it.`,
      status: 'open',
      createdAt: now,
    })
  }
  return out
}

/** The finding raised when the check itself throws, so it cannot fail silently. */
export function modelCheckFailedFinding(message: string, now: number = Date.now()): SentinelFinding {
  return {
    id: 'models:check-failed',
    kind: 'compat',
    severity: 'warn',
    title: 'The Claude Code model list could not be verified',
    evidence: `The model-registry check did not complete: ${message}`,
    badgeText: 'Model list unverified',
    status: 'open',
    createdAt: now,
  }
}
