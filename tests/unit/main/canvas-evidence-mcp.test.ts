// `canvas_review` in TESTING MODE (M3): what the agent is handed by default,
// and what it has to ask for.
//
// THE TOKEN RULE is the whole of this file. A Testing round carries a screenshot
// per note, and a screenshot is by far the most expensive thing this tool can
// return — so the STRUCTURE (the state stamp, the action trail, the pack name)
// comes back every time and the PIXELS only on `includeShots: true`. A default
// that quietly attached them would make every round-read cost an order of
// magnitude more than the agent asked for.

import { describe, it, expect } from 'vitest'
import type { CanvasState, ReviewPayload } from '../../../src/shared/canvas'
import { runCanvasReview, type CanvasToolDeps } from '../../../src/main/canvas-mcp-tool'

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('shot')])
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('shot')])

const STATE: CanvasState = {
  canvasId: 'canvas-abc',
  sessionId: 'sess-mine',
  activeVersionId: 'v5',
  title: 'Checkout flow',
  versions: [
    {
      id: 'v5',
      mode: 'uat',
      createdAt: new Date(2026, 7, 29, 9, 0, 0).toISOString(),
      source: { mode: 'uat', distRoot: 'F:/build/dist', entry: 'index.html', buildLabel: '5' },
    },
  ],
}

function payload(): ReviewPayload {
  return {
    review: {
      id: 'R2',
      canvas: { sessionId: 'sess-mine', canvasId: 'canvas-abc' },
      versionId: 'v5',
      annotationIds: ['a1'],
      status: 'submitted',
      createdAt: '2026-08-29T16:40:00.000Z',
      submittedAt: '2026-08-29T16:50:00.000Z',
      decision: 'reject',
      trail: [
        { at: '2026-08-29T16:40:00.000Z', gapMs: 0, kind: 'navigate', route: '/basket' },
        { at: '2026-08-29T16:40:09.000Z', gapMs: 9000, kind: 'click', target: { role: 'button', name: 'Checkout' } },
      ],
    },
    annotations: [],
    generalNotes: [
      {
        id: 'a1',
        reviewId: 'R2',
        scope: 'general',
        note: 'the total is wrong',
        versionId: 'v5',
        state: 'open',
        evidence: {
          shotPath: 'reviews/evidence/a1.png',
          width: 1600,
          height: 900,
          stamp: {
            capturedAt: '2026-08-29T16:44:02.000Z',
            title: 'Checkout',
            route: '/checkout',
            viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 0, dpr: 2, zoom: 1 },
            dialogs: [],
            focused: { role: 'textbox', name: 'Email' },
            fields: [{ role: 'textbox', name: 'Email', fill: 'invalid' }],
          },
          trail: [{ at: '2026-08-29T16:44:01.900Z', gapMs: 800, kind: 'note' }],
        },
      },
    ],
    attachments: [],
    envelope: 'untrusted-content',
  }
}

function deps(overrides: Partial<CanvasToolDeps> = {}): CanvasToolDeps {
  return {
    getCanvasState: () => STATE,
    requestSnapshot: async () => {
      throw new Error('not under test')
    },
    renderVersion: () => ({ canvasId: 'canvas-abc', versionId: 'v5' }),
    getReviewPayload: () => ({
      payload: payload(),
      attachmentFiles: [],
      evidenceFiles: [{ annotationId: 'a1', absPath: 'F:/fixture/reviews/evidence/a1.png' }],
      submittedReviewIds: ['R2'],
    }),
    readAttachment: () => PNG_BYTES,
    // The DISCIPLINED reader in production (`readImageFileChecked`): it answers
    // `{ bytes, mime }` or null, and the MIME comes from the BYTES rather than
    // the stored extension. A shot must never come back through the plain
    // `readAttachment` path.
    readEvidenceShot: () => ({ bytes: PNG_BYTES, mime: 'image/png' as const }),
    readDesignFile: () => {
      throw new Error('no design files in this fixture')
    },
    ...overrides,
  }
}

describe('includeShots is OFF by default', () => {
  it('returns the structure and NO image blocks', async () => {
    const out = await runCanvasReview({ reviewId: 'R2' }, 'sess-mine', deps())
    expect(out.isError).toBe(false)
    expect(out.images).toHaveLength(0)
    expect(out.text).toContain('screen: route /checkout')
    expect(out.text).toContain('focused textbox "Email"')
    expect(out.text).toContain('fields: 1 invalid (Email)')
    expect(out.text).toContain('stored for the user')
    expect(out.text).toContain('includeShots')
  })

  it('is not bought by a truthy non-boolean — a half-filled argument costs nothing', async () => {
    for (const value of ['true', 1, {}, 'yes']) {
      const out = await runCanvasReview({ reviewId: 'R2', includeShots: value }, 'sess-mine', deps())
      expect(out.images).toHaveLength(0)
    }
  })
})

