// #454: multiple live sessions of one config get a 1-based instance ordinal so
// the otherwise-identical Running rows are tellable apart. Single-instance
// configs get none.
import { describe, it, expect } from 'vitest'
import { sessionInstanceOrdinals } from '../../../src/renderer/components/sidebar/savedConfigsView'

type S = { id: string; configId?: string; kind?: 'ask' }
const s = (id: string, configId?: string, kind?: 'ask'): S => ({ id, configId, kind })

describe('sessionInstanceOrdinals (#454)', () => {
  it('numbers same-config siblings 1..N in array order', () => {
    const m = sessionInstanceOrdinals([s('a', 'cfg1'), s('b', 'cfg1'), s('c', 'cfg1')])
    expect(m.get('a')).toBe(1)
    expect(m.get('b')).toBe(2)
    expect(m.get('c')).toBe(3)
  })

  it('gives NO ordinal to a config with a single live instance', () => {
    const m = sessionInstanceOrdinals([s('a', 'cfg1'), s('b', 'cfg2')])
    expect(m.has('a')).toBe(false)
    expect(m.has('b')).toBe(false)
  })

  it('numbers each config independently', () => {
    const m = sessionInstanceOrdinals([s('a', 'cfg1'), s('b', 'cfg2'), s('c', 'cfg1'), s('d', 'cfg2')])
    expect([m.get('a'), m.get('c')]).toEqual([1, 2]) // cfg1
    expect([m.get('b'), m.get('d')]).toEqual([1, 2]) // cfg2
  })

  it('skips Ask sessions and config-less sessions entirely', () => {
    const m = sessionInstanceOrdinals([s('ask', undefined, 'ask'), s('ask2', undefined, 'ask'), s('none'), s('none2')])
    expect(m.size).toBe(0)
  })

  it('an Ask session sharing nothing does not perturb a real config’s numbering', () => {
    const m = sessionInstanceOrdinals([s('a', 'cfg1'), s('ask', undefined, 'ask'), s('b', 'cfg1')])
    expect(m.get('a')).toBe(1)
    expect(m.get('b')).toBe(2)
  })
})
