// The SETTLED canvas state machine (owner-agreed 2026-08-29) — the rework that
// replaces C1's per-note bookkeeping with VERSION-level decisions.
//
// Three live repros drove it, and each has a describe block here:
//   1. the 6-round pile — v1..v8, the user rejecting each and the agent
//      addressing the notes, ending in SIX "1 for you" rounds after the final
//      approve, because "addressed" was modelled as work owed by the USER and
//      every automatic settle sat behind the agent-close seen barrier;
//   2. the working-pill strand — a version approved WITH a note the agent
//      shipped but never resolved, leaving "1 note with the agent" forever and
//      Mark complete disabled with no user exit;
//   3. zombie rounds — a settled round woken again by a later render.
//
// The properties under test are the ones the model rests on: a user decision is
// the only thing that settles, it settles EVERY earlier round of its artefact,
// approve means NOTHING OWED, and SETTLED STAYS SETTLED against every agent
// path there is. The store's own file is the record: several assertions read
// reviews.json back off disk rather than the in-memory view, because a heal
// that only exists in memory is the bug that shipped last time.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { IPC } from '../../../src/shared/ipc-channels'
import type { Annotation, Review } from '../../../src/shared/canvas'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-settled-machine-'))
  return { getResourcesDirectory: () => dir }
})

// The handler layer is the composition point that holds BOTH stores, so the
// zero-note approve, the settle and the auto-complete only meet there. Capture
// the real registrations rather than re-implementing the composition here — a
// test that re-implements it cannot catch the composition going wrong.
const handlers = new Map<string, (...a: unknown[]) => unknown>()
const listeners = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => unknown) => listeners.set(ch, fn),
  },
  BrowserWindow: vi.fn(),
}))

vi.mock('../../../src/main/canvas/canvas-snapshot-broker', () => ({
  resolveCanvasSnapshot: vi.fn(),
  setSnapshotSender: vi.fn(),
}))

const sessionLink = vi.hoisted(() => ({
  canvasCwdForSession: vi.fn<(sid: string) => string | undefined>(() => undefined),
  installCanvasSessionLink: vi.fn(),
  listReclaimableCanvases: vi.fn(() => []),
  reclaimCanvasForSession: vi.fn(() => false),
}))
vi.mock('../../../src/main/canvas/canvas-session-link', () => sessionLink)

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const reviews = await import('../../../src/main/canvas/canvas-review-store')
const completion = await import('../../../src/main/canvas/canvas-completion')
const shared = await import('../../../src/shared/canvas')
const serialize = await import('../../../src/shared/canvas-review-serialize')
const { registerCanvasHandlers } = await import('../../../src/main/ipc/canvas-handlers')
const { reviewGroupsOf } = await import('../../../src/renderer/stores/canvasReviewStore')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const TITLE = 'Feature X'

/** Every `canvas:changed` / `canvas:reviewChanged` push, in order. */
const pushed: Array<{ channel: string; payload: unknown }> = []
registerCanvasHandlers(
  () =>
    ({
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => pushed.push({ channel, payload }) },
    }) as never,
)

const invoke = async (channel: string, args: unknown): Promise<unknown> => handlers.get(channel)!({} as never, args)

function render(n: number, opts: { ready?: boolean; mode?: 'design' | 'plan'; title?: string } = {}) {
  return store.renderVersion(SID, {
    mode: opts.mode ?? 'design',
    html: `<!doctype html><p data-ux-id="p">v ${n}</p>`,
    title: opts.title ?? TITLE,
    ...(opts.ready !== undefined ? { ready: opts.ready } : {}),
  })
}

function canvasId(): string {
  return store.getCanvasStateForSession(SID)!.canvasId
}

function addNote(versionId: string, text = 'needs work'): { reviewId: string; annotationId: string } {
  const { state, annotationId } = reviews.upsertAnnotation(SID, { scope: 'general', note: text, versionId })
  const draft = state.reviews.find((rv) => rv.status === 'draft')!
  return { reviewId: draft.id, annotationId }
}

interface DiskRecord {
  reviews: Review[]
  annotations: Annotation[]
}

/** reviews.json as it actually sits on disk — the durable record, not the
 *  in-memory view a heal might only have touched there. */
function onDisk(cid: string): DiskRecord {
  return JSON.parse(fs.readFileSync(path.join(getResourcesDirectory(), 'canvas', cid, 'reviews.json'), 'utf8')) as DiskRecord
}

function reviewOnDisk(cid: string, reviewId: string): Review {
  return onDisk(cid).reviews.find((r) => r.id === reviewId)!
}

function noteOnDisk(cid: string, annotationId: string): Annotation {
  return onDisk(cid).annotations.find((a) => a.id === annotationId)!
}

/** `reviewGroupsOf` takes the renderer's mirror shape; only these two fields
 *  are read, so the disk record can drive it directly. */
function groupsFor(cid: string) {
  const rec = onDisk(cid)
  return reviewGroupsOf({ reviews: rec.reviews, annotations: rec.annotations } as never)
}

function writeCanvasJson(cid: string, record: Record<string, unknown>): void {
  fs.mkdirSync(path.join(getResourcesDirectory(), 'canvas', cid), { recursive: true })
  fs.writeFileSync(
    path.join(getResourcesDirectory(), 'canvas', cid, 'canvas.json'),
    JSON.stringify({ ...record, mac: store._canvasRecordMacForTest(record) }, null, 2),
  )
}

function writeReviewsJson(cid: string, record: unknown): void {
  fs.mkdirSync(path.join(getResourcesDirectory(), 'canvas', cid), { recursive: true })
  fs.writeFileSync(path.join(getResourcesDirectory(), 'canvas', cid, 'reviews.json'), JSON.stringify(record, null, 2))
}

function coldStart(): void {
  store._resetCanvasStoreForTest()
  reviews._resetCanvasReviewStoreForTest()
}

