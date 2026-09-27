/**
 * WP2 commit 6: the exit hold a terminal view keeps while it starts the
 * session's PTY (src/renderer/utils/spawnExitHold.ts). Pure: which exits the
 * view acts on, and what its own start's end does with a held one.
 */
import { describe, it, expect } from 'vitest'
import { createSpawnExitHold } from '../../../src/renderer/utils/spawnExitHold'

describe('a view that will spawn holds exits until its own start settles', () => {
  it('holds an exit before pty:spawn is called and while it is in flight', () => {
    const h = createSpawnExitHold(true)
    expect(h.state).toBe('pending')
    expect(h.exit(-1)).toBe(false)
    h.begin()
    expect(h.state).toBe('in-flight')
    expect(h.exit(1)).toBe(false)
  })

  it('a spawn that started a PTY drops the held exit (it was the replaced run\'s)', () => {
    const h = createSpawnExitHold(true)
    h.exit(1)
    h.begin()
    expect(h.settle('started')).toEqual({ end: false, code: null })
    expect(h.state).toBe('settled')
    // The new PTY's own exit is acted on.
    expect(h.exit(0)).toBe(true)
  })

  it('a start that started nothing ends the session, held exit or not', () => {
    const held = createSpawnExitHold(true)
    held.begin()
    held.exit(-1)
    expect(held.settle('nothing-started')).toEqual({ end: true, code: -1 })
    const none = createSpawnExitHold(true)
    expect(none.settle('nothing-started')).toEqual({ end: true, code: null })
  })

  it('when this view starts nothing (a failed spawn, a start left elsewhere), only a held exit ends the session', () => {
    const held = createSpawnExitHold(true)
    held.exit(3)
    expect(held.settle('no-spawn-here')).toEqual({ end: true, code: 3 })
    const none = createSpawnExitHold(true)
    expect(none.settle('no-spawn-here')).toEqual({ end: false, code: null })
  })

  it('settles once: a second settle does nothing', () => {
    const h = createSpawnExitHold(true)
    h.exit(1)
    h.settle('started')
    expect(h.settle('nothing-started')).toEqual({ end: false, code: null })
  })
})

describe('a view that remounts onto a running PTY', () => {
  it('acts on every exit as it arrives', () => {
    const h = createSpawnExitHold(false)
    expect(h.state).toBe('none')
    expect(h.exit(0)).toBe(true)
  })

  it('holds again if it does start a PTY after all (the tracker was cleared meanwhile)', () => {
    const h = createSpawnExitHold(false)
    h.begin()
    expect(h.exit(1)).toBe(false)
  })
})
