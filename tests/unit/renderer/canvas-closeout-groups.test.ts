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
 *  - `settledLabel` is how a settled round says WHY, because a round the user
 *    never closed themselves must not read as one they did.
 */
import { describe, it, expect } from 'vitest'
import { artifactPhaseOf, type Annotation, type CanvasVersion, type Review } from '../../../src/shared/canvas'
import {
  artifactPhaseFor,
  reviewGroupsOf,
  settledLabel,
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
  editingAnnotationId: null, resolution: null, panelHighlight: null,
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

  it('keeps a round live while the ROUND is, and splits its notes either side', () => {
    const s = stateOf(
      [review('R1', 'submitted', '2026-08-22T10:00:00.000Z')],
      [note('a1', 'R1', 'stale', { closedBy: 'agent' }), note('a2', 'R1', 'addressed')],
    )
    const [g] = reviewGroupsOf(s)
    expect(g.notes.map((n) => n.id)).toEqual(['a2'])
    expect(g.closedNotes.map((n) => n.id)).toEqual(['a1'])
    expect(g.waitingOn).toBe('agent')
    expect(g.addressedCount).toBe(1)
  })

  it('lists an OBSERVATION under closedNotes — recorded, and owed by nobody', () => {
    const s = stateOf(
      [review('R1', 'resolved', '2026-08-22T10:00:00.000Z')],
      [note('a1', 'R1', 'observation', { closedBy: 'user', closedFrom: 'open' })],
    )
    const [g] = reviewGroupsOf(s)
    expect(g.notes).toHaveLength(0)
    expect(g.closedNotes.map((n) => n.id)).toEqual(['a1'])
    // An observation is the USER's own close, never the agent's.
    expect(g.agentClosedCount).toBe(0)
  })
})
describe('settledLabel — a settled round says HOW it settled', () => {
  const settledWith = (settled: Review['settled']): ReturnType<typeof reviewGroupsOf>[number] =>
    reviewGroupsOf(stateOf([{ ...review('R1', 'resolved', '2026-08-22T10:00:00.000Z'), settled }], []))[0]

  it('names each provenance in the user`s own terms, and never as a click nobody made', () => {
    // The observation wording follows the MODE: Testing mode calls the decision
    // Pass, everything else calls it Approve, and a row that said "passed" about
    // a mockup the user approved describes a different event. With no versions
    // handed in, the non-Testing word is the honest default.
    expect(settledLabel(settledWith({ at: 'x', by: 'observation' }))).toBe('approved with observations')
    expect(settledLabel(settledWith({ at: 'x', by: 'decision', versionId: 'v8' }))).toBe('settled by your v8 decision')
    expect(settledLabel(settledWith({ at: 'x', by: 'decision', versionId: 'v8', reviewId: 'R8' }))).toBe('superseded by your Review #8')
    expect(settledLabel(settledWith({ at: 'x', by: 'agent' }))).toBe('closed by the agent on your instruction')
    expect(settledLabel(settledWith({ at: 'x', by: 'supersede' }))).toBe('settled when its version was superseded')
    expect(settledLabel(settledWith({ at: 'x', by: 'force' }))).toBe('closed by you, as not done')
    expect(settledLabel(settledWith({ at: 'x', by: 'legacy' }))).toBe('settled when this canvas was brought up to date')
  })

  it('says nothing at all for a LIVE round — there is no settlement to describe', () => {
    const [g] = reviewGroupsOf(stateOf([review('R1', 'submitted', '2026-08-22T10:00:00.000Z')], [note('a1', 'R1', 'open')]))
    expect(settledLabel(g)).toBeNull()
  })

  it('says PASSED with observations in Testing mode — the user`s own word for it', () => {
    // Same gesture, two names. The round froze against a version, and that
    // version's mode is what the button said when the user clicked it.
    const g = settledWith({ at: 'x', by: 'observation' })
    const uat: CanvasVersion = {
      id: 'v1',
      mode: 'uat',
      createdAt: 'x',
      source: { mode: 'uat', distRoot: 'C:/build', entry: 'index.html' },
    } as CanvasVersion
    expect(settledLabel(g, [uat])).toBe('passed with observations')
  })

  it('a ZERO-NOTE decision names the VERDICT, not the neutral word', () => {
    // "settled by your v8 decision" makes the user go and look up which way it
    // went; "your v8 approval" is a sentence they recognise. The word comes from
    // the version record they were given, and falls back only when it is absent.
    const g = settledWith({ at: 'x', by: 'decision', versionId: 'v8' })
    const version = (state: 'approved' | 'rejected'): CanvasVersion =>
      ({ id: 'v8', mode: 'design', createdAt: 'x', source: { mode: 'design', entry: 'i.html' }, verdict: { state, by: 'user', at: 'x' } }) as CanvasVersion
    expect(settledLabel(g, [version('approved')])).toBe('settled by your v8 approval')
    expect(settledLabel(g, [version('rejected')])).toBe('settled by your v8 rejection')
    // Unknown version: the neutral word, never a guessed verdict.
    expect(settledLabel(g, [])).toBe('settled by your v8 decision')
  })
})

