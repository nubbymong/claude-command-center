// Model → colour / short-label helpers shared across tokenomics surfaces.
// Registry-backed (spec 2026-06-11 §4): family/colour comes from the model
// registry; unknown models get a deterministic hashed palette colour instead
// of vanishing into chart-other. Copper stays Opus-only via the registry.
//
// getState() here is non-reactive BY DESIGN: a registry hot-reload (rare,
// user-initiated Sentinel apply) repaints on the next tokenomics data render
// rather than immediately. Cosmetic-only staleness; do not "fix" with hooks.
import { resolveModelInfo, type ModelRegistry } from '../../../shared/model-registry'
import { useRegistryStore } from '../../stores/registryStore'

export function getModelColor(model: string, registry?: ModelRegistry): string {
  const reg = registry ?? useRegistryStore.getState().registry
  return resolveModelInfo(reg, model).colors.chart
}

// Claude models keep their VERSIONED registry label ("Opus 4.8", "Opus 4.7"):
// the split rows are per model id, so the old family chartLabel ("opus")
// produced several identically-named categories — user report 2026-06-12.
// ONLY version-faithful matches (exact id / alias / id-prefix) get the entry
// label; a fuzzy PATTERN hit falls back to the family label, because an old
// claude-opus-4-5 matches the catch-all "opus" pattern on the 4.8 entry and
// would otherwise claim the wrong version. Colour still collapses to the
// family (all opus = copper). codex/GPT keep their OLD verbatim/slice forms.
export function getModelShort(model: string, registry?: ModelRegistry): string {
  // Claude Code writes the literal id "<synthetic>" on CLI-fabricated
  // transcript messages (errors, interruptions) — not a real model, never
  // show it raw (user report 2026-06-13).
  if (model === '<synthetic>') return 'System'
  const reg = registry ?? useRegistryStore.getState().registry
  const r = resolveModelInfo(reg, model)
  if (r.known && r.family === 'codex') return model.startsWith('gpt-') ? model.slice(4) : model
  if (r.known) return r.matchKind === 'pattern' ? r.chartLabel : r.label
  return model
}
