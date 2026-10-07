/**
 * WP2 commit 6: a start that ended with nothing started, told to the view
 * showing the session (src/renderer/utils/spawnEndNotice.ts) -- now, or,
 * when that view is not listening yet (a hidden pane starts only when it is
 * shown), when it starts listening.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { listenForSpawnEnd, reportSpawnEnd, forgetSpawnEnd } from '../../../src/renderer/utils/spawnEndNotice'

beforeEach(() => { forgetSpawnEnd('s-1'); forgetSpawnEnd('s-2') })

describe('a report with a view listening', () => {
  it('is handed over at once', () => {
    const heard = vi.fn()
    const off = listenForSpawnEnd('s-1', heard)
    expect(reportSpawnEnd('s-1', 'refused')).toBe(true)
    expect(heard).toHaveBeenCalledWith('refused')
    off()
  })
})

describe('a report nobody hears yet', () => {
  it('is kept, and handed to the view that listens next, once', () => {
    expect(reportSpawnEnd('s-1', 'refused')).toBe(false)
    const heard = vi.fn()
    const off = listenForSpawnEnd('s-1', heard)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(heard).toHaveBeenCalledWith('refused')
    off()
    const later = vi.fn()
    listenForSpawnEnd('s-1', later)()
    expect(later).not.toHaveBeenCalled()
  })

  it('keeps one per session: a newer report replaces an older one', () => {
    reportSpawnEnd('s-1', 'first')
    reportSpawnEnd('s-1', 'second')
    const heard = vi.fn()
    listenForSpawnEnd('s-1', heard)()
    expect(heard.mock.calls).toEqual([['second']])
  })

  it('is kept per session: another session hears nothing', () => {
    reportSpawnEnd('s-1', 'refused')
    const other = vi.fn()
    listenForSpawnEnd('s-2', other)()
    expect(other).not.toHaveBeenCalled()
  })

  it('is dropped when the session goes', () => {
    reportSpawnEnd('s-1', 'refused')
    forgetSpawnEnd('s-1')
    const heard = vi.fn()
    listenForSpawnEnd('s-1', heard)()
    expect(heard).not.toHaveBeenCalled()
  })

  it('an unsubscribed view stops hearing: the next report is kept instead', () => {
    const heard = vi.fn()
    listenForSpawnEnd('s-1', heard)()
    expect(reportSpawnEnd('s-1', 'refused')).toBe(false)
    expect(heard).not.toHaveBeenCalled()
  })
})

describe('closing or restarting the session drops a kept report', () => {
  it('killSessionPty (close, Restart) forgets it', async () => {
    ;(globalThis as any).window = (globalThis as any).window ?? {}
    ;(globalThis as any).window.electronAPI = { ...((globalThis as any).window.electronAPI ?? {}), pty: { kill: vi.fn() } }
    const { killSessionPty } = await import('../../../src/renderer/ptyTracker')
    reportSpawnEnd('s-1', 'refused')
    killSessionPty('s-1')
    const heard = vi.fn()
    listenForSpawnEnd('s-1', heard)()
    expect(heard).not.toHaveBeenCalled()
  })

  // P3.16a round 2 (Q5): a Restart's kills say so (main does not take their
  // exits as the session's end); a close's do not.
  it('killSessionPty kills the session and its spawned partner, as a Restart\'s kills only when asked', async () => {
    const kill = vi.fn()
    ;(globalThis as any).window = (globalThis as any).window ?? {}
    ;(globalThis as any).window.electronAPI = { ...((globalThis as any).window.electronAPI ?? {}), pty: { kill } }
    const { killSessionPty, markSpawned } = await import('../../../src/renderer/ptyTracker')
    markSpawned('s-2-partner')
    killSessionPty('s-2', { restart: true })
    expect(kill.mock.calls).toEqual([['s-2', 'restart'], ['s-2-partner', 'restart']])
    kill.mockClear()
    markSpawned('s-2-partner')
    killSessionPty('s-2')
    expect(kill.mock.calls).toEqual([['s-2'], ['s-2-partner']])
  })

  // Fixer 3 (F1): a close kills the partner whether or not its process was
  // started again after a Restart (its view not shown since), so main ends
  // the partner's record too; a Restart kills only a partner that runs.
  it('a close kills the partner even when it was not started again after a Restart; a Restart only a started one', async () => {
    const kill = vi.fn()
    ;(globalThis as any).window = (globalThis as any).window ?? {}
    ;(globalThis as any).window.electronAPI = { ...((globalThis as any).window.electronAPI ?? {}), pty: { kill } }
    const { killSessionPty, markSpawned } = await import('../../../src/renderer/ptyTracker')
    markSpawned('s-3-partner')
    killSessionPty('s-3', { restart: true })
    expect(kill.mock.calls).toEqual([['s-3', 'restart'], ['s-3-partner', 'restart']])
    kill.mockClear()
    killSessionPty('s-3', { restart: true })
    expect(kill.mock.calls).toEqual([['s-3', 'restart']])
    kill.mockClear()
    killSessionPty('s-3')
    expect(kill.mock.calls).toEqual([['s-3'], ['s-3-partner']])
  })
})
