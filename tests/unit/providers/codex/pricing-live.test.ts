// P3.8 (row 28): Codex prices come from the live LiteLLM price list Claude's
// prices come from, as Claude's do; the static table is the fallback, and a
// model neither prices reads "no price" (null), as MP11 decided. The list is
// untrusted network input: only OpenAI chat and responses models with finite,
// bounded, non-negative prices and a plain model id are taken.
import { describe, it, expect, afterEach } from 'vitest'
import {
  parseLiteLlmOpenAiPricing,
  parseCachedCodexPricing,
  serializeCodexPricing,
  setLiveCodexPricing,
  priceForModel,
  codexPricingKeys,
  computeCodexCostUsd,
  MAX_LIVE_CODEX_PRICES,
} from '../../../../src/main/providers/codex/pricing'

afterEach(() => { setLiveCodexPricing(null) })

const per = (usdPer1M: number) => usdPer1M / 1e6

/** A LiteLLM-shaped price list (model_prices_and_context_window.json). */
function litellm(): Record<string, unknown> {
  return {
    sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0, litellm_provider: 'openai', mode: 'chat' },
    'gpt-5.5': { input_cost_per_token: per(5), output_cost_per_token: per(30), cache_read_input_token_cost: per(0.5), litellm_provider: 'openai', mode: 'chat' },
    'openai/gpt-5.5': { input_cost_per_token: per(99), output_cost_per_token: per(99), litellm_provider: 'openai', mode: 'chat' },
    'openai/gpt-5.2': { input_cost_per_token: per(9), output_cost_per_token: per(9), litellm_provider: 'openai', mode: 'chat' },
    'gpt-5.2': { input_cost_per_token: per(1.75), output_cost_per_token: per(14), cache_read_input_token_cost: per(0.175), litellm_provider: 'openai', mode: 'responses' },
    'openai/gpt-6-astra': { input_cost_per_token: per(10), output_cost_per_token: per(60), litellm_provider: 'openai', mode: 'responses' },
    'azure/gpt-5.5': { input_cost_per_token: per(1), output_cost_per_token: per(1), litellm_provider: 'azure', mode: 'chat' },
    'gpt-image-1': { input_cost_per_token: per(5), output_cost_per_token: per(40), litellm_provider: 'openai', mode: 'image_generation' },
    'text-embedding-3-large': { input_cost_per_token: per(0.13), output_cost_per_token: 0, litellm_provider: 'openai', mode: 'embedding' },
    'claude-opus-5': { input_cost_per_token: per(5), output_cost_per_token: per(25), litellm_provider: 'anthropic', mode: 'chat' },
    'gpt-negative': { input_cost_per_token: -1e-6, output_cost_per_token: per(1), litellm_provider: 'openai', mode: 'chat' },
    'gpt-string': { input_cost_per_token: '0.000005', output_cost_per_token: per(1), litellm_provider: 'openai', mode: 'chat' },
    'gpt-huge': { input_cost_per_token: 1, output_cost_per_token: per(1), litellm_provider: 'openai', mode: 'chat' },
    'gpt-free': { input_cost_per_token: 0, output_cost_per_token: 0, litellm_provider: 'openai', mode: 'chat' },
    'gpt-badcache': { input_cost_per_token: per(2), output_cost_per_token: per(8), cache_read_input_token_cost: 'x', litellm_provider: 'openai', mode: 'chat' },
    'gpt 5 spaced': { input_cost_per_token: per(1), output_cost_per_token: per(1), litellm_provider: 'openai', mode: 'chat' },
    'gpt-5\nx': { input_cost_per_token: per(1), output_cost_per_token: per(1), litellm_provider: 'openai', mode: 'chat' },
    'openai/nested/gpt': { input_cost_per_token: per(1), output_cost_per_token: per(1), litellm_provider: 'openai', mode: 'chat' },
    'gpt-array': [1, 2],
    'gpt-null': null,
  }
}

