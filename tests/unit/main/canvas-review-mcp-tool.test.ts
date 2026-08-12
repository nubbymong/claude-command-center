// canvas_review — the pull side of D10. What these pin: the transport-bound
// session posture shared with its siblings, the closed refusal vocabulary
// (store words and paths never relayed), the envelope around user/page text,
// operator notes that carry only minted values, and image handling whose
// numbering cannot drift from the text.

import { describe, it, expect } from 'vitest'
import type { CanvasState, ReviewPayload } from '../../../src/shared/canvas'
import { runCanvasReview, type CanvasToolDeps } from '../../../src/main/canvas-mcp-tool'

const STATE: CanvasState = {
  canvasId: 'canvas-abc',
  sessionId: 'sess-mine',
  activeVersionId: 'v3',
  versions: [
    { id: 'v3', mode: 'design', createdAt: '2026-08-13T00:00:00Z', source: { mode: 'design', entry: 'index.html' } },
  ],
}

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png-body'),
])

function payload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    review: {
      id: 'R2',
      canvas: { sessionId: 'sess-mine', canvasId: 'canvas-abc' },
      versionId: 'v3',
      annotationIds: ['a1', 'a2'],
      status: 'submitted',
      createdAt: '2026-08-13T00:00:00Z',
      submittedAt: '2026-08-13T00:05:00Z',
    },
    annotations: [
      {
        id: 'a1',
        reviewId: 'R2',
        scope: 'element',
        note: 'Make this <strong> & bigger',
        focus: {
          targets: [
            { kind: 'ux-id', id: 'save-button' },
            { kind: 'fingerprint', role: 'button', name: 'Save', ancestorPath: 'main>form', ordinal: 0 },
          ],
          bboxPage: { x: 10, y: 20, width: 100, height: 30 },
          label: 'button "Save"',
          versionId: 'v3',
        },
        sketch: { excalidrawElementIds: ['el-1'], pngPath: 'reviews/R2/a1.png', bboxPage: { x: 5, y: 5, width: 60, height: 40 } },
        versionId: 'v3',
        state: 'open',
      },
    ],
    generalNotes: [
      { id: 'a2', reviewId: 'R2', scope: 'general', note: 'overall: ship it', versionId: 'v3', state: 'open' },
    ],
    attachments: [{ annotationId: 'a1', pngPath: 'reviews/R2/a1.png' }],
    envelope: 'untrusted-content',
    ...overrides,
  }
}

function deps(overrides: Partial<CanvasToolDeps> = {}): CanvasToolDeps {
  return {
    getCanvasState: () => STATE,
    requestSnapshot: async () => {
      throw new Error('not under test')
    },
    renderVersion: () => ({ canvasId: 'canvas-abc', versionId: 'v3' }),
    getReviewPayload: () => ({
      payload: payload(),
      attachmentFiles: [{ annotationId: 'a1', absPath: 'C:/fixture/reviews/R2/a1.png' }],
      submittedReviewIds: ['R1', 'R2'],
    }),
    readAttachment: () => PNG_BYTES,
    ...overrides,
  }
}

