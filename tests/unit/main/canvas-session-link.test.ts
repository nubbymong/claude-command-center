// THE OWNERSHIP LEASE, at the seam that decides it (M4).
//
// canvas-session-link answers "is this session live", and everything the user
// can do to somebody else's canvas hangs off that answer: what the front page
// offers to resume, what the resume actually takes, and what a delete or a
// dismiss is allowed to destroy. It was imported by no test at all before
// 2026-08-15, so the whole floor under a one-click transfer of the user's
// private review notes was uncovered. Three defects it had then:
//
//   - a canvas was offered as "an earlier session" WHILE ITS OWN TILE WAS
//     OPEN. The saved-tile oracle answers from a file that exists only between
//     a graceful Save & Close and the next restore, so during a normal run it
//     returned "nobody is open" and a tile whose PTY merely exited looked gone;
//   - the list was uncapped;
//   - the displayed cwd carried whatever characters the path had, bidi
//     overrides included.
//
// M4 REPLACED THE SAVED-TILE BRANCH, deliberately, and the tests that pinned it
// are rewritten below rather than deleted: it answered a different question —
// "did this session exist when the app was last closed" — and a closed app's
// tiles cannot review anything, so treating them as live left every canvas from
// a graceful Save & Close untouchable for the rest of time. That is the exact
// stranding the resume path exists to end. The lease is liveness NOW.
//
// Everything here drives the real module against a real temp resources dir;
// only the ambient lookups it makes (PTY registry, transcript binder, account
// profiles) are stubbed, because those ARE the ambient state.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const h = vi.hoisted(() => ({
  livePtySessions: new Set<string>(),
  profiles: [] as Array<{ id: string; name: string }>,
}))

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-session-link-'))
  return { getResourcesDirectory: () => dir }
})
vi.mock('../../../src/main/session-registry', () => ({
  getSessionMeta: (id: string) => (h.livePtySessions.has(id) ? { id } : undefined),
}))
vi.mock('../../../src/main/logging/logging-service', () => ({ getTranscriptBinder: () => null }))

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const accountProfiles = await import('../../../src/main/account-profiles')
vi.spyOn(accountProfiles, 'listProfiles').mockImplementation(() => h.profiles as never)

const store = await import('../../../src/main/canvas/canvas-store')
const reviews = await import('../../../src/main/canvas/canvas-review-store')
const link = await import('../../../src/main/canvas/canvas-session-link')

const OWNER = 'aaaa1111aaaa1111aaaa1111'
const ASKER = 'bbbb2222bbbb2222bbbb2222'
const THIRD = 'cccc3333cccc3333cccc3333'
const CONV = '8c25bfdc-57d3-4894-8f4f-e234fb583791'
const CONV_2 = '59596c8b-1270-489b-8970-dcbc51a33e47'
const PROJECT = 'C:\\work\\proj'

/** Spawn a session, render one design version as it, and hand back the canvas. */
function renderAs(sessionId: string, cwd: string, conversationUuid?: string, title?: string): string {
  link.noteSessionSpawnForCanvas(sessionId, { cwd, resumeUuid: conversationUuid })
  return store.renderVersion(sessionId, {
    mode: 'design',
    html: '<!doctype html><p>x</p>',
    ...(title ? { title } : {}),
  }).canvasId
}

/** "The app restarted": in-memory state gone, disk records intact. */
function restart(): void {
  store._resetCanvasStoreForTest()
  reviews._resetCanvasReviewStoreForTest()
  link._resetCanvasSessionLinkForTest()
  link.installCanvasSessionLink()
}

beforeEach(() => {
  h.livePtySessions.clear()
  h.profiles = []
  store._resetCanvasStoreForTest()
  reviews._resetCanvasReviewStoreForTest()
  link._resetCanvasSessionLinkForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
  link.installCanvasSessionLink()
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort temp cleanup */
  }
})

describe('a canvas whose own tile is still open', () => {
  it('is not offered to another session, and cannot be taken by naming its id', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV)
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })

    // The owner has no live PTY (it exited) — the state in which the old oracle
    // said "nobody is open" and offered the user their own on-screen work.
    const openTiles = [OWNER, ASKER]
    expect(link.listResumableRows(ASKER, openTiles)).toEqual([])
    expect(link.resumeCanvasFromSession(ASKER, canvasId, OWNER, openTiles)).toEqual({
      ok: false,
      reason: 'owner-live',
    })
    // ...and it is still the owner's.
    expect(store.getCanvasStateForSession(OWNER)?.canvasId).toBe(canvasId)
  })

  it('IS offered once that tile is closed', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV)
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })

    const offered = link.listResumableRows(ASKER, [ASKER])
    expect(offered.map((c) => c.canvasId)).toEqual([canvasId])
    expect(offered[0].expectedOwnerSessionId).toBe(OWNER)
    expect(link.resumeCanvasFromSession(ASKER, canvasId, OWNER, [ASKER])).toEqual({ ok: true, canvasId })
    expect(store.getCanvasStateForSession(ASKER)?.canvasId).toBe(canvasId)
  })

  it('is still protected by a live PTY when the renderer sends no hint at all', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV)
    restart()
    h.livePtySessions.add(OWNER)
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })
    expect(link.listResumableRows(ASKER)).toEqual([])
    expect(link.resumeCanvasFromSession(ASKER, canvasId, OWNER)).toEqual({ ok: false, reason: 'owner-live' })
  })
})

