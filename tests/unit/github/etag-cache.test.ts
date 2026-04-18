import { describe, it, expect } from 'vitest'
import { EtagCache } from '../../../src/main/github/client/etag-cache'

describe('EtagCache', () => {
  it('set/get', () => {
    const c = new EtagCache({})
    c.set('k', 'v')
    expect(c.get('k')).toBe('v')
  })
  it('undefined for missing', () => {
    expect(new EtagCache({}).get('no')).toBeUndefined()
  })
  it('delete clears', () => {
    const c = new EtagCache({})
    c.set('k', 'v')
    c.delete('k')
    expect(c.get('k')).toBeUndefined()
  })
  it('persists through backing map', () => {
    const store: Record<string, string> = {}
    new EtagCache(store).set('k', 'v')
    expect(store.k).toBe('v')
  })
})
