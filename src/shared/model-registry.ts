// Model/effort registry — single source of truth for model identity (spec:
// docs/superpowers/specs/2026-06-11-ccc-sentinel-design.md §4). Pure data +
// pure functions only: both processes hold their own snapshot (main
// authoritative, renderer hydrated via IPC). No Node imports here.

export interface ModelPricingSpec { input: number; output: number; cacheRead: number; cacheWrite: number }

export interface FamilySpec {
  label: string                              // short chart form ("opus")
  color: string                              // default colour token/hex
  colorOverrides?: Record<string, string>    // per-surface, e.g. { agentPill: 'var(--status-success)' }
}

export interface ModelEntry {
  id: string                                 // REQUIRED canonical model id — merge/reconcile key
  patterns: string[]                         // matched (case-insensitive substring-or-regex) against raw model ids
  aliases?: string[]                         // exact CLI alias values ('opus', 'opus[1m]')
  family: string                             // must exist in families{}
  label: string                              // pretty per-model label ("Opus 4.8")
  color?: string                             // optional per-model override of families[family].color
  efforts?: string[]
  fallbackPricing?: ModelPricingSpec
  /** false = never offer this entry as a pinned model-picker row (#385). For
   *  catch-all entries whose `id` is not a launchable model id (`codex-family`).
   *  Absent means pickable, so a Sentinel/user overlay entry shows up in both
   *  pickers with no code change. */
  pickable?: boolean
  /** true = we carry this model deliberately even though Anthropic's Claude Code
   *  model-configuration article does not list it, so neither the release gate
   *  nor the Sentinel check reports it as possibly-retired (#385). */
  articleExempt?: boolean
}

export interface OverlayProvenance {
  addedBy: 'sentinel' | 'user'
  date: string
  ccVersion?: string
  cccVersion?: string
  reason?: string
}
export interface OverlayModelEntry extends ModelEntry { provenance: OverlayProvenance }

export interface EffortLevelSpec { value: string; label: string; hint?: string }
export interface DropdownOptionSpec { value: string; label: string; hint?: string }

export interface ModelRegistry {
  models: ModelEntry[]
  families: Record<string, FamilySpec>
  effortLevels: EffortLevelSpec[]
  /** Ordered ALIAS rows ("Opus 1M" → 'opus[1m]'). These are the family aliases
   *  that always follow the newest model; the pinned per-version rows are
   *  DERIVED from `models` by buildModelPickerRows() (#385) so a Sentinel or
   *  user overlay entry reaches both pickers without a code change. */
  dropdown: DropdownOptionSpec[]
}

export interface RegistryOverlay {
  models?: OverlayModelEntry[]
  families?: Record<string, FamilySpec>
}

/**
 * Merge an overlay (sentinel/user additions) into the static baseline registry.
 * Merged snapshots are READ-ONLY: nested arrays/objects alias the static baseline
 * import; mutating a snapshot would corrupt the baseline for all later merges.
 */
export function mergeRegistry(baseline: ModelRegistry, overlay: RegistryOverlay | null): ModelRegistry {
  if (!overlay) return { ...baseline, models: [...baseline.models], families: { ...baseline.families } }
  const byId = new Map<string, ModelEntry>(baseline.models.map((m) => [m.id, m]))
  for (const o of overlay.models ?? []) byId.set(o.id, o)
  return {
    ...baseline,
    models: [...byId.values()],
    families: { ...baseline.families, ...(overlay.families ?? {}) },
  }
}

export interface ReconcileResult {
  overlay: RegistryOverlay                   // overlay after auto-retire
  autoRetired: OverlayModelEntry[]           // sentinel entries the new baseline now covers
  retireProposals: OverlayModelEntry[]       // user entries the new baseline now covers (never auto-removed)
}

/**
 * First launch after a CCC update: a new baseline "rectifies" overlay entries it now covers (spec §4).
 * Callers must pass a loaded (possibly-empty) overlay, never null.
 */
