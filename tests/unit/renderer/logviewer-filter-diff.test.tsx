// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { computeFilterDiff } from '../../../src/renderer/components/LogViewer'

describe('LogViewer filter diff (U4.4)', () => {
  it('returns added + removed indices between two filter results', () => {
    const before = [0, 1, 2, 3]
    const after =  [1, 2, 3, 4]
    const d = computeFilterDiff(before, after)
    expect(d.added).toEqual([4])
    expect(d.removed).toEqual([0])
  })
  it('returns empty diff when filter is identical', () => {
    const d = computeFilterDiff([0, 1, 2], [0, 1, 2])
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
  })
})
