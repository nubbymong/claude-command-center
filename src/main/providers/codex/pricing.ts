import pricingData from '../../../../resources/codex-pricing.json'

interface ModelPricing {
  inputPer1M: number
  cachedInputPer1M: number | null
  outputPer1M: number
}

const pricing = (pricingData as { models: Record<string, ModelPricing> }).models
const warnedModels = new Set<string>()

export function priceForModel(model: string): ModelPricing | null {
  return pricing[model] ?? null
}

export function codexPricingKeys(): string[] {
  return Object.keys(pricing)
}

/** Codex usage semantics (verified against real rollouts: total_tokens ==
 *  input_tokens + output_tokens exactly, even with nonzero reasoning):
 *  `cached_input_tokens` is a SUBSET of `input_tokens`, and
 *  `reasoning_output_tokens` is a SUBSET of `output_tokens`. So cost splits
 *  input into uncached (full rate) + cached (cached rate, or full rate when the
 *  model has no cached tier), and charges output_tokens once — the old formula
 *  charged the cached portion twice and re-added reasoning on top of output. */
export function computeCodexCostUsd(
  model: string,
  tokens: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
): number | null {
  const p = priceForModel(model)
  if (!p) {
    if (!warnedModels.has(model)) {
      console.warn(`[codex/pricing] no pricing for model "${model}" -- cost will show as --`)
      warnedModels.add(model)
    }
    return null
  }
  const cached = Math.min(tokens.cachedInputTokens, tokens.inputTokens)
  const uncached = tokens.inputTokens - cached
  const inputCost = (uncached / 1e6) * p.inputPer1M
  const cachedCost = (cached / 1e6) * (p.cachedInputPer1M ?? p.inputPer1M)
  const outputCost = (tokens.outputTokens / 1e6) * p.outputPer1M
  return inputCost + cachedCost + outputCost
}
