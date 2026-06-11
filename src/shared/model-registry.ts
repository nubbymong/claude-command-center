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
