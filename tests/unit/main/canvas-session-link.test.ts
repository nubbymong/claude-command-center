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
  profiles: [] as Array<{ id: string; name: string }>,
}))

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-session-link-'))
  return { getResourcesDirectory: () => dir }
})
// session-registry is NOT mocked. It is a plain in-memory map with no
// dependencies, and the defect this file now pins lives in its SHAPE: two
// unrelated subsystems write it, and only one of them is about a PTY.
vi.mock('../../../src/main/logging/logging-service', () => ({ getTranscriptBinder: () => null }))

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const registry = await import('../../../src/main/session-registry')
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

/** A session with a RUNNING PTY, exactly as `pty-manager` records one. */
function ptySpawned(sessionId: string): void {
  registry.markPtySessionAlive(sessionId)
  registry.updateSessionMeta({ id: sessionId, label: sessionId, cwd: PROJECT, provider: 'claude' })
}

/** ...and its exit, exactly as `pty-manager` records that. */
function ptyExited(sessionId: string): void {
  registry.markPtySessionGone(sessionId)
  registry.clearSessionMeta(sessionId)
}

beforeEach(() => {
  for (const sid of [OWNER, ASKER, THIRD]) ptyExited(sid)
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

    // The owner's TILE is on screen. That is a display fact, so the row is not
    // OFFERED — but it is the PTY that protects, and this owner has none, so
    // the canvas is ownerless by the model and a resume by id succeeds.
    const openTiles = [OWNER, ASKER]
    expect(link.listResumableRows(ASKER, openTiles)).toEqual([])
    expect(link.resumeCanvasFromSession(ASKER, canvasId, OWNER, openTiles)).toEqual({ ok: true, canvasId })
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
    ptySpawned(OWNER)
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

  it('but a RESTORED tile is protected again the moment its PTY is running', () => {
    // The restore window closes when the PTY comes back, not when the renderer
    // says the tile is on screen — the hint permits and protects nothing (see
    // the liveness-split block below).
    const canvasId = renderAs(OWNER, PROJECT, CONV)
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })
    // Tile on screen, PTY still dead: not offered (display), but resumable.
    expect(link.listResumableRows(ASKER, [OWNER])).toEqual([])
    ptySpawned(OWNER)
    expect(link.listResumableRows(ASKER, [])).toEqual([])
    expect(link.resumeCanvasFromSession(ASKER, canvasId, OWNER, [])).toEqual({
      ok: false,
      reason: 'owner-live',
    })
  })

  it('isSessionLive answers from the PTY LIFECYCLE and nothing else', () => {
    // The security gate reads ONE signal, and it is the one no caller can
    // shape and no unrelated subsystem writes. See the split below.
    expect(link.isSessionLive(OWNER)).toBe(false)
    ptySpawned(OWNER)
    expect(link.isSessionLive(OWNER)).toBe(true)
    ptyExited(OWNER)
    expect(link.isSessionLive(OWNER)).toBe(false)
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
    // LIVE means a running PTY. Naming the owner in the hint would not protect
    // it, and omitting it would not expose it — the hint decides nothing here.
    ptySpawned(OWNER)
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })
    expect(link.dismissCanvasForSession(ASKER, canvasId, [ASKER])).toEqual({
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

describe('THE LIVENESS SPLIT: the PTY protects, the tile hint only decorates', () => {
  // `openTileSessionIds` is a per-call value the CALLER chooses, and after M4 it
  // reached three destructive decisions: whether a peer may resume another
  // session's canvas, whether it may dismiss/delete it, and whether it may see
  // it at all. A same-project peer had only to OMIT the owner from its own hint
  // to make a live owner look dead — no forgery required, just leaving a field
  // out of a request it composes.
  //
  // So the gate reads the PTY registry and nothing else: PTY-alive = protected,
  // unforgeably; PTY-dead = ownerless by the M4 model = resumable. The hint
  // survives as a DISPLAY filter only — do not OFFER a resume row for a corpse
  // tile the user can still see on their own screen — and can no longer permit
  // anything.

  it('protects a PTY-ALIVE owner even when the caller omits it from the hint', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV, 'live work')
    restart()
    ptySpawned(OWNER)
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })

    // The attacker's request: a hint naming only itself.
    expect(link.listResumableRows(ASKER, [ASKER])).toEqual([])
    expect(link.resumeCanvasFromSession(ASKER, canvasId, OWNER, [ASKER])).toEqual({
      ok: false,
      reason: 'owner-live',
    })
    expect(link.dismissCanvasForSession(ASKER, canvasId, [ASKER])).toEqual({ ok: false, reason: 'owner-live' })
    expect(link.canvasArtifactMutationAllowed(ASKER, canvasId, [ASKER])).toEqual({
      ok: false,
      reason: 'owner-live',
    })
    expect(store.getCanvasStateById(canvasId)?.sessionId).toBe(OWNER)
  })

  it('gives the same answer with NO hint at all — omitting it changes nothing', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV, 'live work')
    restart()
    ptySpawned(OWNER)
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })
    expect(link.resumeCanvasFromSession(ASKER, canvasId, OWNER)).toEqual({ ok: false, reason: 'owner-live' })
    expect(link.dismissCanvasForSession(ASKER, canvasId)).toEqual({ ok: false, reason: 'owner-live' })
  })

  it('and a padded hint cannot protect a PTY-DEAD owner either — the hint permits nothing', () => {
    // The mirror of the attack: the hint may not be used to make a dead owner
    // look alive and freeze a canvas out of reach either. Only the PTY decides.
    const canvasId = renderAs(OWNER, PROJECT, CONV, 'stranded')
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })
    expect(link.resumeCanvasFromSession(ASKER, canvasId, OWNER, [OWNER, ASKER])).toEqual({ ok: true, canvasId })
  })

  it('still declines to OFFER a row whose tile the user can see — display only', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV, 'corpse tile')
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })
    expect(link.listResumableRows(ASKER, [OWNER, ASKER])).toEqual([])
    expect(link.listResumableRows(ASKER, [ASKER]).map((r) => r.canvasId)).toEqual([canvasId])
  })
})

