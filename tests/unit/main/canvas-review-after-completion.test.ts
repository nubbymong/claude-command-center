// #573 — approval auto-complete must not orphan the approval's own notes.
//
// The live repro (2026-08-30): the user approved v4 WITH two notes; the
// approval auto-completed the subject, `setCanvasCompleted` detached the
// session pointer, and the agent's `canvas_review R4` came back "no canvas for
// session" — the one read still owed became impossible. These pin the fix:
//  1. `getReviewPayload` falls back to the session's completed canvas (reads
//     survive sign-off) and returns the approval's notes.
//  2. `getLastCompletedCanvasStateForSession` resolves only THIS session's
//     newest completed canvas — never live ones, never another session's.
//  3. Mutation stays terminal: a completed canvas still refuses new notes.

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-573-'))
  return { getResourcesDirectory: () => dir }
})

const canvasStore = await import('../../../src/main/canvas/canvas-store')
const reviewStore = await import('../../../src/main/canvas/canvas-review-store')

const SID = 'f573aaaaaaaaaaaaaaaaaaaa'
const OTHER_SID = 'f573bbbbbbbbbbbbbbbbbbbb'
let seq = 0

/** Render → one general note → submit as an APPROVAL → complete (the pane's
 *  auto-complete path lands on the same store call). */
function approvedAndCompleted(sessionId: string, note = 'final constraint: terminal view only'): { canvasId: string; reviewId: string } {
  const title = `Approved subject ${++seq}`
  const r = canvasStore.renderVersion(sessionId, {
    mode: 'design',
    html: '<!doctype html><p>page</p>',
    title,
  })
  reviewStore.upsertAnnotation(sessionId, { scope: 'general', note, versionId: r.versionId })
  const submitted = reviewStore.submitReview(sessionId, reviewStore.getReviewStateForSession(sessionId)!.reviews[0].id, [], 'approve')
  const reviewId = submitted.reviews.find((rv) => rv.status !== 'draft')!.id
  const done = canvasStore.setCanvasCompleted(r.canvasId, 'user', sessionId)
  expect('error' in done).toBe(false)
  return { canvasId: r.canvasId, reviewId }
}

describe('#573 — reviews stay fetchable after the approval completed the subject', () => {
  it('getReviewPayload serves the approval round from the detached (completed) canvas', () => {
    const { reviewId } = approvedAndCompleted(SID)
    // The live binding is gone — this is the exact state the bug fired in.
    expect(canvasStore.getCanvasStateForSession(SID)).toBeNull()
    const out = reviewStore.getReviewPayload(SID, reviewId)
    expect(out.payload.review.id).toBe(reviewId)
    const notes = [...out.payload.generalNotes, ...out.payload.annotations].map((a) => a.note)
    expect(notes).toContain('final constraint: terminal view only')
  })

  it('resolves the NEWEST completed canvas, and only this session’s', () => {
    const first = approvedAndCompleted(SID)
    const second = approvedAndCompleted(SID)
    const state = canvasStore.getLastCompletedCanvasStateForSession(SID)
    expect(state?.canvasId).toBe(second.canvasId)
    expect(state?.canvasId).not.toBe(first.canvasId)
    // A session that never completed anything gets nothing — not a neighbour's.
    expect(canvasStore.getLastCompletedCanvasStateForSession(OTHER_SID)).toBeNull()
  })

  it('a session with its OWN completed canvas still cannot fetch another session’s notes', () => {
    // The sharp cross-session case (adversarial pass): OTHER_SID qualifies for
    // the fallback — it has a completed canvas of its own — and asks for the
    // review id minted on SID's canvas. Review ids are per-canvas ("R1" exists
    // on both), so the fallback must resolve OTHER_SID's OWN canvas: it gets
    // its own note back, and the victim's text never crosses over.
    const victim = approvedAndCompleted(SID, 'VICTIM-PRIVATE-NOTE')
    approvedAndCompleted(OTHER_SID, 'attacker own note')
    const out = reviewStore.getReviewPayload(OTHER_SID, victim.reviewId)
    const notes = [...out.payload.generalNotes, ...out.payload.annotations].map((a) => a.note)
    expect(notes).toContain('attacker own note')
    expect(notes.join(' ')).not.toContain('VICTIM-PRIVATE-NOTE')
    expect(out.payload.review.canvas.canvasId).not.toBe(victim.canvasId)
  })

  it('mutation is still terminal: a completed canvas refuses a new note', () => {
    approvedAndCompleted(SID)
    expect(() =>
      reviewStore.upsertAnnotation(SID, { scope: 'general', note: 'late note', versionId: 'v1' }),
    ).toThrowError(/no canvas for session/)
  })
})
