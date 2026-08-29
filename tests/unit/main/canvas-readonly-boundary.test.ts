// THE READ-ONLY BOUNDARY (W38) — every mutating canvas channel, one test each.
//
// M4 puts somebody else's COMPLETED canvas on your screen. A memorialised
// canvas is shared project history: the Library lists it, `canvas:getReadonly`
// hands over its state, and the pane renders it. That is a new class of caller —
// a session holding a canvas id it does not own and never will — so the
// question this file answers is the only one that matters about it: can that
// caller CHANGE anything?
//
// The answer has to be "no" channel by channel, not "no in general", because
// the refusals are not one mechanism. Some channels are session-keyed (they
// resolve `sessionIndex` and simply never see the target); some compare the
// canvas id against the caller's own; some ask an explicit ownership guard. A
// blanket assertion would pass while any one of them regressed, so the list
// below is ENUMERATED FROM `IPC` and each entry is exercised for real.
//
// The oracle is the FILES. Every case runs the call and then compares
// canvas.json and reviews.json byte for byte against a snapshot taken before —
// a refusal that still persisted something is not a refusal, and an in-memory
// -only check would not see it.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { IPC } from '../../../src/shared/ipc-channels'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-readonly-boundary-'))
  return { getResourcesDirectory: () => dir }
})

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const listeners = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => unknown) => listeners.set(ch, fn),
  },
  BrowserWindow: { fromWebContents: () => null },
}))

vi.mock('../../../src/main/canvas/canvas-snapshot-broker', () => ({
  resolveCanvasSnapshot: vi.fn(),
  setSnapshotSender: vi.fn(),
}))

// The liveness oracle's two real inputs. Nothing is live in this file: the
// OWNER has quit, which is the state in which its completed canvas is visible
// to the whole project — and the state a would-be mutator is most likely to
// find it in.
vi.mock('../../../src/main/session-registry', () => ({
  isPtySessionLive: () => false,
  getSessionMeta: () => undefined,
}))
vi.mock('../../../src/main/logging/logging-service', () => ({ getTranscriptBinder: () => null }))

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const reviews = await import('../../../src/main/canvas/canvas-review-store')
const completion = await import('../../../src/main/canvas/canvas-completion')
const link = await import('../../../src/main/canvas/canvas-session-link')
const { registerCanvasHandlers } = await import('../../../src/main/ipc/canvas-handlers')

const OWNER = 'aaaa1111aaaa1111aaaa1111'
const FOREIGN = 'bbbb2222bbbb2222bbbb2222'
const PROJECT = path.join(getResourcesDirectory(), 'project')

registerCanvasHandlers(
  () => ({ isDestroyed: () => false, webContents: { send: () => {} } }) as never,
)

const invoke = async (channel: string, args: unknown): Promise<unknown> => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler({ sender: {} } as never, args)
}

let targetCanvasId: string
let targetVersionId: string
let targetReviewId: string
let targetAnnotationId: string
/** The FOREIGN session's own canvas, so every session-keyed channel resolves to
 *  something. Without it those channels refuse for the uninteresting reason
 *  ("you have no canvas") instead of the interesting one ("not that one"). */
let foreignCanvasId: string

function canvasFile(canvasId: string): string {
  return path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json')
}
function reviewsFile(canvasId: string): string {
  return path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')
}
function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}
/** Everything about the target that a mutation could possibly change. */
function snapshot(): { canvas: string | null; reviews: string | null; dirExists: boolean } {
  return {
    canvas: readOrNull(canvasFile(targetCanvasId)),
    reviews: readOrNull(reviewsFile(targetCanvasId)),
    dirExists: fs.existsSync(path.join(getResourcesDirectory(), 'canvas', targetCanvasId)),
  }
}

/** Run the call and assert it changed NOTHING on the target, whether it refused
 *  by returning a reason, by answering null, or by throwing. */
