import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { usePasteHintStore } from '../../../src/renderer/stores/pasteHintStore'

// Unit 5 W2: per-session transient paste feedback.
describe('pasteHintStore', () => {
  beforeEach(() => { vi.useFakeTimers(); usePasteHintStore.setState({ hints: {} }) })
  afterEach(() => vi.useRealTimers())

  it('shows a hint then auto-clears after 3s', () => {
    usePasteHintStore.getState().show('s1', 'no image')
    expect(usePasteHintStore.getState().hints.s1).toBe('no image')
    vi.advanceTimersByTime(3000)
    expect(usePasteHintStore.getState().hints.s1).toBeUndefined()
  })

  it('a newer hint resets the dismiss window (the old timer does not clear it)', () => {
    usePasteHintStore.getState().show('s1', 'a')
    vi.advanceTimersByTime(2000)
    usePasteHintStore.getState().show('s1', 'b')
    vi.advanceTimersByTime(2000)
    expect(usePasteHintStore.getState().hints.s1).toBe('b')
    vi.advanceTimersByTime(1000)
    expect(usePasteHintStore.getState().hints.s1).toBeUndefined()
  })

  it('keeps hints independent per session', () => {
    usePasteHintStore.getState().show('s1', 'x')
    usePasteHintStore.getState().show('s2', 'y')
    expect(usePasteHintStore.getState().hints).toEqual({ s1: 'x', s2: 'y' })
  })
})