describe('a closed app leaves work RESUMABLE, not stranded (the M4 change)', () => {
  // MIGRATED from "the saved-tile half of the currency oracle". Those three
  // tests pinned the branch that read session-state.json and treated a saved
  // tile as still current. It is gone on purpose, so what is pinned now is the
  // behaviour that replaced it — and the pin still has teeth, because the two
  // branches that remain must keep refusing.

  it('offers a canvas whose owner exists only as a SAVED tile — nothing is live', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV)
    restart()
    // Graceful Save & Close: no PTY anywhere, no tile on screen. Under the old
    // oracle this canvas was untouchable forever; under the lease it is exactly
    // what "ownerless in flight" means.
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })
    expect(link.listResumableRows(ASKER, []).map((r) => r.canvasId)).toEqual([canvasId])
    expect(link.resumeCanvasFromSession(ASKER, canvasId, OWNER, [])).toEqual({ ok: true, canvasId })
  })

  it('but a RESTORED tile is live again the moment the renderer says so', () => {
    // The restore window, and why the hint is admissible: it can only ADD live
    // sessions, and live means untouchable.
    const canvasId = renderAs(OWNER, PROJECT, CONV)
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })
    expect(link.listResumableRows(ASKER, [OWNER])).toEqual([])
    expect(link.resumeCanvasFromSession(ASKER, canvasId, OWNER, [OWNER])).toEqual({
      ok: false,
      reason: 'owner-live',
    })
  })

  it('isSessionLive answers from the PTY registry and the tile hint, and nothing else', () => {
    expect(link.isSessionLive(OWNER, new Set())).toBe(false)
    expect(link.isSessionLive(OWNER, new Set([OWNER]))).toBe(true)
    h.livePtySessions.add(OWNER)
    expect(link.isSessionLive(OWNER, new Set())).toBe(true)
  })
})

describe('what the row is given to tell candidates apart', () => {
  it('falls back to the conversation short id when nothing else names the work', () => {
    const first = renderAs(OWNER, PROJECT, CONV)
    const second = renderAs(THIRD, PROJECT, CONV_2)
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })

    const byId = new Map(link.listResumableRows(ASKER, [ASKER]).map((c) => [c.canvasId, c]))
    expect(byId.get(first)?.title).toBe(`conversation ${CONV.slice(0, 8)}`)
    expect(byId.get(second)?.title).toBe(`conversation ${CONV_2.slice(0, 8)}`)
  })

  it('prefers the SUBJECT when the agent named one', () => {
    renderAs(OWNER, PROJECT, CONV, 'Checkout flow')
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })
    expect(link.listResumableRows(ASKER, [ASKER])[0].title).toBe('Checkout flow')
  })

  it('scopes to the project by RELEVANCE, keeping an unstamped canvas rather than hiding it', () => {
    const here = renderAs(OWNER, PROJECT, CONV, 'here')
    const elsewhere = renderAs(THIRD, 'C:\\work\\other', CONV_2, 'elsewhere')
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })

    const ids = link.listResumableRows(ASKER, [ASKER]).map((r) => r.canvasId)
    expect(ids).toContain(here)
    expect(ids).not.toContain(elsewhere)
  })

  it('carries the live note count so the card can say what is at stake', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV, 'with notes')
    reviews.upsertAnnotation(OWNER, { scope: 'general', note: 'the header wraps', versionId: 'v1' })
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })

    const [row] = link.listResumableRows(ASKER, [ASKER])
    expect(row.canvasId).toBe(canvasId)
    expect(row.noteCount).toBe(1)
  })
})

describe('the candidate list is bounded', () => {
  it('never hands the pane more than a dozen canvases to mis-click', () => {
    for (let i = 0; i < 20; i++) {
      renderAs(`dead${String(i).padStart(20, '0')}`, PROJECT, CONV, `subject ${i}`)
    }
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })

    const offered = link.listResumableRows(ASKER, [ASKER])
    expect(offered.length).toBeGreaterThan(0)
    expect(offered.length).toBeLessThanOrEqual(12)
  })
})

