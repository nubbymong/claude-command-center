import { describe, it, expect } from 'vitest'
// Live-session counting for the sessions panel (owner revision 2026-08-24:
// counts, not a set — the surfaces show HOW MANY and relaunch is allowed).
import { runningConfigCounts } from '../../../src/renderer/components/sidebar/savedConfigsView'

describe('runningConfigCounts', () => {
  it('counts sessions per config id', () => {
    const c = runningConfigCounts([
      { configId: 'a', kind: undefined },
      { configId: 'a', kind: undefined },
      { configId: 'b', kind: undefined },
      { configId: undefined, kind: undefined },
    ] as never)
    expect(c.get('a')).toBe(2)
    expect(c.get('b')).toBe(1)
    expect(c.size).toBe(2)
  })

  it('the Ask Conductor session never marks a config running', () => {
    const c = runningConfigCounts([{ configId: 'a', kind: 'ask' }] as never)
    expect(c.size).toBe(0)
  })

  it('is empty for no sessions', () => {
    expect(runningConfigCounts([]).size).toBe(0)
  })
})
