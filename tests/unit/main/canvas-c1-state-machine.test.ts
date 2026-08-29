// The C1 version state machine (owner-approved on the canvas, 2026-08-26):
// per artifact at most ONE ready version is ever OPEN. Renders supersede,
// submits carry verdicts, chat verdicts are provenance-stamped, reopen
// withdraws, and the legacy backlog heals itself on load — the properties the
// phantom "5 reviews open" counts hung on.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { vi } from 'vitest'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-c1-machine-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const reviews = await import('../../../src/main/canvas/canvas-review-store')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const TITLE = 'Feature X'

function render(n: number, opts: { ready?: boolean } = {}) {
  return store.renderVersion(SID, {
    mode: 'design',
    html: `<!doctype html><p data-ux-id="p">v ${n}</p>`,
    title: TITLE,
    ...(opts.ready !== undefined ? { ready: opts.ready } : {}),
  })
}

function versions() {
  return store.getCanvasStateForSession(SID)!.versions
}

function addNote(versionId: string, text = 'needs work'): { reviewId: string; annotationId: string } {
  const { state, annotationId } = reviews.upsertAnnotation(SID, { scope: 'general', note: text, versionId })
  const draft = state.reviews.find((rv) => rv.status === 'draft')!
  return { reviewId: draft.id, annotationId }
}

beforeEach(() => {
  store._resetCanvasStoreForTest()
  reviews._resetCanvasReviewStoreForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})
afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('one open version per artifact — supersede on ready render', () => {
  it('a ready render stamps the previous open version SUPERSEDED and reports it', () => {
    render(1)
    const second = render(2)
    expect(second.superseded).toEqual(['v1'])
    const [v1, v2] = versions()
    expect(v1.verdict).toMatchObject({ state: 'superseded', by: 'system' })
    expect(v2.verdict).toBeUndefined() // the ONE open version
  })

  it('drafts never supersede anything', () => {
    render(1)
    const draft = render(2, { ready: false })
    expect(draft.superseded).toBeUndefined()
    expect(versions()[0].verdict).toBeUndefined()
  })

  it('supersession is scoped to the artifact the render JOINS — a mockup never stamps the plan (review HIGH-1)', () => {
    // Plan v1 (open), then a DESIGN render: different artifact run — the plan
    // must stay open, nothing reported superseded.
    store.renderVersion(SID, { mode: 'plan', html: '<!doctype html><p>plan</p>', title: TITLE })
    const second = render(2)
    expect(second.superseded).toBeUndefined()
    expect(versions()[0].verdict).toBeUndefined() // the plan is still the plan artifact's open version
    // A THIRD render of the same design artifact supersedes only the design.
    const third = render(3)
    expect(third.superseded).toEqual(['v2'])
    expect(versions()[0].verdict).toBeUndefined()
    expect(versions()[1].verdict).toMatchObject({ state: 'superseded' })
  })

  it('a decided version is left alone — supersession only kills the open one', () => {
    render(1)
    const ruled = store.setVersionVerdict(SID, 'v1', { state: 'approved' }, 'user')
    expect('error' in ruled).toBe(false)
    const third = render(2)
    expect(third.superseded).toBeUndefined()
    expect(versions()[0].verdict).toMatchObject({ state: 'approved' })
  })
})

describe('setVersionVerdict', () => {
  it('rules on the open version by default, clears awaitingReview, and refuses a second ruling', () => {
    render(1)
    expect(store.getCanvasStateForSession(SID)!.awaitingReview?.versionId).toBe('v1')
    const ruled = store.setVersionVerdict(SID, undefined, { state: 'rejected', note: 'wrong logo' }, 'agent-chat')
    expect('error' in ruled).toBe(false)
    const state = ruled as import('../../../src/shared/canvas').CanvasState
    expect(state.versions[0].verdict).toMatchObject({ state: 'rejected', by: 'agent-chat', note: 'wrong logo' })
    expect(state.awaitingReview).toBeUndefined()
    const again = store.setVersionVerdict(SID, 'v1', { state: 'approved' }, 'user')
    expect(again).toMatchObject({ error: expect.stringContaining('already decided') })
  })

  it('refuses drafts and unknown versions', () => {
    render(1)
    render(2, { ready: false })
    expect(store.setVersionVerdict(SID, 'v2', { state: 'approved' }, 'user')).toMatchObject({
      error: expect.stringContaining('draft'),
    })
    expect(store.setVersionVerdict(SID, 'v9', { state: 'approved' }, 'user')).toMatchObject({
      error: expect.stringContaining('no version'),
    })
  })

  it('strips control characters from the note and caps it', () => {
    render(1)
    const ruled = store.setVersionVerdict(SID, 'v1', { state: 'rejected', note: 'bad\u0000\u0007 thing\nline2' }, 'user')
    const state = ruled as import('../../../src/shared/canvas').CanvasState
    expect(state.versions[0].verdict?.note).toBe('bad thing\nline2')
  })
})