async function expectNoEffect(channel: string, args: unknown): Promise<unknown> {
  const before = snapshot()
  let result: unknown
  try {
    result = await invoke(channel, args)
  } catch (err) {
    result = { threw: String(err) }
  }
  expect(snapshot(), `${channel} mutated the target`).toEqual(before)
  return result
}

beforeAll(() => {
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
  fs.mkdirSync(PROJECT, { recursive: true })

  // The OWNER's canvas: one design version, one submitted round with a note,
  // then signed off. Memorialised = visible to the project, read-only to
  // everyone but its owner.
  link.noteSessionSpawnForCanvas(OWNER, { cwd: PROJECT, configLabel: 'Owner tile' })
  const rendered = store.renderVersion(OWNER, {
    mode: 'design',
    title: 'Checkout flow',
    html: '<!doctype html><p data-ux-id="p">v1</p>',
  })
  targetCanvasId = rendered.canvasId
  targetVersionId = rendered.versionId
  const upserted = reviews.upsertAnnotation(OWNER, {
    scope: 'general',
    note: 'the header wraps at 1280',
    versionId: targetVersionId,
  })
  targetAnnotationId = upserted.annotationId
  targetReviewId = upserted.state.reviews.find((r) => r.status === 'draft')!.id
  reviews.submitReview(OWNER, targetReviewId, [], 'approve')
  const done = completion.completeCanvasGuarded(targetCanvasId, 'user', OWNER)
  expect('error' in done ? done.error : done.completed).toBeTruthy()

  // The FOREIGN session: same project, its own canvas, no claim on the target.
  link.noteSessionSpawnForCanvas(FOREIGN, { cwd: PROJECT, configLabel: 'Other tile' })
  foreignCanvasId = store.renderVersion(FOREIGN, {
    mode: 'design',
    title: 'Something else',
    html: '<!doctype html><p>mine</p>',
  }).canvasId
  expect(foreignCanvasId).not.toBe(targetCanvasId)
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort temp cleanup */
  }
})

describe('the premise: a non-owner really can SEE the completed canvas', () => {
  it('reads its state through canvas:getReadonly', async () => {
    const state = (await invoke(IPC.CANVAS_GET_READONLY, {
      sessionId: FOREIGN,
      canvasId: targetCanvasId,
    })) as { canvasId: string; sessionId: string; completed?: unknown } | null
    expect(state?.canvasId).toBe(targetCanvasId)
    expect(state?.sessionId).toBe(OWNER) // the row says whose it is; it does not become ours
    expect(state?.completed).toBeTruthy()
  })

  it('but NOT an in-flight canvas, completed being the whole condition', async () => {
    expect(
      await invoke(IPC.CANVAS_GET_READONLY, { sessionId: OWNER, canvasId: foreignCanvasId }),
    ).toBeNull()
  })

  it('and not one from another project', async () => {
    link.noteSessionSpawnForCanvas('cccc3333cccc3333cccc3333', { cwd: path.join(getResourcesDirectory(), 'elsewhere') })
    expect(
      await invoke(IPC.CANVAS_GET_READONLY, { sessionId: 'cccc3333cccc3333cccc3333', canvasId: targetCanvasId }),
    ).toBeNull()
  })

  it('viewing it never makes it ours', async () => {
    await invoke(IPC.CANVAS_GET_READONLY, { sessionId: FOREIGN, canvasId: targetCanvasId })
    expect(store.getCanvasStateById(targetCanvasId)?.sessionId).toBe(OWNER)
    expect(store.getCanvasStateForSession(FOREIGN)?.canvasId).toBe(foreignCanvasId)
  })
})