describe('artifactPhaseFor — main and the renderer answer with ONE implementation (D3)', () => {
  const version = (id: string, over: Partial<CanvasVersion> = {}): CanvasVersion =>
    ({ id, mode: 'design', createdAt: '2026-08-22T09:00:00.000Z', source: { mode: 'design', entry: 'i.html' }, ...over }) as CanvasVersion

  it('agrees with the shared helper on the same fixture, for every phase', () => {
    const versions = [version('v1', { verdict: { state: 'rejected', by: 'user', at: 'x' } }), version('v2')]
    const live = stateOf([review('R1', 'submitted', '2026-08-22T10:00:00.000Z')], [note('a1', 'R1', 'open')])

    // needs-you: v2 is open, whatever the round says.
    expect(artifactPhaseFor(live, versions, 'v2')).toEqual({ kind: 'needs-you', versionId: 'v2' })
    // The SHARED helper, over the same run, gives the same answer — the point
    // of the wrapper is that there is only ever one of these computations.
    expect(artifactPhaseFor(live, versions, 'v2')).toEqual(artifactPhaseOf(versions, live.reviews, live.annotations))

    // with-agent: no open version, one live round.
    const decided = [versions[0], version('v2', { verdict: { state: 'approved', by: 'user', at: 'x' } })]
    expect(artifactPhaseFor(live, decided, 'v2')).toMatchObject({ kind: 'with-agent', reviewId: 'R1', openNotes: 1 })

    // settled: nothing open, nothing live.
    const done = stateOf([review('R1', 'resolved', '2026-08-22T10:00:00.000Z')], [note('a1', 'R1', 'stale')])
    expect(artifactPhaseFor(done, decided, 'v2')).toEqual({ kind: 'settled', versionId: 'v2', verdict: 'approved' })

    // A version the canvas does not hold names no run at all.
    expect(artifactPhaseFor(done, decided, 'v99')).toEqual({ kind: 'empty' })
    expect(artifactPhaseFor(done, decided, null)).toEqual({ kind: 'empty' })
  })

  it('picks the DISPLAYED artefact`s run, not the newest one', () => {
    // A plan (v1, still open) and a mockup (v2, approved). Which phase you get
    // depends on which one the pane is showing — the whole reason the wrapper
    // takes a version id rather than reading "the latest".
    const versions = [
      version('v1', { mode: 'plan' }),
      version('v2', { verdict: { state: 'approved', by: 'user', at: 'x' } }),
    ]
    const empty = stateOf([], [])
    expect(artifactPhaseFor(empty, versions, 'v1')).toEqual({ kind: 'needs-you', versionId: 'v1' })
    expect(artifactPhaseFor(empty, versions, 'v2')).toEqual({ kind: 'settled', versionId: 'v2', verdict: 'approved' })
  })
})
