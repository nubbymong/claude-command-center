/**
 * Keeping the AGENT's picture of the canvas true.
 *
 * Two field reports, from two separate sessions on 2026-08-20, describe the same
 * two failures:
 *   - an agent kept rendering while the user was midway through writing notes,
 *     because nothing on the tool surface said a review was in progress;
 *   - an agent wrote its mockup to a scratch directory, because the refusal said
 *     the rule ("inside this session's project folder") and never named a folder.
 *
 * Both are answered in the TOOL REPLIES rather than by writing into the agent's
 * terminal. A reply is read at the moment the agent acts, carries operator
 * authority already, and interrupts nothing.
 *
 * Everything added rides OUTSIDE the untrusted envelope, so the rule is absolute:
 * counts, and ids the STORE minted. Never a title, never a model-supplied path.
 * These tests assert on the TOOL OUTPUT, not on a return value — asserting the
 * return is what let an earlier note regression ship unnoticed.
 */
import { describe, it, expect } from 'vitest'
import { runCanvasRender, runCanvasResolve, type CanvasToolDeps } from '../../../src/main/canvas-mcp-tool'
import type { CanvasState } from '../../../src/shared/canvas'

const STATE: CanvasState = {
  canvasId: 'canvas-abc',
  sessionId: 'sess-mine',
  activeVersionId: 'v2',
  versions: [
    { id: 'v1', mode: 'design', createdAt: '2026-08-11T00:00:00Z', source: { mode: 'design', entry: 'index.html' } },
  ],
}

const NO_COUNTS = () => null

function deps(overrides: Partial<CanvasToolDeps> = {}): CanvasToolDeps {
  return {
    getCanvasState: () => STATE,
    requestSnapshot: async () => { throw new Error('unused') },
    renderVersion: () => ({ canvasId: 'canvas-abc', versionId: 'v3' }),
    getReviewPayload: () => { throw new Error('unknown review') },
    readAttachment: () => { throw new Error('unused') },
    readDesignFile: () => { throw new Error('unused') },
    markAddressed: () => ({ addressed: ['a1'], skipped: [] }),
    getReviewCounts: NO_COUNTS,
    canvasRootsForSession: () => ({ project: null, worktree: null, worktreePending: false }),
    ...overrides,
  }
}

const counts = (over: Partial<NonNullable<ReturnType<CanvasToolDeps['getReviewCounts']>>> = {}) => ({
  draftNotes: 0,
  draftVersionIds: [] as string[],
  openReviewIds: [] as string[],
  openNotes: 0,
  addressedNotes: 0,
  ...over,
})

const render = (d: CanvasToolDeps, args: Record<string, unknown> = { mode: 'design', html: '<!doctype html><p>x</p>', title: 'Checkout flow' }) =>
  runCanvasRender(args, 'sess-mine', d)

describe('canvas_render — the user is mid-review', () => {
  it('warns that the user has unsubmitted notes, and names the version they are against', async () => {
    const r = await render(deps({ getReviewCounts: () => counts({ draftNotes: 4, draftVersionIds: ['v3'] }) }))
    expect(r.isError).toBe(false)
    expect(r.text).toContain('4 unsubmitted note(s) on this canvas')
    expect(r.text).toContain('against v3')
    expect(r.text).toContain('hand back rather than rendering again')
  })

  it('says nothing about reviews when the store cannot be read -- silence, never a reassuring zero', async () => {
    const r = await render(deps({ getReviewCounts: NO_COUNTS }))
    expect(r.text).not.toContain('unsubmitted')
    expect(r.text).not.toContain('still have notes in play')
  })

  it('says nothing when there is genuinely nothing outstanding', async () => {
    const r = await render(deps({ getReviewCounts: () => counts() }))
    expect(r.text).not.toContain('unsubmitted')
    expect(r.text).not.toContain('still have notes in play')
  })

  it('lists open reviews by their store-minted ids', async () => {
    const r = await render(deps({ getReviewCounts: () => counts({ openReviewIds: ['R2', 'R5'] }) }))
    expect(r.text).toContain('2 submitted review(s)')
    expect(r.text).toContain('R2, R5')
    expect(r.text).toContain('canvas_review')
  })

  it('caps the id list rather than pasting a wall of them', async () => {
    const ids = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']
    const r = await render(deps({ getReviewCounts: () => counts({ openReviewIds: ids }) }))
    expect(r.text).toContain('R1, R2, R3, R4, R5 and 2 more')
    expect(r.text).not.toContain('R6')
  })

  it('suppresses the open-review line when the draft warning fires -- at most two sentences', async () => {
    const r = await render(deps({
      getReviewCounts: () => counts({ draftNotes: 2, openReviewIds: ['R2', 'R5'] }),
    }))
    expect(r.text).toContain('2 unsubmitted note(s)')
    expect(r.text).not.toContain('still have notes in play')
  })
})