describe('dismiss and the shared mutation guard', () => {
  it('lets the OWNER discard its own canvas, files and all', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV, 'mine')
    expect(link.dismissCanvasForSession(OWNER, canvasId, [OWNER])).toEqual({ ok: true })
    expect(fs.existsSync(path.join(getResourcesDirectory(), 'canvas', canvasId))).toBe(false)
    expect(store.getCanvasStateById(canvasId)).toBeNull()
  })

  it('lets a SAME-PROJECT session discard an ownerless canvas', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV, 'stranded')
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })
    expect(link.dismissCanvasForSession(ASKER, canvasId, [ASKER])).toEqual({ ok: true })
    expect(store.getCanvasStateById(canvasId)).toBeNull()
  })

  it('REFUSES while another session is live-owner — the sharpest thing a stranger could do', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV, 'in flight')
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })
    expect(link.dismissCanvasForSession(ASKER, canvasId, [OWNER, ASKER])).toEqual({
      ok: false,
      reason: 'owner-live',
    })
    expect(store.getCanvasStateById(canvasId)).not.toBeNull()
  })

  it('REFUSES a different project, even when the canvas is ownerless', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV, 'not yours')
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: 'C:\\work\\somewhere-else' })
    expect(link.dismissCanvasForSession(ASKER, canvasId, [ASKER])).toEqual({
      ok: false,
      reason: 'not-eligible',
    })
    expect(store.getCanvasStateById(canvasId)).not.toBeNull()
  })

  it('REFUSES a caller whose own project is unknown — fail closed', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV, 'not yours either')
    restart()
    // No spawn record for ASKER at all: we cannot place it in a project, so it
    // is placed in none.
    expect(link.canvasMutationAllowed(ASKER, canvasId, [ASKER])).toEqual({
      ok: false,
      reason: 'not-eligible',
    })
  })

  it('REFUSES an unknown canvas id outright', () => {
    expect(link.canvasMutationAllowed(ASKER, 'deadbeefdeadbeefdeadbeef', [])).toEqual({
      ok: false,
      reason: 'not-eligible',
    })
  })
})

describe('the audit labels the spawn record carries', () => {
  it('stamps the tile label and the ACCOUNT display name onto the canvas it renders', () => {
    h.profiles = [{ id: 'profile-work', name: 'Work \u00b7 nick' }]
    link.noteSessionSpawnForCanvas(OWNER, {
      cwd: PROJECT,
      resumeUuid: CONV,
      configLabel: 'Checkout tile',
      configId: 'cfg-checkout',
      profileId: 'profile-work',
    })
    const { canvasId } = store.renderVersion(OWNER, { mode: 'design', html: '<!doctype html><p>x</p>' })

    const state = store.getCanvasStateById(canvasId)!
    expect(state.configId).toBe('cfg-checkout')
    expect(state.createdBy).toMatchObject({ sessionId: OWNER, sessionLabel: 'Checkout tile', account: 'Work \u00b7 nick' })
    expect(state.versions[0].renderedBy).toMatchObject({ sessionId: OWNER, account: 'Work \u00b7 nick' })
  })

  it('stamps NO account for a single-account session — there is no per-session display name', () => {
    // Main holds a per-session account identity, but the only DISPLAY-NAME form
    // of it is the profile's name, and a single-account session has no profile.
    // Its email comes from the GLOBAL ~/.claude.json, which is not a
    // per-session identity — inventing one for every row is exactly what
    // ADR-017 removed.
    link.noteSessionSpawnForCanvas(OWNER, { cwd: PROJECT, configLabel: 'Plain tile' })
    const { canvasId } = store.renderVersion(OWNER, { mode: 'design', html: '<!doctype html><p>x</p>' })
    expect(store.getCanvasStateById(canvasId)!.createdBy).toEqual({
      sessionId: OWNER,
      sessionLabel: 'Plain tile',
      at: expect.any(String),
    })
  })

  it("treats the renderer's 'default' config label as ABSENT, not as a name", () => {
    link.noteSessionSpawnForCanvas(OWNER, { cwd: PROJECT, configLabel: 'default' })
    const { canvasId } = store.renderVersion(OWNER, { mode: 'design', html: '<!doctype html><p>x</p>' })
    expect(store.getCanvasStateById(canvasId)!.createdBy?.sessionLabel).toBeUndefined()
    expect(link.canvasConfigNameForSession(OWNER)).toBeUndefined()
  })

  it('refuses a config id that is not a config id shape', () => {
    link.noteSessionSpawnForCanvas(OWNER, { cwd: PROJECT, configId: '../../etc/passwd' })
    const { canvasId } = store.renderVersion(OWNER, { mode: 'design', html: '<!doctype html><p>x</p>' })
    // Refused at the spawn record, so nothing of that shape ever reaches the
    // durable record — the id is a lookup key into the user's own configs.json
    // and a value that is not a config id has no business being stored.
    expect(store.getCanvasStateById(canvasId)!.configId).toBeUndefined()
  })

  it('strips format controls out of a label before it is ever stored', () => {
    // These land on the Library's mono audit line; a bidi override in one makes
    // the rest of the line read backwards. Built from code points — a literal
    // control character never goes into a tracked file.
    const RLO = String.fromCodePoint(0x202e)
    const NEL = String.fromCodePoint(0x0085)
    h.profiles = [{ id: 'profile-x', name: `Work${RLO}${NEL}acct` }]
    link.noteSessionSpawnForCanvas(OWNER, {
      cwd: PROJECT,
      configLabel: `Tile${RLO}name`,
      profileId: 'profile-x',
    })
    const { canvasId } = store.renderVersion(OWNER, { mode: 'design', html: '<!doctype html><p>x</p>' })
    const stamp = store.getCanvasStateById(canvasId)!.createdBy!
    expect(stamp.sessionLabel).toBe('Tilename')
    expect(stamp.account).toBe('Workacct')
  })
})
