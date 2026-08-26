/**
 * The session→canvas binding survives an in-tile account switch — ON PURPOSE.
 *
 * #371's checklist carried this from the #308 pass as a follow-up to CLOSE, on
 * the reading that a binding surviving an account switch was a leak. ADR-017,
 * accepted the same day, decides the opposite and says so explicitly:
 *
 *   "The session→canvas index remains keyed on session id alone, so the active
 *    canvas follows a tile across an account switch. Under this ADR that is
 *    correct behaviour rather than the leak it looked like beforehand."
 *   "A future adversarial pass will find no account check here. That is
 *    intentional, and this ADR is the record of why — do not re-add it without
 *    a new decision."
 *
 * A canvas is a mockup of something in a PROJECT. Which Claude account happened
 * to be signed in while it was drawn is a property of the session that drew it,
 * not of the artifact — and people switch accounts inside one tile for reasons
 * (rate limits, work vs personal) that have nothing to do with what they are
 * designing. The account floor that used to be here made a tile that had
 * switched accounts unable to re-open canvases it had drawn itself.
 *
 * So this file does not change the behaviour. It PINS it, because it was
 * previously load-bearing but unasserted: nothing failed if someone re-added an
 * account check, and an adversarial pass that found no account check had no way
 * to tell "deliberate" from "missing". Every test here goes red if one comes
 * back.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-acct-switch-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')

/** The tile's session id. It is the SAME id before and after the switch: an
 *  account switch is implemented as respawn-and-resume under the same id
 *  (`useSwitchAccount` → `restart` → `forceRemount`, which re-asserts
 *  `id: session.id` and moves only `createdAt`). That is the fact the whole
 *  behaviour rests on. */
const SID = 'aaaa1111aaaa1111aaaa1111'
const OTHER = 'bbbb2222bbbb2222bbbb2222'
const CONV = '8c25bfdc-57d3-4894-8f4f-e234fb583791'

