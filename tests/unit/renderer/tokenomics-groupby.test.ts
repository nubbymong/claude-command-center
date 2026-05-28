import { describe, it, expect } from 'vitest'
import type { GroupByLens } from '../../../src/renderer/components/TokenomicsPage'

describe('Tokenomics GroupByLens (U2.1)', () => {
  it('exports the Phase 1 lens union', () => {
    const lenses: GroupByLens[] = ['project', 'account', 'model']
    expect(lenses).toHaveLength(3)
  })
})
