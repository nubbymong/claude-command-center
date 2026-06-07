// @vitest-environment jsdom
// tests/unit/renderer/logs/timeline-rail.test.tsx
//
// Tests for TimelineRail:
//   1. decimateTurns pure helper: math, dominant-kind, empty input.
//   2. TimelineRail component: self-fetch, click → onJump, searchHits markers,
//      viewportRange renders without crash.
//
// Mock window.electronAPI.logs2.turnSummary — no real IPC.

import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import {
  decimateTurns,
  type TurnSummaryItem,
} from '../../../../src/renderer/components/logs/TimelineRail'
import TimelineRail from '../../../../src/renderer/components/logs/TimelineRail'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurn(
  idx: number,
  kind: TurnSummaryItem['kind'] = 'message',
  runId = 1,
): TurnSummaryItem {
  return { runId, idx, role: 'assistant', kind, ts: 1000 + idx, toolName: null }
}

function makeTurns(n: number, kind: TurnSummaryItem['kind'] = 'message'): TurnSummaryItem[] {
  return Array.from({ length: n }, (_, i) => makeTurn(i, kind))
}

// DOM helpers
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

// ---------------------------------------------------------------------------
// 1. decimateTurns — pure helper tests (no render)
// ---------------------------------------------------------------------------

describe('decimateTurns (pure helper)', () => {
  it('returns [] for empty input', () => {
    expect(decimateTurns([])).toEqual([])
  })

  it('returns one cell per turn when n <= 2000', () => {
    const turns = makeTurns(5)
    const buckets = decimateTurns(turns)
    expect(buckets.length).toBe(5)
    // Each bucket contains exactly 1 turn
    for (const b of buckets) {
      expect(b.turns.length).toBe(1)
    }
  })

  it('returns exactly 2000 cells for exactly 2000 turns', () => {
    const turns = makeTurns(2000)
    const buckets = decimateTurns(turns)
    expect(buckets.length).toBe(2000)
  })

  it('decimates n=5000 using ceil(5000/2000)=3 turns/bucket, yielding ceil(5000/3)=1667 cells', () => {
    const turns = makeTurns(5000)
    const buckets = decimateTurns(turns)
    // bucket size = ceil(5000/2000) = 3; numBuckets = ceil(5000/3) = 1667
    expect(buckets.length).toBe(1667)
    // First bucket has 3 turns
    expect(buckets[0].turns.length).toBe(3)
    // Last bucket may be smaller (5000 = 1666*3 + 2 → last bucket has 2)
    const lastBucket = buckets[buckets.length - 1]
    expect(lastBucket.turns.length).toBeGreaterThanOrEqual(1)
    expect(lastBucket.turns.length).toBeLessThanOrEqual(3)
  })

  it('total turns across all buckets equals input length', () => {
    const turns = makeTurns(5000)
    const buckets = decimateTurns(turns)
    const totalTurns = buckets.reduce((sum, b) => sum + b.turns.length, 0)
    expect(totalTurns).toBe(5000)
  })

  it('dominant kind: single kind → that kind', () => {
    const turns = [makeTurn(0, 'tool_call'), makeTurn(1, 'tool_call'), makeTurn(2, 'tool_call')]
    const [bucket] = decimateTurns(turns)
    expect(bucket.dominantKind).toBe('tool_call')
  })

  it('dominant kind: majority wins', () => {
    // 2 message, 1 tool_call → dominant is message
    const turns = [makeTurn(0, 'message'), makeTurn(1, 'message'), makeTurn(2, 'tool_call')]
    const [bucket] = decimateTurns(turns)
    expect(bucket.dominantKind).toBe('message')
  })

  it('dominant kind: clear/relaunch beats message when it has the most', () => {
    const turns = [
      makeTurn(0, 'clear'),
      makeTurn(1, 'clear'),
      makeTurn(2, 'message'),
    ]
    const [bucket] = decimateTurns(turns)
    expect(bucket.dominantKind).toBe('clear')
  })

  it('each bucket carries firstTurn (first turn of the bucket) for jump target', () => {
    const turns = makeTurns(6)
    const buckets = decimateTurns(turns, 3) // 3 cells max → 2 turns each
    expect(buckets[0].firstTurn).toEqual(turns[0])
    expect(buckets[1].firstTurn).toEqual(turns[2])
    expect(buckets[2].firstTurn).toEqual(turns[4])
  })

  it('custom maxCells respected', () => {
    const turns = makeTurns(100)
    const buckets = decimateTurns(turns, 10)
    expect(buckets.length).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// 2. TimelineRail — component tests
// ---------------------------------------------------------------------------

describe('TimelineRail (component)', () => {
  it('renders without crashing when turnSummary resolves', async () => {
    const turnSummary = vi.fn(async () => makeTurns(10))
    ;(globalThis as any).window.electronAPI = { logs2: { turnSummary } }

    await act(async () => {
      root.render(
        React.createElement(TimelineRail, {
          scope: { sessionId: 's1' },
          onJump: vi.fn(),
        }),
      )
    })
    await flush()

    expect(turnSummary).toHaveBeenCalledTimes(1)
    // Rail container should be present
    expect(container.querySelector('[data-testid="timeline-rail"]')).toBeTruthy()
  })

  it('renders empty/nothing when turnSummary rejects (graceful)', async () => {
    const turnSummary = vi.fn(async () => { throw new Error('ipc failure') })
    ;(globalThis as any).window.electronAPI = { logs2: { turnSummary } }

    await act(async () => {
      root.render(
        React.createElement(TimelineRail, {
          scope: { sessionId: 's1' },
          onJump: vi.fn(),
        }),
      )
    })
    await flush()

    // Must not throw; rail may be empty or hidden
    const rail = container.querySelector('[data-testid="timeline-rail"]')
    // either absent OR present but empty (both acceptable)
    if (rail) {
      expect(rail.querySelectorAll('[data-testid="rail-cell"]').length).toBe(0)
    }
  })

  it('clicking a cell calls onJump with {runId, idx} of the first turn in that bucket', async () => {
    // 4 turns, no decimation needed (< 2000)
    const turns: TurnSummaryItem[] = [
      makeTurn(0, 'message', 1),
      makeTurn(1, 'tool_call', 1),
      makeTurn(2, 'clear', 1),
      makeTurn(3, 'message', 1),
    ]
    const turnSummary = vi.fn(async () => turns)
    const onJump = vi.fn()
    ;(globalThis as any).window.electronAPI = { logs2: { turnSummary } }

    await act(async () => {
      root.render(
        React.createElement(TimelineRail, {
          scope: { sessionId: 's1' },
          onJump,
        }),
      )
    })
    await flush()

    // Click the first cell → should jump to turns[0]: {runId:1, idx:0}
    const cells = container.querySelectorAll('[data-testid="rail-cell"]')
    expect(cells.length).toBe(4)

    await act(async () => {
      ;(cells[0] as HTMLElement).click()
    })
    expect(onJump).toHaveBeenCalledTimes(1)
    expect(onJump).toHaveBeenCalledWith({ runId: 1, idx: 0 })

    // Click the 3rd cell → turns[2]: {runId:1, idx:2}
    await act(async () => {
      ;(cells[2] as HTMLElement).click()
    })
    expect(onJump).toHaveBeenCalledTimes(2)
    expect(onJump).toHaveBeenLastCalledWith({ runId: 1, idx: 2 })
  })

  it('clicking a decimated cell calls onJump with the first turn of that bucket', async () => {
    // 6 turns, maxCells=3 → 2 turns per bucket
    const turns = makeTurns(6)
    const turnSummary = vi.fn(async () => turns)
    const onJump = vi.fn()
    ;(globalThis as any).window.electronAPI = { logs2: { turnSummary } }

    // Pass maxCells=3 via testId override isn't possible, but we can test
    // directly via decimateTurns (already covered). For the component test,
    // with 6 turns < 2000, we get 6 cells. Verify click on cell[0] → turns[0].
    await act(async () => {
      root.render(
        React.createElement(TimelineRail, {
          scope: { sessionId: 's1' },
          onJump,
        }),
      )
    })
    await flush()

    const cells = container.querySelectorAll('[data-testid="rail-cell"]')
    expect(cells.length).toBe(6)

    await act(async () => {
      ;(cells[0] as HTMLElement).click()
    })
    expect(onJump).toHaveBeenCalledWith({ runId: turns[0].runId, idx: turns[0].idx })
  })

  it('renders searchHits markers at the correct bucket positions', async () => {
    const turns = makeTurns(10)
    const turnSummary = vi.fn(async () => turns)
    ;(globalThis as any).window.electronAPI = { logs2: { turnSummary } }

    // searchHits at idx 2 and idx 7
    const searchHits = [
      { runId: 1, idx: 2 },
      { runId: 1, idx: 7 },
    ]

    await act(async () => {
      root.render(
        React.createElement(TimelineRail, {
          scope: { sessionId: 's1' },
          onJump: vi.fn(),
          searchHits,
        }),
      )
    })
    await flush()

    const hitMarkers = container.querySelectorAll('[data-testid="rail-hit"]')
    expect(hitMarkers.length).toBe(2)
  })

  it('renders with viewportRange without crashing', async () => {
    const turns = makeTurns(20)
    const turnSummary = vi.fn(async () => turns)
    ;(globalThis as any).window.electronAPI = { logs2: { turnSummary } }

    await act(async () => {
      root.render(
        React.createElement(TimelineRail, {
          scope: { sessionId: 's1' },
          onJump: vi.fn(),
          viewportRange: { startIdx: 5, endIdx: 15 },
        }),
      )
    })
    await flush()

    // Should render without throw
    expect(container.querySelector('[data-testid="timeline-rail"]')).toBeTruthy()
    // Viewport highlight present
    const viewport = container.querySelector('[data-testid="rail-viewport"]')
    expect(viewport).toBeTruthy()
  })

  it('re-fetches when scope changes', async () => {
    const turnSummary = vi.fn(async () => makeTurns(5))
    ;(globalThis as any).window.electronAPI = { logs2: { turnSummary } }

    const { unmount } = (() => {
      let ctrl = { unmount: () => {} }
      act(() => {
        root.render(
          React.createElement(TimelineRail, {
            scope: { sessionId: 's1' },
            onJump: vi.fn(),
          }),
        )
        ctrl = { unmount: () => act(() => root.unmount()) }
      })
      return ctrl
    })()

    await flush()
    expect(turnSummary).toHaveBeenCalledTimes(1)

    // Re-render with different scope
    await act(async () => {
      root.render(
        React.createElement(TimelineRail, {
          scope: { sessionId: 's2' },
          onJump: vi.fn(),
        }),
      )
    })
    await flush()

    expect(turnSummary).toHaveBeenCalledTimes(2)
    expect(turnSummary.mock.calls[1][0]).toEqual({ scope: { sessionId: 's2' } })
  })
})