describe('refusals (operator voice, closed vocabulary)', () => {
  it('refuses a foreign canvasId and a missing reviewId', async () => {
    const foreign = await runCanvasReview({ canvasId: 'someone-elses', reviewId: 'R1' }, 'sess-mine', deps())
    expect(foreign.isError).toBe(true)
    expect(foreign.text).toContain('does not belong to this session')

    const missing = await runCanvasReview({}, 'sess-mine', deps())
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('chat marker')
  })

  it('maps a draft to "still being written" without relaying store words', async () => {
    const out = await runCanvasReview(
      { reviewId: 'R1' },
      'sess-mine',
      deps({
        getReviewPayload: () => {
          throw new Error('review is a draft')
        },
      }),
    )
    expect(out.isError).toBe(true)
    expect(out.text).toContain('still being written')
  })

  it('lists the fetchable ids on an unknown review — minted values only', async () => {
    const err = new Error('unknown review') as Error & { submittedReviewIds?: string[] }
    err.submittedReviewIds = ['R1', 'R3']
    const out = await runCanvasReview(
      { reviewId: 'R9' },
      'sess-mine',
      deps({
        getReviewPayload: () => {
          throw err
        },
      }),
    )
    expect(out.isError).toBe(true)
    expect(out.text).toContain('R1, R3')
  })

  it('never relays a store message carrying a path', async () => {
    const out = await runCanvasReview(
      { reviewId: 'R1' },
      'sess-mine',
      deps({
        getReviewPayload: () => {
          throw new Error('EACCES: C:\\Users\\someone\\secret\\reviews.json')
        },
      }),
    )
    expect(out.isError).toBe(true)
    expect(out.text).not.toContain('someone')
    expect(out.text).not.toContain('EACCES')
    expect(out.text).toContain('could not be fetched')
  })

  it('guards the state read itself (a throw must not escape to the SDK)', async () => {
    const out = await runCanvasReview(
      { reviewId: 'R1' },
      'sess-mine',
      deps({
        getCanvasState: () => {
          throw new Error('ENOENT: C:\\private\\canvas.json')
        },
      }),
    )
    expect(out.isError).toBe(true)
    expect(out.text).not.toContain('private')
  })
})

describe('the successful fetch', () => {
  it('wraps user/page text in the envelope, keeps operator notes to minted values, attaches images', async () => {
    const out = await runCanvasReview({ reviewId: 'R2' }, 'sess-mine', deps())
    expect(out.isError).toBe(false)

    // Envelope discipline: the body is inside, defanged; the header notes are
    // outside and carry only store-minted values.
    const [outside, inside] = out.text.split('<untrusted-content')
    expect(outside).toContain('note: review R2, submitted, frozen against v3')
    expect(outside).toContain('2 note(s): 1 element, 0 region, 1 general; 2 open')
    expect(outside).toContain('1 sketch image(s) attached')
    expect(outside).not.toContain('Make this')

    // The user's note text rides inside, with its angle bracket defanged.
    expect(inside).toContain('Make this &lt;strong> &amp; bigger')
    expect(inside).toContain('ux-id save-button')
    expect(inside).toContain('general notes:')
    expect(inside).toContain('overall: ship it')
    // The sketch is numbered, and exactly that many images ride along.
    expect(inside).toContain('attached as image 1')
    expect(out.images).toHaveLength(1)
    expect(out.images[0].mimeType).toBe('image/png')
    expect(Buffer.from(out.images[0].data, 'base64').equals(PNG_BYTES)).toBe(true)
  })

  it('drops an unreadable or oversized attachment with a counted note — and the text never numbers it', async () => {
    const out = await runCanvasReview(
      { reviewId: 'R2' },
      'sess-mine',
      deps({
        readAttachment: () => {
          throw new Error('ENOENT')
        },
      }),
    )
    expect(out.isError).toBe(false)
    expect(out.images).toHaveLength(0)
    expect(out.text).toContain('1 sketch attachment(s) could not be loaded')
    expect(out.text).not.toContain('attached as image')

    const big = await runCanvasReview(
      { reviewId: 'R2' },
      'sess-mine',
      deps({ readAttachment: () => Buffer.alloc(3 * 1024 * 1024, 1) }),
    )
    expect(big.images).toHaveLength(0)
    expect(big.text).toContain('could not be loaded')
  })

  it('serializes the raw payload behind format: json, still inside the envelope', async () => {
    const out = await runCanvasReview({ reviewId: 'R2', format: 'json' }, 'sess-mine', deps())
    expect(out.isError).toBe(false)
    const inside = out.text.split('<untrusted-content')[1]
    expect(inside).toContain('"id": "R2"')
    expect(inside).toContain('"envelope": "untrusted-content"')
  })
})
