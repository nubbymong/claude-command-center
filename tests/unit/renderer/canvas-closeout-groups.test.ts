// @vitest-environment jsdom
/**
 * Close-out, as the panel derives it (#365).
 *
 * A closed note is CLEARED, not deleted — so `reviewGroupsOf` has to hand the
 * panel two lists rather than one: what is still live, and what has been ruled
 * on and is still readable (and reopenable) underneath it.
 *
 * The rules that matter and why:
 *  - a note closed as 'stale' leaves the live list, so the round reads 'closed'
 *    and the pill count it feeds drops;
 *  - it appears under `closedNotes` with its text intact, because a bulk action
 *    whose results you cannot see is not one anyone should click;
 *  - 'reannotated' is NOT closed work — it has a live successor carrying the
 *    same issue, so listing it would show the same feedback twice;
 *  - `agentClosedCount` counts only what the AGENT closed on the user's word,
 *    which is the one thing on that list the user did not do themselves;
 *  - `roundsWaitingOnYou` / `notesWaitingOnYou` are the bulk button's scope, and
 *    they exclude any round still holding an open note — the same scope rule the
 *    store enforces on the agent's side.
 */
import { describe, it, expect } from 'vitest'
import type { Annotation, Review } from '../../../src/shared/canvas'
import {
  notesWaitingOnYou,
  reviewGroupsOf,
  roundsWaitingOnYou,
  type CanvasReviewSessionState,
} from '../../../src/renderer/stores/canvasReviewStore'

const review = (id: string, status: Review['status'], submittedAt?: string): Review => ({
  id,
  canvas: { canvasId: 'c1', versionId: 'v1' } as Review['canvas'],
  versionId: 'v1',
  annotationIds: [],
  status,
  createdAt: '2026-08-22T09:00:00.000Z',
  submittedAt,
})

const note = (
  id: string,
  reviewId: string,
  state: Annotation['state'],
  extra: Partial<Annotation> = {},
): Annotation => ({
  id, reviewId, scope: 'general', note: `text of ${id}`, versionId: 'v1', state, ...extra,
})

const stateOf = (reviews: Review[], annotations: Annotation[]): CanvasReviewSessionState => ({
  loaded: true, canvasId: 'c1', reviews, annotations,
  focus: null, focusChain: [], focusChainIndex: 0, marqueeArmed: false,
  editingAnnotationId: null, resolution: null, panelHighlight: null, helpDismissed: false,
})

describe('closed notes are kept, not dropped', () => {
  it('moves a staled note out of the live list and into closedNotes, text intact', () => {
    const s = stateOf(
      [review('R1', 'resolved', '2026-08-22T10:00:00.000Z')],
      [note('a1', 'R1', 'stale', { closedBy: 'agent', closedFrom: 'addressed' })],
    )
    const [g] = reviewGroupsOf(s)
    expect(g.notes).toEqual([])
    expect(g.waitingOn).toBe('closed')
    expect(g.closedNotes.map((n) => n.id)).toEqual(['a1'])
    // Cleared, not deleted: the user can still read what they wrote.
    expect(g.closedNotes[0].note).toBe('text of a1')
  })

  it('lists approvals and dismissals there too — one place for everything ruled on', () => {
    const s = stateOf(
      [review('R1', 'resolved', '2026-08-22T10:00:00.000Z')],
      [
        note('a1', 'R1', 'approved', { closedBy: 'user', closedFrom: 'addressed' }),
        note('a2', 'R1', 'dismissed', { closedBy: 'user', closedFrom: 'open' }),
        note('a3', 'R1', 'stale', { closedBy: 'agent', closedFrom: 'addressed' }),
      ],
    )
    const [g] = reviewGroupsOf(s)
    expect(g.closedNotes.map((n) => n.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('never lists a re-annotated note — its successor is carrying the issue', () => {
    const s = stateOf(
      [review('R1', 'submitted', '2026-08-22T10:00:00.000Z'), review('R2', 'draft')],
      [note('a1', 'R1', 'reannotated', { supersededBy: 'a2' }), note('a2', 'R2', 'open')],
    )
    const [g] = reviewGroupsOf(s)
    expect(g.closedNotes).toEqual([])
    expect(g.notes).toEqual([])
  })

  it('counts only what the agent closed on your instruction', () => {
    const s = stateOf(
      [review('R1', 'resolved', '2026-08-22T10:00:00.000Z')],
      [
        note('a1', 'R1', 'stale', { closedBy: 'agent', closedFrom: 'addressed' }),
        note('a2', 'R1', 'stale', { closedBy: 'user', closedFrom: 'addressed' }),
        // A record from before close-out existed: no claim either way.
        note('a3', 'R1', 'dismissed'),
      ],
    )
    const [g] = reviewGroupsOf(s)
    expect(g.closedNotes).toHaveLength(3)
    expect(g.agentClosedCount).toBe(1)
  })

  it('keeps a round live while anything on it still is', () => {
    const s = stateOf(
      [review('R1', 'submitted', '2026-08-22T10:00:00.000Z')],
      [note('a1', 'R1', 'stale', { closedBy: 'agent' }), note('a2', 'R1', 'addressed')],
    )
    const [g] = reviewGroupsOf(s)
    expect(g.notes.map((n) => n.id)).toEqual(['a2'])
    expect(g.closedNotes.map((n) => n.id)).toEqual(['a1'])
    expect(g.waitingOn).toBe('you')
    expect(g.addressedCount).toBe(1)
  })
})

describe('the bulk button’s scope', () => {
  const s = stateOf(
    [
      review('R1', 'submitted', '2026-08-22T10:00:00.000Z'), // all addressed -> yours
      review('R2', 'submitted', '2026-08-22T11:00:00.000Z'), // one open -> the agent's
      review('R3', 'resolved', '2026-08-22T12:00:00.000Z'), // nothing left
      review('R4', 'draft'),
    ],
    [
      note('a1', 'R1', 'addressed'),
      note('a2', 'R1', 'addressed'),
      note('a3', 'R2', 'addressed'),
      note('a4', 'R2', 'open'),
      note('a5', 'R3', 'stale', { closedBy: 'user' }),
      note('a6', 'R4', 'open'),
    ],
  )

  it('takes only the rounds waiting on YOU', () => {
    expect(roundsWaitingOnYou(reviewGroupsOf(s)).map((g) => g.review.id)).toEqual(['R1'])
  })

  it('never reaches into a round still holding a note the agent has not claimed', () => {
    // a3 is addressed, but it sits in a round that is still with the agent —
    // closing it would clear feedback as part of a round nobody finished.
    const ids = notesWaitingOnYou(reviewGroupsOf(s)).map((n) => n.id)
    expect(ids).toEqual(['a1', 'a2'])
    expect(ids).not.toContain('a3')
  })

  it('never reaches into the draft — that is the composer’s own list', () => {
    expect(notesWaitingOnYou(reviewGroupsOf(s)).map((n) => n.id)).not.toContain('a6')
  })

  it('is empty once everything has been closed, so the button disappears', () => {
    const cleared = stateOf(
      [review('R1', 'resolved', '2026-08-22T10:00:00.000Z')],
      [note('a1', 'R1', 'stale', { closedBy: 'user', closedFrom: 'addressed' })],
    )
    expect(notesWaitingOnYou(reviewGroupsOf(cleared))).toEqual([])
    expect(roundsWaitingOnYou(reviewGroupsOf(cleared))).toEqual([])
  })
})
