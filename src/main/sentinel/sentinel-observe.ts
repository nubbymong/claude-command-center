// Trigger A (spec §5): deterministic unknown-model/effort detector. Free, no
// AI. Drafts a registry-proposal finding awaiting user Apply (action level B).
import type { ModelRegistry, OverlayModelEntry } from '../../shared/model-registry'
import type { SentinelState } from './sentinel-state'

export interface Observation { kind: 'model' | 'effort'; value: string; source: string }

/** Family guess: 'claude-vision-2' -> 'vision'; else first id segment. */
export function guessFamily(modelId: string): string {
  const m = /^claude-([a-z]+)/i.exec(modelId)
  if (m) return m[1].toLowerCase()
  return modelId.split(/[-_ ]/)[0].toLowerCase() || 'unknown'
}

export function draftProposal(registry: ModelRegistry, modelId: string): OverlayModelEntry {
  const family = guessFamily(modelId)
  const familyKnown = !!registry.families[family]
  const sonnet = registry.models.find((m) => m.id === 'claude-sonnet-4-6')
  return {
    id: modelId,
    patterns: [modelId.toLowerCase()],
    family,
    label: modelId,                                          // verbatim until the user edits/AI refines
    // Pricing guess marked by provenance.reason; numbers = guessed family's
    // fallback else sonnet rates (spec §4) so tokenomics keeps costing.
    fallbackPricing: registry.models.find((m) => m.family === family && m.fallbackPricing)?.fallbackPricing
      ?? sonnet?.fallbackPricing,
    provenance: {
      addedBy: 'sentinel', date: new Date().toISOString().slice(0, 10),
      reason: `observed unknown model (pricing unverified${familyKnown ? '' : '; new family'})`,
    },
  }
}

export function makeObserver(state: SentinelState, getRegistry: () => ModelRegistry) {
  // Severe-breaking-only (spec 2026-07-04): unknown model / effort observations
  // are housekeeping, not breaking changes, so Sentinel no longer raises findings
  // for them. The registry overlay still auto-reconciles on CCC update
  // (reconcileOnUpdate); this observer is now a safe no-op kept for the Trigger A
  // call sites (effort-tracker / statusline-watcher). guessFamily/draftProposal
  // stay exported for the registry tooling.
  void state; void getRegistry
  return function observe(_obs: Observation): void { /* no-op: findings cut */ }
}
