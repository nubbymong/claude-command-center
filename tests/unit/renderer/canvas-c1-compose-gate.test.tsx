// @vitest-environment jsdom
//
// C1 compose gate (owner state machine, 2026-08-26): a review IS a verdict on
// the displayed version. Approve/Reject sit at compose time, a reject demands
// a note, Submit stays dead until the decision is made and arms visibly, and
// a decided version takes no further review.
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
const OPEN_VERSION: CanvasVersion = {
  id: 'v3',
  mode: 'design',
  createdAt: '2026-08-26T10:00:00Z',
  source: { mode: 'design', entry: 'index.html' },
} as CanvasVersion
const DECIDED_VERSION: CanvasVersion = {
  ...OPEN_VERSION,
  verdict: { state: 'approved', by: 'user', at: '2026-08-26T11:00:00Z' },
} as CanvasVersion

function draftState(canvasId: string, noteTexts: string[]): CanvasReviewState {
  const reviews: Review[] = []
  const annotations: Annotation[] = []
  if (noteTexts.length > 0) {
    reviews.push({
      id: 'R1',
      canvas: { canvasId, versionId: 'v3' } as Review['canvas'],
      versionId: 'v3',
      annotationIds: noteTexts.map((_, i) => `a${i + 1}`),
      status: 'draft',
      createdAt: '2026-08-26T10:05:00Z',
    })
    noteTexts.forEach((text, i) => {
      annotations.push({ id: `a${i + 1}`, reviewId: 'R1', scope: 'general', note: text, versionId: 'v3', state: 'open' })
    })
  }
  return { canvasId, sessionId: SID, reviews, annotations }
}

let current: CanvasReviewState = draftState('canvas-a', [])
const versionVerdict = vi.fn(async () => ({ canvasId: 'canvas-a' }))
const reviewSubmit = vi.fn()

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: vi.fn() },
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    reviewGetState: vi.fn(async () => current),
    versionVerdict,
    reviewSubmit,
  },
}

let container: HTMLDivElement
let root: Root

async function render(version: CanvasVersion = OPEN_VERSION): Promise<void> {
  await act(async () => {
    root.render(
      <CanvasNotesPanel sessionId={SID} version={version} getGlassApi={() => null} onReturnToTerminal={() => {}} {...paneSketchProps()} canvasId={CID} isActive={false} />,
    )
  })
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
/** Submit says what it FILES rather than the bare word, so it is found by its
 *  testid — the label itself is what the assertions below read. */
const submit = () => q('canvas-submit') as HTMLButtonElement

beforeEach(() => {
  current = draftState('canvas-a', [])
  versionVerdict.mockClear()
  reviewSubmit.mockClear()
  useCanvasReviewStore.getState().reset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('the decision gate', () => {
  it('opens undecided: Approve and Reject shown, Submit dead', async () => {
    await render()
    expect(q('decision-row')).not.toBeNull()
    expect(q('decision-approve')).not.toBeNull()
    expect(q('decision-reject')).not.toBeNull()
    expect(submit().disabled).toBe(true)
  })

  it('a plain Approve arms Submit with zero notes, and files the version verdict (no review record)', async () => {
    await render()
    act(() => q('decision-approve')!.click())
    const btn = submit()
    expect(btn.disabled).toBe(false)
    expect(btn.textContent).toBe('Submit — Approve v3')
    await act(async () => { btn.click(); await new Promise((r) => setTimeout(r, 0)) })
    expect(versionVerdict).toHaveBeenCalledWith({ sessionId: SID, versionId: 'v3', state: 'approved' })
    expect(reviewSubmit).not.toHaveBeenCalled()
  })

  it('Reject with no note stays dead and says why; a note arms it', async () => {
    await render()
    act(() => q('decision-reject')!.click())
    expect(submit().disabled).toBe(true)
    expect(q('reject-needs-note')).not.toBeNull()
    current = draftState('canvas-a', ['the tagline is off'])
    await act(async () => {
      useCanvasReviewStore.setState((s) => ({ bySessionId: { ...s.bySessionId, [SID]: { ...s.bySessionId[SID], ...current } } }))
    })
    await render() // decision 'reject' still armed — the note arriving is what arms Submit
    const btn = submit()
    expect(btn.disabled).toBe(false)
    expect(btn.textContent).toBe('Submit — Reject v3, 1 note')
    expect(q('reject-needs-note')).toBeNull()
  })

  it('a decided version takes no review: no composer, no decision row, and a line saying why', async () => {
    await render(DECIDED_VERSION)
    expect(q('decision-row')).toBeNull()
    // Never a dead compose area, and never "already decided (rejected)" — the
    // line says what happened in the words the user used, and what follows.
    const line = q('canvas-version-closed-line')!
    expect(line.textContent).toContain('v3 is approved')
    expect(container.textContent).not.toContain('already decided')
    expect(submit()).toBeNull()
    expect(q('composer-textarea')).toBeNull()
  })
})
