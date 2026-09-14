// @vitest-environment jsdom
/**
 * Reviews as ROUNDS.
 *
 * The panel used to flatten every open note from every review under one
 * heading, so a round sent as a unit came back as loose items: no way to see a
 * whole round was finished, no way to close one, and this morning's note sitting
 * between two from ten minutes ago.
 *
 * The rules that matter and why:
 *  - the DRAFT review is excluded (it is the composer's own list, shown below;
 *    listing it twice is how the two get out of step);
 *  - a round waits on the AGENT while any note is still 'open' -- the user
 *    cannot close it alone, so no bulk action may be offered;
 *  - a round waits on YOU only once every remaining note is 'addressed';
 *  - resolved/dismissed/superseded notes are done and are not listed at all.
 */
import { describe, it, expect } from 'vitest'
import type { Annotation, Review } from '../../../src/shared/canvas'
import { reviewGroupsOf, type CanvasReviewSessionState } from '../../../src/renderer/stores/canvasReviewStore'

const review = (id: string, status: Review['status'], submittedAt?: string): Review => ({
  id,
  canvas: { canvasId: 'c1', versionId: 'v1' } as Review['canvas'],
  versionId: 'v1',
  annotationIds: [],
  status,
  createdAt: '2026-08-20T09:00:00.000Z',
  submittedAt,
})

const note = (id: string, reviewId: string, state: Annotation['state']): Annotation => ({
  id, reviewId, scope: 'general', note: id, versionId: 'v1', state,
})

const stateOf = (reviews: Review[], annotations: Annotation[]): CanvasReviewSessionState => ({
  loaded: true, canvasId: 'c1', reviews, annotations,
  focus: null, focusChain: [], focusChainIndex: 0, marqueeArmed: false,
  editingAnnotationId: null, resolution: null, panelHighlight: null,
})

describe('reviewGroupsOf', () => {
  it('never lists the draft review -- that is the composer\'s own list', () => {
    const s = stateOf(
      [review('R1', 'submitted', '2026-08-20T10:00:00.000Z'), review('R2', 'draft')],
      [note('a1', 'R1', 'addressed'), note('a2', 'R2', 'open')],
    )
    expect(reviewGroupsOf(s).map((g) => g.review.id)).toEqual(['R1'])
  })

  it('waits on the AGENT while any note is still open, even if others are addressed', () => {
    const s = stateOf(
      [review('R1', 'submitted', '2026-08-20T10:00:00.000Z')],
      [note('a1', 'R1', 'open'), note('a2', 'R1', 'addressed'), note('a3', 'R1', 'addressed')],
    )
    const [g] = reviewGroupsOf(s)
    expect(g.waitingOn).toBe('agent')
    expect(g.openCount).toBe(1)
    expect(g.addressedCount).toBe(2)
  })

  it('STILL waits on the agent once every note is addressed — nothing ever waits on you', () => {
    // The change the settled machine makes here: "addressed" is the agent's
    // claim about its own work, not a debt owed by the user. A round with two
    // addressed notes is the agent's until the user's next DECISION ends it,
    // and the old third state ('you') is what let six of these stack up.
    const s = stateOf(
      [review('R1', 'submitted', '2026-08-20T10:00:00.000Z')],
      [note('a1', 'R1', 'addressed'), note('a2', 'R1', 'addressed')],
    )
    const [g] = reviewGroupsOf(s)
    expect(g.waitingOn).toBe('agent')
    expect(g.addressedCount).toBe(2)
  })

  it('is closed once the ROUND is resolved, whatever its notes say', () => {
    // Read from the round's status, which is one-way now — not re-derived from
    // the notes, which is how the panel and the pill came to disagree.
    const s = stateOf(
      [review('R1', 'resolved', '2026-08-20T10:00:00.000Z')],
      [note('a1', 'R1', 'observation' as Annotation['state']), note('a2', 'R1', 'dismissed' as Annotation['state'])],
    )
    const [g] = reviewGroupsOf(s)
    expect(g.waitingOn).toBe('closed')
    expect(g.notes).toHaveLength(0)
    expect(g.closedNotes).toHaveLength(2)
  })

  it('still lists a resolved review, so a closed round does not vanish from the history', () => {
    const s = stateOf([review('R1', 'resolved', '2026-08-20T10:00:00.000Z')], [])
    expect(reviewGroupsOf(s).map((g) => g.review.id)).toEqual(['R1'])
  })

  it('orders newest round first', () => {
    const s = stateOf(
      [
        review('R1', 'submitted', '2026-08-20T09:10:00.000Z'),
        review('R3', 'submitted', '2026-08-20T14:20:00.000Z'),
        review('R2', 'submitted', '2026-08-20T13:41:00.000Z'),
      ],
      [],
    )
    expect(reviewGroupsOf(s).map((g) => g.review.id)).toEqual(['R3', 'R2', 'R1'])
  })

  it('falls back to the review ordinal when timestamps tie or cannot be read', () => {
    const s = stateOf(
      [
        { ...review('R2', 'submitted'), createdAt: 'not-a-date' },
        { ...review('R11', 'submitted'), createdAt: 'not-a-date' },
        { ...review('R7', 'submitted'), createdAt: 'not-a-date' },
      ],
      [],
    )
    // Ordinal, not string order -- R11 sorts above R7, which "R11" < "R7" would not.
    expect(reviewGroupsOf(s).map((g) => g.review.id)).toEqual(['R11', 'R7', 'R2'])
  })

  it('keeps each round\'s notes to itself', () => {
    const s = stateOf(
      [review('R1', 'submitted', '2026-08-20T10:00:00.000Z'), review('R2', 'submitted', '2026-08-20T11:00:00.000Z')],
      [note('a1', 'R1', 'open'), note('a2', 'R2', 'addressed'), note('a3', 'R2', 'addressed')],
    )
    const groups = reviewGroupsOf(s)
    expect(groups.map((g) => g.review.id)).toEqual(['R2', 'R1'])
    expect(groups[0].notes.map((n) => n.id)).toEqual(['a2', 'a3'])
    expect(groups[1].notes.map((n) => n.id)).toEqual(['a1'])
  })
})
