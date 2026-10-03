// P3.8 round 1 (Q2): the pricing CTE Tokenomics queries with carries only the
// price keys the stored usage names, so a live list of hundreds of models is
// not bound into every query; a key no usage names never changes a cost (the
// CTE is joined to the usage by its price key). better-sqlite3 is built for
// Electron's runtime, so it is stubbed here: this is the pure helper only (the
// queries themselves run in tests/unit/native, on CI and the test VM).
import { describe, it, expect, vi } from 'vitest'

vi.mock('better-sqlite3', () => ({ default: class {} }))

const { pricingCte } = await import('../../../src/main/tokenomics/tk-db')

const P = (input: number) => ({ input, output: input * 2, cacheRead: input / 10, cacheWrite: 0 })

describe('pricingCte', () => {
  it('binds only the price keys the usage names', () => {
    const pricing: Record<string, ReturnType<typeof P>> = {}
    for (let i = 0; i < 500; i++) pricing[`gpt-m${i}`] = P(i + 1)
    pricing['claude-opus-5'] = P(5)
    pricing['gpt-5.5'] = P(4)
    const { cte, binds } = pricingCte(pricing, new Set(['claude-opus-5', 'gpt-5.5', 'unpriced-model']))
    expect(Object.keys(binds).filter((k) => k.startsWith('pm')).map((k) => binds[k]).sort()).toEqual(['claude-opus-5', 'gpt-5.5'])
    expect(cte.match(/\(@pm/g)).toHaveLength(2)
    expect(binds[Object.keys(binds).find((k) => binds[k] === 'gpt-5.5')!.replace('pm', 'pin')]).toBe(4)
  })

  it('with nothing used it binds no row, and a valid empty CTE remains', () => {
    const { cte, binds } = pricingCte({ 'gpt-5.5': P(4) }, new Set())
    expect(binds).toEqual({})
    expect(cte).toContain('WHERE 0')
  })

  it('without a used set it binds every key, as before', () => {
    const { binds } = pricingCte({ 'gpt-5.5': P(4), 'claude-opus-5': P(5) })
    expect(Object.keys(binds).filter((k) => k.startsWith('pm'))).toHaveLength(2)
  })
})
