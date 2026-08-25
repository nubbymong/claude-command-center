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
  it('signing off the DRAFTING canvas clears the deferred-draft binding with it', () => {
    // A subject-change DRAFT defers the repoint: the session still shows the
    // old canvas, and draftIndex lets canvas_snapshot follow the draft. If
    // that drafting canvas is signed off, the binding must die with the
    // detach (the dropCanvas rule) — or the agent's self-check would keep
    // reading a canvas nothing will ever promote.
    const base = renderCanvas() // the session's current, user-facing canvas
    canvasStore.clearAwaitingReview(base.canvasId)
    const draft = canvasStore.renderVersion(SID, {
      mode: 'design',
      html: '<!doctype html><p>draft</p>',
      title: `Deferred ${++seq}`,
      ready: false,
    })
    expect(draft.canvasId).not.toBe(base.canvasId)
    expect(canvasStore.getAgentCanvasStateForSession(SID)?.canvasId).toBe(draft.canvasId)
    const res = completion.completeCanvasGuarded(draft.canvasId, 'user', SID)
    expect(err(res)).toBe('')
    // The agent-facing read falls back to the session's own canvas.
    expect(canvasStore.getAgentCanvasStateForSession(SID)?.canvasId).toBe(base.canvasId)
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
