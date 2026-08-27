// Show-and-tell renders (owner call, 2026-08-27): `intent: 'show'` marks a
// ready, surfaced version that owes NO review — the lane for "just show me
// something". The properties held shut here:
//  - a show render never sets awaitingReview and never supersedes an open
//    review version (agent-side debt-vanishing stays impossible);
//  - a show version is never the artifact's OPEN version;
//  - a show-only canvas completes on the agent path (the user's dismiss-in-chat
//    case) while review debt of any kind still refuses completion;
//  - the load-time shape rules treat `show` exactly like `draft`.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { vi } from 'vitest'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-show-intent-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const reviews = await import('../../../src/main/canvas/canvas-review-store')
const { completeCanvasGuarded } = await import('../../../src/main/canvas/canvas-completion')
const { openVersionOf } = await import('../../../src/shared/canvas')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const TITLE = 'Show me a thing'

function render(n: number, opts: { ready?: boolean; intent?: 'review' | 'show' } = {}) {
  return store.renderVersion(SID, {
    mode: 'design',
    html: `<!doctype html><p data-ux-id="p">v ${n}</p>`,
    title: TITLE,
    ...(opts.ready !== undefined ? { ready: opts.ready } : {}),
    ...(opts.intent !== undefined ? { intent: opts.intent } : {}),
  })
}

function state() {
  return store.getCanvasStateForSession(SID)!
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

describe('show renders create no review debt', () => {
  it('a show render is ready (not a draft), stamped show, and sets no awaitingReview', () => {
    render(1, { ready: true, intent: 'show' })
    const s = state()
    expect(s.versions).toHaveLength(1)
    expect(s.versions[0].draft).toBeUndefined()
    expect(s.versions[0].show).toBe(true)
    expect(s.awaitingReview).toBeUndefined()
  })

  it('a show render neither clears nor creates the standing first-look debt', () => {
    render(1, { ready: true }) // review hand-over: debt owed on v1
    expect(state().awaitingReview?.versionId).toBe('v1')
    render(2, { ready: true, intent: 'show' })
    expect(state().awaitingReview?.versionId).toBe('v1') // untouched
  })

  it('a show render supersedes nothing — an open review version stays open', () => {
    render(1, { ready: true })
    const second = render(2, { ready: true, intent: 'show' })
    expect(second.superseded).toBeUndefined()
    const [v1] = state().versions
    expect(v1.verdict).toBeUndefined() // still the open review version
  })

  it('a show version is never the OPEN version, and does not mask an earlier one', () => {
    render(1, { ready: true })
    render(2, { ready: true, intent: 'show' })
    const open = openVersionOf(state().versions)
    expect(open?.id).toBe('v1')
  })

  it("intent 'review' behaves exactly like today's default", () => {
    render(1, { ready: true, intent: 'review' })
    expect(state().awaitingReview?.versionId).toBe('v1')
    expect(state().versions[0].show).toBeUndefined()
  })
})

describe('completion for show-and-tell canvases', () => {
  it('an agent completion goes through on a show-only canvas (dismiss on the user’s word)', () => {
    render(1, { ready: true, intent: 'show' })
    const result = completeCanvasGuarded(state().canvasId, 'agent', SID)
    expect('error' in result).toBe(false)
    expect((result as { completed?: { by: string } }).completed?.by).toBe('agent')
  })

  it('a review-intent render awaiting its first review still refuses completion', () => {
    render(1, { ready: true })
    const result = completeCanvasGuarded(state().canvasId, 'agent', SID)
    expect(result).toMatchObject({ error: expect.stringContaining('awaiting') })
  })

  it('annotating a show version puts the canvas under the normal review rules', () => {
    render(1, { ready: true, intent: 'show' })
    reviews.upsertAnnotation(SID, { scope: 'general', note: 'actually, a note', versionId: 'v1' })
    const result = completeCanvasGuarded(state().canvasId, 'agent', SID)
    expect(result).toMatchObject({ error: expect.stringContaining('unsubmitted') })
  })
})

describe('guard-laundering regressions (independent review, 2026-08-27)', () => {
  it('BLOCKER 1: a show render cannot launder the agent-chat sign-off guard', () => {
    render(1, { ready: true })
    // The agent records the user's chat approval — clears awaitingReview.
    const verdicted = store.setVersionVerdict(SID, 'v1', { state: 'approved' }, 'agent-chat')
    expect('error' in verdicted).toBe(false)
    // The guard refuses an agent completion resting on that sign-off…
    expect(completeCanvasGuarded(state().canvasId, 'agent', SID)).toMatchObject({
      error: expect.stringContaining('chat'),
    })
    // …and a show render on top must NOT become the "latest ready" it inspects.
    render(2, { ready: true, intent: 'show' })
    expect(completeCanvasGuarded(state().canvasId, 'agent', SID)).toMatchObject({
      error: expect.stringContaining('chat'),
    })
  })

  it('BLOCKER 2: the load heal never retro-supersedes an open review version under a show render', () => {
    render(1, { ready: true })
    render(2, { ready: true, intent: 'show' })
    const canvasId = state().canvasId
    store._resetCanvasStoreForTest()
    const reloaded = store.getCanvasStateById(canvasId)!
    const v1 = reloaded.versions.find((v) => v.id === 'v1')!
    expect(v1.verdict).toBeUndefined() // still the open review version
    expect(openVersionOf(reloaded.versions)?.id).toBe('v1')
  })

  it('BLOCKER 3: a chat verdict with no named version lands on the open review version, not the show render', () => {
    render(1, { ready: true })
    render(2, { ready: true, intent: 'show' })
    const verdicted = store.setVersionVerdict(SID, undefined, { state: 'approved' }, 'agent-chat')
    expect('error' in verdicted).toBe(false)
    const [v1, v2] = state().versions
    expect(v1.verdict).toMatchObject({ state: 'approved', by: 'agent-chat' })
    expect(v2.verdict).toBeUndefined()
  })
})

describe('load-time shape rules', () => {
  it('a hand-edited non-boolean `show` drops the version, same posture as draft', () => {
    render(1, { ready: true, intent: 'show' })
    const canvasId = state().canvasId
    const file = path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json')
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    record.versions[0].show = 'yes'
    fs.writeFileSync(file, JSON.stringify(record))
    store._resetCanvasStoreForTest()
    const reloaded = store.getCanvasStateById(canvasId)
    expect(reloaded?.versions ?? []).toHaveLength(0)
  })

  it('a persisted show stamp survives a reload intact', () => {
    render(1, { ready: true, intent: 'show' })
    const canvasId = state().canvasId
    store._resetCanvasStoreForTest()
    const reloaded = store.getCanvasStateById(canvasId)
    expect(reloaded?.versions[0]?.show).toBe(true)
    expect(reloaded?.awaitingReview).toBeUndefined()
  })
})
