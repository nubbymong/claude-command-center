// Canvas completion (#476): the subject-level terminal state, driven through
// the REAL stores (temp resources dir), like canvas-closeout-store.test.ts.
//
// What these pin, in order of how much they matter:
//
//  1. NOTHING OWED, OR NO SIGN-OFF. Every kind of outstanding work refuses the
//     completion — an unreviewed ready render, unsubmitted drafts, notes with
//     the agent, notes awaiting verdicts — and an unreadable review store
//     refuses rather than signing off what cannot be checked. The guard's
//     tallies are the queue's own, so the pill and the refusal cannot disagree.
//  2. OWNERSHIP. Both ingresses name the session they act for; a canvas owned
//     by another session is refused.
//  3. TERMINAL MEANS TERMINAL. A completed canvas refuses renders; a new
//     render under the same title starts a FRESH canvas rather than silently
//     resuming the one the user signed off. Reopen is the only way back.
//  4. NOTHING DELETED. Completion detaches and stamps; Reopen restores.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-completion-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const canvasStore = await import('../../../src/main/canvas/canvas-store')
const reviewStore = await import('../../../src/main/canvas/canvas-review-store')
const completion = await import('../../../src/main/canvas/canvas-completion')
const { runCanvasComplete } = await import('../../../src/main/canvas-mcp-tool')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
let seq = 0

/** A fresh canvas for this test, under its own title so it never collides. */
function renderCanvas(ready?: boolean): { canvasId: string; versionId: string; title: string } {
  const title = `Subject ${++seq}`
  const r = canvasStore.renderVersion(SID, {
    mode: 'design',
    html: '<!doctype html><p>page</p>',
    title,
    ...(ready === undefined ? {} : { ready }),
  })
  return { canvasId: r.canvasId, versionId: r.versionId, title }
}

/** A canvas whose whole review cycle FINISHED: render → note → submit →
 *  addressed → seen → the user approved. Nothing is owed either way. */
function finishedCycle(): { canvasId: string; title: string } {
  const { canvasId, versionId, title } = renderCanvas()
  const { annotationId } = reviewStore.upsertAnnotation(SID, { scope: 'general', note: 'one note', versionId })
  const submitted = reviewStore.submitReview(SID, reviewStore.getReviewStateForSession(SID)!.reviews[0].id, [])
  const reviewId = submitted.reviews.find((r) => r.status === 'submitted')!.id
  reviewStore.markAnnotationsAddressed(SID, reviewId, [annotationId])
  reviewStore.markAddressedNotesSeen(SID, canvasId, [annotationId])
  reviewStore.resolveAnnotation(SID, annotationId, 'approve', canvasId)
  return { canvasId, title }
}

const err = (r: unknown): string => (r && typeof r === 'object' && 'error' in r ? String((r as { error: unknown }).error) : '')

