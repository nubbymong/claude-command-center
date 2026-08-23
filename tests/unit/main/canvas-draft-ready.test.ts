// Draft / ready (#366): the agent's self-review loop is invisible.
//
// A render with `ready: false` is a DRAFT — it supersedes the previous draft in
// place (one version id for the whole loop, so self-checking cannot burn the
// version cap), sets no review-needed state, and its change event says `draft`
// so the renderer surfaces nothing. `ready: true` promotes the draft and marks
// the round as awaiting the user's first review; a render with NO flag behaves
// as every render did before drafts existed — it surfaces AND counts as ready,
// so an old-style agent's hand-off is never invisible.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import type { CanvasChangedEvent } from '../../../src/shared/canvas'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-draftready-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')

const SID = 'aaaa1111aaaa1111aaaa1111'

function canvasRoot(): string {
  return path.join(getResourcesDirectory(), 'canvas')
}

function render(body: string, ready?: boolean) {
  return store.renderVersion(SID, {
    mode: 'design',
    html: `<!doctype html><p>${body}</p>`,
    title: 'Queue states',
    ...(ready !== undefined ? { ready } : {}),
  })
}

function versionHtml(canvasId: string, versionId: string): string {
  return fs.readFileSync(path.join(canvasRoot(), canvasId, 'versions', versionId, 'index.html'), 'utf8')
}

beforeEach(() => {
  store._resetCanvasStoreForTest()
  fs.rmSync(canvasRoot(), { recursive: true, force: true })
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('drafts (#366)', () => {
  it('a draft render is marked draft, sets no review-needed state, and says so in its event', () => {
    const events: CanvasChangedEvent[] = []
    const off = store.onCanvasChanged((e) => events.push(e))
    const r = render('draft one', false)
    off()

    expect(r.draft).toBe(true)
    const state = store.getCanvasStateForSession(SID)!
    expect(state.versions).toHaveLength(1)
    expect(state.versions[0].draft).toBe(true)
    expect(state.awaitingReview).toBeUndefined()
    expect(events).toHaveLength(1)
    expect(events[0].draft).toBe(true)
  })

  it('drafts of the same round supersede IN PLACE: one id, latest content, no version burn', () => {
    const first = render('draft one', false)
    const second = render('draft two', false)
    const third = render('draft three', false)

    expect(second.versionId).toBe(first.versionId)
    expect(third.versionId).toBe(first.versionId)
    const state = store.getCanvasStateForSession(SID)!
    expect(state.versions).toHaveLength(1)
    expect(versionHtml(first.canvasId, first.versionId)).toContain('draft three')
  })

  it('the ready-mark promotes the draft: same id, draft flag gone, round awaiting review', () => {
    const draft = render('draft', false)
    const events: CanvasChangedEvent[] = []
    const off = store.onCanvasChanged((e) => events.push(e))
    const ready = render('final', true)
    off()

    expect(ready.versionId).toBe(draft.versionId)
    expect(ready.draft).toBeUndefined()
    const state = store.getCanvasStateForSession(SID)!
    expect(state.versions).toHaveLength(1)
    expect(state.versions[0].draft).toBeUndefined()
    expect(state.awaitingReview).toEqual({ versionId: ready.versionId, at: state.versions[0].createdAt })
    expect(versionHtml(ready.canvasId, ready.versionId)).toContain('final')
    expect(events[0].draft).toBeUndefined()
  })

  it('a render with NO flag behaves as before drafts existed: appends, surfaces, and counts as ready', () => {
    const r = render('legacy')
    const state = store.getCanvasStateForSession(SID)!
    expect(r.draft).toBeUndefined()
    expect(state.versions[0].draft).toBeUndefined()
    expect(state.awaitingReview?.versionId).toBe(r.versionId)
  })

  it('a new draft AFTER a ready round appends its own version and leaves the owed round standing', () => {
    const ready = render('round one', true)
    const draft = render('round two draft', false)

    const state = store.getCanvasStateForSession(SID)!
    expect(draft.versionId).not.toBe(ready.versionId)
    expect(state.versions).toHaveLength(2)
    expect(state.versions[1].draft).toBe(true)
    // The user still owes the FIRST round its review; drafting the next one
    // must not silently clear it.
    expect(state.awaitingReview?.versionId).toBe(ready.versionId)
  })

  it('draft and awaiting-review survive a reload from disk', () => {
    render('round one', true)
    const draft = render('round two draft', false)
    const before = store.getCanvasStateForSession(SID)!

    store._resetCanvasStoreForTest()
    const after = store.getCanvasStateForSession(SID)
    // The session index is rebuilt from disk on scan; the record must come
    // back with the same shape.
    expect(after?.versions.map((v) => [v.id, v.draft ?? null])).toEqual(
      before.versions.map((v) => [v.id, v.draft ?? null]),
    )
    expect(after?.awaitingReview).toEqual(before.awaitingReview)
    expect(after?.activeVersionId).toBe(draft.versionId)
  })
})

describe('clearAwaitingReview', () => {
  it('clears the owed round, persists, and emits; idempotent on a quiet canvas', () => {
    const r = render('round', true)
    expect(store.getCanvasStateForSession(SID)!.awaitingReview).toBeTruthy()

    const events: CanvasChangedEvent[] = []
    const off = store.onCanvasChanged((e) => events.push(e))
    store.clearAwaitingReview(r.canvasId)
    store.clearAwaitingReview(r.canvasId) // second call: nothing to do, no event
    off()

    expect(store.getCanvasStateForSession(SID)!.awaitingReview).toBeUndefined()
    expect(events).toHaveLength(1)

    // ...and the clear survives a reload (it persisted, not just memory).
    store._resetCanvasStoreForTest()
    expect(store.getCanvasStateForSession(SID)?.awaitingReview).toBeUndefined()
  })
})

describe('the library row (#364)', () => {
  it('carries awaitingReview from the record itself, and drops it once cleared', () => {
    const r = render('round', true)
    let rows = store.listAllCanvases([], undefined, SID)
    expect(rows[0]).toMatchObject({ canvasId: r.canvasId, awaitingReview: true })
    expect(typeof rows[0].awaitingReviewAt).toBe('string')

    store.clearAwaitingReview(r.canvasId)
    rows = store.listAllCanvases([], undefined, SID)
    expect(rows[0].awaitingReview).toBeUndefined()
  })
})