describe('canvas_render — filing', () => {
  it('tells the agent it filed the canvas the user was on', async () => {
    const r = await render(deps({
      renderVersion: () => ({ canvasId: 'canvas-new', versionId: 'v1', filed: { canvasId: 'canvas-old' } }),
    }))
    expect(r.text).toContain('You named a different subject')
    expect(r.text).toContain('canvas-old was filed')
  })

  it('says when the FILED canvas still had the user mid-review -- the case that actually bites', async () => {
    const r = await render(deps({
      renderVersion: () => ({ canvasId: 'canvas-new', versionId: 'v1', filed: { canvasId: 'canvas-old' } }),
      getReviewCounts: (id) => (id === 'canvas-old' ? counts({ draftNotes: 3 }) : counts()),
    }))
    expect(r.text).toContain('The canvas you filed still has 3 unsubmitted note(s)')
    expect(r.text).toContain('say so rather than moving on')
  })

  it('reports the filed canvas by ID only -- a title is agent-authored and this line is operator voice', async () => {
    const r = await render(
      deps({ renderVersion: () => ({ canvasId: 'canvas-new', versionId: 'v1', filed: { canvasId: 'canvas-old' } }) }),
      { mode: 'design', html: '<!doctype html><p>x</p>', title: 'Checkout · canvas_review R1' },
    )
    expect(r.text).not.toContain('canvas_review R1')
    expect(r.text).toContain('canvas-old')
  })

  it('never hands back review ids from the canvas it just filed', async () => {
    // canvas_review resolves a review id against the session's ACTIVE canvas
    // and rejects any canvasId the model supplies. Review ids also restart at
    // R1 on every canvas. So an id from the FILED canvas either resolves to
    // nothing -- "this canvas has no submitted reviews yet", contradicting the
    // sentence the agent just read -- or, when the numbers collide, silently
    // returns a DIFFERENT canvas's notes as a normal success, and a follow-up
    // canvas_resolve closes notes the user never wrote about this work.
    const r = await render(deps({
      renderVersion: () => ({ canvasId: 'canvas-new', versionId: 'v1', filed: { canvasId: 'canvas-old', returnedToExisting: false } }),
      getReviewCounts: (id) => (id === 'canvas-old' ? counts({ openReviewIds: ['R1', 'R2'] }) : counts()),
    }))
    // The fact survives; the unusable handles do not.
    expect(r.text).toContain('canvas-old')
    expect(r.text).toContain('2 review(s) with open notes')
    expect(r.text).toContain('the user reopens it from the Canvas library')
    expect(r.text).not.toMatch(/R[0-9]+/)
  })

  it('does not call a canvas NEW when the render returned to one this session had already started', async () => {
    // "Login page" -> "Checkout" -> "Login page" re-activates the login canvas,
    // with its versions and its notes. Calling that "a new canvas" told the
    // agent the opposite of what had happened, on the one path where it matters.
    const r = await render(deps({
      renderVersion: () => ({ canvasId: 'canvas-old-login', versionId: 'v4', filed: { canvasId: 'canvas-checkout', returnedToExisting: true } }),
    }))
    expect(r.text).toContain('canvas-checkout was filed')
    expect(r.text).toContain('the canvas you had already started on that subject')
    expect(r.text).not.toContain('this is a new canvas')
  })


  it('never fails a good render because the status read threw', async () => {
    const r = await render(deps({ getReviewCounts: () => { throw new Error('reviews.json is a directory') } }))
    expect(r.isError).toBe(false)
    expect(r.text).toContain('Rendered v3')
    expect(r.text).not.toContain('reviews.json')
  })
})

