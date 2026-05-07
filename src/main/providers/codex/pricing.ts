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

export function computeCodexCostUsd(
  model: string,
  tokens: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number },
): number | null {
  const p = priceForModel(model)
  if (!p) {
    if (!warnedModels.has(model)) {
      console.warn(`[codex/pricing] no pricing for model "${model}" -- cost will show as --`)
      warnedModels.add(model)
    }
    return null
  }
  const inputCost = (tokens.inputTokens / 1e6) * p.inputPer1M
  const cachedCost = p.cachedInputPer1M != null ? (tokens.cachedInputTokens / 1e6) * p.cachedInputPer1M : 0
  const outputCost = ((tokens.outputTokens + tokens.reasoningOutputTokens) / 1e6) * p.outputPer1M
  return inputCost + cachedCost + outputCost
}
