import pricingData from '../../../../resources/codex-pricing.json'

interface ModelPricing {
  inputPer1M: number
  cachedInputPer1M: number | null
  outputPer1M: number
}

const pricing = (pricingData as { models: Record<string, ModelPricing> }).models
const warnedModels = new Set<string>()

// -- Live prices (P3.8, row 28) --
//
// Claude's prices come from the LiteLLM price list with the registry as the
// fallback (tokenomics/tk-pricing.ts); Codex's come from the same list, with
// resources/codex-pricing.json as the fallback, and a model neither prices
// reads "no price" (MP11). tk-pricing fetches the list and hands the OpenAI
// part here. The list is untrusted network input (and its saved copy a local
// file): only an OpenAI chat or responses model, with a plain id and finite,
// bounded, non-negative prices, is taken, and a model is looked up by its
// exact id only.

/** A Codex model id as it may be priced: letters, digits, `.`, `_`, `:`, `-`,
 *  starting with a letter or digit (no path, no space, no control character). */
const PRICED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
/** No real price is anywhere near this ($100,000 per 1M tokens): above it an
 *  entry is taken to be garbage, not a price. */
const MAX_PER_1M = 100_000
/** The most live prices kept (the whole list holds a few hundred OpenAI models). */
export const MAX_LIVE_CODEX_PRICES = 2000

let live: Map<string, ModelPricing> = new Map()

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const usablePer1M = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_PER_1M

/**
 * The OpenAI models of a LiteLLM price list (model_prices_and_context_window.json),
 * per 1M tokens. An `openai/`-prefixed key names the same model as its bare id;
 * the bare entry wins. A missing or unusable cached rate is no cached tier.
 */
export function parseLiteLlmOpenAiPricing(all: unknown): Map<string, ModelPricing> {
  const out = new Map<string, ModelPricing>()
  if (!isRecord(all)) return out
  const bare = new Set<string>()
  for (const key of Object.keys(all)) {
    const val = all[key]
    if (!isRecord(val) || val.litellm_provider !== 'openai') continue
    if (val.mode !== 'chat' && val.mode !== 'responses') continue
    const prefixed = key.startsWith('openai/')
    const id = prefixed ? key.slice('openai/'.length) : key
    if (!PRICED_ID_RE.test(id)) continue
    if (prefixed && bare.has(id)) continue
    if (out.size >= MAX_LIVE_CODEX_PRICES && !out.has(id)) continue
    const input = typeof val.input_cost_per_token === 'number' ? val.input_cost_per_token * 1e6 : NaN
    const output = typeof val.output_cost_per_token === 'number' ? val.output_cost_per_token * 1e6 : NaN
    if (!usablePer1M(input) || !usablePer1M(output) || (input === 0 && output === 0)) continue
    const cachedRaw = typeof val.cache_read_input_token_cost === 'number' ? val.cache_read_input_token_cost * 1e6 : NaN
    out.set(id, { inputPer1M: input, cachedInputPer1M: usablePer1M(cachedRaw) ? cachedRaw : null, outputPer1M: output })
    if (!prefixed) bare.add(id)
  }
  return out
}

/** The live prices as they are saved beside Claude's (tk-pricing's cache). */
export function serializeCodexPricing(map: ReadonlyMap<string, ModelPricing>): { models: Record<string, ModelPricing> } {
  const models: Record<string, ModelPricing> = {}
  for (const [id, p] of map) models[id] = { inputPer1M: p.inputPer1M, cachedInputPer1M: p.cachedInputPer1M, outputPer1M: p.outputPer1M }
  return { models }
}

/** The saved live prices read back, each entry checked as the list's are:
 *  anything that is not a usable price is dropped. */
export function parseCachedCodexPricing(saved: unknown): Map<string, ModelPricing> {
  const out = new Map<string, ModelPricing>()
  if (!isRecord(saved) || !isRecord(saved.models)) return out
  for (const id of Object.keys(saved.models)) {
    if (out.size >= MAX_LIVE_CODEX_PRICES) break
    const p = saved.models[id]
    if (!PRICED_ID_RE.test(id) || !isRecord(p)) continue
    if (!usablePer1M(p.inputPer1M) || !usablePer1M(p.outputPer1M)) continue
    if (p.cachedInputPer1M !== null && !usablePer1M(p.cachedInputPer1M)) continue
    out.set(id, { inputPer1M: p.inputPer1M, cachedInputPer1M: p.cachedInputPer1M as number | null, outputPer1M: p.outputPer1M })
  }
  return out
}

/** The live prices to use from now on (null: none, the table alone). */
export function setLiveCodexPricing(map: ReadonlyMap<string, ModelPricing> | null): void {
  live = new Map(map ?? [])
}

export function priceForModel(model: string): ModelPricing | null {
  if (typeof model !== 'string') return null
  const fromLive = live.get(model)
  if (fromLive) return fromLive
  return Object.prototype.hasOwnProperty.call(pricing, model) ? pricing[model] : null
}

/** Every priced model once: the live list's and the table's. */
export function codexPricingKeys(): string[] {
  return [...new Set([...live.keys(), ...Object.keys(pricing)])]
}

/** The rate cached input costs (usage track MP11: one rule for the session
 *  strip and Tokenomics): the model's cached tier, or its full input rate
 *  when it has none. */
export function codexCachedInputPer1M(p: { inputPer1M: number; cachedInputPer1M: number | null }): number {
  return p.cachedInputPer1M ?? p.inputPer1M
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
  const cachedCost = (cached / 1e6) * codexCachedInputPer1M(p)
  const outputCost = (tokens.outputTokens / 1e6) * p.outputPer1M
  return inputCost + cachedCost + outputCost
}