describe('reopenVersionForReview — "go back to v5, get rid of v6"', () => {
  it('clears the target verdict, withdraws later ready versions, repoints the pane', () => {
    render(1)
    render(2)
    render(3)
    const result = store.reopenVersionForReview(SID, 'v1', 'agent-chat')
    expect('error' in result).toBe(false)
    const { state, withdrawn } = result as { state: import('../../../src/shared/canvas').CanvasState; withdrawn: string[] }
    expect(withdrawn.sort()).toEqual(['v2', 'v3'])
    expect(state.versions[0].verdict).toBeUndefined()
    expect(state.versions[1].verdict).toMatchObject({ state: 'withdrawn', by: 'agent-chat' })
    expect(state.versions[2].verdict).toMatchObject({ state: 'withdrawn' })
    expect(state.activeVersionId).toBe('v1')
    expect(state.awaitingReview?.versionId).toBe('v1')
  })
})

describe('review-note settlement rides supersession', () => {
  it('an OPEN note is NEVER auto-settled by supersession — it is agent debt (adv FINDING 1)', () => {
    render(1)
    const { reviewId } = addNote('v1', 'the login button is broken')
    reviews.submitReview(SID, reviewId, [], 'reject')
    const result = render(2) // agent renders a new version WITHOUT addressing the note
    const settled = reviews.settleReviewsForSupersededVersions(result.canvasId, result.superseded!)
    expect(settled).toBe(0)
    // The user's open feedback survives the render, not silently staled.
    expect(reviews.getReviewStateForSession(SID)!.annotations[0].state).toBe('open')
  })

  it('an ADDRESSED note settles only once the user has SEEN it addressed — the seen-barrier (adv FINDING 1b)', () => {
    render(1)
    const { reviewId, annotationId } = addNote('v1')
    reviews.submitReview(SID, reviewId, [], 'reject')
    const canvasId = reviews.getReviewStateForSession(SID)!.canvasId
    reviews.markAnnotationsAddressed(SID, reviewId, [annotationId], {})
    // Not yet seen: supersession must NOT close it (the unattended-close bypass).
    expect(reviews.settleReviewsForSupersededVersions(canvasId, ['v1'])).toBe(0)
    expect(reviews.getReviewStateForSession(SID)!.annotations[0].state).toBe('addressed')
    // The user sees it addressed → the settle may now close it.
    reviews.markAddressedNotesSeen(SID, canvasId, [annotationId])
    expect(reviews.settleReviewsForSupersededVersions(canvasId, ['v1'])).toBe(1)
    expect(reviews.getReviewStateForSession(SID)!.annotations[0]).toMatchObject({ state: 'stale', closedBy: 'supersede', closedFrom: 'addressed' })
    expect(reviews.getReviewStateForSession(SID)!.reviews[0]).toMatchObject({ status: 'resolved', settled: { by: 'supersede' } })
  })

  it('a REOPENED note is shielded from the settle', () => {
    render(1)
    const { reviewId, annotationId } = addNote('v1')
    reviews.submitReview(SID, reviewId, [], 'reject')
    const canvasId = reviews.getReviewStateForSession(SID)!.canvasId
    reviews.markAnnotationsAddressed(SID, reviewId, [annotationId], {})
    reviews.markAddressedNotesSeen(SID, canvasId, [annotationId])
    reviews.settleReviewsForSupersededVersions(canvasId, ['v1'])
    // The user deliberately puts it back in play — no automatic settle may
    // touch it again.
    reviews.reopenAnnotation(SID, annotationId)
    expect(reviews.settleReviewsForSupersededVersions(canvasId, ['v1'])).toBe(0)
    expect(reviews.getReviewStateForSession(SID)!.annotations[0].state).toBe('addressed')
  })

  it('submitReview carries the decision onto the version', () => {
    render(1)
    const { reviewId } = addNote('v1', 'the tagline is off')
    reviews.submitReview(SID, reviewId, [], 'reject')
    expect(versions()[0].verdict).toMatchObject({ state: 'rejected', by: 'user' })
  })

  it('the legacy backlog heals on load: a SEEN addressed note on a dead version settles', () => {
    // The agent renders twice while the user is still writing, so v1 is
    // SUPERSEDED (it was open when v2 arrived). The user's note is anchored to
    // v1 — the dead page — while the round freezes against v2 (D12).
    render(1)
    const result = render(2)
    expect(result.superseded).toEqual(['v1'])
    const { reviewId, annotationId } = addNote('v1')
    reviews.submitReview(SID, reviewId, [], 'reject')
    const canvasId = reviews.getReviewStateForSession(SID)!.canvasId
    reviews.markAnnotationsAddressed(SID, reviewId, [annotationId], {})
    reviews.markAddressedNotesSeen(SID, canvasId, [annotationId])

    // Pre-C1 pile: the review store never heard about the supersession. A
    // fresh load heals it — but only within the seen-barrier the settle keeps.
    reviews._resetCanvasReviewStoreForTest()
    const st = reviews.getReviewStateForSession(SID)!
    expect(st.annotations[0]).toMatchObject({ state: 'stale', closedBy: 'supersede' })
  })

  it('reopen archives the prior verdict — a user rejection is never erased (adv FINDING 2)', () => {
    render(1)
    // User rejects the OPEN version v1 (their own verdict).
    store.setVersionVerdict(SID, 'v1', { state: 'rejected', note: 'wrong copy' }, 'user')
    // Agent reopens v1 on the user's word — the rejection must not vanish.
    const reopened = store.reopenVersionForReview(SID, 'v1', 'agent-chat')
    expect('error' in reopened).toBe(false)
    const v1 = versions().find((v) => v.id === 'v1')!
    expect(v1.verdict).toBeUndefined() // open again
    expect(v1.priorVerdicts).toEqual([{ state: 'rejected', by: 'user', at: expect.any(String), note: 'wrong copy' }])
  })

  it('reopen keeps the prior verdict of a WITHDRAWN later version too (adv FINDING 2)', () => {
    render(1)
    render(2) // v1 superseded, v2 open
    store.setVersionVerdict(SID, 'v2', { state: 'rejected', note: 'still off' }, 'user')
    render(3) // v2's rejection stands; v3 open... but reopen v1:
    store.setVersionVerdict(SID, 'v3', { state: 'approved' }, 'user')
    store.reopenVersionForReview(SID, 'v1', 'agent-chat')
    const v3 = versions().find((v) => v.id === 'v3')!
    expect(v3.verdict).toMatchObject({ state: 'withdrawn' })
    expect(v3.priorVerdicts?.some((pv) => pv.state === 'approved' && pv.by === 'user')).toBe(true)
  })

  it('a version-verdict recorded from chat is stamped agent-chat and never impersonates a user click (adv FINDING 3)', () => {
    render(1)
    const chat = store.setVersionVerdict(SID, 'v1', { state: 'approved' }, 'agent-chat')
    expect('error' in chat).toBe(false)
    expect(versions()[0].verdict).toMatchObject({ state: 'approved', by: 'agent-chat' })
    // No agent-reachable path can produce by:'user' — that stamp is the
    // renderer IPC's alone (submitReview / versionVerdict handler).
  })

  it('reopen is idempotent — repeated reopens never grow or drop the withdrawn audit trail (adv round 2)', () => {
    render(1)
    render(2)
    render(3) // v1,v2 superseded, v3 open
    for (let i = 0; i < 70; i++) store.reopenVersionForReview(SID, 'v1', 'agent-chat')
    const v3 = versions().find((v) => v.id === 'v3')!
    expect(v3.verdict).toMatchObject({ state: 'withdrawn' })
    // The already-withdrawn later version is not re-withdrawn on every reopen,
    // so priorVerdicts stays bounded and the version survives a reload.
    expect((v3.priorVerdicts?.length ?? 0)).toBeLessThanOrEqual(32)
    store._resetCanvasStoreForTest()
    // 70 reopens did NOT breach the load cap and drop v2/v3.
    expect(store.getCanvasStateForSession(SID)!.versions.map((v) => v.id)).toEqual(['v1', 'v2', 'v3'])
  })
})
