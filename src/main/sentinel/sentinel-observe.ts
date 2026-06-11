// Trigger A (spec §5): deterministic unknown-model/effort detector. Free, no
// AI. Drafts a registry-proposal finding awaiting user Apply (action level B).
import type { ModelRegistry, OverlayModelEntry } from '../../shared/model-registry'
import { resolveModelInfo } from '../../shared/model-registry'
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
  return function observe(obs: Observation): void {
    try {
      if (!obs.value || typeof obs.value !== 'string') return
      const registry = getRegistry()
      if (obs.kind === 'model') {
        if (resolveModelInfo(registry, obs.value).known) return
        state.upsertFinding({
          id: `obs:model:${obs.value}`, kind: 'registry-proposal', severity: 'warn',
          title: `Unknown model: ${obs.value}`,
          evidence: `Observed via ${obs.source}; not matched by the model registry.`,
          proposedPatch: draftProposal(registry, obs.value),
          status: 'open', createdAt: Date.now(),
        })
      } else {
        if (registry.effortLevels.some((l) => l.value === obs.value)) return
        state.upsertFinding({
          id: `obs:effort:${obs.value}`, kind: 'registry-proposal', severity: 'info',
          title: `Unknown effort level: ${obs.value}`,
          evidence: `Observed via ${obs.source}; not in the registry's effortLevels.`,
          status: 'open', createdAt: Date.now(),
        })
      }
    } catch { /* observation must never break the caller (fail-open) */ }
  }
}
