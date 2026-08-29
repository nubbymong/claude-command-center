// @vitest-environment jsdom
//
// The recall view (M3): a submitted test run, read back as evidence.
//
// The load-bearing claim is the one in the banner — the live site is not stored
// and is not needed. So this file pins that the view never mounts a frame, that
// every picture comes from the evidence read channel, and that everything the
// PAGE said about itself is still marked as the page's word weeks later.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { Annotation, CanvasVersion } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { CanvasEvidenceRecall } = await import('../../../src/renderer/components/CanvasEvidenceRecall')

const SID = 'session-1'
const CID = 'canvas-a'

const version: CanvasVersion = {
  id: 'v4',
  mode: 'uat',
  createdAt: '2026-08-29T10:00:00Z',
  source: { mode: 'uat', distRoot: 'C:/build', entry: 'index.html', buildLabel: '5' },
  verdict: { state: 'rejected', at: '2026-08-29T17:00:00Z', by: 'user' },
} as CanvasVersion

function evidenceNote(id: string, over: Partial<Annotation> = {}): Annotation {
  return {
    id,
    reviewId: 'R1',
    scope: 'general',
    note: `note ${id}`,
    versionId: 'v4',
    state: 'open',
    evidence: {
      shotPath: `reviews/evidence/${id}.png`,
      width: 800,
      height: 600,
      stamp: {
        capturedAt: '2026-08-29T16:44:02.000Z',
        route: '/checkout',
        title: 'Checkout',
        viewport: { width: 800, height: 600, scrollX: 0, scrollY: 100, dpr: 1, zoom: 1 },
        dialogs: [{ role: 'dialog', name: 'Confirm order' }],
        fields: [
          { role: 'textbox', name: 'Email', fill: 'filled' },
          { role: 'textbox', name: 'Card', fill: 'invalid' },
        ],
      },
      trail: [
        { at: '2026-08-29T16:43:58.000Z', gapMs: 0, kind: 'click', target: { role: 'button', name: 'Checkout' } },
        { at: '2026-08-29T16:44:01.000Z', gapMs: 3100, kind: 'typed', target: { role: 'textbox', name: 'Email' } },
        { at: '2026-08-29T16:44:02.000Z', gapMs: 800, kind: 'note', annotationId: id },
      ],
    },
    ...over,
  } as unknown as Annotation
}