describe('includeShots: true', () => {
  it('attaches each note’s shot and names its block in the text', async () => {
    const out = await runCanvasReview({ reviewId: 'R2', includeShots: true }, 'sess-mine', deps())
    expect(out.images).toHaveLength(1)
    expect(out.images[0].mimeType).toBe('image/png')
    expect(out.text).toContain('attached as attachment 1 (1600x900)')
    expect(out.text).toContain('1 image(s) attached after the text')
  })

  it('advertises the MIME the bytes actually are — the ladder may have ended on JPEG', async () => {
    const out = await runCanvasReview(
      { reviewId: 'R2', includeShots: true },
      'sess-mine',
      deps({ readEvidenceShot: () => ({ bytes: JPEG_BYTES, mime: 'image/jpeg' }) }),
    )
    expect(out.images[0].mimeType).toBe('image/jpeg')
  })

  it('reads a shot through the DISCIPLINED reader, never the plain attachment read', async () => {
    let plainReads = 0
    let checkedReads = 0
    const out = await runCanvasReview(
      { reviewId: 'R2', includeShots: true },
      'sess-mine',
      deps({
        readAttachment: () => {
          plainReads++
          return PNG_BYTES
        },
        readEvidenceShot: () => {
          checkedReads++
          return { bytes: PNG_BYTES, mime: 'image/png' }
        },
      }),
    )
    expect(out.images).toHaveLength(1)
    expect(checkedReads).toBe(1)
    // `readAttachment` is a bare readFileSync in production — no reparse-point
    // refusal, no size check before the allocation. An evidence shot must not
    // reach it.
    expect(plainReads).toBe(0)
  })

  it('reports a shot the reader REFUSED rather than shifting the numbering silently', async () => {
    const out = await runCanvasReview(
      { reviewId: 'R2', includeShots: true },
      'sess-mine',
      // What `readImageFileChecked` answers for a reparse point, a directory, an
      // oversized file or a non-image: null, with no words of its own.
      deps({ readEvidenceShot: () => null }),
    )
    expect(out.images).toHaveLength(0)
    expect(out.text).toContain('1 image attachment(s) could not be loaded')
    // The note's line falls back to the stored wording, so the text and the
    // blocks still agree about what is attached.
    expect(out.text).toContain('stored for the user')
  })

  it('survives a reader that throws, and relays no path from it', async () => {
    const out = await runCanvasReview(
      { reviewId: 'R2', includeShots: true },
      'sess-mine',
      deps({
        readEvidenceShot: () => {
          throw new Error('F:/fixture/reviews/evidence/a1.png is gone')
        },
      }),
    )
    expect(out.images).toHaveLength(0)
    expect(out.text).toContain('1 image attachment(s) could not be loaded')
    expect(out.text).not.toContain('F:/fixture')
  })
})

describe('the pack name and the Pass/Fail vocabulary', () => {
  it('composes the DEFAULT pack name from the config, the build label and the date', async () => {
    const out = await runCanvasReview({ reviewId: 'R2' }, 'sess-mine', deps({ getConfigName: () => 'Checkout flow' }))
    expect(out.text).toContain('pack: Checkout flow · build 5 · 29 Aug')
  })

  it('prefers the user’s OWN name when they set one', async () => {
    const named: CanvasState = { ...STATE, versions: [{ ...STATE.versions[0], packName: 'Friday smoke test' }] }
    const out = await runCanvasReview({ reviewId: 'R2' }, 'sess-mine', deps({ getCanvasState: () => named }))
    expect(out.text).toContain('pack: Friday smoke test')
  })

  it('falls back to the canvas title when the session has no config name', async () => {
    const out = await runCanvasReview({ reviewId: 'R2' }, 'sess-mine', deps())
    expect(out.text).toContain('pack: Checkout flow · build 5 · 29 Aug')
  })

  it('reads the decision back in the words the user saw', async () => {
    const out = await runCanvasReview({ reviewId: 'R2' }, 'sess-mine', deps())
    expect(out.text).toContain('decision: FAILED')
    expect(out.text).not.toContain('decision: REJECTED')
  })

  it('names no pack for a MOCKUP round — the concept belongs to Testing', async () => {
    const design: CanvasState = {
      ...STATE,
      versions: [{ id: 'v5', mode: 'design', createdAt: STATE.versions[0].createdAt, source: { mode: 'design', entry: 'index.html' } }],
    }
    const out = await runCanvasReview({ reviewId: 'R2' }, 'sess-mine', deps({ getCanvasState: () => design }))
    expect(out.text).not.toContain('pack:')
    expect(out.text).toContain('decision: REJECTED')
  })
})

describe('the run trail', () => {
  it('rides at the top, once, and says what it does not carry', async () => {
    const out = await runCanvasReview({ reviewId: 'R2' }, 'sess-mine', deps())
    expect(out.text).toContain('run trail (2 action(s), oldest first) — what the user did, never what they typed:')
    expect(out.text).toContain('navigate /basket')
    expect(out.text.match(/run trail/g)).toHaveLength(1)
  })
})
