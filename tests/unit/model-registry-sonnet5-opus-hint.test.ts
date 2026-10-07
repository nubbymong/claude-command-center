/**
 * [host] The owner's 2026-10-04 answers on two model-registry entries.
 *
 * Sonnet 5's fallback price: Anthropic's published rate, re-checked at the fix
 * (platform.claude.com/docs/en/about-claude/pricing, 2026-10-04): $2 / MTok
 * input, $10 / MTok output, $0.20 / MTok cache hits, $2.50 / MTok 5-minute cache
 * writes (the $2 / $10 launch price is now the standard price; the increase to
 * $3 / $15 that was scheduled for 2026-09-01 does not happen). Tested on the
 * path Tokenomics prices a Claude turn on: getAllPricing()'s keys, the turn's
 * model mapped by parseClaudeUsageLine (its own key, else the longest key it
 * starts with), and the cost the summary query computes from the four token
 * counts (tk-db.ts COST: in*pin + out*pout + cacheRead*pcr + cacheCreate*pcw,
 * per million). Offline: no live price list in a unit test, so the registry's
 * fallback is what prices it. The same turn through the real database is
 * tests/unit/native/tk-db-sonnet5-price.native.test.ts [CI].
 *
 * The picker's "Opus" alias row: Claude Code's documentation (model
 * configuration, read 2026-10-04) resolves the plain `opus` alias to a
 * different model per provider, with a context window that differs with it
 * (1M on the Anthropic API, where the alias is Opus 5.5; Opus 4.6 on Microsoft
 * Foundry reaches 1M only through its [1m] variant), so the row names no
 * context size. The "Opus 1M" row keeps the 1M its `opus[1m]` alias is
 * documented to use.
 */
import { describe, it, expect } from 'vitest'
import baselineJson from '../../resources/model-registry.json'
import type { ModelRegistry } from '../../src/shared/model-registry'
import { buildModelPickerRows } from '../../src/shared/model-registry'
import { getAllPricing, registryFallbackPricing } from '../../src/main/tokenomics/tk-pricing'
import { parseClaudeUsageLine } from '../../src/main/tokenomics/tk-parse'

const SONNET_5 = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }

describe('Sonnet 5 is priced at Anthropic\'s published rate', () => {
  it('[host] the registry fallback carries $2 / $10, cache hits $0.20, 5-minute cache writes $2.50', () => {
    expect(registryFallbackPricing()['claude-sonnet-5']).toEqual(SONNET_5)
  })

  it('[host] Tokenomics prices a Sonnet 5 turn, dated or not, at that rate', () => {
    const map = getAllPricing()
    const keys = Object.keys(map)
    const M = 1_000_000
    for (const model of ['claude-sonnet-5', 'claude-sonnet-5-20260601']) {
      const line = JSON.stringify({ type: 'assistant', timestamp: '2026-10-04T10:00:00Z', sessionId: 's', requestId: `r-${model}`,
        message: { id: `m-${model}`, model, usage: { input_tokens: M, output_tokens: M, cache_read_input_tokens: M, cache_creation_input_tokens: M } } })
      const turn = parseClaudeUsageLine(line, keys)!
      expect(turn.priceModel, model).toBe('claude-sonnet-5')
      const p = map[turn.priceModel]
      expect(p, model).toEqual(SONNET_5)
      // The summary query's cost for the turn (tk-db.ts COST), in dollars.
      const cost = (turn.inTok * p.input + turn.outTok * p.output + turn.cacheReadTok * p.cacheRead + turn.cacheCreateTok * p.cacheWrite) / M
      expect(cost, model).toBeCloseTo(2 + 10 + 0.2 + 2.5, 9)
    }
  })

  it('[host] the neighbours keep their own rates: Sonnet 5.5 and Sonnet 4.6', () => {
    const map = getAllPricing()
    expect(map['claude-sonnet-5-5']).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 })
    expect(map['claude-sonnet-4-6']).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
  })
})

describe('the picker\'s Opus alias rows', () => {
  const rows = buildModelPickerRows(baselineJson as unknown as ModelRegistry)
  const hint = (value: string) => rows.find((r) => r.value === value)?.hint

  it('[host] the plain Opus row names no context size', () => {
    expect(hint('opus')).toBe('Latest Opus')
    expect(hint('opus')).not.toMatch(/\d\s*[km]\b|context/i)
  })

  it('[host] the Opus 1M row keeps the 1M its alias is documented to use', () => {
    expect(hint('opus[1m]')).toBe('Latest Opus (1M context)')
  })
})