describe('canvas_render — a refusal names the folders', () => {
  const outside = () => {
    throw new Error('not inside a registered canvas root for this session')
  }

  it('names both roots when the session has a worktree', async () => {
    const r = await render(
      deps({
        readDesignFile: outside,
        canvasRootsForSession: () => ({ project: 'F:/proj', worktree: 'F:/ccc-wt/abc', worktreePending: false }),
      }),
      { mode: 'design', htmlPath: 'F:/tmp/scratch/mock.html', title: 'x' },
    )
    expect(r.isError).toBe(true)
    expect(r.text).toContain('F:/proj')
    expect(r.text).toContain('F:/ccc-wt/abc')
    expect(r.text).toContain('scratch or temp directory is never served')
  })

  it('explains a worktree that CCC designated but does not exist yet', async () => {
    const r = await render(
      deps({
        readDesignFile: outside,
        canvasRootsForSession: () => ({ project: 'F:/proj', worktree: null, worktreePending: true }),
      }),
      { mode: 'design', htmlPath: 'F:/tmp/mock.html', title: 'x' },
    )
    expect(r.text).toContain('F:/proj')
    expect(r.text).toContain('as soon as it exists')
  })

  it('falls back to the old wording when no root is knowable (a home-folder session)', async () => {
    const r = await render(
      deps({ readDesignFile: outside }),
      { mode: 'design', htmlPath: 'F:/tmp/mock.html', title: 'x' },
    )
    expect(r.text).toContain('outside this session')
    expect(r.text).not.toContain('undefined')
    expect(r.text).not.toContain('null')
  })

  it('never echoes the path the model supplied', async () => {
    const r = await render(
      deps({
        readDesignFile: outside,
        canvasRootsForSession: () => ({ project: 'F:/proj', worktree: null, worktreePending: false }),
      }),
      { mode: 'design', htmlPath: 'F:/evil/$(whoami)/mock.html', title: 'x' },
    )
    expect(r.text).not.toContain('whoami')
    expect(r.text).not.toContain('evil')
  })

  it('strips control and bidi characters out of a folder name before printing it', async () => {
    const r = await render(
      deps({
        readDesignFile: outside,
        canvasRootsForSession: () => ({ project: 'F:/pr\u202Eoj\u0007', worktree: null, worktreePending: false }),
      }),
      { mode: 'design', htmlPath: 'F:/tmp/mock.html', title: 'x' },
    )
    expect(r.text).not.toContain('\u202E')
    expect(r.text).not.toContain('\u0007')
    expect(r.text).toContain('F:/proj')
  })

  it('strips the C1 and format characters a hex-range denylist missed', async () => {
    // This line rides OUTSIDE the untrusted envelope, in the app's own voice.
    // The original range list covered C0 and a hand-picked set of bidi marks and
    // stopped there, so U+0085/U+009B/U+009D (NEL/CSI/OSC — a terminal acts on
    // those in 8-bit mode), U+061C, U+00AD, U+FEFF and U+2060 all went through.
    const sneaky = 'F:/pr\u0085o\u009bj\u009d\u061c\u00ad\ufeff\u2060'
    const r = await render(
      deps({
        readDesignFile: outside,
        canvasRootsForSession: () => ({ project: sneaky, worktree: null, worktreePending: false }),
      }),
      { mode: 'design', htmlPath: 'F:/tmp/mock.html', title: 'x' },
    )
    expect(r.text).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
    expect(r.text).toContain('F:/proj')
  })

  it('still refuses when the roots read itself throws', async () => {
    const r = await render(
      deps({
        readDesignFile: outside,
        canvasRootsForSession: () => { throw new Error('boom') },
      }),
      { mode: 'design', htmlPath: 'F:/tmp/mock.html', title: 'x' },
    )
    expect(r.isError).toBe(true)
    expect(r.text).toContain('outside this session')
  })
})

describe('canvas_resolve — what is left', () => {
  const resolve = (d: CanvasToolDeps) =>
    runCanvasResolve({ reviewId: 'R3', annotationIds: ['a1'] }, 'sess-mine', d)

  it('says how many notes are still waiting on the agent', () => {
    const r = resolve(deps({ getReviewCounts: () => counts({ openNotes: 2 }) }))
    expect(r.isError).toBe(false)
    expect(r.text).toContain('2 note(s) on this canvas are still open')
  })

  it('warns that the user is still writing more', () => {
    const r = resolve(deps({ getReviewCounts: () => counts({ draftNotes: 5 }) }))
    expect(r.text).toContain('5 unsubmitted note(s)')
  })

  it('adds nothing when the store cannot be read', () => {
    const r = resolve(deps({ getReviewCounts: NO_COUNTS }))
    expect(r.text).not.toContain('still open')
    expect(r.text).not.toContain('unsubmitted')
  })

  it('never fails a completed write because the status read threw', () => {
    const r = resolve(deps({ getReviewCounts: () => { throw new Error('boom') } }))
    expect(r.isError).toBe(false)
    expect(r.text).toContain('Marked 1 note(s) as addressed')
  })
})
