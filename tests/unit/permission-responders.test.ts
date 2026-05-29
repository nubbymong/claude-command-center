import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  registerResponder,
  deregisterResponder,
  resolveResponder,
  _resetResponders,
  _responderCount,
} from '../../src/main/permission-responders'

describe('permission-responders', () => {
  beforeEach(() => { _resetResponders() })

  it('invokes a registered responder with the decision and drops it', () => {
    const fn = vi.fn()
    registerResponder('req-1', fn)
    expect(_responderCount()).toBe(1)
    resolveResponder('req-1', 'approved')
    expect(fn).toHaveBeenCalledWith('approved')
    expect(_responderCount()).toBe(0)
  })

  it('resolveResponder is a no-op for an unknown id', () => {
    expect(() => resolveResponder('nope', 'denied')).not.toThrow()
  })

  it('deregisterResponder removes the entry without invoking it', () => {
    const fn = vi.fn()
    registerResponder('req-2', fn)
    deregisterResponder('req-2')
    expect(_responderCount()).toBe(0)
    resolveResponder('req-2', 'approved')
    expect(fn).not.toHaveBeenCalled()
  })

  it('latest registration wins on duplicate requestId', () => {
    const first = vi.fn()
    const second = vi.fn()
    registerResponder('req-3', first)
    registerResponder('req-3', second)
    resolveResponder('req-3', 'denied')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('denied')
  })

  it('resolving once does not re-fire on a second resolve', () => {
    const fn = vi.fn()
    registerResponder('req-4', fn)
    resolveResponder('req-4', 'approved')
    resolveResponder('req-4', 'denied')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('approved')
  })
})
