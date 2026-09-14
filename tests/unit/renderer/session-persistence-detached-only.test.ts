// @vitest-environment jsdom
// rc.14 review F9 (aicc_planning#53): the left-running registry (Remote
// Resumable) must outlive the attached session set.
//
// Leaving the last SSH session running gives `sessions: []` with a non-empty
// `detachedRemotes`. The zero-tab close then cleared the whole saved file, and
// boot only hydrated the registry inside the attached-session restore, which
// never ran for an empty set -- so the remote kept running and the app forgot
// how to get back to it. These two helpers are what the three discard paths
// (zero-tab close, "Don't open", "Don't save") and the no-restore boot use.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DetachedRemote } from '../../../src/shared/types'

const save = vi.fn(async () => true)
const clear = vi.fn(async () => true)
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  session: { save, clear, load: vi.fn(), hasSaved: vi.fn() },
}

const { persistDetachedOnlyOrClear, hydrateDetachedFromSavedState } = await import('../../../src/renderer/session-persistence')
const { useDetachedRemotesStore } = await import('../../../src/renderer/stores/detachedRemotesStore')

const entry: DetachedRemote = {
  sessionId: 'ssh-1', configId: 'cfg-9', host: 'pi.local', username: 'mong', remotePath: '~/work',
  mux: 'tmux', label: 'pi', detachedAt: 1_700_000_000_000,
}

beforeEach(() => {
  useDetachedRemotesStore.setState({ entries: [] })
  save.mockClear()
  clear.mockClear()
})

describe('persistDetachedOnlyOrClear', () => {
  it('REGRESSION: with a left-running remote, writes an EMPTY session set that still carries the registry', async () => {
    useDetachedRemotesStore.setState({ entries: [entry] })
    await expect(persistDetachedOnlyOrClear()).resolves.toBe('saved')
    expect(clear).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledTimes(1)
    const written = save.mock.calls[0][0] as { sessions: unknown[]; activeSessionId: unknown; detachedRemotes: DetachedRemote[] }
    expect(written.sessions).toEqual([])
    expect(written.activeSessionId).toBeNull()
    expect(written.detachedRemotes).toEqual([entry])
  })

  it('with nothing left running, clears the file exactly as before', async () => {
    await expect(persistDetachedOnlyOrClear()).resolves.toBe('cleared')
    expect(clear).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
  })
})

describe('hydrateDetachedFromSavedState', () => {
  it('REGRESSION: a saved state with no sessions still hydrates its registry', () => {
    const n = hydrateDetachedFromSavedState({ sessions: [], activeSessionId: null, savedAt: 1, detachedRemotes: [entry] })
    expect(n).toBe(1)
    expect(useDetachedRemotesStore.getState().entries).toEqual([entry])
  })

  it('nothing saved, or an empty registry, hydrates nothing and leaves the store alone', () => {
    useDetachedRemotesStore.setState({ entries: [entry] })
    expect(hydrateDetachedFromSavedState(null)).toBe(0)
    expect(hydrateDetachedFromSavedState({ detachedRemotes: [] })).toBe(0)
    expect(hydrateDetachedFromSavedState({ detachedRemotes: undefined })).toBe(0)
    expect(useDetachedRemotesStore.getState().entries).toEqual([entry])
  })

  it('goes through the sanitising hydrate: a malformed entry is dropped, not stored', () => {
    const n = hydrateDetachedFromSavedState({ detachedRemotes: [{ sessionId: 'x' } as never, entry] })
    expect(n).toBe(1)
    expect(useDetachedRemotesStore.getState().entries).toEqual([entry])
  })
})
