/**
 * Running-config detection (the surviving pure helper of the old #362 module;
 * the cards/find views and their helpers retired with the two-mode Sessions
 * panel). A config with a live session is "running"; the config-less Ask
 * session can never mark one.
 */
import { describe, it, expect } from 'vitest'
import { runningConfigIds } from '../../../src/renderer/components/sidebar/savedConfigsView'

describe('runningConfigIds', () => {
  it('collects the configIds of live sessions', () => {
    const ids = runningConfigIds([
      { configId: 'a', kind: undefined },
      { configId: 'b', kind: undefined },
      { configId: 'a', kind: undefined }, // second session of the same config
      { configId: undefined, kind: undefined }, // adopted/config-less
    ] as never)
    expect([...ids].sort()).toEqual(['a', 'b'])
  })

  it('skips the Ask session even when it somehow carries a configId', () => {
    const ids = runningConfigIds([{ configId: 'a', kind: 'ask' }] as never)
    expect(ids.size).toBe(0)
  })

  it('is empty for no sessions', () => {
    expect(runningConfigIds([]).size).toBe(0)
  })
})