describe('every mutating canvas channel refuses a foreign caller', () => {
  // ENUMERATED FROM `IPC`. The guard below fails the suite when a new
  // CANVAS_* channel lands without a case here, so this list cannot rot
  // quietly — which is the failure mode a hand-written list normally has.

  it('CANVAS_RENDER writes to the CALLER’s canvas, never the target', async () => {
    const result = await expectNoEffect(IPC.CANVAS_RENDER, {
      sessionId: FOREIGN,
      source: { mode: 'design', html: '<!doctype html><p>injected</p>', title: 'Checkout flow' },
    })
    expect((result as { canvasId?: string }).canvasId).not.toBe(targetCanvasId)
  })

  it('CANVAS_SET_ACTIVE_VERSION cannot re-point the target', async () => {
    await expectNoEffect(IPC.CANVAS_SET_ACTIVE_VERSION, { sessionId: FOREIGN, versionId: targetVersionId })
  })

  it('CANVAS_DELETE refuses: a completed canvas is its owner’s history', async () => {
    const result = await expectNoEffect(IPC.CANVAS_DELETE, {
      sessionId: FOREIGN,
      canvasId: targetCanvasId,
      openTileSessionIds: [FOREIGN],
    })
    expect(result).toEqual({ ok: false, reason: 'not-eligible' })
  })

  it('CANVAS_ARCHIVE_ARTIFACT refuses', async () => {
    const result = await expectNoEffect(IPC.CANVAS_ARCHIVE_ARTIFACT, {
      sessionId: FOREIGN,
      canvasId: targetCanvasId,
      versionId: targetVersionId,
      archived: true,
      openTileSessionIds: [FOREIGN],
    })
    expect(result).toMatchObject({ ok: false, reason: 'not-eligible' })
  })

  it('CANVAS_DELETE_ARTIFACT refuses', async () => {
    const result = await expectNoEffect(IPC.CANVAS_DELETE_ARTIFACT, {
      sessionId: FOREIGN,
      canvasId: targetCanvasId,
      versionId: targetVersionId,
      openTileSessionIds: [FOREIGN],
    })
    expect(result).toMatchObject({ ok: false, reason: 'not-eligible' })
  })

  it('CANVAS_ANNOTATION_UPSERT cannot add a note to it', async () => {
    await expectNoEffect(IPC.CANVAS_ANNOTATION_UPSERT, {
      sessionId: FOREIGN,
      draft: { scope: 'general', note: 'planted', versionId: targetVersionId },
    })
  })

  it('CANVAS_ANNOTATION_DELETE cannot remove its note', async () => {
    await expectNoEffect(IPC.CANVAS_ANNOTATION_DELETE, {
      sessionId: FOREIGN,
      annotationId: targetAnnotationId,
    })
  })

  it('CANVAS_REVIEW_SUBMIT cannot submit against its round', async () => {
    await expectNoEffect(IPC.CANVAS_REVIEW_SUBMIT, {
      sessionId: FOREIGN,
      reviewId: targetReviewId,
      sketches: [],
      decision: 'reject',
    })
  })

  it('CANVAS_VERSION_VERDICT lands on the CALLER’s own version, never the target’s', async () => {
    // Worth being precise about, because the refusal is not a refusal: the
    // channel is session-keyed, and version ids are ORDINALS WITHIN A CANVAS —
    // every canvas has a 'v1'. So naming the target's version id does not reach
    // the target at all; it rules on the caller's own same-numbered version.
    // The target is untouched (asserted by the file snapshot), which is the
    // property that matters, and the result names the caller's canvas.
    const result = await expectNoEffect(IPC.CANVAS_VERSION_VERDICT, {
      sessionId: FOREIGN,
      versionId: targetVersionId,
      state: 'rejected',
      note: 'not mine to say',
    })
    expect((result as { canvasId?: string }).canvasId).not.toBe(targetCanvasId)
    // Still the OWNER's own approval, not the stranger's rejection.
    expect(store.getCanvasStateById(targetCanvasId)?.versions[0].verdict)
      .toMatchObject({ state: 'approved', by: 'user' })
  })

  it('CANVAS_VERSION_REOPEN likewise reaches only the caller’s own canvas', async () => {
    const result = await expectNoEffect(IPC.CANVAS_VERSION_REOPEN, {
      sessionId: FOREIGN,
      versionId: targetVersionId,
    })
    expect((result as { canvasId?: string }).canvasId).not.toBe(targetCanvasId)
    // The target is still signed off: a reopen there would restore obligations
    // on somebody else's memorialised work.
    expect(store.getCanvasStateById(targetCanvasId)?.completed).toBeTruthy()
  })

  it('CANVAS_ANNOTATION_REOPEN cannot revive its note', async () => {
    await expectNoEffect(IPC.CANVAS_ANNOTATION_REOPEN, {
      sessionId: FOREIGN,
      annotationId: targetAnnotationId,
    })
  })

  it('CANVAS_REVIEW_REOPEN cannot revive its round', async () => {
    await expectNoEffect(IPC.CANVAS_REVIEW_REOPEN, {
      sessionId: FOREIGN,
      canvasId: targetCanvasId,
      reviewId: targetReviewId,
    })
  })

  it('CANVAS_REVIEW_MARK_SEEN cannot release its close-out barrier', async () => {
    await expectNoEffect(IPC.CANVAS_REVIEW_MARK_SEEN, {
      sessionId: FOREIGN,
      canvasId: targetCanvasId,
      annotationIds: [targetAnnotationId],
    })
  })

  it('CANVAS_COMPOSER_DRAFT_SET cannot plant text in its composer', async () => {
    await expectNoEffect(IPC.CANVAS_COMPOSER_DRAFT_SET, {
      sessionId: FOREIGN,
      canvasId: targetCanvasId,
      draft: { versionId: targetVersionId, text: 'planted draft', images: [] },
    })
  })

  it('CANVAS_COMPOSER_DRAFT_CLEAR cannot throw its composer away', async () => {
    await expectNoEffect(IPC.CANVAS_COMPOSER_DRAFT_CLEAR, {
      sessionId: FOREIGN,
      canvasId: targetCanvasId,
    })
  })

  it('CANVAS_COMPLETE refuses', async () => {
    const result = await expectNoEffect(IPC.CANVAS_COMPLETE, { sessionId: FOREIGN, canvasId: targetCanvasId })
    expect(result).toMatchObject({ ok: false })
  })

  it('CANVAS_COMPLETE_FORCE refuses', async () => {
    const result = await expectNoEffect(IPC.CANVAS_COMPLETE_FORCE, { sessionId: FOREIGN, canvasId: targetCanvasId })
    expect(result).toMatchObject({ ok: false })
  })

  it('CANVAS_COMPLETE_REOPEN refuses — reopening restores obligations', async () => {
    const result = await expectNoEffect(IPC.CANVAS_COMPLETE_REOPEN, { sessionId: FOREIGN, canvasId: targetCanvasId })
    expect(result).toMatchObject({ ok: false })
  })

  it('CANVAS_SET_PACK_NAME cannot rename it', async () => {
    await expectNoEffect(IPC.CANVAS_SET_PACK_NAME, {
      sessionId: FOREIGN,
      canvasId: targetCanvasId,
      versionId: targetVersionId,
      name: 'renamed by a stranger',
    })
  })

  it('CANVAS_EVIDENCE_CAPTURE refuses with not-owner', async () => {
    const result = await expectNoEffect(IPC.CANVAS_EVIDENCE_CAPTURE, {
      sessionId: FOREIGN,
      canvasId: targetCanvasId,
      versionId: targetVersionId,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      stamp: {
        viewport: { width: 10, height: 10, scrollX: 0, scrollY: 0, dpr: 1, zoom: 1 },
        dialogs: [],
        fields: [],
      },
      trail: [],
    })
    expect(result).toEqual({ ok: false, reason: 'not-owner' })
  })

  it('CANVAS_EVIDENCE_DISCARD refuses', async () => {
    const result = await expectNoEffect(IPC.CANVAS_EVIDENCE_DISCARD, {
      sessionId: FOREIGN,
      canvasId: targetCanvasId,
      evidenceId: 'a'.repeat(24),
    })
    expect(result).toEqual({ ok: false })
  })

  it('CANVAS_RESUME refuses: a completed canvas is not adoptable at all', async () => {
    const result = await expectNoEffect(IPC.CANVAS_RESUME, {
      sessionId: FOREIGN,
      canvasId: targetCanvasId,
      expectedOwnerSessionId: OWNER,
      openTileSessionIds: [FOREIGN],
    })
    expect(result).toEqual({ ok: false, reason: 'completed' })
    expect(store.getCanvasStateById(targetCanvasId)?.sessionId).toBe(OWNER)
  })

  it('CANVAS_DISMISS refuses: memorialised work is not dismissable', async () => {
    const result = await expectNoEffect(IPC.CANVAS_DISMISS, {
      sessionId: FOREIGN,
      canvasId: targetCanvasId,
      openTileSessionIds: [FOREIGN],
    })
    expect(result).toEqual({ ok: false, reason: 'not-eligible' })
  })

  it('CANVAS_RECLAIM (open here) refuses — it is own-canvas only', async () => {
    const result = await expectNoEffect(IPC.CANVAS_RECLAIM, {
      sessionId: FOREIGN,
      canvasId: targetCanvasId,
      openTileSessionIds: [FOREIGN],
    })
    expect(result).toMatchObject({ ok: false })
    // Not compared against `foreignCanvasId`: earlier cases in this block
    // legitimately moved FOREIGN's CURRENT canvas (its own render filed one and
    // started another). What must hold is that it is never the target.
    expect(store.getCanvasStateForSession(FOREIGN)?.canvasId).not.toBe(targetCanvasId)
    expect(store.getCanvasStateById(targetCanvasId)?.sessionId).toBe(OWNER)
  })
})