describe('THE SECOND FACTOR: same project AND same config to touch a peer\u2019s canvas', () => {
  // `sameProjectDir` case-folds on `process.platform`, so on a case-SENSITIVE
  // NTFS directory or APFS volume two genuinely different projects compare
  // equal and a peer in `foo` could dismiss or resume a victim's canvas rooted
  // at `Foo`. The record has stamped a `configId` since M4 and the session's
  // reaches main at spawn, so the destructive cross-session gate requires both.

  const FOO = 'C:\\work\\Foo'
  const foo = 'C:\\work\\foo'

  function victimAt(dir: string, configId?: string): string {
    link.noteSessionSpawnForCanvas(OWNER, { cwd: dir, ...(configId ? { configId } : {}) })
    return store.renderVersion(OWNER, { mode: 'design', title: 'Victim work', html: '<!doctype html><p>v</p>' }).canvasId
  }

  it('refuses a case-only directory match when the CONFIGS differ', () => {
    const canvasId = victimAt(FOO, 'cfg-victim')
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: foo, configId: 'cfg-attacker' })

    expect(link.canvasMutationAllowed(ASKER, canvasId, [ASKER])).toEqual({ ok: false, reason: 'not-eligible' })
    expect(link.dismissCanvasForSession(ASKER, canvasId, [ASKER])).toEqual({ ok: false, reason: 'not-eligible' })
    expect(link.resumeCanvasFromSession(ASKER, canvasId, OWNER, [ASKER])).toEqual({ ok: false, reason: 'gone' })
    expect(link.listResumableRows(ASKER, [ASKER])).toEqual([])
    expect(store.getCanvasStateById(canvasId)).not.toBeNull()
  })

  it('allows it when both factors agree — the residual a case-only filesystem keeps', () => {
    // STATED, not hidden: on a case-sensitive volume two real projects whose
    // paths differ only by case AND whose sessions run the SAME config still
    // match. Both factors have to collide, which is no longer something a peer
    // can arrange by choosing where to sit.
    const canvasId = victimAt(FOO, 'cfg-shared')
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: foo, configId: 'cfg-shared' })
    expect(link.canvasMutationAllowed(ASKER, canvasId, [ASKER])).toEqual({ ok: true })
  })

  it('falls back to the project alone when either side has no config id', () => {
    const canvasId = victimAt(PROJECT)
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT, configId: 'cfg-attacker' })
    expect(link.canvasMutationAllowed(ASKER, canvasId, [ASKER])).toEqual({ ok: true })
  })

  it('gates RESUME on the workspace too — the store never checked it at all', () => {
    // The resume path took an id and an owner token and no project term
    // whatever, so a peer that learned a canvas id could take work from a
    // project it has never opened. The list and the action now share one rule.
    const canvasId = victimAt('C:\\work\\somewhere-else', 'cfg-victim')
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT, configId: 'cfg-attacker' })
    expect(link.listResumableRows(ASKER, [ASKER])).toEqual([])
    expect(link.resumeCanvasFromSession(ASKER, canvasId, OWNER, [ASKER])).toEqual({ ok: false, reason: 'gone' })
    expect(store.getCanvasStateById(canvasId)?.sessionId).toBe(OWNER)
  })
})

