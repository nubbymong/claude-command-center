// Validation gate for Apply (spec §7): schema checks + the hijack guard. AI and
// observed patches go through the SAME path — both fully untrusted. Apply itself
// delegates to model-registry-service.applyOverlayEntry (atomic write + hot
// reload) — this module only decides whether a proposal is safe.
import type { ModelRegistry, OverlayModelEntry } from '../../shared/model-registry'

const MAX_SANE_PER_1M_USD = 1000

// Mirrors matchEntry's contract: anchored patterns are regexes, everything else
// is a case-insensitive substring (regex specials inert there).
function patternHits(pattern: string, candidate: string): boolean {
  if (pattern.startsWith('^') || pattern.endsWith('$')) {
    return new RegExp(pattern, 'i').test(candidate.toLowerCase())
  }
  return candidate.toLowerCase().includes(pattern.toLowerCase())
}

export function validateProposal(registry: ModelRegistry, entry: OverlayModelEntry): { ok: boolean; error?: string } {
  if (!entry.id || !entry.label || !entry.family) return { ok: false, error: 'id, label, family are required' }
  if (registry.models.some((m) => m.id === entry.id)) {
    return { ok: false, error: `id "${entry.id}" already exists in the registry — edit/revert that entry instead` }
  }
  if (!entry.patterns?.length) return { ok: false, error: 'at least one pattern required' }
  for (const p of entry.patterns) {
    if (p.startsWith('^') || p.endsWith('$')) {
      try { new RegExp(p, 'i') } catch { return { ok: false, error: `anchored pattern does not compile: ${p}` } }
    }
  }
  const fp = entry.fallbackPricing
  if (fp) {
    if (!(fp.input > 0 && fp.output > 0 && fp.cacheRead >= 0 && fp.cacheWrite >= 0)) {
      return { ok: false, error: 'pricing must be positive (input/output) and non-negative (cache)' }
    }
    if (fp.input > MAX_SANE_PER_1M_USD || fp.output > MAX_SANE_PER_1M_USD) {
      return { ok: false, error: `pricing exceeds sanity bound ($${MAX_SANE_PER_1M_USD}/1M)` }
    }
  }
  if (entry.color && !/^(#[0-9a-fA-F]{6}|var\(--[\w-]+\))$/.test(entry.color)) {
    return { ok: false, error: 'colour must be #rrggbb or var(--token)' }
  }
  if (!registry.families[entry.family]) {
    return { ok: false, error: `family "${entry.family}" not in registry` }
  }
  // Hijack guard: would any pattern capture an id that already belongs to a
  // DIFFERENT known entry? Loud rejection instead of a quiet Apply (spec §7).
  for (const known of registry.models) {
    if (known.id === entry.id) continue
    for (const p of entry.patterns) {
      let hit = false
      try { hit = patternHits(p, known.id) } catch { /* unreachable: compile pre-checked */ }
      if (hit) return { ok: false, error: `pattern "${p}" re-matches already-known model ${known.id}` }
    }
  }
  return { ok: true }
}