describe('the enumeration cannot rot', () => {
  /**
   * Channels that are NOT a renderer-driven mutation of a named canvas.
   *
   * Split out by hand ON PURPOSE and each one justified, because "it is only a
   * read" is exactly the claim that should be re-argued when someone adds a
   * channel — the list below is the argument, and the guard makes writing one
   * mandatory.
   */
  const NOT_A_RENDERER_MUTATION = new Set<string>([
    // Pure reads. None of them writes, and each is separately scoped: the two
    // listing channels apply the privacy rule in main, getReadonly is
    // completed-and-same-project, describeForceClosures is owner-only, and
    // evidenceRead resolves only paths the record itself carries.
    IPC.CANVAS_GET_STATE,
    IPC.CANVAS_GET_READONLY,
    IPC.CANVAS_LIST_ALL,
    IPC.CANVAS_LIBRARY_LIST,
    IPC.CANVAS_LIST_RESUMABLES,
    IPC.CANVAS_REVIEW_GET_STATE,
    IPC.CANVAS_DESCRIBE_FORCE_CLOSURES,
    IPC.CANVAS_EVIDENCE_READ,
    // main -> renderer pushes. Not an ingress at all: nothing outside main can
    // invoke one.
    IPC.CANVAS_CHANGED,
    IPC.CANVAS_REVIEW_CHANGED,
    IPC.CANVAS_SNAPSHOT_REQUEST,
    IPC.CANVAS_FRAME_NAVIGATED,
    // renderer -> main REPLY to a main-initiated request, correlated by an
    // id main minted. It names no canvas and mutates nothing.
    IPC.CANVAS_SNAPSHOT_RESULT,
  ])

  it('covers every CANVAS_* channel that a renderer can invoke', () => {
    const covered = new Set<string>([
      IPC.CANVAS_RENDER,
      IPC.CANVAS_SET_ACTIVE_VERSION,
      IPC.CANVAS_DELETE,
      IPC.CANVAS_ARCHIVE_ARTIFACT,
      IPC.CANVAS_DELETE_ARTIFACT,
      IPC.CANVAS_ANNOTATION_UPSERT,
      IPC.CANVAS_ANNOTATION_DELETE,
      IPC.CANVAS_REVIEW_SUBMIT,
      IPC.CANVAS_VERSION_VERDICT,
      IPC.CANVAS_VERSION_REOPEN,
      IPC.CANVAS_ANNOTATION_REOPEN,
      IPC.CANVAS_REVIEW_REOPEN,
      IPC.CANVAS_REVIEW_MARK_SEEN,
      IPC.CANVAS_COMPOSER_DRAFT_SET,
      IPC.CANVAS_COMPOSER_DRAFT_CLEAR,
      IPC.CANVAS_COMPLETE,
      IPC.CANVAS_COMPLETE_FORCE,
      IPC.CANVAS_COMPLETE_REOPEN,
      IPC.CANVAS_SET_PACK_NAME,
      IPC.CANVAS_EVIDENCE_CAPTURE,
      IPC.CANVAS_EVIDENCE_DISCARD,
      IPC.CANVAS_RESUME,
      IPC.CANVAS_DISMISS,
      IPC.CANVAS_RECLAIM,
    ])
    const all = Object.entries(IPC)
      .filter(([name]) => name.startsWith('CANVAS_'))
      .map(([, channel]) => channel)
    const uncovered = all.filter((c) => !covered.has(c) && !NOT_A_RENDERER_MUTATION.has(c))
    expect(uncovered, 'a new canvas channel needs a boundary case, or a justified exemption above').toEqual([])
    // ...and the exemption list may not name a channel that does not exist.
    for (const exempt of NOT_A_RENDERER_MUTATION) expect(all).toContain(exempt)
  })

  it('registers a handler for every mutating channel it claims to test', () => {
    // The negative control: without this, deleting a handler would make every
    // case above pass for the wrong reason ("nothing happened").
    for (const channel of [
      IPC.CANVAS_DELETE,
      IPC.CANVAS_ARCHIVE_ARTIFACT,
      IPC.CANVAS_DELETE_ARTIFACT,
      IPC.CANVAS_RESUME,
      IPC.CANVAS_DISMISS,
      IPC.CANVAS_RECLAIM,
      IPC.CANVAS_GET_READONLY,
      IPC.CANVAS_LIBRARY_LIST,
      IPC.CANVAS_LIST_RESUMABLES,
    ]) {
      expect(handlers.has(channel), `${channel} is not registered`).toBe(true)
    }
    expect(listeners.has(IPC.CANVAS_SNAPSHOT_RESULT)).toBe(true)
  })
})