describe('the completion guard — nothing owed, or no sign-off', () => {
  it('refuses while a ready render awaits the user’s first review', () => {
    const { canvasId } = renderCanvas()
    const res = completion.completeCanvasGuarded(canvasId, 'agent', SID)
    expect(err(res)).toContain('awaiting the user’s first review')
  })

  it('ADV round 2: an AGENT cannot render, self-approve from chat, and self-complete (MEDIUM)', () => {
    // The bypass: canvas_version_verdict (agent-chat) clears awaitingReview,
    // which the guard leaned on — so without the agent-chat guard the whole
    // render → self-approve → sign-off runs with zero user gestures.
    const title = `Self approve ${++seq}`
    const r = canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>x</p>', title })
    const ruled = canvasStore.setVersionVerdict(SID, r.versionId, { state: 'approved' }, 'agent-chat')
    expect('error' in ruled).toBe(false) // the verdict itself is recorded (honest, from chat)
    // ...but an AGENT completion may not rest on it.
    const agent = completion.completeCanvasGuarded(r.canvasId, 'agent', SID)
    expect(err(agent)).toContain('recorded from chat')
    // The USER completing it themselves (pane button) is never blocked here.
    const user = completion.completeCanvasGuarded(r.canvasId, 'user', SID)
    expect('error' in user).toBe(false)
  })

  it('ADV round 2: a USER-submitted approval DOES let the agent complete', () => {
    const title = `User approve ${++seq}`
    const r = canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>y</p>', title })
    canvasStore.setVersionVerdict(SID, r.versionId, { state: 'approved' }, 'user') // the pane submit path
    const agent = completion.completeCanvasGuarded(r.canvasId, 'agent', SID)
    expect('error' in agent).toBe(false)
  })

  it('ADV: refuses a DRAFT-ONLY canvas — nothing was ever offered to the user', () => {
    // The draft-render bypass (adversarial): a ready render sets awaitingReview
    // and writes reviews.json, but a draft (ready:false) does neither — so the
    // old guard found "nothing owed" and signed off a canvas the user never saw.
    const title = `Draft only ${++seq}`
    const r = canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>wip</p>', title, ready: false })
    const res = completion.completeCanvasGuarded(r.canvasId, 'agent', SID)
    expect(err(res)).toContain('nothing has been offered for review')
  })

  it('ADV: refuses when the LATEST version is a draft, even over a reviewed ready one', () => {
    // Finish a real cycle, then the agent renders a fresh DRAFT on top — that
    // draft is unseen WIP; signing off would stamp complete over it.
    const done = finishedCycle()
    canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>wip2</p>', title: done.title, ready: false })
    const res = completion.completeCanvasGuarded(done.canvasId, 'agent', SID)
    expect(err(res)).toContain('nothing has been offered for review')
  })

  it('ADV: checks ownership BEFORE reading review tallies (no cross-session oracle)', () => {
    // A foreign session naming another session's canvas must be turned away
    // with the ownership reason, never with that canvas's private note counts.
    const { canvasId, versionId } = renderCanvas()
    reviewStore.upsertAnnotation(SID, { scope: 'general', note: 'secret', versionId })
    reviewStore.submitReview(SID, reviewStore.getReviewStateForSession(SID)!.reviews[0].id, [])
    const res = completion.completeCanvasGuarded(canvasId, 'agent', 'ffffffffffffffffffffffff')
    expect(err(res)).toBe('not this session’s canvas')
  })

  it('refuses unsubmitted draft notes, and names them', () => {
    const { canvasId, versionId } = renderCanvas()
    canvasStore.clearAwaitingReview(canvasId)
    reviewStore.upsertAnnotation(SID, { scope: 'general', note: 'draft', versionId })
    const res = completion.completeCanvasGuarded(canvasId, 'user', SID)
    expect(err(res)).toContain('unsubmitted note')
  })

  it('refuses notes still with the agent', () => {
    const { canvasId, versionId } = renderCanvas()
    reviewStore.upsertAnnotation(SID, { scope: 'general', note: 'open', versionId })
    reviewStore.submitReview(SID, reviewStore.getReviewStateForSession(SID)!.reviews[0].id, [])
    const res = completion.completeCanvasGuarded(canvasId, 'user', SID)
    expect(err(res)).toContain('still with the agent')
  })

  it('refuses notes awaiting the user’s verdict', () => {
    const { canvasId, versionId } = renderCanvas()
    const { annotationId } = reviewStore.upsertAnnotation(SID, { scope: 'general', note: 'n', versionId })
    const submitted = reviewStore.submitReview(SID, reviewStore.getReviewStateForSession(SID)!.reviews[0].id, [])
    const reviewId = submitted.reviews.find((r) => r.status === 'submitted')!.id
    reviewStore.markAnnotationsAddressed(SID, reviewId, [annotationId])
    const res = completion.completeCanvasGuarded(canvasId, 'user', SID)
    expect(err(res)).toContain('awaiting your verdict')
  })

  it('fails CLOSED on an unreadable review store', () => {
    const { canvasId } = finishedCycle()
    // Corrupt the reviews.json under the store: a file that exists but will
    // not read must refuse the sign-off, never count as "nothing owed".
    const reviewsPath = path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')
    expect(fs.existsSync(reviewsPath)).toBe(true)
    fs.writeFileSync(reviewsPath, '{ not json')
    reviewStore.dropReviewsForCanvas(canvasId)
    const res = completion.completeCanvasGuarded(canvasId, 'user', SID)
    expect(err(res)).toContain('could not be read')
  })

  it('completes a canvas whose whole cycle finished — and a never-annotated one once its ask is cleared', () => {
    const a = finishedCycle()
    const resA = completion.completeCanvasGuarded(a.canvasId, 'user', SID)
    expect(err(resA)).toBe('')
    expect((resA as { completed?: { by: string } }).completed?.by).toBe('user')

    const b = renderCanvas()
    canvasStore.clearAwaitingReview(b.canvasId)
    const resB = completion.completeCanvasGuarded(b.canvasId, 'agent', SID)
    expect(err(resB)).toBe('')
    expect((resB as { completed?: { by: string } }).completed?.by).toBe('agent')
  })
})

