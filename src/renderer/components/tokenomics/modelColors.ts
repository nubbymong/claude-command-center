// Model → colour / short-label helpers shared across tokenomics surfaces.
// Registry-backed (spec 2026-06-11 §4): family/colour comes from the model
// registry; unknown models get a deterministic hashed palette colour instead
// of vanishing into chart-other. Copper stays Opus-only via the registry.
import { resolveModelInfo, type ModelRegistry } from '../../../shared/model-registry'
import { useRegistryStore } from '../../stores/registryStore'

export function getModelColor(model: string, registry?: ModelRegistry): string {
  const reg = registry ?? useRegistryStore.getState().registry
  return resolveModelInfo(reg, model).colors.chart
}

// Claude families collapse to the family label for chart grouping; codex/GPT
// keep their OLD verbatim/slice forms — display reshaping is graceful-default
// code, not registry data (plan: v1 simplification 2).
export function getModelShort(model: string, registry?: ModelRegistry): string {
  const reg = registry ?? useRegistryStore.getState().registry
  const r = resolveModelInfo(reg, model)
  if (r.known && r.family === 'codex') return model.startsWith('gpt-') ? model.slice(4) : model
  if (r.known) return r.chartLabel
  return model
}