describe('the OWNER is not locked out of its own memorialised canvas', () => {
  // The positive control. Every refusal above would also be produced by a store
  // that refused everybody, which would be a different bug and an invisible
  // one — so the same channels are exercised as the owner and must WORK.
  it('reopens, renames and re-archives its own completed canvas', async () => {
    const reopened = (await invoke(IPC.CANVAS_COMPLETE_REOPEN, {
      sessionId: OWNER,
      canvasId: targetCanvasId,
    })) as { ok: boolean }
    expect(reopened.ok).toBe(true)
    expect(store.getCanvasStateById(targetCanvasId)?.completed).toBeUndefined()

    const renamed = await invoke(IPC.CANVAS_SET_PACK_NAME, {
      sessionId: OWNER,
      canvasId: targetCanvasId,
      versionId: targetVersionId,
      name: 'the owner may rename',
    })
    expect((renamed as { versions: Array<{ packName?: string }> }).versions[0].packName).toBe('the owner may rename')

    const archived = (await invoke(IPC.CANVAS_ARCHIVE_ARTIFACT, {
      sessionId: OWNER,
      canvasId: targetCanvasId,
      versionId: targetVersionId,
      archived: true,
      openTileSessionIds: [OWNER],
    })) as { ok: boolean }
    expect(archived.ok).toBe(true)
  })
})