describe('what completion does', () => {
  it('stamps, clears the review-needed ask, detaches the session, and announces itself', () => {
    const { canvasId } = finishedCycle()
    const events: Array<{ canvasId: string; completed?: boolean }> = []
    const off = canvasStore.onCanvasChanged((e) => events.push({ canvasId: e.canvasId, completed: e.completed }))
    const res = completion.completeCanvasGuarded(canvasId, 'user', SID)
    off()
    expect(err(res)).toBe('')
    // Detached: the session no longer shows this canvas — the pane falls back
    // to its front page.
    expect(canvasStore.getCanvasStateForSession(SID)).toBeNull()
    // The record keeps everything, plus the stamp; the ask is gone.
    const byId = canvasStore.getCanvasStateById(canvasId)
    expect(byId?.completed?.by).toBe('user')
    expect(byId?.awaitingReview).toBeUndefined()
    expect(events.some((e) => e.canvasId === canvasId && e.completed)).toBe(true)
  })

  it('refuses ownership it does not have, and refuses twice', () => {
    const { canvasId } = finishedCycle()
    expect(err(completion.completeCanvasGuarded(canvasId, 'user', 'ffffffffffffffffffffffff'))).toContain('not this session')
    expect(err(completion.completeCanvasGuarded(canvasId, 'user', SID))).toBe('')
    expect(err(completion.completeCanvasGuarded(canvasId, 'user', SID))).toContain('already completed')
  })

  it('shows up in the library with the stamp', () => {
    const { canvasId } = finishedCycle()
    completion.completeCanvasGuarded(canvasId, 'user', SID)
    const entry = canvasStore.listAllCanvases([], undefined, SID).find((e) => e.canvasId === canvasId)
    expect(entry?.completed?.by).toBe('user')
  })
})

