// @vitest-environment jsdom
//
// The SEEN REPORT — the release side of the agent's close-out barrier (#365).
//
// The store refuses to let `canvas_verdict` close a note the user has not seen
// in its addressed state, and this panel is the ONLY thing in the system that
// can say they have: no MCP tool reaches that channel. What it reports, and
// when, is therefore a security property rather than a nicety, and every
// condition below is one an agent must not be able to satisfy on the user's
// behalf:
//
//  - a DWELL, because a row that flashed past during a re-render was not read;
//  - the ACTIVE session, because every session mounts its own pane and the
//    inactive ones are merely hidden with CSS — mounted is not seen;
//  - a VISIBLE window, because a minimised one shows nobody anything;
//  - and no re-reporting, because the report's own commit refreshes the panel
//    and a report per refresh is a loop.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { Annotation, CanvasReviewState, CanvasVersion, Review } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@excalidraw/excalidraw', () => ({ exportToBlob: vi.fn() }))

import { paneSketchProps } from './canvas-panel-harness'
const CanvasNotesPanel = (await import('../../../src/renderer/components/CanvasNotesPanel')).default
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')

const SID = 'session-1'
const CID = 'canvas-a'
const VERSION: CanvasVersion = {
  id: 'v1',
  mode: 'design',
  createdAt: '2026-08-22T10:00:00Z',
  source: { mode: 'design', entry: 'index.html' },
} as CanvasVersion

const review = (id: string, status: Review['status'], ids: string[]): Review => ({
  id,
  canvas: { canvasId: 'canvas-a', sessionId: SID },
  versionId: 'v1',
  annotationIds: ids,
  status,
  createdAt: '2026-08-22T09:01:00Z',
  submittedAt: '2026-08-22T09:01:30Z',
})

const note = (id: string, reviewId: string, state: Annotation['state']): Annotation => ({
  id,
  reviewId,
  scope: 'general',
  note: `text of ${id}`,
  versionId: 'v1',
  state,
})

/** One round the agent has addressed (a1, a2) and one note still open (a3). */
function board(): CanvasReviewState {
  return {
    canvasId: 'canvas-a',
    sessionId: SID,
    reviews: [review('R1', 'submitted', ['a1', 'a2']), review('R2', 'submitted', ['a3'])],
    annotations: [note('a1', 'R1', 'addressed'), note('a2', 'R1', 'addressed'), note('a3', 'R2', 'open')],
  }
}

let current: CanvasReviewState
let container: HTMLDivElement
let root: Root
/** Every "the user has these on screen" report the panel sent, in order. */
let seenReports: Array<{ canvasId: string; annotationIds: string[] }>

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: vi.fn() },
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    reviewGetState: vi.fn(async () => current),
    reviewMarkSeen: vi.fn(async ({ canvasId, annotationIds }: { canvasId: string; annotationIds: string[] }) => {
      seenReports.push({ canvasId, annotationIds })
      const marked = new Set(annotationIds)
      current = {
        ...current,
        annotations: current.annotations.map((a) => (marked.has(a.id) ? { ...a, userSawAddressed: true } : a)),
      }
      return { state: current, seen: annotationIds }
    }),
  },
}

/** `isActive` defaults to FALSE — the value that claims the user has seen
 *  nothing — so a test has to ask for the release explicitly. */
async function render(isActive = false): Promise<void> {
  await act(async () => {
    root.render(
      <CanvasNotesPanel
        {...paneSketchProps()}
        canvasId={CID}
        sessionId={SID}
        version={VERSION}
        getGlassApi={() => null}
        onReturnToTerminal={() => {}}
        isActive={isActive}
      />,
    )
  })
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
  await act(async () => {})
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  current = board()
  seenReports = []
  useCanvasReviewStore.getState().reset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('the seen report', () => {
  it('reports the addressed notes once the user has had them on screen', async () => {
    await render(true)
    // Not immediately: the claim is that somebody READ the round.
    expect(seenReports).toEqual([])
    await settle(2000)
    expect(seenReports).toHaveLength(1)
    expect(seenReports[0].canvasId).toBe('canvas-a')
    // Every addressed note, and no open one — there is nothing addressed about
    // a3 for the user to have seen.
    expect([...seenReports[0].annotationIds].sort()).toEqual(['a1', 'a2'])
    expect(seenReports[0].annotationIds).not.toContain('a3')
  })

  it('reports NOTHING when this session is not the one on screen', async () => {
    // The whole barrier rests on this: an agent working in a background session
    // must not have its round marked seen because the pane happens to be
    // mounted behind another view.
    await render(false)
    await settle(10_000)
    expect(seenReports).toEqual([])
  })

  it('reports nothing while the window is hidden', async () => {
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      await render(true)
      document.dispatchEvent(new Event('visibilitychange'))
      await settle(10_000)
      expect(seenReports).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('does not report a round that was on screen for only an instant', async () => {
    await render(true)
    // Half the dwell, then the user switches away.
    await act(async () => {
      vi.advanceTimersByTime(700)
    })
    await render(false)
    await settle(10_000)
    expect(seenReports).toEqual([])
  })

  it('does not re-report notes already marked seen', async () => {
    await render(true)
    await settle(2000)
    expect(seenReports).toHaveLength(1)
    // The report's own commit refreshes the panel; the steady state must be an
    // empty set and no further IPC, or the effect feeds itself forever.
    await settle(10_000)
    expect(seenReports).toHaveLength(1)
  })
})