describe('an OWNERLESS IN-FLIGHT canvas: dismissable, but not reachable INSIDE', () => {
  // The line between the two guards, and the reason there are two.
  //
  // A canvas whose session is gone, sitting in the project you are in, has to
  // be clearable by somebody — so DISMISS admits a same-project caller. It
  // discards the canvas WHOLE, behind a confirm that says the evidence goes.
  //
  // Reaching INSIDE that canvas to archive or destroy ONE artefact of it is a
  // different act: silent, partial, and invisible to whoever made the rest.
  // Those two channels are the OWNER's alone, in flight or memorialised.

  let stranded = 0
  /** A fresh canvas owned by a session that never comes back. */
  function strandOne(): { canvasId: string; versionId: string } {
    stranded += 1
    const ghost = `dead${String(stranded).padStart(20, '0')}`
    link.noteSessionSpawnForCanvas(ghost, { cwd: PROJECT, configLabel: 'Gone tile' })
    const rendered = store.renderVersion(ghost, {
      mode: 'design',
      title: `Stranded ${stranded}`,
      html: '<!doctype html><p>left behind</p>',
    })
    // Nothing in this file is live, so it is ownerless the moment it exists.
    expect(store.getCanvasStateById(rendered.canvasId)?.completed).toBeUndefined()
    return rendered
  }

  it('refuses ARCHIVE to a same-project caller — owner-only', async () => {
    const { canvasId, versionId } = strandOne()
    const result = await invoke(IPC.CANVAS_ARCHIVE_ARTIFACT, {
      sessionId: FOREIGN,
      canvasId,
      versionId,
      archived: true,
      openTileSessionIds: [FOREIGN],
    })
    expect(result).toMatchObject({ ok: false, reason: 'not-eligible' })
    expect(store.getCanvasStateById(canvasId)!.versions[0].archived).toBeUndefined()
  })

  it('refuses DELETE-ARTIFACT to a same-project caller — owner-only', async () => {
    const { canvasId, versionId } = strandOne()
    const result = await invoke(IPC.CANVAS_DELETE_ARTIFACT, {
      sessionId: FOREIGN,
      canvasId,
      versionId,
      openTileSessionIds: [FOREIGN],
    })
    expect(result).toMatchObject({ ok: false, reason: 'not-eligible' })
    expect(store.getCanvasStateById(canvasId)).not.toBeNull()
  })

  it('ALLOWS both to the owner, so the refusal is about identity and not about the canvas', async () => {
    stranded += 1
    const mine = `dead${String(stranded).padStart(20, '0')}`
    link.noteSessionSpawnForCanvas(mine, { cwd: PROJECT })
    const first = store.renderVersion(mine, { mode: 'design', title: 'Mine A', html: '<!doctype html><p>a</p>' })
    const second = store.renderVersion(mine, { mode: 'plan', title: 'Mine A', html: '<!doctype html><p>b</p>' })

    expect(
      await invoke(IPC.CANVAS_ARCHIVE_ARTIFACT, {
        sessionId: mine,
        canvasId: first.canvasId,
        versionId: first.versionId,
        archived: true,
        openTileSessionIds: [mine],
      }),
    ).toMatchObject({ ok: true })
    expect(
      await invoke(IPC.CANVAS_DELETE_ARTIFACT, {
        sessionId: mine,
        canvasId: second.canvasId,
        versionId: second.versionId,
        openTileSessionIds: [mine],
      }),
    ).toMatchObject({ ok: true })
  })

  it('but DISMISS is allowed to that same-project caller — the canvas goes WHOLE', async () => {
    const { canvasId } = strandOne()
    expect(
      await invoke(IPC.CANVAS_DISMISS, { sessionId: FOREIGN, canvasId, openTileSessionIds: [FOREIGN] }),
    ).toEqual({ ok: true })
    expect(store.getCanvasStateById(canvasId)).toBeNull()
    expect(fs.existsSync(path.join(getResourcesDirectory(), 'canvas', canvasId))).toBe(false)
  })

  it('and so is the whole-canvas DELETE, which is the same rule as dismiss', async () => {
    const { canvasId } = strandOne()
    expect(
      await invoke(IPC.CANVAS_DELETE, { sessionId: FOREIGN, canvasId, openTileSessionIds: [FOREIGN] }),
    ).toEqual({ ok: true })
    expect(store.getCanvasStateById(canvasId)).toBeNull()
  })
})
