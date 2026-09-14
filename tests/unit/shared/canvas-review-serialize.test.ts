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
    const { text } = serializeReviewPayload(payload([a], []), [{ annotationId: 'a1', kind: 'sketch' }])
    expect(text).toContain('- a1 [element] [open] on v2')
    expect(text).toContain('target: button "Save" [box=10,20,100,30]')
    expect(text).toContain('anchors: ux-id save; fingerprint role="button" name="Save" path="main>form" ordinal=2')
    expect(text).toContain('note: too small')
    // A drawing RIDES its note — the user does not attach it, they draw on the
    // page and it goes with the note they write next. The words say so.
    expect(text).toContain('drawing: rides this note, attached as attachment 1 [box=1,2,3,4]')
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

  it('emits the variants line and, once approved, the chosen winner (#373)', () => {
    const offered = note({
      id: 'a4',
      state: 'addressed',
      variants: [
        { key: 'A', label: 'thin rule' },
        { key: 'B', label: 'no rule' },
      ],
    })
    const picked = note({
      id: 'a5',
      state: 'approved',
      variants: [
        { key: 'A', label: 'left' },
        { key: 'B', label: 'right' },
      ],
      chosenVariantKey: 'B',
    })
    const { text } = serializeReviewPayload(payload([], [offered, picked]), [])
    expect(text).toContain('variants: A=thin rule; B=no rule')
    expect(text).toMatch(/- a5[\s\S]*chosen-variant: B/)
    // The unapproved note carries no chosen line.
    expect(text.split('- a5')[0]).not.toContain('chosen-variant')
    // A note with no variants emits neither line.
    expect(serializeReviewPayload(payload([], [note({})]), []).text).not.toContain('variants:')
  })

  it('suppresses the variants line once the offer is no longer live', () => {
    // A superseded / dismissed / stale note advertising alternatives would
    // read as a question still open — only addressed and approved emit.
    for (const state of ['reannotated', 'dismissed', 'stale'] as const) {
      const stale = note({ id: 'a6', state, variants: [{ key: 'A', label: 'thin rule' }] })
      expect(serializeReviewPayload(payload([], [stale]), []).text).not.toContain('variants:')
    }
  })

  it('numbers images by the attachment order it is HANDED, not by note order', () => {
    const first = note({ id: 'a1', sketch: { excalidrawElementIds: ['e'], pngPath: 'p1', bboxPage: { x: 0, y: 0, width: 1, height: 1 } } })
    const second = note({ id: 'a2', sketch: { excalidrawElementIds: ['e'], pngPath: 'p2', bboxPage: { x: 0, y: 0, width: 1, height: 1 } } })
    // a1's file failed to load: only a2 made it into the reply.
    const { text } = serializeReviewPayload(payload([], [first, second]), [{ annotationId: 'a2', kind: 'sketch' }])
    expect(text).not.toContain('a1.png')
    expect(text).toMatch(/- a2[\s\S]*attached as attachment 1/)
    // a1 carries no attachment line at all.
    expect(text.split('- a2')[0]).not.toContain('attached as attachment')
  })

  it('maps each note`s OWN image numbers onto the blocks that carry them (W15)', () => {
    // The note text says "Image 2" and means the second screenshot pasted onto
    // THAT note; the image blocks are numbered across the whole payload. An
    // agent handed only one of those numbers cannot tell which picture is which,
    // so the line says both.
    const a = note({
      id: 'a1',
      note: 'the gap in Image 1 and the label in Image 2',
      images: [{ pngPath: 'reviews/pasted/a1-0.png' }, { pngPath: 'reviews/pasted/a1-1.png' }],
    })
    const b = note({ id: 'a2', note: 'and this', images: [{ pngPath: 'reviews/pasted/a2-0.png' }] })
    const { text } = serializeReviewPayload(payload([], [a, b]), [
      { annotationId: 'a1', kind: 'image', imageIndex: 1 },
      { annotationId: 'a1', kind: 'image', imageIndex: 2 },
      { annotationId: 'a2', kind: 'image', imageIndex: 1 },
    ])
    expect(text).toContain('images (2): Image 1 = attachment 1; Image 2 = attachment 2')
    expect(text).toContain('images (1): Image 1 = attachment 3')
  })

  it('says both when a note carries images AND a drawing', () => {
    const a = note({
      id: 'a1',
      note: 'see Image 1, and the circle',
      images: [{ pngPath: 'reviews/pasted/a1-0.png' }],
      sketch: { excalidrawElementIds: ['e'], pngPath: 'reviews/R1/a1.png', bboxPage: { x: 5, y: 6, width: 7, height: 8 } },
    })
    const { text } = serializeReviewPayload(payload([], [a]), [
      { annotationId: 'a1', kind: 'image', imageIndex: 1 },
      { annotationId: 'a1', kind: 'sketch' },
    ])
    expect(text).toContain('images (1): Image 1 = attachment 1')
    expect(text).toContain('drawing: rides this note, attached as attachment 2 [box=5,6,7,8]')
  })
})