beforeEach(() => {
  coldStart()
  pushed.length = 0
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

/**
 * The live repro, exactly: v1..v(rounds+1) ready, each round a note the user
 * rejects and the agent then marks addressed — and NEVER a `markAddressedNotesSeen`,
 * because the user never re-opened the panel between renders. That missing
 * glance is what stranded every round under the old seen-barrier settle.
 */
function buildPile(rounds = 7): { cid: string; roundIds: string[]; noteIds: string[] } {
  render(1)
  const roundIds: string[] = []
  const noteIds: string[] = []
  for (let k = 1; k <= rounds; k++) {
    const { reviewId, annotationId } = addNote(`v${k}`, `round ${k} is wrong`)
    reviews.submitReview(SID, reviewId, [], 'reject')
    reviews.markAnnotationsAddressed(SID, reviewId, [annotationId])
    roundIds.push(reviewId)
    noteIds.push(annotationId)
    render(k + 1)
  }
  return { cid: canvasId(), roundIds, noteIds }
}

// ── 1. the 6-round pile ─────────────────────────────────────────────────────

describe('the 6-round pile — a later decision settles every earlier round', () => {
  it('a ZERO-NOTE approve of v8 settles R1..R7 and signs the canvas off', async () => {
    const { cid, roundIds, noteIds } = buildPile()

    // Before the approve the pile is already down to ONE live round: each
    // rejection settled the round beneath it as it went, which is the fix — the
    // old model let all seven stack because only an *approve* ever settled
    // anything and only for notes the user had re-read.
    expect(reviews.getReviewCountsForCanvas(cid)!.liveRounds).toBe(1)

    const ruled = await invoke(IPC.CANVAS_VERSION_VERDICT, { sessionId: SID, versionId: 'v8', state: 'approved' })
    expect(ruled).not.toHaveProperty('error')

    roundIds.forEach((id, i) => {
      const r = reviewOnDisk(cid, id)
      expect(r.status).toBe('resolved')
      expect(r.settled?.by).toBe('decision')
      // R1..R6 by the rejection of the version after them; R7 by the v8 approve.
      expect(r.settled?.versionId).toBe(`v${i + 2}`)
    })
    for (const id of noteIds) {
      const a = noteOnDisk(cid, id)
      expect(shared.isLiveNote(a)).toBe(false)
      expect(a.closedBy).toBe('decision')
      expect(a.settledBy?.versionId).toBeTruthy()
    }

    const counts = reviews.getReviewCountsForCanvas(cid)!
    expect(counts).toMatchObject({ draftNotes: 0, openNotes: 0, addressedNotes: 0, liveRounds: 0 })

    expect(groupsFor(cid).every((g) => g.waitingOn === 'closed')).toBe(true)

    // W2: the approve auto-completes, because nothing is owed anywhere.
    expect(store.getCanvasStateById(cid)!.completed?.by).toBe('user')
    // …and the pane returns to its front page: the canvas is no longer the
    // session's current one.
    expect(store.getCanvasStateForSession(SID)).toBeNull()
  })

  it('an approve of v8 WITH a note settles R1..R7 and records that note as an observation', async () => {
    const { cid, roundIds } = buildPile()
    const { reviewId, annotationId } = addNote('v8', 'tiny nit, ship it')
    await invoke(IPC.CANVAS_REVIEW_SUBMIT, { sessionId: SID, reviewId, sketches: [], decision: 'approve' })

    const note = noteOnDisk(cid, annotationId)
    expect(note.state).toBe('observation')
    expect(note.closedBy).toBe('user')
    expect(note.closedFrom).toBe('open')

    const round = reviewOnDisk(cid, reviewId)
    expect(round.status).toBe('resolved')
    expect(round.decision).toBe('approve')
    expect(round.settled?.by).toBe('observation')

    for (const id of roundIds) expect(reviewOnDisk(cid, id)).toMatchObject({ status: 'resolved', settled: { by: 'decision' } })

    expect(store.getCanvasStateById(cid)!.completed?.by).toBe('user')
    const completedPush = pushed.filter((p) => p.channel === IPC.CANVAS_CHANGED).map((p) => p.payload as { completed?: boolean })
    expect(completedPush.some((p) => p.completed === true)).toBe(true)
  })

  it('a HAND-BUILT pile — legacy addressed notes on dead versions, never seen — reads as closed after one approve', async () => {
    // The pile shape as it actually sat on disk before the rework: three rounds
    // of agent-addressed notes anchored to versions that have since been
    // superseded, with `userSawAddressed` ABSENT on every one — the missing
    // glance that made the old seen-barrier settle skip all of them. Built by
    // hand rather than by driving the API, so the fixture cannot drift into
    // whatever shape the current code happens to produce.
    render(1)
    const cid = canvasId()
    render(2)
    render(3)
    render(4)
    // v1..v3 are superseded (each was open when the next arrived); v4 is open.
    const versions = store.getCanvasStateById(cid)!.versions
    expect(versions.slice(0, 3).every((v) => v.verdict?.state === 'superseded')).toBe(true)

    writeReviewsJson(cid, {
      canvasId: cid,
      sessionId: SID,
      nextReview: 4,
      nextAnnotation: 4,
      reviews: [1, 2, 3].map((n) => ({
        id: `R${n}`,
        canvas: { canvasId: cid, sessionId: SID },
        versionId: `v${n}`,
        annotationIds: [`a${n}`],
        status: 'submitted',
        createdAt: '2026-08-01T00:00:00.000Z',
        submittedAt: '2026-08-01T00:01:00.000Z',
      })),
      annotations: [1, 2, 3].map((n) => ({
        id: `a${n}`,
        reviewId: `R${n}`,
        scope: 'general',
        note: `round ${n}`,
        versionId: `v${n}`,
        state: 'addressed',
        addressedAt: '2026-08-02T00:00:00.000Z',
        addressedBy: { actor: 'agent', sessionId: SID },
      })),
    })
    coldStart()
    // Nothing about the load settles them: no user verdict anchors them yet,
    // and the seen barrier stops the version supersede.
    expect(reviews.getReviewCountsForCanvas(cid)!.liveRounds).toBe(3)

    // ONE approve, through the real handler composition.
    const ruled = await invoke(IPC.CANVAS_VERSION_VERDICT, { sessionId: SID, versionId: 'v4', state: 'approved' })
    expect(ruled).not.toHaveProperty('error')

    const groups = groupsFor(cid)
    expect(groups).toHaveLength(3)
    expect(groups.every((g) => g.waitingOn === 'closed')).toBe(true)
    expect(reviews.getReviewCountsForCanvas(cid)).toMatchObject({
      draftNotes: 0,
      openNotes: 0,
      addressedNotes: 0,
      liveRounds: 0,
    })
    for (const n of [1, 2, 3]) {
      const r = reviewOnDisk(cid, `R${n}`)
      expect(r.status).toBe('resolved')
      // Anchored on the version the user decided, whichever pass got there
      // first. On a PRE-REWORK record like this one the load heal claims them
      // (`by: 'legacy'`) the moment v4 gains its user verdict, before the
      // submit-time settle runs; on a record this build wrote it is
      // `by: 'decision'`. Both name v4, and both are honest — pinning the word
      // here would pin an ordering neither the user nor the agent can observe.
      expect(r.settled?.versionId).toBe('v4')
      expect(['legacy', 'decision']).toContain(r.settled?.by)
      expect(noteOnDisk(cid, `a${n}`).settledBy).toMatchObject({ versionId: 'v4' })
    }
  })

  it('the grouping is DERIVED after the settle — a pile of addressed notes the user never saw reads as closed', async () => {
    const { cid } = buildPile()
    // Before the decision every round is still with the agent.
    expect(groupsFor(cid).some((g) => g.waitingOn === 'agent')).toBe(true)
    await invoke(IPC.CANVAS_VERSION_VERDICT, { sessionId: SID, versionId: 'v8', state: 'approved' })
    const groups = groupsFor(cid)
    expect(groups).toHaveLength(7)
    expect(groups.every((g) => g.waitingOn === 'closed')).toBe(true)
    expect(groups.every((g) => g.notes.length === 0)).toBe(true)
    expect(groups.every((g) => g.closedNotes.length === 1)).toBe(true)
  })
})

// ── 2. approve = nothing owed ───────────────────────────────────────────────

describe('approve means NOTHING OWED (the working-pill strand)', () => {
  it('a single approve with a note leaves nothing with the agent and completes', async () => {
    render(1)
    const cid = canvasId()
    const { reviewId, annotationId } = addNote('v1', 'the pill should be calmer')
    await invoke(IPC.CANVAS_REVIEW_SUBMIT, { sessionId: SID, reviewId, sketches: [], decision: 'approve' })

    expect(noteOnDisk(cid, annotationId)).toMatchObject({ state: 'observation', closedBy: 'user', closedFrom: 'open' })
    expect(reviewOnDisk(cid, reviewId)).toMatchObject({ status: 'resolved', settled: { by: 'observation' } })
    expect(reviews.getReviewCountsForCanvas(cid)).toMatchObject({ openNotes: 0, addressedNotes: 0, liveRounds: 0 })
    expect(store.getCanvasStateById(cid)!.completed?.by).toBe('user')
  })

  it('`updatedIn` names a READY version only — never a draft the user cannot open', () => {
    render(1)
    const { reviewId, annotationId } = addNote('v1', 'fix this')
    reviews.submitReview(SID, reviewId, [], 'reject')
    const draft = render(2, { ready: false })
    expect(draft.draft).toBe(true)
    // A draft is invisible by contract, so "updated in v2" would be a chip the
    // user can never open — and a claim the fix landed somewhere they have not
    // been shown.
    expect(() => reviews.markAnnotationsAddressed(SID, reviewId, [annotationId], undefined, draft.versionId)).toThrow(/not on this canvas/)
    expect(() => reviews.markAnnotationsAddressed(SID, reviewId, [annotationId], undefined, 'v99')).toThrow(/not on this canvas/)
    expect(() => reviews.markAnnotationsAddressed(SID, reviewId, [annotationId], undefined, 'nope')).toThrow(/invalid updated-in/)
    // The ready one it was written against is fine.
    expect(reviews.markAnnotationsAddressed(SID, reviewId, [annotationId], undefined, 'v1').addressed).toEqual([annotationId])
  })

  it('an observation is never reachable from an agent tool — canvas_resolve refuses it by name', async () => {
    render(1)
    const cid = canvasId()
    const { reviewId, annotationId } = addNote('v1', 'nit')
    await invoke(IPC.CANVAS_REVIEW_SUBMIT, { sessionId: SID, reviewId, sketches: [], decision: 'approve' })
    // Reopen so the canvas is writable again (completion is terminal), then try.
    await invoke(IPC.CANVAS_COMPLETE_REOPEN, { sessionId: SID, canvasId: cid })

    const res = reviews.markAnnotationsAddressed(SID, reviewId, [annotationId])
    expect(res.addressed).toEqual([])
    expect(res.refused.map((r) => r.id)).toEqual([annotationId])
    expect(res.refused[0].reason).toMatch(/observation/i)
    expect(noteOnDisk(cid, annotationId).state).toBe('observation')
    expect(reviewOnDisk(cid, reviewId).status).toBe('resolved')
  })
})

// ── 3. reject ───────────────────────────────────────────────────────────────

describe('reject hands the round to the agent', () => {
  it('a rejection leaves the round LIVE, the version rejected, and nothing awaiting the user', async () => {
    render(1)
    const cid = canvasId()
    const { reviewId } = addNote('v1', 'the logo is wrong')
    await invoke(IPC.CANVAS_REVIEW_SUBMIT, { sessionId: SID, reviewId, sketches: [], decision: 'reject' })

    const state = store.getCanvasStateById(cid)!
    expect(state.versions[0].verdict).toMatchObject({ state: 'rejected', by: 'user' })
    expect(state.awaitingReview).toBeUndefined()
    expect(state.completed).toBeUndefined()
    expect(reviewOnDisk(cid, reviewId)).toMatchObject({ status: 'submitted', decision: 'reject' })
    expect(reviewOnDisk(cid, reviewId).settled).toBeUndefined()

    const rec = onDisk(cid)
    const phase = shared.artifactPhaseOf(state.versions, rec.reviews, rec.annotations)
    expect(phase).toMatchObject({ kind: 'with-agent', reviewId, openNotes: 1, awaiting: 'next-version' })
  })

  it('a reject with no notes is refused by the store, not only by the composer', () => {
    render(1)
    const draft = reviews.upsertAnnotation(SID, { scope: 'general', note: 'x', versionId: 'v1' })
    const reviewId = draft.state.reviews.find((r) => r.status === 'draft')!.id
    reviews.deleteAnnotation(SID, draft.annotationId)
    expect(() => reviews.submitReview(SID, reviewId, [], 'reject')).toThrow()
  })

  it('an IMAGE-ONLY reject still stamps the version — the submit IS the reason', () => {
    // A note may legally carry no text when a pasted screenshot is the note.
    // The store refuses a rejection with no note (correctly, for the zero-note
    // verdict path), so without a synthesized gist this submit landed its round
    // and left the version OPEN — which reads as "I rejected it and nothing
    // happened", the exact strand shape the machine exists to kill.
    render(1)
    const cid = canvasId()
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x'.repeat(32))]).toString('base64')
    const { state, annotationId } = reviews.upsertAnnotation(SID, {
      scope: 'general',
      note: '',
      versionId: 'v1',
      image: { pngBase64: png },
    })
    const reviewId = state.reviews.find((r) => r.status === 'draft')!.id
    reviews.submitReview(SID, reviewId, [], 'reject')

    const version = store.getCanvasStateById(cid)!.versions[0]
    expect(version.verdict).toMatchObject({ state: 'rejected', by: 'user' })
    // The History gist points at the note rather than pretending to summarise it.
    expect(version.verdict!.note).toBe('see the attached image')
    const rec = onDisk(cid)
    expect(shared.artifactPhaseOf(store.getCanvasStateById(cid)!.versions, rec.reviews, rec.annotations)).toMatchObject({
      kind: 'with-agent',
      reviewId,
      openNotes: 1,
    })
    expect(noteOnDisk(cid, annotationId).note).toBe('')
  })

  it('a ZERO-NOTE reject must say why — refused at the seam AND in the store', async () => {
    // A reject settles every earlier round of the artefact, so one with nothing
    // said closes the user's own outstanding feedback while explaining it to
    // nobody — and leaves the agent a verdict it cannot act on.
    render(1)
    await expect(invoke(IPC.CANVAS_VERSION_VERDICT, { sessionId: SID, versionId: 'v1', state: 'rejected' })).rejects.toThrow()
    await expect(invoke(IPC.CANVAS_VERSION_VERDICT, { sessionId: SID, versionId: 'v1', state: 'rejected', note: '   ' })).rejects.toThrow()
    expect(store.setVersionVerdict(SID, 'v1', { state: 'rejected' }, 'user')).toMatchObject({
      error: expect.stringContaining('a rejection needs a note'),
    })
    expect(store.getCanvasStateById(canvasId())!.versions[0].verdict).toBeUndefined()
    // With a reason, it goes through — and an APPROVE never needed one.
    expect(await invoke(IPC.CANVAS_VERSION_VERDICT, { sessionId: SID, versionId: 'v1', state: 'rejected', note: 'wrong logo' })).not.toHaveProperty('error')
  })

  it('an OPEN version awaiting a decision reads as needs-you', () => {
    render(1)
    const state = store.getCanvasStateById(canvasId())!
    expect(shared.artifactPhaseOf(state.versions, [], [])).toMatchObject({ kind: 'needs-you', versionId: 'v1' })
  })
})

// ── 4. SETTLED STAYS SETTLED ────────────────────────────────────────────────

describe('settled stays settled — one wake path per test', () => {
  /** The pile, settled by the user's approve of v8, with the canvas reopened so
   *  every write below is attempted against a LIVE canvas (a completed canvas
   *  refuses writes for an unrelated reason, which would hide the real result). */
  async function settledPile(): Promise<{ cid: string; roundIds: string[]; noteIds: string[] }> {
    const pile = buildPile()
    await invoke(IPC.CANVAS_VERSION_VERDICT, { sessionId: SID, versionId: 'v8', state: 'approved' })
    await invoke(IPC.CANVAS_COMPLETE_REOPEN, { sessionId: SID, canvasId: pile.cid })
    return pile
  }

  function expectStillSettled(pile: { cid: string; roundIds: string[]; noteIds: string[] }): void {
    for (const id of pile.roundIds) {
      expect(reviewOnDisk(pile.cid, id).status).toBe('resolved')
      expect(reviewOnDisk(pile.cid, id).settled).toBeDefined()
    }
    for (const id of pile.noteIds) expect(shared.isLiveNote(noteOnDisk(pile.cid, id))).toBe(false)
  }

  it('a ready render does not wake it', async () => {
    const pile = await settledPile()
    render(9)
    expectStillSettled(pile)
  })

  it('a show render does not wake it', async () => {
    const pile = await settledPile()
    store.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>show</p>', title: TITLE, intent: 'show' })
    expectStillSettled(pile)
  })

  it('a draft render does not wake it', async () => {
    const pile = await settledPile()
    render(9, { ready: false })
    expectStillSettled(pile)
  })

  it('canvas_resolve on a settled note is refused, and the round keeps its status', async () => {
    const pile = await settledPile()
    const res = reviews.markAnnotationsAddressed(SID, pile.roundIds[0], [pile.noteIds[0]])
    expect(res.addressed).toEqual([])
    // The reason NAMES the decision that settled it — "the user's v2 rejection",
    // not an anonymous skip. R1 fell to the rejection of v2, one round later.
    expect(res.refused[0]?.reason).toMatch(/settled by the user's v2 rejection/i)
    expectStillSettled(pile)
  })

  it('canvas_verdict cannot reach a settled round', async () => {
    const pile = await settledPile()
    expect(() => reviews.closeAnnotationsByAgent(SID, pile.roundIds[0], null, 'stale')).toThrow()
    expectStillSettled(pile)
  })

  it('canvas_pick cannot reach a settled round', async () => {
    const pile = await settledPile()
    expect(() => reviews.recordChatPick(SID, pile.roundIds[0], pile.noteIds[0], 'A')).toThrow()
    expectStillSettled(pile)
  })

  it('the render supersede settle cannot reach a settled round', async () => {
    const pile = await settledPile()
    const moved = reviews.settleReviewsForSupersededVersions(pile.cid, ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'])
    expect(moved).toBe(0)
    expectStillSettled(pile)
  })

  it('reopening a VERSION reopens the version and no round — from chat or from the pane', async () => {
    const pile = await settledPile()
    const byChat = store.reopenVersionForReview(SID, 'v6', 'agent-chat')
    expect('error' in byChat).toBe(false)
    expectStillSettled(pile)
    const byUser = await invoke(IPC.CANVAS_VERSION_REOPEN, { sessionId: SID, versionId: 'v5' })
    expect(byUser).not.toHaveProperty('error')
    expectStillSettled(pile)
  })

  it('an agent-chat version verdict wakes nothing', async () => {
    const pile = await settledPile()
    render(9)
    const ruled = store.setVersionVerdict(SID, 'v9', { state: 'approved' }, 'agent-chat')
    expect('error' in ruled).toBe(false)
    expectStillSettled(pile)
  })

  it('deleting ANOTHER artifact wakes nothing', async () => {
    const pile = await settledPile()
    // A second artifact on the same canvas (a plan run), then delete it.
    store.renderVersion(SID, { mode: 'plan', html: '<!doctype html><p>plan</p>', title: TITLE })
    const planId = store.getCanvasStateById(pile.cid)!.versions.slice(-1)[0].id
    const res = store.deleteArtifact(pile.cid, planId)
    expect(res.ok).toBe(true)
    reviews.deleteAnnotationsForVersions(pile.cid, res.ok ? res.deletedVersionIds : [])
    expectStillSettled(pile)
  })

  it('a cold reload from disk wakes nothing', async () => {
    const pile = await settledPile()
    coldStart()
    // The LOAD path, not just the read path: `getReviewStateForSession` is what
    // runs `loadRecord` → the heals → the persist, so asserting on disk without
    // it would only prove that nothing had written, which is not the claim.
    reviews.getReviewStateForSession(SID)
    expect(reviews.getReviewCountsForCanvas(pile.cid)).toMatchObject({ openNotes: 0, addressedNotes: 0, liveRounds: 0 })
    expectStillSettled(pile)
  })

  it('the USER can reopen — a round, and a single note', async () => {
    const pile = await settledPile()
    const roundBack = await invoke(IPC.CANVAS_REVIEW_REOPEN, { sessionId: SID, canvasId: pile.cid, reviewId: pile.roundIds[0] })
    expect(roundBack).toBeTruthy()
    expect(reviewOnDisk(pile.cid, pile.roundIds[0]).status).toBe('submitted')
    expect(reviewOnDisk(pile.cid, pile.roundIds[0]).settled).toBeUndefined()
    const revived = noteOnDisk(pile.cid, pile.noteIds[0])
    expect(shared.isLiveNote(revived)).toBe(true)
    expect(revived.settledBy).toBeUndefined()
    expect(revived.reopenedAt).toBeTruthy()

    await invoke(IPC.CANVAS_ANNOTATION_REOPEN, { sessionId: SID, annotationId: pile.noteIds[1] })
    expect(shared.isLiveNote(noteOnDisk(pile.cid, pile.noteIds[1]))).toBe(true)
    expect(reviewOnDisk(pile.cid, pile.roundIds[1]).status).toBe('submitted')
  })
})

// ── 4b. THE REOPEN SURVIVES A RESTART (the heal must not eat it) ────────────

describe('a reopen survives a cold reload — the heal never undoes it (B1)', () => {
  /** v1 rejected (R1), v2 rejected (R2) — which settles R1 by decision. */
  function settledByLaterReject(): { cid: string; noteId: string } {
    render(1)
    const first = addNote('v1', 'the first thing')
    reviews.submitReview(SID, first.reviewId, [], 'reject')
    render(2)
    const second = addNote('v2', 'the second thing')
    reviews.submitReview(SID, second.reviewId, [], 'reject')
    return { cid: canvasId(), noteId: first.annotationId }
  }

  function reload(): void {
    coldStart()
    reviews.getReviewStateForSession(SID)
  }

  it('reopenReview on a decision-settled round stays live across the reload', () => {
    const { cid } = settledByLaterReject()
    expect(reviewOnDisk(cid, 'R1').status).toBe('resolved')
    reviews.reopenReview(SID, cid, 'R1')
    reload()
    // The legacy heal would settle R1 all over again: it is frozen on v1, which
    // sits BELOW the user's latest verdict. Only the round's own `decision`
    // stamp tells it apart from a genuine pre-rework leftover.
    expect(reviewOnDisk(cid, 'R1')).toMatchObject({ status: 'submitted' })
    expect(reviewOnDisk(cid, 'R1').settled).toBeUndefined()
    expect(reviews.getReviewCountsForCanvas(cid)!.liveRounds).toBe(2)
  })

  it('reopenReview on an OBSERVATION round stays live across the reload', () => {
    render(1)
    const { reviewId } = addNote('v1', 'a remark')
    reviews.submitReview(SID, reviewId, [], 'approve')
    const cid = canvasId()
    reviews.reopenReview(SID, cid, reviewId)
    reload()
    // The approve-frozen-on-the-anchor branch of the heal would re-observe it.
    expect(reviewOnDisk(cid, reviewId)).toMatchObject({ status: 'submitted' })
    expect(noteOnDisk(cid, 'a1').state).toBe('open')
  })

  it('reopenAnnotation likewise — the per-note half of the same gesture', () => {
    const { cid, noteId } = settledByLaterReject()
    reviews.reopenAnnotation(SID, noteId)
    reload()
    expect(reviewOnDisk(cid, 'R1').status).toBe('submitted')
    expect(shared.isLiveNote(noteOnDisk(cid, noteId))).toBe(true)
    expect(noteOnDisk(cid, noteId).reopenedAt).toBeTruthy()
  })

  it('both heals are idempotent on a reopened record — a second load changes nothing', () => {
    const { cid } = settledByLaterReject()
    reviews.reopenReview(SID, cid, 'R1')
    reload()
    const first = fs.readFileSync(path.join(getResourcesDirectory(), 'canvas', cid, 'reviews.json'), 'utf8')
    reload()
    expect(fs.readFileSync(path.join(getResourcesDirectory(), 'canvas', cid, 'reviews.json'), 'utf8')).toBe(first)
    // …and the READ path agrees with the load path, which is the other half of
    // "two answers to one question".
    expect(reviews.getReviewCountsForCanvas(cid)!.liveRounds).toBe(2)
  })
})

// ── 4c. the settle's artefact scoping ───────────────────────────────────────

describe('settleEarlierRounds never crosses artefacts', () => {
  it('a plan round beside a mockup decision is untouched', () => {
    store.renderVersion(SID, { mode: 'plan', html: '<!doctype html><p>plan</p>', title: TITLE })
    const plan = addNote('v1', 'step two is wrong')
    reviews.submitReview(SID, plan.reviewId, [], 'reject')
    // A DESIGN render starts a second artefact; the user decides on that one.
    render(2)
    const mockup = addNote('v2', 'the logo')
    reviews.submitReview(SID, mockup.reviewId, [], 'reject')
    const cid = canvasId()
    expect(reviewOnDisk(cid, plan.reviewId)).toMatchObject({ status: 'submitted' })
    expect(reviewOnDisk(cid, plan.reviewId).settled).toBeUndefined()
    expect(noteOnDisk(cid, plan.annotationId).state).toBe('open')
  })

  it('a FREEZE-SLIP round — frozen on the plan, notes on the mockup — is isolated, not settled', () => {
    // The agent renders a plan between the user writing a note and submitting
    // it, so the round freezes against the plan version while its note points
    // at the mockup. It belongs to neither run, and the fail-closed side is to
    // settle it from neither.
    render(1)
    const slip = addNote('v1', 'about the mockup')
    store.renderVersion(SID, { mode: 'plan', html: '<!doctype html><p>plan</p>', title: TITLE })
    reviews.submitReview(SID, slip.reviewId, [], 'reject')
    const cid = canvasId()
    expect(reviewOnDisk(cid, slip.reviewId).versionId).toBe('v2') // the plan
    expect(noteOnDisk(cid, slip.annotationId).versionId).toBe('v1') // the mockup

    // A later decision on the MOCKUP run does not reach it…
    render(3)
    reviews.settleRoundsForUserDecision(cid, 'v3')
    expect(reviewOnDisk(cid, slip.reviewId).status).toBe('submitted')
    // …and neither does one on the PLAN run.
    reviews.settleRoundsForUserDecision(cid, 'v2')
    expect(reviewOnDisk(cid, slip.reviewId).status).toBe('submitted')
  })
})

// ── 5. heal on load ─────────────────────────────────────────────────────────

describe('heal on load — pre-rework records read cleanly or are cleanly archived', () => {
  const CID = 'aaaabbbbccccddddeeeeffff'

  function legacyCanvas(versions: unknown[]): void {
    writeCanvasJson(CID, {
      canvasId: CID,
      sessionId: SID,
      createdAt: '2026-08-01T00:00:00.000Z',
      title: TITLE,
      versions,
      activeVersionId: `v${versions.length}`,
      nextVersion: versions.length + 1,
    })
  }

  function version(n: number, verdict?: Record<string, unknown>): Record<string, unknown> {
    return {
      id: `v${n}`,
      mode: 'design',
      createdAt: `2026-08-0${Math.min(n, 9)}T00:00:00.000Z`,
      source: { mode: 'design', entry: 'index.html' },
      ...(verdict ? { verdict } : {}),
    }
  }

  function legacyNote(id: string, reviewId: string, versionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id, reviewId, scope: 'general', note: `note ${id}`, versionId, state: 'open', ...extra }
  }

  it('(a) the working-pill strand: an approved version with an open note becomes an observation, nothing owed', () => {
    legacyCanvas([version(1, { state: 'approved', by: 'user', at: '2026-08-02T00:00:00.000Z' })])
    writeReviewsJson(CID, {
      canvasId: CID,
      sessionId: SID,
      nextReview: 2,
      nextAnnotation: 2,
      reviews: [{ id: 'R1', canvas: { canvasId: CID, sessionId: SID }, versionId: 'v1', annotationIds: ['a1'], status: 'submitted', createdAt: '2026-08-01T00:00:00.000Z' }],
      annotations: [legacyNote('a1', 'R1', 'v1')],
    })
    coldStart()

    // The COUNTS path heals too — it reads the file without loadRecord's
    // rebind, and a canvas that answered "1 owed" there and "nothing owed" to a
    // state read is two answers to one question.
    expect(reviews.getReviewCountsForCanvas(CID)).toMatchObject({ openNotes: 0, addressedNotes: 0, liveRounds: 0 })
    // …and a real load makes it durable.
    reviews.getReviewStateForSession(SID)
    expect(noteOnDisk(CID, 'a1')).toMatchObject({ state: 'observation', closedBy: 'user' })
    expect(reviewOnDisk(CID, 'R1')).toMatchObject({ status: 'resolved', settled: { by: 'legacy' } })
  })

  it('(b) the 6-round pile of legacy ADDRESSED notes settles as legacy', () => {
    const versions = [1, 2, 3, 4, 5, 6, 7].map((n) => version(n, { state: 'rejected', by: 'user', at: '2026-08-05T00:00:00.000Z' }))
    versions.push(version(8, { state: 'approved', by: 'user', at: '2026-08-06T00:00:00.000Z' }))
    legacyCanvas(versions)
    writeReviewsJson(CID, {
      canvasId: CID,
      sessionId: SID,
      nextReview: 8,
      nextAnnotation: 8,
      reviews: [1, 2, 3, 4, 5, 6, 7].map((n) => ({
        id: `R${n}`,
        canvas: { canvasId: CID, sessionId: SID },
        versionId: `v${n}`,
        annotationIds: [`a${n}`],
        status: 'submitted',
        createdAt: '2026-08-01T00:00:00.000Z',
      })),
      annotations: [1, 2, 3, 4, 5, 6, 7].map((n) => legacyNote(`a${n}`, `R${n}`, `v${n}`, { state: 'addressed', addressedAt: '2026-08-05T00:00:00.000Z', addressedBy: { actor: 'agent', sessionId: SID } })),
    })
    coldStart()

    expect(reviews.getReviewCountsForCanvas(CID)).toMatchObject({ openNotes: 0, addressedNotes: 0, liveRounds: 0 })
    reviews.getReviewStateForSession(SID)
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      expect(reviewOnDisk(CID, `R${n}`)).toMatchObject({ status: 'resolved', settled: { by: 'legacy', versionId: 'v8' } })
      expect(noteOnDisk(CID, `a${n}`)).toMatchObject({ closedBy: 'decision', settledBy: { versionId: 'v8' } })
    }
  })

  it('(c) a dead `verdict` field and a plan-step target are dropped; the note and its box survive', () => {
    legacyCanvas([version(1)])
    writeReviewsJson(CID, {
      canvasId: CID,
      sessionId: SID,
      nextReview: 2,
      nextAnnotation: 2,
      reviews: [{ id: 'R1', canvas: { canvasId: CID, sessionId: SID }, versionId: 'v1', annotationIds: ['a1'], status: 'submitted', createdAt: '2026-08-01T00:00:00.000Z' }],
      annotations: [
        {
          id: 'a1',
          reviewId: 'R1',
          scope: 'element',
          note: 'step two is wrong',
          versionId: 'v1',
          state: 'open',
          verdict: 'accept',
          focus: {
            targets: [
              { kind: 'plan-step', id: 's2' },
              { kind: 'ux-id', id: 'step-2' },
            ],
            bboxPage: { x: 1, y: 2, width: 3, height: 4 },
            label: 'step 2',
            versionId: 'v1',
          },
        },
      ],
    })
    coldStart()

    const a = reviews.getReviewStateForSession(SID)!.annotations.find((n) => n.id === 'a1')!
    expect(a.note).toBe('step two is wrong')
    expect((a as unknown as { verdict?: unknown }).verdict).toBeUndefined()
    expect(a.focus!.bboxPage).toEqual({ x: 1, y: 2, width: 3, height: 4 })
    expect(a.focus!.targets).toEqual([{ kind: 'ux-id', id: 'step-2' }])
  })

  it('(d) a live round on a rejected version with no later user verdict stays LIVE', () => {
    legacyCanvas([version(1, { state: 'rejected', by: 'user', at: '2026-08-02T00:00:00.000Z' }), version(2)])
    writeReviewsJson(CID, {
      canvasId: CID,
      sessionId: SID,
      nextReview: 2,
      nextAnnotation: 2,
      reviews: [{ id: 'R1', canvas: { canvasId: CID, sessionId: SID }, versionId: 'v1', annotationIds: ['a1'], status: 'submitted', createdAt: '2026-08-01T00:00:00.000Z' }],
      annotations: [legacyNote('a1', 'R1', 'v1')],
    })
    coldStart()

    expect(reviews.getReviewCountsForCanvas(CID)).toMatchObject({ openNotes: 1, liveRounds: 1 })
    expect(reviewOnDisk(CID, 'R1').status).toBe('submitted')
  })

  it('(e) a hand-corrupted reviews.json marks the canvas broken and is never overwritten', () => {
    legacyCanvas([version(1)])
    const corrupt = '{ "canvasId": "' + CID + '", "reviews": [ '
    writeReviewsJson(CID, 'placeholder')
    fs.writeFileSync(path.join(getResourcesDirectory(), 'canvas', CID, 'reviews.json'), corrupt)
    coldStart()

    expect(reviews.getReviewStateForSession(SID)).toMatchObject({ reviews: [], annotations: [] })
    expect(reviews.getReviewCountsForCanvas(CID)).toBeNull()
    expect(() => reviews.upsertAnnotation(SID, { scope: 'general', note: 'x', versionId: 'v1' })).toThrow()
    expect(fs.readFileSync(path.join(getResourcesDirectory(), 'canvas', CID, 'reviews.json'), 'utf8')).toBe(corrupt)
  })

  it('(f) the heal is idempotent — a second cold load produces byte-identical output', () => {
    const versions = [version(1, { state: 'rejected', by: 'user', at: '2026-08-05T00:00:00.000Z' }), version(2, { state: 'approved', by: 'user', at: '2026-08-06T00:00:00.000Z' })]
    legacyCanvas(versions)
    writeReviewsJson(CID, {
      canvasId: CID,
      sessionId: SID,
      nextReview: 3,
      nextAnnotation: 3,
      reviews: [1, 2].map((n) => ({
        id: `R${n}`,
        canvas: { canvasId: CID, sessionId: SID },
        versionId: `v${n}`,
        annotationIds: [`a${n}`],
        status: 'submitted',
        createdAt: '2026-08-01T00:00:00.000Z',
      })),
      annotations: [legacyNote('a1', 'R1', 'v1'), legacyNote('a2', 'R2', 'v2')],
    })
    coldStart()
    reviews.getReviewStateForSession(SID)
    const first = fs.readFileSync(path.join(getResourcesDirectory(), 'canvas', CID, 'reviews.json'), 'utf8')
    coldStart()
    reviews.getReviewStateForSession(SID)
    const second = fs.readFileSync(path.join(getResourcesDirectory(), 'canvas', CID, 'reviews.json'), 'utf8')
    expect(second).toBe(first)
  })
})

// ── 6. Mark complete is never dead ──────────────────────────────────────────

describe('force complete — the user always has an exit', () => {
  /** A canvas holding one of everything a force close has to deal with: an
   *  unsent draft note, a note still with the agent, a note the agent answered,
   *  and a ready version nobody has reviewed. All on ONE round, because a second
   *  round would settle the first — which is the point of the machine, and would
   *  leave nothing here to force. */
  function owedCanvas(): { cid: string } {
    render(1)
    const first = addNote('v1', 'still open')
    const second = addNote('v1', 'answered')
    reviews.submitReview(SID, first.reviewId, [], 'reject')
    reviews.markAnnotationsAddressed(SID, first.reviewId, [second.annotationId])
    render(2)
    addNote('v2', 'unsent draft')
    return { cid: canvasId() }
  }

  it('describeForceClosures names exactly what the force will do', () => {
    const { cid } = owedCanvas()
    expect(completion.describeForceClosures(cid)).toMatchObject({
      unsentNotes: 1,
      openNotes: 1,
      addressedNotes: 1,
      unreviewedVersionIds: ['v2'],
    })
  })

  it('the force closes each of them and the description matched', () => {
    const { cid } = owedCanvas()
    const described = completion.describeForceClosures(cid)!
    const result = completion.completeCanvasGuarded(cid, 'user', SID, { force: true })
    expect(result).not.toHaveProperty('error')

    const rec = onDisk(cid)
    expect(rec.annotations.filter((a) => shared.isLiveNote(a))).toHaveLength(0)
    // The unsent draft is DELETED, not closed — it was never sent.
    expect(rec.annotations).toHaveLength(described.openNotes + described.addressedNotes)
    for (const r of rec.reviews) {
      expect(r.status).toBe('resolved')
      expect(r.settled?.by).toBe('force')
    }
    const state = store.getCanvasStateById(cid)!
    expect(state.completed?.by).toBe('user')
    expect(state.versions.find((v) => v.id === 'v2')!.verdict).toMatchObject({ state: 'dismissed', by: 'user' })
  })

  it('force is USER-only — the agent path and canvas_complete still refuse while anything is owed', () => {
    const { cid } = owedCanvas()
    expect(completion.completeCanvasGuarded(cid, 'agent', undefined, { force: true })).toMatchObject({
      error: expect.stringContaining('not everything is settled'),
    })
    expect(completion.completeCanvasGuarded(cid, 'agent', undefined)).toMatchObject({
      error: expect.stringContaining('not everything is settled'),
    })
    expect(store.getCanvasStateById(cid)!.completed).toBeUndefined()
  })

  it('the IPC surface exposes both, and the plain complete still refuses', async () => {
    const { cid } = owedCanvas()
    expect(await invoke(IPC.CANVAS_DESCRIBE_FORCE_CLOSURES, { sessionId: SID, canvasId: cid })).toMatchObject({ openNotes: 1 })
    expect(await invoke(IPC.CANVAS_COMPLETE, { sessionId: SID, canvasId: cid })).toMatchObject({ ok: false })
    expect(await invoke(IPC.CANVAS_COMPLETE_FORCE, { sessionId: SID, canvasId: cid })).toMatchObject({ ok: true })
  })

  it('the describe is OWNER-ONLY — a foreign session gets null, never the tallies', async () => {
    // These are the canvas's private review counts. Answering them to anybody
    // makes this an oracle for exactly what `completeForce` refuses to act on,
    // so ownership is checked before a single tally is read.
    const { cid } = owedCanvas()
    const stranger = 'ffffffffffffffffffffffff'
    expect(completion.describeForceClosures(cid, stranger)).toBeNull()
    expect(await invoke(IPC.CANVAS_DESCRIBE_FORCE_CLOSURES, { sessionId: stranger, canvasId: cid })).toBeNull()
    // …and the owner still gets them.
    expect(completion.describeForceClosures(cid, SID)).toMatchObject({ openNotes: 1 })
  })
})

// ── 6b. an open version ANYWHERE is owed ────────────────────────────────────

describe('an open version on ANY artefact blocks the sign-off (M2)', () => {
  /** A canvas with two artefacts: a PLAN left open, and a design the user
   *  approved. The plan is a decision they still owe. */
  function twoArtefacts(): { cid: string } {
    store.renderVersion(SID, { mode: 'plan', html: '<!doctype html><p>plan</p>', title: TITLE })
    render(2)
    return { cid: canvasId() }
  }

  it('refuses, and NAMES the open version — approving the design must not strand the plan', async () => {
    const { cid } = twoArtefacts()
    // The user approves the design. Its own artefact is settled…
    const ruled = await invoke(IPC.CANVAS_VERSION_VERDICT, { sessionId: SID, versionId: 'v2', state: 'approved' })
    expect(ruled).not.toHaveProperty('error')
    // …but the plan is still open, so the auto-complete did NOT sign off.
    expect(store.getCanvasStateById(cid)!.completed).toBeUndefined()
    expect(completion.completeCanvasGuarded(cid, 'user', SID)).toMatchObject({
      error: expect.stringContaining('v1 (plan) still open for review'),
    })
    // The plan is still decidable — which it would not be on a completed canvas.
    expect('error' in store.setVersionVerdict(SID, 'v1', { state: 'approved' }, 'user')).toBe(false)
  })

  it('the force dismisses EVERY open run, and names each of them first', async () => {
    const { cid } = twoArtefacts()
    expect(completion.describeForceClosures(cid, SID)!.unreviewedVersionIds.sort()).toEqual(['v1', 'v2'])
    expect(completion.completeCanvasGuarded(cid, 'user', SID, { force: true })).not.toHaveProperty('error')
    const state = store.getCanvasStateById(cid)!
    for (const id of ['v1', 'v2']) {
      expect(state.versions.find((v) => v.id === id)!.verdict).toMatchObject({ state: 'dismissed', by: 'user', note: 'closed unreviewed' })
    }
    expect(state.completed?.by).toBe('user')
  })

  it('an ARCHIVED run is not owed — the user already put it down', () => {
    const { cid } = twoArtefacts()
    store.setArtifactArchived(cid, 'v1', true)
    expect(completion.describeForceClosures(cid, SID)!.unreviewedVersionIds).toEqual(['v2'])
  })
})

// ── 7. the agent's own word settles nothing ─────────────────────────────────

describe('an agent-chat verdict settles nothing and completes nothing (A2)', () => {
  it('canvas_version_verdict approving v8 leaves the live round live and completes nothing', () => {
    const { cid, roundIds } = buildPile()
    const live = roundIds[roundIds.length - 1]
    const before = onDisk(cid)
    const ruled = store.setVersionVerdict(SID, 'v8', { state: 'approved' }, 'agent-chat')
    expect('error' in ruled).toBe(false)
    expect(reviewOnDisk(cid, live)).toMatchObject({ status: 'submitted' })
    expect(reviewOnDisk(cid, live).settled).toBeUndefined()
    // …and nothing else moved either: the record is byte-identical.
    expect(onDisk(cid)).toEqual(before)
    // No round anywhere claims v8 settled it — a relayed verdict settles nothing.
    expect(onDisk(cid).reviews.some((r) => r.settled?.versionId === 'v8')).toBe(false)
    expect(store.getCanvasStateById(cid)!.completed).toBeUndefined()
  })
})

// ── 8. a reject settles earlier rounds too, and reports what was lost ───────

describe('a later REJECT settles earlier rounds (A1) and reports never-resolved notes (A4)', () => {
  it('the earlier round settles and the new round reports its never-resolved notes', () => {
    render(1)
    const cid = canvasId()
    const first = addNote('v1', 'nobody ever answered this')
    reviews.submitReview(SID, first.reviewId, [], 'reject')
    render(2)
    const second = addNote('v2', 'still wrong')
    reviews.submitReview(SID, second.reviewId, [], 'reject')

    expect(reviewOnDisk(cid, first.reviewId)).toMatchObject({
      status: 'resolved',
      settled: { by: 'decision', versionId: 'v2', reviewId: second.reviewId },
    })
    expect(noteOnDisk(cid, first.annotationId)).toMatchObject({
      state: 'stale',
      closedBy: 'decision',
      closedFrom: 'open',
      settledBy: { versionId: 'v2', reviewId: second.reviewId },
    })

    const { payload } = reviews.getReviewPayload(SID, second.reviewId)
    expect(payload.settledByThisSubmission).toEqual([
      { reviewId: first.reviewId, neverResolved: [expect.objectContaining({ id: first.annotationId })] },
    ])
  })

  it('lists EVERY round it settled, even one where nothing was left unanswered (m7)', () => {
    // The agent's picture of what is live has to match the store's. A round
    // quietly missing from this list is a round it still thinks it owes work
    // on — so the block carries all of them, and the count is a count of
    // ROUNDS while the list under it is the notes nobody ever answered.
    render(1)
    const cid = canvasId()
    const answered = addNote('v1', 'the agent handled this one')
    reviews.submitReview(SID, answered.reviewId, [], 'reject')
    reviews.markAnnotationsAddressed(SID, answered.reviewId, [answered.annotationId])
    render(2)
    const next = addNote('v2', 'still wrong')
    reviews.submitReview(SID, next.reviewId, [], 'reject')

    const { payload } = reviews.getReviewPayload(SID, next.reviewId)
    expect(payload.settledByThisSubmission).toEqual([{ reviewId: answered.reviewId, neverResolved: [] }])
    const text = serialize.serializeReviewPayload(payload, [])
    expect(text.text).toContain(`settled by this submission (1): ${answered.reviewId}`)
    expect(text.text).toContain('never resolved: none — every note on them was answered')
    void cid
  })
})