export function reconcileOverlay(baseline: ModelRegistry, overlay: RegistryOverlay): ReconcileResult {
  const baseIds = new Set(baseline.models.map((m) => m.id))
  const kept: OverlayModelEntry[] = []
  const autoRetired: OverlayModelEntry[] = []
  const retireProposals: OverlayModelEntry[] = []
  for (const o of overlay.models ?? []) {
    if (!baseIds.has(o.id)) { kept.push(o); continue }
    if (o.provenance.addedBy === 'sentinel') autoRetired.push(o)
    else { kept.push(o); retireProposals.push(o) }
  }
  return { overlay: { ...overlay, models: kept }, autoRetired, retireProposals }
}

// ── Resolution ──

export interface ResolvedModelInfo {
  known: boolean
  id: string                                 // matched entry id, or the raw input when unknown
  family: string | null
  label: string                              // entry label, or verbatim input when unknown
  chartLabel: string                         // families[family].label, or verbatim input
  /** HOW the entry matched. exact/alias/prefix are version-faithful (safe to
   *  show the entry's versioned label); pattern is a fuzzy family catch-all
   *  (an old claude-opus-4-5 hits the "opus" pattern on the 4.8 entry — its
   *  label would claim the wrong version). null when unknown. */
  matchKind: ModelMatchKind | null
  colors: { default: string; chart: string; agentPill: string }
  efforts: string[] | null                   // null = unknown → callers assume all valid (spec §3)
  fallbackPricing?: ModelPricingSpec
}

// Dedicated unknown-model palette (spec §3): hex hues distinct from the 5 chart
// tokens — copper stays Opus-only (modelColors.ts:4-5). Hash pattern mirrors
// identity-colors.ts (stable key, deterministic pick).
const UNKNOWN_MODEL_PALETTE = ['#9a8cf0', '#3ba8d4', '#34b39a', '#9bbf4e', '#e8794a', '#ef5f7e'] as const

export function hashUnknownModelColor(modelId: string): string {
  let h = 0
  for (let i = 0; i < modelId.length; i++) h = (h * 31 + modelId.charCodeAt(i)) >>> 0
  return UNKNOWN_MODEL_PALETTE[h % UNKNOWN_MODEL_PALETTE.length]
}

export type ModelMatchKind = 'exact' | 'alias' | 'prefix' | 'pattern'

function matchEntry(
  registry: ModelRegistry,
  modelId: string,
): { entry: ModelEntry; kind: ModelMatchKind } | null {
  const raw = modelId.trim()
  if (!raw) return null
  // 1. exact id
  const exact = registry.models.find((m) => m.id === raw)
  if (exact) return { entry: exact, kind: 'exact' }
  // 2. exact alias (CLI alias values like 'opus', 'opus[1m]')
  const alias = registry.models.find((m) => m.aliases?.includes(raw))
  if (alias) return { entry: alias, kind: 'alias' }
  // 3. longest id-prefix (date-suffixed ids: claude-opus-4-7-20260101)
  let prefix: ModelEntry | null = null
  for (const m of registry.models) {
    if (raw.startsWith(m.id) && (!prefix || m.id.length > prefix.id.length)) prefix = m
  }
  if (prefix) return { entry: prefix, kind: 'prefix' }
  // 4. first pattern match in registry order (substring unless anchored regex)
  const lower = raw.toLowerCase()
  for (const m of registry.models) {
    for (const p of m.patterns) {
      let hit = false
      try {
        hit = p.startsWith('^') || p.endsWith('$')
          ? new RegExp(p, 'i').test(lower)
          : lower.includes(p.toLowerCase())
      } catch { /* malformed pattern in a hand-edited overlay: skip, never crash a render */ }
      if (hit) return { entry: m, kind: 'pattern' }
    }
  }
  return null
}