describe('parseLiteLlmOpenAiPricing', () => {
  it('takes OpenAI chat and responses models, per 1M tokens, an unprefixed entry over an openai/ one', () => {
    const m = parseLiteLlmOpenAiPricing(litellm())
    expect(m.get('gpt-5.5')).toEqual({ inputPer1M: 5, cachedInputPer1M: 0.5, outputPer1M: 30 })
    expect(m.get('gpt-5.2')!.inputPer1M).toBeCloseTo(1.75, 9)
    expect(m.get('gpt-5.2')!.cachedInputPer1M).toBeCloseTo(0.175, 9)
    expect(m.get('gpt-6-astra')).toEqual({ inputPer1M: 10, cachedInputPer1M: null, outputPer1M: 60 })
  })

  it('refuses other providers, other modes, unusable prices and unusable ids', () => {
    const keys = [...parseLiteLlmOpenAiPricing(litellm()).keys()].sort()
    expect(keys).toEqual(['gpt-5.2', 'gpt-5.5', 'gpt-6-astra', 'gpt-badcache'])
  })

  it('a cached rate that is not a usable number is no cached tier (MP11: cached input costs the input rate)', () => {
    expect(parseLiteLlmOpenAiPricing(litellm()).get('gpt-badcache')!.cachedInputPer1M).toBeNull()
  })

  it('anything but an object gives nothing', () => {
    for (const bad of [null, undefined, 'x', 42, [], [litellm()]]) expect(parseLiteLlmOpenAiPricing(bad).size).toBe(0)
  })

  it('takes a bounded number of models', () => {
    const many: Record<string, unknown> = {}
    for (let i = 0; i < MAX_LIVE_CODEX_PRICES + 50; i++) many[`gpt-m${i}`] = { input_cost_per_token: per(1), output_cost_per_token: per(1), litellm_provider: 'openai', mode: 'chat' }
    expect(parseLiteLlmOpenAiPricing(many).size).toBe(MAX_LIVE_CODEX_PRICES)
  })
})

describe('the saved copy of the live prices', () => {
  it('round-trips, and a saved entry that is not a usable price is dropped on read', () => {
    const live = parseLiteLlmOpenAiPricing(litellm())
    const back = parseCachedCodexPricing(JSON.parse(JSON.stringify(serializeCodexPricing(live))))
    expect([...back.entries()]).toEqual([...live.entries()])
    const tampered = parseCachedCodexPricing({ models: {
      'gpt-5.5': { inputPer1M: 5, cachedInputPer1M: null, outputPer1M: 30 },
      'gpt-bad': { inputPer1M: 'x', cachedInputPer1M: null, outputPer1M: 30 },
      'gpt-neg': { inputPer1M: -1, cachedInputPer1M: null, outputPer1M: 30 },
      'gpt-big': { inputPer1M: 1e9, cachedInputPer1M: null, outputPer1M: 30 },
      'gpt-badcached': { inputPer1M: 1, cachedInputPer1M: 'x', outputPer1M: 1 },
      'gpt-negcached': { inputPer1M: 1, cachedInputPer1M: -1, outputPer1M: 1 },
      'bad id': { inputPer1M: 1, cachedInputPer1M: null, outputPer1M: 1 },
    } })
    expect([...tampered.keys()]).toEqual(['gpt-5.5'])
    for (const junk of [null, 'x', [], { models: [] }, { models: null }]) expect(parseCachedCodexPricing(junk).size).toBe(0)
  })
})

describe('priceForModel: live, then the table, then no price', () => {
  it('a live price wins over the table; the table prices what the live list lacks; anything else is no price', () => {
    setLiveCodexPricing(new Map([
      ['gpt-5.5', { inputPer1M: 4, cachedInputPer1M: 0.4, outputPer1M: 20 }],
      ['gpt-6-astra', { inputPer1M: 10, cachedInputPer1M: null, outputPer1M: 60 }],
    ]))
    expect(priceForModel('gpt-5.5')).toEqual({ inputPer1M: 4, cachedInputPer1M: 0.4, outputPer1M: 20 })
    expect(priceForModel('gpt-6-astra')!.outputPer1M).toBe(60)
    expect(priceForModel('gpt-5.3-codex')!.inputPer1M).toBe(1.75)
    expect(priceForModel('gpt-9')).toBeNull()
    expect(computeCodexCostUsd('gpt-6-astra', { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(70, 9)
    expect(computeCodexCostUsd('gpt-9', { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 })).toBeNull()
  })

  it('without live prices the table is what it was', () => {
    expect(priceForModel('gpt-5.5')).toEqual({ inputPer1M: 5, cachedInputPer1M: 1.25, outputPer1M: 30 })
    expect(priceForModel('gpt-6-astra')).toBeNull()
  })

  it('only a model id is priced, never an inherited name', () => {
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(priceForModel(k), k).toBeNull()
      expect(computeCodexCostUsd(k, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }), k).toBeNull()
    }
  })

  it('codexPricingKeys is every priced model once, live and table', () => {
    setLiveCodexPricing(new Map([
      ['gpt-5.5', { inputPer1M: 4, cachedInputPer1M: 0.4, outputPer1M: 20 }],
      ['gpt-6-astra', { inputPer1M: 10, cachedInputPer1M: null, outputPer1M: 60 }],
    ]))
    const keys = codexPricingKeys()
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of ['gpt-5.5', 'gpt-6-astra', 'gpt-5.3-codex', 'gpt-5.5-pro']) expect(keys).toContain(k)
  })
})
