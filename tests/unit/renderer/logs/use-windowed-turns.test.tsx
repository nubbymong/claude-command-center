// @vitest-environment jsdom
// tests/unit/renderer/logs/use-windowed-turns.test.tsx
//
// Hook test for the GB-safe windowed transcript pager. Mirrors the repo's
// no-@testing-library pattern: a tiny local `renderHook` shim (react-dom/client
// + react `act`) and a partial electronAPI assignment so jsdom's window
// survives react-dom's commit phase.
//
// The mock `logs2.readMessages` is anchor/dir-driven: it serves canned pages
// from a synthetic transcript so we can assert page mounting/unmounting and the
// tail/older/jump cursors. `onNewMessages` records the callback + returns an
// unsub spy so we can fire a live push and assert teardown.
import React from 'react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import {
  useWindowedTurns,
  PAGE_SIZE,
  type Logs2Message,
} from '../../../../src/renderer/hooks/useWindowedTurns'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function renderHook<T>(hook: () => T): { result: { current: T }; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const result = { current: undefined as unknown as T }
  const HookHost: React.FC = () => {
    result.current = hook()
    return null
  }
  act(() => {
    root.render(<HookHost />)
  })
  return {
    result,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

// ---- Synthetic transcript: a single run with N messages, idx 0..N-1 --------
const RUN = 1
const TOTAL = PAGE_SIZE * 5 // 500 messages → 5 pages

function makeMsg(idx: number): Logs2Message {
  return {
    runId: RUN,
    idx,
    ts: 1000 + idx,
    role: idx % 2 === 0 ? 'user' : 'assistant',
    kind: 'message',
    content: `msg ${idx}`,
    toolName: null,
    toolMeta: null,
  }
}

const ALL: Logs2Message[] = Array.from({ length: TOTAL }, (_, i) => makeMsg(i))

// Serve a window of the synthetic transcript according to anchor/dir. This
// MIRRORS the real backend's strict-exclusive tuple semantics (transcripts-db.ts
// readMessagesPage): there is NO centered read. The worker (transcripts-worker.ts)
// coerces any non-'newer' dir to 'older' and logs2-handlers defaults dir to
// 'older', so a missing dir behaves like 'older'.
//  - anchor 'tail'            → the last PAGE_SIZE messages
//  - anchor {runId,idx} older → the PAGE_SIZE messages STRICTLY before idx
//  - anchor {runId,idx} newer → the PAGE_SIZE messages STRICTLY after idx
//    (idx may be -1; the first row strictly after idx:-1 is idx:0)
function serve(args: {
  scope: unknown
  anchor?: 'tail' | { runId: number; idx: number }
  dir?: 'older' | 'newer'
  limit?: number
}): Logs2Message[] {
  const limit = args.limit ?? PAGE_SIZE
  if (!args.anchor || args.anchor === 'tail') {
    // 'tail' + 'newer' is empty in the backend (nothing after the tail); the
    // hook never issues it, so this branch only needs the older/default case.
    return ALL.slice(Math.max(0, TOTAL - limit))
  }
  const { idx } = args.anchor
  if (args.dir === 'newer') {
    // Strictly AFTER idx → first returned row is idx+1. For idx:-1 that's row 0.
    const start = idx + 1
    return ALL.slice(Math.max(0, start), Math.max(0, start) + limit)
  }
  // 'older' (or no dir, which the backend coerces to 'older'): strictly BEFORE idx.
  const end = idx
  return ALL.slice(Math.max(0, end - limit), Math.max(0, end))
}

let readMessages: ReturnType<typeof vi.fn>
let onNewCb: ((e: { sessionId: string; configId: string | null; count: number }) => void) | null
let unsub: ReturnType<typeof vi.fn>

beforeEach(() => {
  onNewCb = null
  unsub = vi.fn()
  readMessages = vi.fn(async (args: any) => serve(args))
  ;(globalThis as any).window.electronAPI = {
    logs2: {
      readMessages,
      onNewMessages: (fn: any) => {
        onNewCb = fn
        return unsub
      },
    },
  }
})

const SCOPE = { sessionId: 's1' } as const

// Flush microtasks (awaited readMessages + the .then state writes).
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useWindowedTurns', () => {
  it('opens at the tail (first read uses anchor:tail) and is following', async () => {
    const { result } = renderHook(() => useWindowedTurns(SCOPE))
    await flush()
    expect(readMessages).toHaveBeenCalledTimes(1)
    const firstArgs = readMessages.mock.calls[0][0]
    expect(firstArgs.anchor).toBe('tail')
    // The newest page is mounted; the last message is the very last idx.
    const msgs = result.current.messages
    expect(msgs.length).toBe(PAGE_SIZE)
    expect(msgs[msgs.length - 1].idx).toBe(TOTAL - 1)
    expect(msgs[0].idx).toBe(TOTAL - PAGE_SIZE)
    // Initial state follows the tail.
    expect(result.current.follow).toBe(true)
  })

  it('scroll-up loads an OLDER page (prepended) using the oldest mounted cursor', async () => {
    const { result } = renderHook(() => useWindowedTurns(SCOPE))
    await flush()
    const oldestBefore = result.current.messages[0].idx // TOTAL - PAGE_SIZE
    await act(async () => {
      await result.current.loadOlder()
    })
    await flush()
    // A second read happened, anchored at the oldest mounted (runId,idx), older.
    expect(readMessages).toHaveBeenCalledTimes(2)
    const secondArgs = readMessages.mock.calls[1][0]
    expect(secondArgs.dir).toBe('older')
    expect(secondArgs.anchor).toEqual({ runId: RUN, idx: oldestBefore })
    // The older page is prepended → first message moves back a page; tail intact.
    const msgs = result.current.messages
    expect(msgs[0].idx).toBe(oldestBefore - PAGE_SIZE)
    expect(msgs[msgs.length - 1].idx).toBe(TOTAL - 1)
    expect(msgs.length).toBe(PAGE_SIZE * 2)
  })

  it('caps mounted pages at 3, dropping the far (bottom) page on the 4th older load', async () => {
    const { result } = renderHook(() => useWindowedTurns(SCOPE))
    await flush()
    // Load 3 older pages → would be 4 pages mounted; cap drops the bottom-most.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await result.current.loadOlder()
      })
      await flush()
    }
    const msgs = result.current.messages
    // Only 3 pages remain mounted (GB-safe), 300 messages.
    expect(msgs.length).toBe(PAGE_SIZE * 3)
    // The bottom (tail) page was dropped — the last idx is no longer TOTAL-1.
    expect(msgs[msgs.length - 1].idx).toBeLessThan(TOTAL - 1)
    expect(result.current.pageCount).toBe(3)
  })

  it('a live push appends the tail ONLY when following', async () => {
    const { result } = renderHook(() => useWindowedTurns(SCOPE))
    await flush()
    expect(result.current.follow).toBe(true)
    const callsBefore = readMessages.mock.calls.length
    act(() => {
      onNewCb!({ sessionId: 's1', configId: null, count: 1 })
    })
    await flush()
    // A push while following refreshes the tail page (a 'tail' read fires).
    const newCalls = readMessages.mock.calls.slice(callsBefore)
    expect(newCalls.length).toBeGreaterThanOrEqual(1)
    expect(newCalls.some((c) => c[0].anchor === 'tail')).toBe(true)
  })

  it('a live push does NOT append when scrolled up (follow=false)', async () => {
    const { result } = renderHook(() => useWindowedTurns(SCOPE))
    await flush()
    // User scrolls up → not at bottom.
    act(() => result.current.setFollow(false))
    expect(result.current.follow).toBe(false)
    const callsBefore = readMessages.mock.calls.length
    act(() => {
      onNewCb!({ sessionId: 's1', configId: null, count: 3 })
    })
    await flush()
    // No new read while not following.
    expect(readMessages.mock.calls.length).toBe(callsBefore)
  })

  it('ignores live pushes for a different scope', async () => {
    const { result } = renderHook(() => useWindowedTurns(SCOPE))
    await flush()
    const callsBefore = readMessages.mock.calls.length
    act(() => {
      onNewCb!({ sessionId: 'OTHER', configId: null, count: 1 })
    })
    await flush()
    expect(readMessages.mock.calls.length).toBe(callsBefore)
  })

  it('jumpTo loads a window that CONTAINS the target idx and turns follow OFF', async () => {
    const { result } = renderHook(() => useWindowedTurns(SCOPE))
    await flush()
    const callsBefore = readMessages.mock.calls.length
    const target = 250
    await act(async () => {
      await result.current.jumpTo({ runId: RUN, idx: target })
    })
    await flush()

    // REGRESSION GUARD: the backend has NO centered read — 'older'/'newer' are
    // STRICTLY exclusive of the anchor tuple. A forward page must therefore be
    // anchored at idx-1 with dir:'newer' so its FIRST row is the target itself.
    const jumpCalls = readMessages.mock.calls.slice(callsBefore).map((c) => c[0])
    const newerCall = jumpCalls.find((a) => a.dir === 'newer')
    expect(newerCall).toBeTruthy()
    expect(newerCall.anchor).toEqual({ runId: RUN, idx: target - 1 })
    // And an older page anchored strictly before the target.
    const olderCall = jumpCalls.find((a) => a.dir === 'older')
    expect(olderCall).toBeTruthy()
    expect(olderCall.anchor).toEqual({ runId: RUN, idx: target })
    // There must be NO redundant no-dir "center" read.
    expect(jumpCalls.some((a) => a.dir === undefined)).toBe(false)

    expect(result.current.follow).toBe(false)
    const msgs = result.current.messages
    // The mounted window MUST contain the target idx (this fails against the old
    // centerless backend, where a no-dir read returned [], dropping the target).
    expect(msgs.some((m) => m.idx === target)).toBe(true)
  })

  it('exposes jumpTarget (coords + a fresh nonce per jump); null until the first jump', async () => {
    const { result } = renderHook(() => useWindowedTurns(SCOPE))
    await flush()
    // No jump yet: the view has nothing to scroll/highlight.
    expect(result.current.jumpTarget).toBeNull()

    await act(async () => { await result.current.jumpTo({ runId: RUN, idx: 120 }) })
    await flush()
    const first = result.current.jumpTarget
    expect(first).toMatchObject({ runId: RUN, idx: 120 })
    expect(typeof first!.nonce).toBe('number')

    // A second jump (even to a different target) must carry a DISTINCT nonce so a
    // repeat jump re-fires the view's scroll/highlight rather than being deduped.
    await act(async () => { await result.current.jumpTo({ runId: RUN, idx: 300 }) })
    await flush()
    const second = result.current.jumpTarget
    expect(second).toMatchObject({ runId: RUN, idx: 300 })
    expect(second!.nonce).not.toBe(first!.nonce)
  })

  it('clears jumpTarget when the scope re-initializes (no stale highlight target)', async () => {
    // A host that re-runs the hook with a SWAPPABLE scope so we exercise the
    // in-place scope re-init path (configId<->sessionId, sk changes) WITHOUT a
    // remount — the case GlobalLogsView's keyed panel hides but ChatTranscript /
    // LogsPane allow. A stale jumpTarget here could scroll/flash the wrong row
    // (runIds are per-transcript, not globally unique).
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const result = { current: undefined as unknown as ReturnType<typeof useWindowedTurns> }
    const Host: React.FC<{ scope: Parameters<typeof useWindowedTurns>[0] }> = ({ scope }) => {
      result.current = useWindowedTurns(scope)
      return null
    }
    act(() => { root.render(<Host scope={{ sessionId: 's1' }} />) })
    await flush()
    await act(async () => { await result.current.jumpTo({ runId: RUN, idx: 200 }) })
    await flush()
    expect(result.current.jumpTarget).not.toBeNull()

    // Re-init on a DIFFERENT scope must wipe the stale jump target.
    act(() => { root.render(<Host scope={{ sessionId: 's2' }} />) })
    await flush()
    expect(result.current.jumpTarget).toBeNull()

    act(() => root.unmount())
    container.remove()
  })

  it('jumpTo to idx 0 still includes the target (idx-1 = -1 newer anchor)', async () => {
    const { result } = renderHook(() => useWindowedTurns(SCOPE))
    await flush()
    await act(async () => {
      await result.current.jumpTo({ runId: RUN, idx: 0 })
    })
    await flush()
    const msgs = result.current.messages
    expect(msgs.some((m) => m.idx === 0)).toBe(true)
    expect(msgs[0].idx).toBe(0)
  })

  it('unsubscribes from onNewMessages on unmount', async () => {
    const { unmount } = renderHook(() => useWindowedTurns(SCOPE))
    await flush()
    unmount()
    expect(unsub).toHaveBeenCalledTimes(1)
  })

  it('does not throw if readMessages rejects (empty, not crashed)', async () => {
    readMessages.mockRejectedValueOnce(new Error('worker down'))
    const { result } = renderHook(() => useWindowedTurns(SCOPE))
    await flush()
    expect(result.current.messages).toEqual([])
    expect(result.current.error).toBeTruthy()
  })

  it('dedups: the same (runId,idx) is not double-rendered across pages', async () => {
    const { result } = renderHook(() => useWindowedTurns(SCOPE))
    await flush()
    await act(async () => {
      await result.current.loadOlder()
    })
    await flush()
    const ids = result.current.messages.map((m) => `${m.runId}:${m.idx}`)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