export function resolveModelInfo(registry: ModelRegistry, modelId: string): ResolvedModelInfo {
  const match = matchEntry(registry, modelId)
  if (!match) {
    const hashed = hashUnknownModelColor(modelId)
    return {
      known: false, id: modelId, family: null, label: modelId, chartLabel: modelId,
      matchKind: null,
      colors: { default: hashed, chart: hashed, agentPill: hashed },
      efforts: null,
    }
  }
  const entry = match.entry
  const fam = registry.families[entry.family]
  const base = entry.color ?? fam?.color ?? hashUnknownModelColor(modelId)
  const colors = {
    default: base,
    chart: fam?.colorOverrides?.chart ?? base,
    agentPill: fam?.colorOverrides?.agentPill ?? base,
  }
  return {
    known: true, id: entry.id, family: entry.family, label: entry.label,
    chartLabel: fam?.label ?? entry.family, matchKind: match.kind, colors,
    efforts: entry.efforts ?? null, fallbackPricing: entry.fallbackPricing,
  }
}

// ── Model-picker rows (#385) ────────────────────────────────────────
//
// The pickers used to render `dropdown` verbatim, so only the five family
// aliases were ever offered and a pinned version (Opus 4.6) could not be chosen
// even though the registry knew it. Rows are now built as:
//
//   1. the curated ALIAS rows from `dropdown`, first, under one "Latest" group
//      ("Opus" -> always the newest Opus), then
//   2. PINNED rows derived from `models`, grouped under their family
//      ("Opus 4.6" -> 'claude-opus-4-6').
//
// Deriving (2) from `models` is what makes a Sentinel/user overlay entry
// selectable with no code change: mergeRegistry() puts it in `models`, and it
// appears in both pickers on the next render.

export type ModelPickerRowKind = 'alias' | 'pinned'

export interface ModelPickerRow {
  value: string                              // the exact string handed to `--model` / `/model`
  label: string
  hint?: string
  group: string                              // 'Latest' for alias rows, else the family display label
  kind: ModelPickerRowKind
  family?: string                            // pinned rows only
}

export const ALIAS_GROUP_LABEL = 'Latest'

