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
  dropdown: DropdownOptionSpec[]             // ordered model-picker rows incl. variants ("Opus 1M" → 'opus[1m]')
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