const tempDirs: string[] = []
function tmp(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

let project = ''

/**
 * What the main process actually does to canvas state when a tile switches
 * account: the PTY is killed, and its exit handler — once no newer PTY has
 * taken the session over — runs `cleanupSessionResources`, whose canvas half is
 * this ONE call (`pty-manager.ts`, `revokeCanvasUatRoots`). Nothing in it
 * touches the session→canvas index.
 *
 * `forgetSessionForCanvas` fires from the same handler but is not modelled
 * here: it clears `spawnInfo` in `canvas-session-link`, not canvas-store state,
 * so it is out of scope for a store-level test.
 */
function tearDownForSwitch(): void {
  store.revokeCanvasUatRoots(SID)
}

/** What the respawn under the SAME id then does. */
function respawnAfterSwitch(): void {
  expect(store.registerCanvasUatRoot(SID, project)).toBe(true)
}

beforeEach(() => {
  store._resetCanvasStoreForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
  project = tmp('ccc-acct-proj-')
  store.setCanvasSessionInfoResolver(() => ({ cwd: project, conversationUuid: CONV }))
})

afterAll(() => {
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  try { fs.rmSync(getResourcesDirectory(), { recursive: true, force: true }) } catch { /* best effort */ }
})

describe('a tile that switches account keeps the canvas it drew', () => {
  it('still owns its canvas across the teardown and respawn', () => {
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>mine</p>' })
    expect(store.getCanvasStateForSession(SID)?.canvasId).toBe(canvasId)

    tearDownForSwitch()
    // The binding is index state, not root state: it survives the teardown.
    expect(store.getCanvasStateForSession(SID)?.canvasId).toBe(canvasId)

    respawnAfterSwitch()
    expect(store.getCanvasStateForSession(SID)?.canvasId).toBe(canvasId)
  })

  it('renders the NEXT version onto the same canvas, not a parallel one', () => {
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>one</p>' })
    tearDownForSwitch()
    respawnAfterSwitch()

    // The "repush to canvas" failure, in its account-switch shape: a second v1
    // on a second canvas instead of v2 on this one.
    expect(store.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>two</p>' }))
      .toEqual({ canvasId, versionId: 'v2', superseded: ['v1'] })
  })

  it('is not offered its own canvas back as a reclaim candidate', () => {
    store.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>mine</p>' })
    tearDownForSwitch()
    respawnAfterSwitch()

    // NOT a binding assertion, and labelled so rather than left to look like
    // one: `isReclaimCandidate` excludes own-session records independently of
    // `sessionIndex`, so this stays green under the `sessionIndex.delete`
    // mutation the other three tests are pinned by. It is here because
    // offering the user their own live canvas to "reclaim" is the visible
    // symptom of the ADR-017 lockout, not because it guards the index.
    expect(store.listOrphanCandidateCanvases(SID, { isSessionCurrent: () => true })).toEqual([])
  })
})

describe('the account decides nothing (ADR-017), and cannot start deciding by accident', () => {
  it('a pre-ADR-017 record carrying a profileId still loads, and the field does not survive the read', () => {
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>legacy</p>' })
    const file = path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json')
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    delete record.mac

    // Exactly what an older build wrote: the same record plus an account stamp.
    const legacy = { ...record, profileId: 'profile-from-the-old-account' }
    fs.writeFileSync(file, JSON.stringify({ ...legacy, mac: store._canvasRecordMacForTest(legacy as never) }))
    store._resetCanvasStoreForTest()

    // It loads and it is still this session's canvas…
    expect(store.getCanvasStateForSession(SID)?.canvasId).toBe(canvasId)
    // …and the retired field is gone the next time the record is written, so
    // nothing downstream can quietly start consulting it again.
    store.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>again</p>' })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).not.toHaveProperty('profileId')
  })

  /**
   * Retitled: the record here carries NO stamp, because this build never writes
   * `profileId` at all, so "whatever stamp it carries" was not what was being
   * tested. The stamp-mismatch shape is in fact unreachable now — `sanitizeRecord`
   * strips the field at read, so no in-memory record can carry a foreign one —
   * which makes "the strip must keep happening" the honest pin, and that is
   * covered more strongly in `canvas-adoption.test.ts` ("does not carry an
   * unknown or retired field back out of a record", which plants `profileId`
   * AND `hostileExtra`). What is left worth asserting here is the fast path
   * itself.
   */
  it('re-opening your own canvas by id is an allowed fast path, not an adoption', () => {
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>mine</p>' })
    store._resetCanvasStoreForTest()

    expect(store.adoptCanvasForSession(SID, canvasId, { isSessionCurrent: () => false }))
      .toEqual({ canvasId, activeVersionId: 'v1' })
  })

  it('and none of that loosens the guard that stops ANOTHER session taking it', () => {
    // The floor ADR-017 explicitly leaves standing: a canvas whose owner might
    // still come back is never taken, and a directory match never moves one.
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>mine</p>' })
    store._resetCanvasStoreForTest()

    expect(store.adoptCanvasForSession(OTHER, canvasId, { isSessionCurrent: () => true })).toBeNull()
    expect(store.listOrphanCandidateCanvases(OTHER, { isSessionCurrent: () => true })).toEqual([])
  })
})

describe('what the switch DOES cost, so the boundary is not overstated', () => {
  it('nothing is servable until the respawn re-registers a root', () => {
    const dist = tmp('ccc-acct-dist-')
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><p>app</p>')
    expect(store.registerCanvasUatRoot(SID, dist)).toBe(true)
    const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: dist })
    expect(store.getServableVersion(canvasId, 'v1')).not.toBeNull()

    // The PTY is gone, so the roots are revoked. Ownership is untouched; the
    // ability to READ from disk is not — the root floor still decides that.
    store.revokeCanvasUatRoots(SID)
    expect(store.getCanvasStateForSession(SID)?.canvasId).toBe(canvasId)
    expect(store.getServableVersion(canvasId, 'v1')).toBeNull()

    // …and comes back when the respawn registers the root again.
    expect(store.registerCanvasUatRoot(SID, dist)).toBe(true)
    expect(store.getServableVersion(canvasId, 'v1')).not.toBeNull()
  })
})