describe('LIVENESS IS THE PTY LIFECYCLE, not "somebody wrote session metadata"', () => {
  // The round-1 fix moved the gate onto `getSessionMeta` because a PTY is the
  // one thing a caller cannot fake. But `session-registry` is a shared metadata
  // map with TWO writers, and only one of them is about a PTY:
  // `github-handlers.bindGitHubMeta` patches `{ id, repo, branch }` for every
  // saved session with a GitHub integration, at handler-registration time,
  // whether or not that session has ever run.
  //
  // So an id that never spawned read LIVE for the rest of the run, and its
  // canvas was stranded three ways at once: un-resumable, un-dismissable, and
  // INVISIBLE in the Library (the same oracle scopes the privacy rule). Nothing
  // reversed it short of a restart. The "unforgeable PTY-only" invariant the
  // whole M4 gate leans on was simply not true of that signal.

  it('a GitHub-only metadata write does NOT make a canvas look live', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV, 'stranded')
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })

    // Exactly what github-handlers does for a saved session, no PTY anywhere.
    registry.updateSessionMeta({ id: OWNER, repo: 'me/app', branch: 'main' })
    expect(registry.getSessionMeta(OWNER)).toBeDefined() // the old oracle said LIVE

    expect(link.isSessionLive(OWNER)).toBe(false)
    expect(link.listResumableRows(ASKER, [ASKER]).map((r) => r.canvasId)).toEqual([canvasId])
    expect(link.canvasMutationAllowed(ASKER, canvasId, [ASKER])).toEqual({ ok: true })
    expect(link.resumeCanvasFromSession(ASKER, canvasId, OWNER, [ASKER])).toEqual({ ok: true, canvasId })
  })

  it('and does not hide it from the Library either — the same oracle scopes both', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV, 'stranded')
    restart()
    registry.updateSessionMeta({ id: OWNER, repo: 'me/app', branch: 'main' })
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })

    const ids = store
      .listAllCanvases([], undefined, ASKER, link.canvasLivenessQuery().isSessionLive)
      .map((e) => e.canvasId)
    expect(ids).toContain(canvasId)
  })

  it('a real PTY spawn DOES, and its cleanup reverts it', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV, 'live work')
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })

    ptySpawned(OWNER)
    expect(link.isSessionLive(OWNER)).toBe(true)
    expect(link.canvasMutationAllowed(ASKER, canvasId, [ASKER])).toEqual({ ok: false, reason: 'owner-live' })

    ptyExited(OWNER)
    expect(link.isSessionLive(OWNER)).toBe(false)
    expect(link.canvasMutationAllowed(ASKER, canvasId, [ASKER])).toEqual({ ok: true })
  })

  it('a GitHub write AFTER the PTY exits does not resurrect the lease', () => {
    // The compounding case: cleanup clears the metadata entry, github re-binds,
    // and under the metadata oracle the canvas locked itself again.
    const canvasId = renderAs(OWNER, PROJECT, CONV, 'stranded')
    restart()
    ptySpawned(OWNER)
    ptyExited(OWNER)
    registry.updateSessionMeta({ id: OWNER, repo: 'me/app', branch: 'main' })
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })

    expect(link.isSessionLive(OWNER)).toBe(false)
    expect(link.dismissCanvasForSession(ASKER, canvasId, [ASKER])).toEqual({ ok: true })
  })
})

