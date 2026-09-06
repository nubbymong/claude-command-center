// rc.15 review R10 (Codex, 2026-09-06; aicc_planning#52 adjacent): the reviewer's
// characterization (evidence/canvas-followup.review.test.ts) flipped into the
// desired behaviour, credit Codex rc.15 stability review; RED against 7ef62a2e
// before this change. Positive controls are labelled.
//
// The resume gate read the NEWEST artefact run only, so a rejected plan hid
// behind a later approved design: the canvas vanished from the resumable rows
// and resume answered 'completed' while Mark complete (rightly) refused the
// outstanding plan note. One predicate now serves the list, the action and
// the completion guard's version/debt terms: every live run must be decided,
// and the full review debt (draft, open, answered notes, live rounds; an
// unreadable store) keeps a canvas resumable. Real stores over a temp root.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const hoisted = vi.hoisted(() => {
  const nfs = require('node:fs') as typeof import('node:fs')
  const nos = require('node:os') as typeof import('node:os')
  const npath = require('node:path') as typeof import('node:path')
  return { root: nfs.mkdtempSync(npath.join(nos.tmpdir(), 'ccc-vitest-r10-')) }
})
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => hoisted.root }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getTranscriptBinder: () => null }))

const store = await import('../../../src/main/canvas/canvas-store')
const reviews = await import('../../../src/main/canvas/canvas-review-store')
const link = await import('../../../src/main/canvas/canvas-session-link')
const completion = await import('../../../src/main/canvas/canvas-completion')
import type { CanvasReviewDebt } from '../../../src/main/canvas/canvas-store'

link.installCanvasSessionLink()
const cwd = 'C:\\synthetic-r10-project'
let n = 0
const owner = () => 'a'.repeat(20) + String(++n).padStart(4, '0')
const peerOf = (o: string) => 'b'.repeat(20) + o.slice(20)

/** The oracle the session link builds for production, rebuilt here so parity
 *  can be asserted on the SHARED predicate (plan 5.2). */
const debtOf = (canvasId: string): CanvasReviewDebt => {
  const c = reviews.getReviewCountsForCanvas(canvasId)
  if (c) return { draftNotes: c.draftNotes, openNotes: c.openNotes, addressedNotes: c.addressedNotes, liveRounds: c.liveRounds }
  return reviews.reviewStoreFileExists(canvasId) ? 'unreadable' : 'none'
}
const listed = (peer: string, canvasId: string) => link.listResumableRows(peer, [peer]).some((r) => r.canvasId === canvasId)
const settledNow = (canvasId: string) => store.isSettled(store.getCanvasStateById(canvasId)!, debtOf)
/** The two surfaces and the predicate must agree (plan 5.2 parity). */
function expectResumable(peer: string, canvasId: string, o: string, resumable: boolean): void {
  expect(listed(peer, canvasId)).toBe(resumable)
  expect(settledNow(canvasId)).toBe(!resumable)
  if (resumable) expect(link.resumeCanvasFromSession(peer, canvasId, o, [peer])).toEqual({ ok: true, canvasId })
  else expect(link.resumeCanvasFromSession(peer, canvasId, o, [peer])).toEqual({ ok: false, reason: 'completed' })
}

/** Codex's fixture: a rejected plan with its note still with the agent, and a
 *  later approved design on the same canvas. */
function rejectedPlanApprovedDesign(o: string) {
  link.noteSessionSpawnForCanvas(o, { cwd })
  const plan = store.renderVersion(o, { title: 'Review subject', mode: 'plan', html: '<p>plan</p>' })
  const { annotationId } = reviews.upsertAnnotation(o, { scope: 'general', note: 'The migration plan is incomplete', versionId: plan.versionId })
  const draft = reviews.getReviewStateForSession(o)!.reviews.find((r) => r.status === 'draft')!
  reviews.submitReview(o, draft.id, [], 'reject')
  const design = store.renderVersion(o, { title: 'Review subject', mode: 'design', html: '<p>design</p>' })
  expect(design.canvasId).toBe(plan.canvasId)
  store.setVersionVerdict(o, design.versionId, { state: 'approved' }, 'user')
  reviews.settleRoundsForUserDecision(plan.canvasId, design.versionId)
  return { canvasId: plan.canvasId, planVersionId: plan.versionId, reviewId: draft.id, annotationId }
}
/** A plan the user rejected from the pane (no review round, no notes) beside an approved design. */
function rejectedPlanNoNotesApprovedDesign(o: string) {
  link.noteSessionSpawnForCanvas(o, { cwd })
  const plan = store.renderVersion(o, { title: 'Review subject', mode: 'plan', html: '<p>plan</p>' })
  store.setVersionVerdict(o, plan.versionId, { state: 'rejected', note: 'redo it' }, 'user')
  const design = store.renderVersion(o, { title: 'Review subject', mode: 'design', html: '<p>design</p>' })
  store.setVersionVerdict(o, design.versionId, { state: 'approved' }, 'user')
  return { canvasId: plan.canvasId, planVersionId: plan.versionId }
}
function approvedDesignOnly(o: string) {
  link.noteSessionSpawnForCanvas(o, { cwd })
  const design = store.renderVersion(o, { title: 'Just a design', mode: 'design', html: '<p>design</p>' })
  store.setVersionVerdict(o, design.versionId, { state: 'approved' }, 'user')
  return { canvasId: design.canvasId, versionId: design.versionId }
}

