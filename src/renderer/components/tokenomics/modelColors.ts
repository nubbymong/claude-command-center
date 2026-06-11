// Model → colour / short-label helpers shared across tokenomics surfaces
// (chart legend, donut, table cells, detail drawer).
//
// Chart series bound to semantic tokens (theme-aware). Spec section 5: copper =
// Opus ONLY, desaturated via --chart-opus so it does not dominate; never a status.
export function getModelColor(model: string): string {
  const m = model.toLowerCase()
  if (m.includes('fable')) return 'var(--chart-fable)'
  if (m.includes('opus')) return 'var(--chart-opus)'
  if (m.includes('sonnet')) return 'var(--chart-sonnet)'
  if (m.startsWith('gpt-') || m.includes('codex') || m.startsWith('o')) return 'var(--chart-codex)'
  return 'var(--chart-other)'   // haiku + unknown
}

/**
 * Short label for a model, used in compact UI surfaces (chart legend, table cells).
 *
 * Claude variants collapse to their family name (sonnet / opus / haiku) so the
 * model-breakdown chart can group all Claude versions visually. Codex / GPT
 * models drop the "gpt-" prefix to show just the version (e.g. "5.5"). Anything
 * else is returned verbatim.
 *
 * Bug fix on 2026-05-07 (Copilot review on PR #30): the prior implementation
 * stripped non-alpha characters then sliced the first 6 chars, which collapsed
 * every Claude variant to "claude" and lost Sonnet/Opus/Haiku categorization.
 */
export function getModelShort(model: string): string {
  const family = model.match(/sonnet|opus|haiku|fable/i)
  if (family) return family[0].toLowerCase()
  if (model.startsWith('gpt-')) return model.slice(4)
  return model
}