/** Family display label ("opus" -> "Opus"), falling back to the family key. */
export function familyDisplayLabel(registry: ModelRegistry, family: string): string {
  const raw = registry.families?.[family]?.label ?? family
  if (typeof raw !== 'string' || !raw) return 'Other'
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

/**
 * A model label/reading reduced to a comparable form: trailing parentheticals
 * dropped ("Opus 4.7 (1M context)" -> "opus 4.7"), trimmed, lowercased.
 */
export function normalizeModelLabel(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase()
}

/**
 * The registry id a set of readings refers to, or undefined when none of them
 * can be placed on a specific entry.
 *
 * Callers pass the readings they have in preference order — typically the live
 * statusline `display_name` first, then the id the session was spawned with.
 * A reading is accepted when it matches an entry VERSION-faithfully (exact id /
 * alias / id-prefix) or when it is exactly an entry's label: the statusline
 * reports "Opus 4.6", which can only ever `pattern`-match and is therefore
 * distrusted everywhere else, but as a label it names its entry precisely.
 * That is what keeps per-model effort gating working after a mid-session
 * /model change, when the spawn-time id has gone stale (review Q2).
 */
export function resolvePickedModelId(
  registry: ModelRegistry,
  ...readings: (string | null | undefined)[]
): string | undefined {
  for (const reading of readings) {
    if (!reading) continue
    const info = resolveModelInfo(registry, reading)
    if (info.known && info.matchKind !== 'pattern') return info.id
    const norm = normalizeModelLabel(reading)
    const byLabel = (registry.models ?? []).find(
      (m) => typeof m.label === 'string' && normalizeModelLabel(m.label) === norm,
    )
    if (byLabel) return byLabel.id
  }
  return undefined
}

/**
 * Ordered picker rows: alias rows first, then pinned versions grouped by family.
 *
 * Family order follows the alias rows (so the Opus pins sit under the Opus
 * alias), with any family that has no alias row appended in `models` order.
 * Within a family, pins keep `models` order (newest first by convention).
 * Entries with `pickable === false` are skipped: their `id` is a matcher, not a
 * launchable model.
 */
export function buildModelPickerRows(registry: ModelRegistry): ModelPickerRow[] {
  const aliasRows: ModelPickerRow[] = (registry.dropdown ?? []).map((d) => ({
    value: d.value, label: d.label, hint: d.hint, group: ALIAS_GROUP_LABEL, kind: 'alias' as const,
  }))

  // Never offer the same string twice: an alias row wins over an identical pin.
  const seen = new Set(aliasRows.map((r) => r.value))

  const pinsByFamily = new Map<string, ModelPickerRow[]>()
  for (const m of registry.models ?? []) {
    if (!m || m.pickable === false) continue
    // `registry-overlay.json` is a hand-editable user file: loadOverlay only
    // fails open on invalid JSON and validateProposal runs on APPLY, not on
    // load, so a malformed entry reaches here intact. Before #385 the pickers
    // read `dropdown` only and never touched `models`, so a missing `family`
    // was harmless; now it would throw and take both pickers down with it.
    // Skip the entry and say so rather than crash the render (review Q3).
    if (typeof m.id !== 'string' || !m.id || typeof m.family !== 'string' || !m.family) {
      // eslint-disable-next-line no-console
      console.warn('[model-registry] skipping malformed model entry (needs a string id and family):', m)
      continue
    }
    if (seen.has(m.id)) continue
    seen.add(m.id)
    const row: ModelPickerRow = {
      value: m.id,
      label: m.label || m.id,
      group: familyDisplayLabel(registry, m.family),
      kind: 'pinned',
      family: m.family,
    }
    const list = pinsByFamily.get(m.family)
    if (list) list.push(row)
    else pinsByFamily.set(m.family, [row])
  }

  const familyOrder: string[] = []
  const pushFamily = (f: string | null | undefined): void => {
    if (f && pinsByFamily.has(f) && !familyOrder.includes(f)) familyOrder.push(f)
  }
  for (const row of aliasRows) pushFamily(resolveModelInfo(registry, row.value).family)
  for (const f of pinsByFamily.keys()) pushFamily(f)

  const pinned: ModelPickerRow[] = []
  for (const f of familyOrder) pinned.push(...(pinsByFamily.get(f) ?? []))
  return [...aliasRows, ...pinned]
}

/** Group consecutive rows into ordered { title, rows } sections for a popover. */
export function groupPickerRows(rows: ModelPickerRow[]): { title: string; rows: ModelPickerRow[] }[] {
  const out: { title: string; rows: ModelPickerRow[] }[] = []
  for (const row of rows) {
    const last = out[out.length - 1]
    if (last && last.title === row.group) last.rows.push(row)
    else out.push({ title: row.group, rows: [row] })
  }
  return out
}

export interface EffortRow { value: string; label: string; hint?: string; supported: boolean }

/**
 * Effort levels for a model, each marked `supported`.
 *
 * A model's `efforts` list is only trusted when the registry matched the model
 * VERSION-faithfully (exact id / alias / id-prefix). A `pattern` hit is the
 * fuzzy family catch-all -- a statusline reading of "Opus 4.6" pattern-matches
 * the newest Opus entry, whose effort list may differ -- so those, and unknown
 * models, fall back to "all supported" (spec §3: null efforts = assume valid).
 * Unsupported levels are DISABLED by callers rather than hidden, so the list
 * never silently changes shape under the user.
 */
export function buildEffortRows(
  registry: ModelRegistry,
  modelId: string | undefined | null,
): EffortRow[] {
  const levels = registry.effortLevels ?? []
  const info = modelId ? resolveModelInfo(registry, modelId) : null
  const trustworthy = !!info && info.known && info.matchKind !== 'pattern'
  const allowed = trustworthy && info!.efforts ? new Set(info!.efforts) : null
  return levels.map((l) => ({
    value: l.value, label: l.label, hint: l.hint,
    supported: allowed ? allowed.has(l.value) : true,
  }))
}

// ── Model coverage vs. the published Claude Code model configuration (#385) ──
//
// Anthropic's Claude Code model configuration support article is the reference
// for the model options we offer (owner, #385).
// `resources/claude-code-model-configuration.json` is a hand-refreshed snapshot
// of its Supported models table, and this comparison runs in TWO places so the
// registry cannot quietly drift from it:
//   - the Sentinel check (src/main/sentinel/sentinel-models.ts), at runtime, and
//   - the release gate (scripts/release-gate.mjs), which refuses the cut.
// The gate is dependency-free ESM that runs before `npm ci`, so it carries its
// own copy of this logic; tests/unit/model-coverage-parity.test.ts asserts the
// two implementations agree on every fixture.

export interface ExpectedModelSpec { id: string; label?: string }
export interface ExpectedModelSet {
  source?: string
  fetchedAt?: string                         // ISO date the article was last read
  models: ExpectedModelSpec[]
}

export interface ModelCoverageResult {
  ok: boolean
  reason: string | null
  missing: ExpectedModelSpec[]               // article lists it, the registry does not
  extra: ExpectedModelSpec[]                 // registry carries it, the article does not (retired/renamed?)
  covered: { id: string; by: string }[]
}

/** True for an entry that came from the overlay (Sentinel- or user-added). */
export function isOverlaySourced(entry: ModelEntry): boolean {
  return !!(entry as Partial<OverlayModelEntry>).provenance
}

/** An article id is covered by a registry id when equal, or equal minus a -YYYYMMDD suffix. */
export function registryIdCovers(registryId: string, expectedId: string): boolean {
  if (registryId === expectedId) return true
  const m = /^(.*)-(\d{8})$/.exec(expectedId)
  return !!m && m[1] === registryId
}

/**
 * Compare the registry against the article snapshot.
 *
 * Fails closed on an empty/missing expected set: a check that passes because it
 * had nothing to compare is worse than no check.
 */
export function evaluateModelCoverage(
  registry: ModelRegistry,
  expected: ExpectedModelSet | null | undefined,
): ModelCoverageResult {
  const registryModels = registry?.models ?? []
  const expectedModels = expected?.models ?? []
  if (expectedModels.length === 0) {
    return {
      ok: false,
      reason: 'the expected-models fixture is empty or missing — cannot verify the registry (fail closed)',
      missing: [], extra: [], covered: [],
    }
  }
  const missing: ExpectedModelSpec[] = []
  const covered: { id: string; by: string }[] = []
  const usedRegistryIds = new Set<string>()
  for (const exp of expectedModels) {
    const hit = registryModels.find((m) => registryIdCovers(m.id, exp.id))
    if (hit) { covered.push({ id: exp.id, by: hit.id }); usedRegistryIds.add(hit.id) }
    else missing.push({ id: exp.id, label: exp.label })
  }
  // Claude models we carry that the article no longer names. Excluded:
  //  - non-Claude entries (the codex catch-all) — not the article's business
  //  - `articleExempt` entries — carried deliberately
  //  - OVERLAY entries (they carry `provenance`) — a model Sentinel or the user
  //    just added is necessarily absent from a snapshot frozen before it, and
  //    reporting it as "possibly retired" the moment it is added contradicts
  //    the whole point of letting an overlay add one (review Q4).
  const extra = registryModels
    .filter((m) => typeof m.id === 'string' && m.id.startsWith('claude-')
      && !usedRegistryIds.has(m.id) && m.articleExempt !== true && !isOverlaySourced(m))
    .map((m) => ({ id: m.id, label: m.label }))
  return {
    ok: missing.length === 0,
    reason: missing.length === 0
      ? null
      : `${missing.length} model(s) from the Claude Code model configuration article are not in the registry`,
    missing, extra, covered,
  }
}