beforeEach(() => { /* each test mints its own owner/peer; the stores keep every canvas */ })
afterAll(() => { fs.rmSync(hoisted.root, { recursive: true, force: true }) })

describe('R10: an approved design does not hide an unfinished plan from resume (Codex, flipped)', () => {
  it('Codex: rejected plan + 1 open note + approved design -> Mark complete refuses, and the canvas IS listed and resumable from a peer', () => {
    const o = owner(); const peer = peerOf(o)
    const { canvasId } = rejectedPlanApprovedDesign(o)
    expect(reviews.getReviewCountsForCanvas(canvasId)?.openNotes).toBe(1)
    expect(completion.completeCanvasGuarded(canvasId, 'user', o)).toEqual({ error: 'not everything is settled: 1 note still with the agent' })
    link.noteSessionSpawnForCanvas(peer, { cwd })
    // 7ef62a2e: not listed, and resume answered 'completed'.
    expectResumable(peer, canvasId, o, true)
  })

  it('answering that note does NOT settle it: the rejected plan is unsuperseded, so the canvas stays resumable until a later plan version is decided', () => {
    const o = owner(); const peer = peerOf(o)
    const { canvasId, reviewId, annotationId } = rejectedPlanApprovedDesign(o)
    reviews.markAnnotationsAddressed(o, reviewId, [annotationId])
    expect(reviews.getReviewCountsForCanvas(canvasId)).toMatchObject({ openNotes: 0, addressedNotes: 1 })
    // The versions alone keep it open, whatever the review store says.
    expect(store.isSettled(store.getCanvasStateById(canvasId)!, () => 'none')).toBe(false)
    link.noteSessionSpawnForCanvas(peer, { cwd })
    expect(listed(peer, canvasId)).toBe(true)
    expect(settledNow(canvasId)).toBe(false)
    // A reworked plan the user approves is the rework the rejection waited for:
    // the VERSIONS are settled now...
    const plan2 = store.renderVersion(o, { title: 'Review subject', mode: 'plan', html: '<p>plan v2</p>' })
    store.setVersionVerdict(o, plan2.versionId, { state: 'approved' }, 'user')
    reviews.settleRoundsForUserDecision(canvasId, plan2.versionId)
    expect(store.isSettled(store.getCanvasStateById(canvasId)!, () => 'none')).toBe(true)
    // ...but the answered note the user has not looked at is still debt (the
    // design's and the new plan's decisions settle their own rounds, not the
    // old plan's), so the canvas stays resumable and Mark complete says why.
    expect(reviews.getReviewCountsForCanvas(canvasId)?.addressedNotes).toBe(1)
    expect(completion.completeCanvasGuarded(canvasId, 'user', o)).toEqual({ error: 'not everything is settled: 1 note the agent has answered' })
    expectResumable(peer, canvasId, o, true)
  })

  it('Mark complete refuses a rejected, unreworked plan by name (no notes anywhere), and the user\'s force still completes it', () => {
    const o = owner(); const peer = peerOf(o)
    const { canvasId, planVersionId } = rejectedPlanNoNotesApprovedDesign(o)
    expect(reviews.getReviewCountsForCanvas(canvasId)).toBeNull()
    link.noteSessionSpawnForCanvas(peer, { cwd })
    expect(listed(peer, canvasId)).toBe(true) // resumable on the versions alone
    expect(completion.completeCanvasGuarded(canvasId, 'user', o)).toEqual({ error: `not everything is settled: ${planVersionId} (plan) rejected and not yet reworked` })
    expect(completion.completeCanvasGuarded(canvasId, 'user', o, { force: true })).toMatchObject({ completed: expect.anything() })
  })

  it('a draft (unsubmitted) note alone keeps an otherwise approved canvas resumable', () => {
    const o = owner(); const peer = peerOf(o)
    const { canvasId, versionId } = approvedDesignOnly(o)
    reviews.upsertAnnotation(o, { scope: 'general', note: 'still typing', versionId })
    expect(reviews.getReviewCountsForCanvas(canvasId)?.draftNotes).toBe(1)
    expect(completion.completeCanvasGuarded(canvasId, 'user', o)).toEqual({ error: 'not everything is settled: 1 unsubmitted note' })
    link.noteSessionSpawnForCanvas(peer, { cwd })
    expectResumable(peer, canvasId, o, true)
  })

  it('the debt oracle: each count keeps the canvas resumable on its own; an unreadable store is debt; a throwing oracle is treated as owed', () => {
    const o = owner()
    const { canvasId } = approvedDesignOnly(o)
    const record = store.getCanvasStateById(canvasId)!
    const zero = { draftNotes: 0, openNotes: 0, addressedNotes: 0, liveRounds: 0 }
    expect(store.isSettled(record, () => zero)).toBe(true)
    expect(store.isSettled(record, () => 'none')).toBe(true)
    expect(store.isSettled(record)).toBe(true)
    for (const key of ['draftNotes', 'openNotes', 'addressedNotes', 'liveRounds'] as const) {
      expect(store.isSettled(record, () => ({ ...zero, [key]: 1 })), key).toBe(false)
    }
    expect(store.isSettled(record, () => 'unreadable')).toBe(false)
    expect(store.isSettled(record, () => { throw new Error('disk') })).toBe(false)
  })

  it('a corrupt review store as the ONLY debt keeps the canvas resumable; a healthy absent file does not (control)', () => {
    const o = owner(); const peer = peerOf(o)
    const { canvasId } = approvedDesignOnly(o)
    link.noteSessionSpawnForCanvas(peer, { cwd })
    expectResumable(peer, canvasId, o, false) // control: nothing owed, no store
    fs.writeFileSync(path.join(hoisted.root, 'canvas', canvasId, 'reviews.json'), '{ not json')
    reviews._resetCanvasReviewStoreForTest()
    expect(reviews.getReviewCountsForCanvas(canvasId)).toBeNull()
    expect(reviews.reviewStoreFileExists(canvasId)).toBe(true)
    expect(completion.completeCanvasGuarded(canvasId, 'user', o)).toEqual({ error: 'the review store for this canvas could not be read — refusing to sign off what cannot be checked' })
    expect(listed(peer, canvasId)).toBe(true)
    expect(settledNow(canvasId)).toBe(false)
    fs.rmSync(path.join(hoisted.root, 'canvas', canvasId, 'reviews.json'), { force: true })
    reviews._resetCanvasReviewStoreForTest()
  })

  it('positive control: plan AND design both approved, no notes -> not listed, resume says completed, Mark complete succeeds', () => {
    const o = owner(); const peer = peerOf(o)
    link.noteSessionSpawnForCanvas(o, { cwd })
    const plan = store.renderVersion(o, { title: 'Both approved', mode: 'plan', html: '<p>plan</p>' })
    store.setVersionVerdict(o, plan.versionId, { state: 'approved' }, 'user')
    const design = store.renderVersion(o, { title: 'Both approved', mode: 'design', html: '<p>design</p>' })
    store.setVersionVerdict(o, design.versionId, { state: 'approved' }, 'user')
    link.noteSessionSpawnForCanvas(peer, { cwd })
    expectResumable(peer, plan.canvasId, o, false)
    expect(completion.completeCanvasGuarded(plan.canvasId, 'user', o)).toMatchObject({ completed: expect.anything() })
  })

  it('an ARCHIVED rejected run is the user\'s own tucking-away and does not keep the canvas resumable (Codex re-review, condition 3)', () => {
    const o = owner(); const peer = peerOf(o)
    link.noteSessionSpawnForCanvas(o, { cwd })
    const plan = store.renderVersion(o, { title: 'Archived plan', mode: 'plan', html: '<p>plan</p>' })
    store.setVersionVerdict(o, plan.versionId, { state: 'rejected', note: 'redo' }, 'user')
    store.setArtifactArchived(plan.canvasId, plan.versionId, true)
    const design = store.renderVersion(o, { title: 'Archived plan', mode: 'design', html: '<p>design</p>' })
    store.setVersionVerdict(o, design.versionId, { state: 'approved' }, 'user')
    link.noteSessionSpawnForCanvas(peer, { cwd })
    expectResumable(peer, plan.canvasId, o, false)
  })
})