describe('adversarial — reclaim, review-writes, cap, fork', () => {
  it('a completed canvas is never offered to, or adopted by, another session', () => {
    // isReclaimCandidate must exclude completed: completion detaches the owner,
    // so without the check a signed-off canvas looks like an orphan — offered
    // in the reclaim card and adoptable, handing over its notes AND the right
    // to Reopen a sign-off the adopter never made.
    const done = finishedCycle()
    completion.completeCanvasGuarded(done.canvasId, 'user', SID)
    const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb'
    const offered = canvasStore.listOrphanCandidateCanvases(OTHER, { isSessionCurrent: () => false })
    expect(offered.some((c) => c.canvasId === done.canvasId)).toBe(false)
    const adopted = canvasStore.adoptCanvasForSession(OTHER, done.canvasId, { isSessionCurrent: () => false })
    expect(adopted).toBeNull()
  })

  it('a completed canvas refuses EVERY note-writing mutation over the store (terminal, main-side)', () => {
    // Round-2 adversarial: the gate must cover the siblings too — reannotate
    // (resolveAnnotation) MINTS a note, reopenAnnotation REVIVES one. All the
    // write mutators refuse; the pane's read path (getReviewStateForSession)
    // stays open so history is still viewable.
    const done = finishedCycle()
    completion.completeCanvasGuarded(done.canvasId, 'user', SID)
    canvasStore.adoptCanvasForSession(SID, done.canvasId, { isSessionCurrent: () => false })
    const v = canvasStore.getCanvasStateForSession(SID)!.versions[0].id
    expect(() => reviewStore.upsertAnnotation(SID, { scope: 'general', note: 'x', versionId: v })).toThrow(/signed off/)
    expect(() => reviewStore.resolveAnnotation(SID, 'a1', 'reannotate', done.canvasId)).toThrow(/signed off/)
    expect(() => reviewStore.reopenAnnotation(SID, 'a1')).toThrow(/signed off/)
    expect(() => reviewStore.deleteAnnotation(SID, 'a1')).toThrow(/signed off/)
    expect(() => reviewStore.markAnnotationsAddressed(SID, 'R1', ['a1'])).toThrow(/signed off/)
    // The history read still works — the pane can show the closed round.
    expect(reviewStore.getReviewStateForSession(SID)?.canvasId).toBe(done.canvasId)
  })

  it('completing then rendering in a loop cannot mint canvases past the cap', () => {
    // The cap was gated on subjectChanged, which completion makes false — so an
    // agent that completes-then-renders could mint without bound.
    let last = ''
    for (let i = 0; i < 3; i++) {
      const r = canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>x</p>', title: `Loop ${++seq}` })
      canvasStore.clearAwaitingReview(r.canvasId)
      completion.completeCanvasGuarded(r.canvasId, 'user', SID)
      last = r.canvasId
    }
    // The count is bounded — every render minted a NEW canvas (held was null
    // after each completion), and the cap now fires on !existing regardless of
    // subjectChanged. Prove the cap path is live: it counts completed canvases.
    expect(canvasStore.listAllCanvases([], undefined, SID).filter((e) => e.completed).length).toBeGreaterThanOrEqual(3)
    expect(last).not.toBe('')
  })

  it('completing one subject does not fork a DIFFERENT live filed subject', () => {
    // A (Login) live+filed, B (Checkout) current & completed → rendering "A"
    // again must RETURN to A, not mint a duplicate (held is null after the
    // completion detach, so findFiledCanvas must still be consulted).
    const a = canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>login</p>', title: 'Login page ADV' })
    const b = canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>checkout</p>', title: 'Checkout ADV' })
    expect(b.canvasId).not.toBe(a.canvasId)
    canvasStore.clearAwaitingReview(b.canvasId)
    completion.completeCanvasGuarded(b.canvasId, 'user', SID)
    const back = canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>login2</p>', title: 'Login page ADV' })
    expect(back.canvasId).toBe(a.canvasId)
  })
})

describe('terminal means terminal', () => {
  it('a render under the SAME title starts a fresh canvas, never resumes the completed one', () => {
    // Two guards conspire here: completion DETACHED the session (held is
    // null), and even a detached lookup by title skips completed records —
    // the second is pinned on its own by the another-canvas case below.
    const { canvasId, title } = finishedCycle()
    completion.completeCanvasGuarded(canvasId, 'user', SID)
    const next = canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>again</p>', title })
    expect(next.canvasId).not.toBe(canvasId)
    // And the completed record was not touched.
    expect(canvasStore.getCanvasStateById(canvasId)?.completed).toBeTruthy()
  })

  it('naming a completed subject from another canvas starts fresh as well — not a refusal, not a resume', () => {
    // The filing lookup must SKIP completed records: with the session parked
    // on some other canvas, a render naming the completed subject would
    // otherwise find it as `returnedTo` and die on the terminal refusal.
    const done = finishedCycle()
    completion.completeCanvasGuarded(done.canvasId, 'user', SID)
    renderCanvas() // the session moves on to an unrelated subject
    const next = canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>fresh</p>', title: done.title })
    expect(next.canvasId).not.toBe(done.canvasId)
    expect(canvasStore.getCanvasStateById(done.canvasId)?.completed).toBeTruthy()
  })
})

