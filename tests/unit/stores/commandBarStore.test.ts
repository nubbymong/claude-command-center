import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: vi.fn(),
}))

import { useCommandBarStore } from '../../../src/renderer/stores/commandBarStore'
import { saveConfigNow } from '../../../src/renderer/utils/config-saver'

describe('useCommandBarStore', () => {
  beforeEach(() => {
    useCommandBarStore.setState({
      state: { collapsedSectionIds: [] },
      isLoaded: false,
    })
    vi.mocked(saveConfigNow).mockClear()
  })

  it('hydrate seeds collapsedSectionIds from disk and sets isLoaded', () => {
    useCommandBarStore.getState().hydrate({ collapsedSectionIds: ['a', 'b'] })
    expect(useCommandBarStore.getState().state.collapsedSectionIds).toEqual(['a', 'b'])
    expect(useCommandBarStore.getState().isLoaded).toBe(true)
  })

  it('hydrate with missing field defaults to empty array', () => {
    useCommandBarStore.getState().hydrate({})
    expect(useCommandBarStore.getState().state.collapsedSectionIds).toEqual([])
    expect(useCommandBarStore.getState().isLoaded).toBe(true)
  })

  it('toggleSection adds id when not present, removes when present', () => {
    useCommandBarStore.getState().toggleSection('sec-1')
    expect(useCommandBarStore.getState().state.collapsedSectionIds).toEqual(['sec-1'])

    useCommandBarStore.getState().toggleSection('sec-2')
    expect(useCommandBarStore.getState().state.collapsedSectionIds).toEqual(['sec-1', 'sec-2'])

    useCommandBarStore.getState().toggleSection('sec-1')
    expect(useCommandBarStore.getState().state.collapsedSectionIds).toEqual(['sec-2'])
  })

  it('toggleSection persists to disk on each change', () => {
    useCommandBarStore.getState().toggleSection('sec-x')
    expect(saveConfigNow).toHaveBeenCalledWith('commandBarUi', { collapsedSectionIds: ['sec-x'] })

    useCommandBarStore.getState().toggleSection('sec-x')
    expect(saveConfigNow).toHaveBeenLastCalledWith('commandBarUi', { collapsedSectionIds: [] })
  })

  it('isCollapsed reflects current set membership', () => {
    expect(useCommandBarStore.getState().isCollapsed('foo')).toBe(false)
    useCommandBarStore.getState().toggleSection('foo')
    expect(useCommandBarStore.getState().isCollapsed('foo')).toBe(true)
    useCommandBarStore.getState().toggleSection('foo')
    expect(useCommandBarStore.getState().isCollapsed('foo')).toBe(false)
  })
})
