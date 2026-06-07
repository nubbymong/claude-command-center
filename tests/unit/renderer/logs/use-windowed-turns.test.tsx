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

// Serve a window of the synthetic transcript according to anchor/dir.
//  - anchor 'tail'         → the last PAGE_SIZE messages
//  - anchor {runId,idx} older → the PAGE_SIZE messages STRICTLY before idx
//  - anchor {runId,idx} newer → the PAGE_SIZE messages STRICTLY after idx
//  - anchor {runId,idx} (no dir / jump) → a centered window around idx
function serve(args: {
  scope: unknown
  anchor?: 'tail' | { runId: number; idx: number }
  dir?: 'older' | 'newer'
  limit?: number
}): Logs2Message[] {
  const limit = args.limit ?? PAGE_SIZE
  if (!args.anchor || args.anchor === 'tail') {
    return ALL.slice(Math.max(0, TOTAL - limit))
  }
  const { idx } = args.anchor
  if (args.dir === 'older') {
    const end = idx // strictly before
    return ALL.slice(Math.max(0, end - limit), end)
  }
  if (args.dir === 'newer') {
    const start = idx + 1 // strictly after
    return ALL.slice(start, start + limit)
  }
  // Jump: centered window around idx.
  const half = Math.floor(limit / 2)
  return ALL.slice(Math.max(0, idx - half), Math.min(TOTAL, idx + half))
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

  it('jumpTo loads a window centered on the idx and turns follow OFF', async () => {
    const { result } = renderHook(() => useWindowedTurns(SCOPE))
    await flush()
    const target = 250
    await act(async () => {
      await result.current.jumpTo({ runId: RUN, idx: target })
    })
    await flush()
    const jumpArgs = readMessages.mock.calls[readMessages.mock.calls.length - 1][0]
    expect(jumpArgs.anchor).toEqual({ runId: RUN, idx: target })
    expect(result.current.follow).toBe(false)
    const msgs = result.current.messages
    // The window contains the target idx.
    expect(msgs.some((m) => m.idx === target)).toBe(true)
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