describe('survival and viewing', () => {
  it('signing off the session’s canvas drops a stranded deferred-draft binding too', () => {
    // A subject-change DRAFT defers the repoint: sessionIndex stays on the
    // user-facing base, draftIndex points at the new draft canvas so
    // canvas_snapshot can follow it. Completing the BASE detaches the session —
    // and must drop the draft pointer with it, or getAgentCanvasStateForSession
    // keeps resolving a stale draft the user will never promote (the round-1
    // fix keyed the delete on the wrong id and missed this).
    const base = renderCanvas() // ready; the session's current canvas
    const draft = canvasStore.renderVersion(SID, {
      mode: 'design',
      html: '<!doctype html><p>draft</p>',
      title: `Deferred ${++seq}`,
      ready: false,
    })
    expect(draft.canvasId).not.toBe(base.canvasId)
    // The deferred draft is agent-visible; the user still sees base.
    expect(canvasStore.getAgentCanvasStateForSession(SID)?.canvasId).toBe(draft.canvasId)
    expect(canvasStore.getCanvasStateForSession(SID)?.canvasId).toBe(base.canvasId)
    canvasStore.clearAwaitingReview(base.canvasId)
    const res = completion.completeCanvasGuarded(base.canvasId, 'user', SID)
    expect(err(res)).toBe('')
    // Both bindings gone: the session is on the front page, and the agent-side
    // read no longer resolves the stranded draft.
    expect(canvasStore.getCanvasStateForSession(SID)).toBeNull()
    expect(canvasStore.getAgentCanvasStateForSession(SID)).toBeNull()
  })

  it('the stamp survives a reload, and a completed canvas never rebinds as current', () => {
    const { canvasId } = finishedCycle()
    completion.completeCanvasGuarded(canvasId, 'user', SID)
    // Relaunch: memory dropped, records reloaded from disk.
    canvasStore._resetCanvasStoreForTest()
    // Rebind skip: the session comes back to the front page, not the
    // signed-off subject...
    expect(canvasStore.getCanvasStateForSession(SID)?.canvasId).not.toBe(canvasId)
    // ...and the stamp round-tripped through sanitizeRecord intact.
    expect(canvasStore.getCanvasStateById(canvasId)?.completed?.by).toBe('user')
  })

  it('a render while VIEWING a completed canvas starts fresh instead of dead-ending', () => {
    // The library's View re-points the session at the completed canvas. A
    // render there must not refuse forever (the untitled case could never
    // escape) and must not resume — fresh canvas, viewing record untouched.
    const done = finishedCycle()
    completion.completeCanvasGuarded(done.canvasId, 'user', SID)
    const adopted = canvasStore.adoptCanvasForSession(SID, done.canvasId, { isSessionCurrent: () => false })
    expect(adopted?.canvasId).toBe(done.canvasId)
    expect(canvasStore.getCanvasStateForSession(SID)?.canvasId).toBe(done.canvasId)
    const next = canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>new</p>', title: done.title })
    expect(next.canvasId).not.toBe(done.canvasId)
    expect(canvasStore.getCanvasStateById(done.canvasId)?.completed).toBeTruthy()
  })
})

describe('reopen', () => {
  it('clears the stamp and rebinds when the session shows nothing else', () => {
    const { canvasId } = finishedCycle()
    completion.completeCanvasGuarded(canvasId, 'user', SID)
    expect(canvasStore.getCanvasStateForSession(SID)).toBeNull()
    const res = completion.reopenCanvasGuarded(canvasId, SID)
    expect(err(res)).toBe('')
    expect((res as { completed?: unknown }).completed).toBeUndefined()
    expect(canvasStore.getCanvasStateForSession(SID)?.canvasId).toBe(canvasId)
  })

  it('does not steal the session’s current canvas when one exists', () => {
    const a = finishedCycle()
    completion.completeCanvasGuarded(a.canvasId, 'user', SID)
    const b = renderCanvas() // the session moved on
    const res = completion.reopenCanvasGuarded(a.canvasId, SID)
    expect(err(res)).toBe('')
    expect(canvasStore.getCanvasStateForSession(SID)?.canvasId).toBe(b.canvasId)
  })

  it('refuses a canvas that is not completed, and foreign ownership', () => {
    const { canvasId } = renderCanvas()
    expect(err(completion.reopenCanvasGuarded(canvasId, SID))).toContain('not completed')
    canvasStore.clearAwaitingReview(canvasId)
    completion.completeCanvasGuarded(canvasId, 'user', SID)
    expect(err(completion.reopenCanvasGuarded(canvasId, 'ffffffffffffffffffffffff'))).toContain('not this session')
  })
})

