import { describe, it, expect } from 'vitest'
import { decorateStatuslineWithColour } from '../../../src/main/tokenomics-manager'
import type { StatuslineData } from '../../../src/shared/types'

describe('decorateStatuslineWithColour', () => {
  it('computes accountColour from accountEmail', () => {
    const sl: StatuslineData = { sessionId: 's', accountEmail: 'alice@example.com' } as any
    const out = decorateStatuslineWithColour(sl)
    expect(out.accountColour).toBeDefined()
    expect(['red','peach','yellow','green','teal','sky','blue','lavender','mauve','pink','flamingo','rosewater']).toContain(out.accountColour)
  })

  it('returns same colour for same email (deterministic)', () => {
    const a = decorateStatuslineWithColour({ sessionId: 's', accountEmail: 'x@y.com' } as any)
    const b = decorateStatuslineWithColour({ sessionId: 's', accountEmail: 'x@y.com' } as any)
    expect(a.accountColour).toBe(b.accountColour)
  })

  it('omits accountColour when accountEmail is absent', () => {
    const sl: StatuslineData = { sessionId: 's' } as any
    const out = decorateStatuslineWithColour(sl)
    expect(out.accountColour).toBeUndefined()
  })

  it('preserves all other fields', () => {
    const sl: StatuslineData = { sessionId: 's', model: 'sonnet', accountEmail: 'a@b.com' } as any
    const out = decorateStatuslineWithColour(sl)
    expect(out.model).toBe('sonnet')
  })
})
