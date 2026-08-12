// The review payload's wire text (§4.1 discipline). Everything it emits goes
// INSIDE the envelope — so these tests pin structure and numbering, and that
// nothing here pretends to escape (the envelope owns defanging).

import { describe, it, expect } from 'vitest'
import type { Annotation, ReviewPayload } from '../../../src/shared/canvas'
import { serializeReviewPayload } from '../../../src/shared/canvas-review-serialize'

function note(overrides: Partial<Annotation>): Annotation {
  return {
    id: 'a1',
    reviewId: 'R1',
    scope: 'general',
    note: 'a note',
    versionId: 'v2',
    state: 'open',
    ...overrides,
  }
}

function payload(annotations: Annotation[], generalNotes: Annotation[]): ReviewPayload {
  return {
    review: {
      id: 'R1',
      canvas: { sessionId: 's', canvasId: 'c' },
      versionId: 'v2',
      annotationIds: [...annotations, ...generalNotes].map((a) => a.id),
      status: 'submitted',
      createdAt: 'now',
    },
    annotations,
    generalNotes,
    attachments: [],
    envelope: 'untrusted-content',
  }
}

describe('serializeReviewPayload', () => {
  it('lays out an element note with target, anchors, note text, and its image number', () => {
    const a = note({
      scope: 'element',
      note: 'too small',
      focus: {
        targets: [
          { kind: 'ux-id', id: 'save' },
          { kind: 'fingerprint', role: 'button', name: 'Save', ancestorPath: 'main>form', ordinal: 2 },
        ],
        bboxPage: { x: 10.4, y: 19.6, width: 100, height: 30 },
        label: 'button "Save"',
        versionId: 'v2',
      },
      sketch: { excalidrawElementIds: ['e1'], pngPath: 'reviews/R1/a1.png', bboxPage: { x: 1, y: 2, width: 3, height: 4 } },
    })
    const { text } = serializeReviewPayload(payload([a], []), ['a1'])
    expect(text).toContain('- a1 [element] [open] on v2')
    expect(text).toContain('target: button "Save" [box=10,20,100,30]')
    expect(text).toContain('anchors: ux-id save; fingerprint role="button" name="Save" path="main>form" ordinal=2')
    expect(text).toContain('note: too small')
    expect(text).toContain('sketch: attached as image 1 [box=1,2,3,4]')
  })

  it('renders regions with their box, generals in their own section, and indents multi-line notes', () => {
    const region = note({
      id: 'a2',
      scope: 'region',
      note: 'crowded corner',
      focus: { targets: [], bboxPage: { x: 0, y: 0, width: 420, height: 180 }, label: 'region 420×180', versionId: 'v2' },
    })
    const general = note({ id: 'a3', note: 'line one\nline two' })
    const { text } = serializeReviewPayload(payload([region], [general]), [])
    expect(text).toContain('region: region 420×180 [box=0,0,420,180]')
    expect(text).toContain('general notes:')
    expect(text).toContain('note: line one\n      line two')
  })

  it('marks a superseded note and says when a review is empty', () => {
    const superseded = note({ state: 'reannotated', supersededBy: 'a9' })
    expect(serializeReviewPayload(payload([], [superseded]), []).text).toContain('superseded-by: a9')
    expect(serializeReviewPayload(payload([], []), []).text).toContain('no notes')
  })

  it('numbers images by the attachment order it is HANDED, not by note order', () => {
    const first = note({ id: 'a1', sketch: { excalidrawElementIds: ['e'], pngPath: 'p1', bboxPage: { x: 0, y: 0, width: 1, height: 1 } } })
    const second = note({ id: 'a2', sketch: { excalidrawElementIds: ['e'], pngPath: 'p2', bboxPage: { x: 0, y: 0, width: 1, height: 1 } } })
    // a1's file failed to load: only a2 made it into the reply.
    const { text } = serializeReviewPayload(payload([], [first, second]), ['a2'])
    expect(text).not.toContain('a1.png')
    expect(text).toMatch(/- a2[\s\S]*attached as image 1/)
    // a1 carries no image line at all.
    expect(text.split('- a2')[0]).not.toContain('attached as image')
  })
})