const reads: string[] = []
const evidenceRead = vi.fn(async ({ path }: { path: string }) => {
  reads.push(path)
  return { dataUrl: `data:image/png;base64,${path}` }
})

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: { ...((globalThis as any).window?.electronAPI?.canvas ?? {}), evidenceRead },
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  reads.length = 0
  evidenceRead.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const q = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`)

async function render(notes: Annotation[], over: Partial<React.ComponentProps<typeof CanvasEvidenceRecall>> = {}): Promise<void> {
  await act(async () => {
    root.render(
      <CanvasEvidenceRecall
        sessionId={SID}
        canvasId={CID}
        version={version}
        packName="Checkout flow · build 5 · 29 Aug"
        verdict="FAILED"
        notes={notes}
        observations={false}
        backLabel="Library"
        onBack={() => {}}
        onClose={() => {}}
        {...over}
      />,
    )
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('the pack, read back', () => {
  it('shows the pack, the outcome and the promise that the site is not needed', async () => {
    await render([evidenceNote('a1')])
    expect(q('canvas-recall-pack-name')!.textContent).toBe('Checkout flow · build 5 · 29 Aug')
    expect(q('canvas-recall-verdict')!.textContent).toBe('FAILED')
    expect(q('canvas-recall-banner')!.textContent).toContain('the live site is not stored')
  })

  it('never mounts a frame — the evidence IS the artefact', async () => {
    await render([evidenceNote('a1')])
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('webview')).toBeNull()
  })

  it('paints the captured screen from the evidence channel, with its capture time', async () => {
    await render([evidenceNote('a1')])
    expect(reads).toContain('reviews/evidence/a1.png')
    const img = q('canvas-recall-shot')!.querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toContain('reviews/evidence/a1.png')
    expect(q('canvas-recall-captured-at')!.textContent).toMatch(/^captured \d\d:\d\d:02$/)
  })

  it('lays the drawing back over the shot at the box it was drawn in', async () => {
    const note = evidenceNote('a1', {
      sketch: { excalidrawElementIds: ['s1'], pngPath: 'reviews/R1/a1.png', bboxPage: { x: 80, y: 200, width: 400, height: 150 } },
    } as Partial<Annotation>)
    await render([note])
    const sketch = q('canvas-recall-sketch') as HTMLImageElement
    expect(sketch).not.toBeNull()
    // Per cent of the STAMPED viewport, with the stamped scroll taken off — so
    // the mark stays on what it marked however the pane is resized later.
    expect(sketch.style.left).toBe('10%')
    expect(sketch.style.top).toBe(`${((200 - 100) / 600) * 100}%`)
    expect(sketch.style.width).toBe('50%')
    expect(reads).toContain('reviews/R1/a1.png')
  })

  it('summarises the page state as chips, and marks the page`s own words', async () => {
    await render([evidenceNote('a1')])
    const chips = q('canvas-recall-state')!
    expect(chips.textContent).toContain('route /checkout')
    expect(chips.textContent).toContain('dialog open')
    expect(chips.textContent).toContain('1 field filled')
    expect(chips.textContent).toContain('1 invalid')
    // The route is the page's claim; the counts are ours.
    const routeChip = Array.from(chips.children).find((c) => c.textContent?.includes('/checkout')) as HTMLElement
    expect(routeChip.textContent).toContain('page-reported')
    const countChip = Array.from(chips.children).find((c) => c.textContent?.includes('field filled')) as HTMLElement
    expect(countChip.textContent).not.toContain('page-reported')
  })

  it('reads the trail back as timed lines', async () => {
    await render([evidenceNote('a1')])
    const trail = q('canvas-recall-trail')!.textContent ?? ''
    expect(trail).toContain('click')
    expect(trail).toContain('Checkout')
    expect(trail).toContain('typed into')
    expect(trail).toContain('note saved')
    expect(trail).toMatch(/\d\d:\d\d:58/)
    // Nothing about what was typed, only which field.
    expect(trail).not.toContain('valueLength')
  })

  it('carries a note`s pasted images as their own tiles', async () => {
    await render([evidenceNote('a1', { images: [{ pngPath: 'reviews/pasted/a1-0.png' }] } as Partial<Annotation>)])
    expect(reads).toContain('reviews/pasted/a1-0.png')
    expect(q('canvas-recall-image-1')).not.toBeNull()
  })
})

describe('stepping through the run', () => {
  it('counts the notes and walks them with the arrows', async () => {
    await render([evidenceNote('a1'), evidenceNote('a2'), evidenceNote('a3')])
    expect(q('canvas-recall-stepper')!.textContent).toContain('note 1 of 3')
    expect((q('canvas-recall-prev') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      q('canvas-recall-next')!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(q('canvas-recall-stepper')!.textContent).toContain('note 2 of 3')
    expect(reads).toContain('reviews/evidence/a2.png')
  })

  it('walks with ArrowLeft / ArrowRight too', async () => {
    await render([evidenceNote('a1'), evidenceNote('a2')])
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
      await Promise.resolve()
    })
    expect(q('canvas-recall-stepper')!.textContent).toContain('note 2 of 2')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
      await Promise.resolve()
    })
    expect(q('canvas-recall-stepper')!.textContent).toContain('note 1 of 2')
  })

  it('calls a note a defect on a failed run and an observation on a passed one', async () => {
    await render([evidenceNote('a1')])
    expect(q('canvas-recall-note-meta')!.textContent).toContain('defect')

    await render([evidenceNote('a1')], { observations: true, verdict: 'PASSED WITH OBSERVATIONS' })
    expect(q('canvas-recall-note-meta')!.textContent).toContain('observation')
  })
})

describe('the honest gaps', () => {
  it('says so when a note has no saved screen — a legacy note is not a broken one', async () => {
    const legacy = { id: 'a9', reviewId: 'R1', scope: 'general', note: 'old note', versionId: 'v4', state: 'open' } as Annotation
    await render([legacy])
    expect(q('canvas-recall-no-shot')!.textContent).toContain('No screen was saved with this note')
    expect(q('canvas-recall-trail')).toBeNull()
  })

  it('says so when the file cannot be read, rather than showing an empty box', async () => {
    evidenceRead.mockResolvedValueOnce(null as never)
    await render([evidenceNote('a1')])
    expect(q('canvas-recall-no-shot')!.textContent).toContain('could not be read')
  })

  it('has something to say for a run submitted with no notes at all', async () => {
    await render([])
    expect(q('canvas-recall-empty')!.textContent).toContain('submitted with no notes')
    expect(q('canvas-recall-stepper')).toBeNull()
  })
})