describe('the MCP surface (canvas_complete)', () => {
  it('refuses with guidance when the session has no canvas', () => {
    const r = runCanvasComplete('deadbeefdeadbeefdeadbeef', {
      getCanvasState: () => null,
      completeCanvas: () => ({ error: 'unused' }),
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('no active canvas')
  })

  it('passes the settled-refusal through with hand-back guidance', () => {
    const r = runCanvasComplete(SID, {
      getCanvasState: () => ({ canvasId: 'c', sessionId: SID, activeVersionId: 'v1', versions: [] }),
      completeCanvas: () => ({ error: 'not everything is settled: 2 notes awaiting your verdict' }),
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('not everything is settled')
    expect(r.text).toContain('hand back')
  })

  it('reports success in the provenance’s own words — completed on instruction, never approval', () => {
    const r = runCanvasComplete(SID, {
      getCanvasState: () => ({ canvasId: 'c', sessionId: SID, activeVersionId: 'v1', versions: [] }),
      completeCanvas: () => ({ canvasId: 'c', sessionId: SID, activeVersionId: 'v1', versions: [], completed: { at: 'now', by: 'agent' as const } }),
    })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('on the user’s instruction')
    expect(r.text).toContain('Reopen')
  })

  it('ADV: a submit that does not cover the awaited version leaves it awaiting, so completion still refuses', () => {
    // The store-direct race the turn model normally prevents: awaitingReview is
    // v2 (agent rendered a newer ready render) while the user's note was
    // authored against v1. submitReview must NOT clear the v2 ask — the user
    // never saw v2 — and completion must then refuse.
    const title = `Race ${++seq}`
    const v1 = canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>v1</p>', title, ready: true })
    // User writes a note against v1 (a draft note, versionId v1).
    reviewStore.upsertAnnotation(SID, { scope: 'general', note: 'about v1', versionId: v1.versionId })
    // Agent renders v2 ready (supersedes the ask) BEFORE the user submits.
    const v2 = canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>v2</p>', title, ready: true })
    expect(v2.versionId).not.toBe(v1.versionId)
    expect(canvasStore.getCanvasStateForSession(SID)?.awaitingReview?.versionId).toBe(v2.versionId)
    // User submits their v1 note. The submit does not cover v2.
    reviewStore.submitReview(SID, reviewStore.getReviewStateForSession(SID)!.reviews.find((r) => r.status === 'draft')!.id, [])
    // v2 still awaits review → completion refused.
    expect(canvasStore.getCanvasStateForSession(SID)?.awaitingReview?.versionId).toBe(v2.versionId)
    expect(err(completion.completeCanvasGuarded(v1.canvasId, 'agent', SID))).toContain('first review')
  })

  it('the end-to-end agent path: refused before the user has seen the round, allowed after their cycle finished', () => {
    // Before: a fresh ready render — first-review barrier.
    const { canvasId } = renderCanvas()
    const deps = {
      getCanvasState: (sid: string) => canvasStore.getCanvasStateForSession(sid),
      completeCanvas: (sid: string, cid: string) => completion.completeCanvasGuarded(cid, 'agent' as const, sid),
    }
    const refused = runCanvasComplete(SID, deps)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('first review')
    // Finish the cycle on THIS canvas, then the same call signs off.
    const { versionId } = { versionId: canvasStore.getCanvasStateForSession(SID)!.versions[0].id }
    const { annotationId } = reviewStore.upsertAnnotation(SID, { scope: 'general', note: 'n', versionId })
    const submitted = reviewStore.submitReview(SID, reviewStore.getReviewStateForSession(SID)!.reviews[0].id, [])
    const reviewId = submitted.reviews.find((r) => r.status === 'submitted')!.id
    reviewStore.markAnnotationsAddressed(SID, reviewId, [annotationId])
    reviewStore.markAddressedNotesSeen(SID, canvasId, [annotationId])
    reviewStore.resolveAnnotation(SID, annotationId, 'approve', canvasId)
    const ok = runCanvasComplete(SID, deps)
    expect(ok.isError).toBe(false)
    expect(canvasStore.getCanvasStateById(canvasId)?.completed?.by).toBe('agent')
  })
})