describe('THE FALLBACK when a configId is unknown: exact-case project match', () => {
  // The second factor only bites when BOTH sides carry a configId, and that is
  // the uncommon case: every pre-M4 canvas has none, and so does every session
  // not launched from a named saved config. Falling back to the case-FOLDED
  // project compare reopened the whole hole for exactly the common and legacy
  // rows, on the destructive paths.
  //
  // So when a configId is missing the project must match EXACTLY, case
  // included. Read-only surfaces keep the forgiving compare — being unable to
  // SEE your own work is the bug that rule exists to avoid; being unable to
  // DESTROY somebody else's is the right side to fail on.

  const FOO = 'C:\\work\\Foo'
  const foo = 'C:\\work\\foo'

  function victimAt(dir: string): string {
    link.noteSessionSpawnForCanvas(OWNER, { cwd: dir })
    return store.renderVersion(OWNER, { mode: 'design', title: 'Legacy work', html: '<!doctype html><p>v</p>' }).canvasId
  }

  it('REFUSES a case-only project match when NEITHER side has a config id', () => {
    const canvasId = victimAt(FOO)
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: foo })

    expect(link.canvasMutationAllowed(ASKER, canvasId, [ASKER])).toEqual({ ok: false, reason: 'not-eligible' })
    expect(link.dismissCanvasForSession(ASKER, canvasId, [ASKER])).toEqual({ ok: false, reason: 'not-eligible' })
    expect(link.resumeCanvasFromSession(ASKER, canvasId, OWNER, [ASKER])).toEqual({ ok: false, reason: 'gone' })
    expect(link.listResumableRows(ASKER, [ASKER])).toEqual([])
    expect(store.getCanvasStateById(canvasId)).not.toBeNull()
  })

  it('REFUSES it when only ONE side has a config id', () => {
    const canvasId = victimAt(FOO)
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: foo, configId: 'cfg-attacker' })
    expect(link.canvasMutationAllowed(ASKER, canvasId, [ASKER])).toEqual({ ok: false, reason: 'not-eligible' })
  })

  it('ALLOWS a genuine same-directory peer with no config id either side', () => {
    const canvasId = victimAt(FOO)
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: FOO })
    expect(link.canvasMutationAllowed(ASKER, canvasId, [ASKER])).toEqual({ ok: true })
    expect(link.listResumableRows(ASKER, [ASKER]).map((r) => r.canvasId)).toEqual([canvasId])
  })

  it('still tolerates a RESPELLING that is not a case difference', () => {
    // The reason the fallback is not raw string equality: one tile's cwd key
    // legitimately alternates spelling across its life (a trailing separator, a
    // relaunch reading it out of the transcript). Only CASE is treated as a
    // real difference.
    const canvasId = victimAt(FOO)
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: FOO + '\\' })
    expect(link.canvasMutationAllowed(ASKER, canvasId, [ASKER])).toEqual({ ok: true })
  })

  it('keeps the FORGIVING compare on the read-only surfaces', () => {
    // The Library must not hide a canvas over a case difference: not being able
    // to find your own work is the failure this scope exists to avoid, and
    // listing one grants nothing.
    const canvasId = victimAt(FOO)
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: foo })
    const ids = store
      .listAllCanvases([], foo, ASKER, link.canvasLivenessQuery().isSessionLive)
      .map((e) => e.canvasId)
    expect(ids).toContain(canvasId)
  })
})
