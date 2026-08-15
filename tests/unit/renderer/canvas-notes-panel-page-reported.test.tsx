// @vitest-environment jsdom
//
// What the reviewer is TOLD when the page under review lies (adversarial
// review, 2026-08-14).
//
// The resolution checklist used to render "re-anchored" in resolved green
// straight from the frame's own `resolveAnchors` reply — the artifact grading
// its own homework. A page could mark every open issue against it as tracked
// and point the highlight anywhere; the reviewer saw their issues as followed
// up when nothing had been. Same shape for the target labels: 'button "Save"'
// is the page's account of what the user clicked, printed in the app's voice.
//
// These render the REAL panel and read what a person would see.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { Annotation, CanvasReviewState, CanvasVersion, Review } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// The panel imports exportToBlob for submit; the dev ESM of the real package
// does not load under raw Node and nothing here submits.
vi.mock('@excalidraw/excalidraw', () => ({ exportToBlob: vi.fn() }))

const CanvasNotesPanel = (await import('../../../src/renderer/components/CanvasNotesPanel')).default
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')

const SID = 'session-1'
const V2: CanvasVersion = {
  id: 'v2',
  mode: 'design',
  createdAt: '2026-08-14T10:00:00Z',
  source: { mode: 'design', entry: 'index.html' },
} as CanvasVersion

const REVIEW: Review = {
  id: 'R1',
  canvas: { canvasId: 'canvas-1', versionId: 'v1' } as Review['canvas'],
  versionId: 'v1',
  annotationIds: ['a1', 'a2'],
  status: 'submitted',
  createdAt: '2026-08-14T09:00:00Z',
  submittedAt: '2026-08-14T09:05:00Z',
}

/** An element note from an earlier version: the kind the checklist re-anchors,
 *  and the kind whose label the page authored. */
const ELEMENT_NOTE: Annotation = {
  id: 'a1',
  reviewId: 'R1',
  scope: 'element',
  note: 'this button is too small',
  focus: {
    targets: [{ kind: 'ux-id', id: 'save-button' }],
    bboxPage: { x: 10, y: 20, width: 30, height: 40 },
    label: 'button "Save"',
    versionId: 'v1',
  },
  versionId: 'v1',
  state: 'open',
}

/** A region note: its label is the app's own measurement, so it is NOT marked. */
const REGION_NOTE: Annotation = {
  id: 'a2',
  reviewId: 'R1',
  scope: 'region',
  note: 'this whole strip is cramped',
  focus: { targets: [], bboxPage: { x: 0, y: 0, width: 400, height: 100 }, label: 'region 400×100', versionId: 'v1' },
  versionId: 'v1',
  state: 'open',
}

const STATE: CanvasReviewState = {
  canvasId: 'canvas-1',
  sessionId: SID,
  reviews: [REVIEW],
  annotations: [ELEMENT_NOTE, REGION_NOTE],
}

let container: HTMLDivElement
let root: Root

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: vi.fn() },
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    reviewGetState: vi.fn(async () => STATE),
  },
}

/** The page answered "yes, still there" for the open note's anchor, and put the
 *  box somewhere of its own choosing. */
function pageClaimsReanchored(via: 'ux-id' | 'fingerprint' = 'ux-id'): void {
  useCanvasReviewStore.getState().setResolution(SID, {
    versionId: 'v2',
    byAnnotation: {
      a1: { found: true, via, box: { x: 900, y: 900, width: 20, height: 20 }, role: 'button', name: 'Save' },
    },
  })
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <CanvasNotesPanel sessionId={SID} version={V2} getGlassApi={() => null} onReturnToTerminal={() => {}} />,
    )
  })
}

/** The checklist row for the element note — the row itself, not the text node
 *  inside it, so the status badge is part of what it reads. */
function checklistRow(): HTMLElement {
  const row = Array.from(container.querySelectorAll('div')).find(
    (el) => el.textContent?.includes('this button is too small') && el.className.includes('border-t'),
  )
  expect(row, 'checklist row for the open element note').toBeTruthy()
  return row as HTMLElement
}

beforeEach(async () => {
  useCanvasReviewStore.getState().reset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('the checklist never claims resolution on the page’s say-so', () => {
  it('renders a page-asserted re-anchor in the page’s voice, not the app’s', async () => {
    await render()
    await act(async () => {
      pageClaimsReanchored('ux-id')
    })
    const row = checklistRow()
    expect(row.textContent).toContain('page says re-anchored (id)')
    // The word the old UI used, and the one a reviewer reads as "handled".
    expect(row.textContent).not.toMatch(/(^|[^s] )re-anchored/)
  })

  it('says which mechanism the page claims, still in the page’s voice', async () => {
    await render()
    await act(async () => {
      pageClaimsReanchored('fingerprint')
    })
    expect(checklistRow().textContent).toContain('page says re-anchored (fingerprint)')
  })

  it('does not paint a page-asserted anchor in the colour that means resolved', async () => {
    await render()
    await act(async () => {
      pageClaimsReanchored()
    })
    const badge = Array.from(container.querySelectorAll('span')).find((el) =>
      el.textContent?.startsWith('page says re-anchored'),
    )!
    expect(badge).toBeTruthy()
    expect(badge.className).not.toContain('green')
    expect(badge.className).toContain('blue')
    // And it carries the attribution as a tooltip.
    expect(badge.getAttribute('title')).toMatch(/cannot verify/i)
  })

  it('hovering a page-asserted row highlights the stage as REPORTED, not as anchored', async () => {
    await render()
    await act(async () => {
      pageClaimsReanchored()
    })
    await act(async () => {
      checklistRow().dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    const highlight = useCanvasReviewStore.getState().bySessionId[SID]?.panelHighlight
    expect(highlight).toMatchObject({ kind: 'reported', rect: { x: 900, y: 900 } })
  })

  it('still shows an unresolved note as needing re-pointing', async () => {
    await render()
    await act(async () => {
      useCanvasReviewStore.getState().setResolution(SID, { versionId: 'v2', byAnnotation: { a1: null } })
    })
    expect(checklistRow().textContent).toContain('needs re-pointing')
  })
})

describe('page-authored identity is labelled as page-authored', () => {
  it('marks an element note’s label and leaves a region note’s alone', async () => {
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain('page-reported button "Save"')
    expect(text).toContain('region 400×100')
    expect(text).not.toContain('page-reported region')
  })

  it('carries the attribution as a tooltip on the label the page wrote', async () => {
    await render()
    const label = Array.from(container.querySelectorAll('span')).find((el) =>
      el.textContent?.includes('button "Save"'),
    )!
    expect(label.getAttribute('title')).toMatch(/cannot verify/i)
  })
})
