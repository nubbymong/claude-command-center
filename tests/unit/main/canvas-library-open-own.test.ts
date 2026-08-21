/**
 * The canvas LIBRARY must be able to open a canvas the asking session made.
 *
 * Reported 2026-08-20: every row in the library refused with "That canvas could
 * not be opened here — it may belong to a session that is still running", on a
 * list showing the user's OWN three canvases from the session they were sitting
 * in.
 *
 * Cause: `adoptCanvasForSession` bailed on `sessionIndex.has(sessionId)` before
 * looking at which canvas was asked for. A session owns ONE active canvas but
 * may have authored many — rendering a new subject files the previous one and
 * repoints the index — so once a session had rendered anything, every "Open
 * here" was refused, including for canvases it had made itself. That is every
 * session that has a library worth opening.
 *
 * The guard itself is right and stays: it stops a session that already holds a
 * canvas from taking someone ELSE'S. It just has to run after the "this is
 * already mine" case, which transfers no ownership at all.
 *
 * Also covers the library's project scoping: the list is per-project, because a
 * library mixing every project's mockups is unreadable. Scoping is RELEVANCE,
 * never authorization — a record with no cwd, or a caller with no cwd, still
 * appears rather than being hidden.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-lib-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')

const MINE = 'aaaa1111aaaa1111aaaa1111'
const THEIRS = 'bbbb2222bbbb2222bbbb2222'

const PROJECT = path.join(getResourcesDirectory(), 'project')
const OTHER = path.join(getResourcesDirectory(), 'elsewhere')

/** Somebody else's live session — the case the guard exists for. */
const allCurrent = () => true

// A canvas holds one SUBJECT: the same title appends a version, a different
// title files the current canvas and starts a fresh one. That is exactly how a
// session ends up with several, which is what the library is for — so every
// render here names its own subject.
function renderAs(sessionId: string, cwd: string | undefined, title: string, profileId?: string) {
  store.setCanvasSessionInfoResolver(() => ({ cwd, conversationUuid: undefined, profileId }))
  return store.renderVersion(sessionId, { mode: 'design', title, html: `<!doctype html><p>${title}</p>` })
}

beforeEach(() => {
  store._resetCanvasStoreForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('opening a canvas this session already owns', () => {
  it('succeeds for an earlier canvas after a new subject filed it', () => {
    // Three subjects in one session, exactly like a working session: each new
    // title files the last and the index points at the newest.
    const first = renderAs(MINE, PROJECT, 'one')
    const second = renderAs(MINE, PROJECT, 'two')
    expect(second.canvasId).not.toBe(first.canvasId)

    // Going back to the first is a switch between the session's OWN canvases.
    const reopened = store.adoptCanvasForSession(MINE, first.canvasId, { isSessionCurrent: allCurrent })
    expect(reopened).not.toBeNull()
    expect(reopened?.canvasId).toBe(first.canvasId)

    // ...and it is now the active one for that session.
    expect(store.getCanvasStateForSession(MINE)?.canvasId).toBe(first.canvasId)
  })

  it('does not change the record owner, because there is nothing to transfer', () => {
    const first = renderAs(MINE, PROJECT, 'one')
    renderAs(MINE, PROJECT, 'two')
    store.adoptCanvasForSession(MINE, first.canvasId, { isSessionCurrent: allCurrent })

    const record = JSON.parse(
      fs.readFileSync(path.join(getResourcesDirectory(), 'canvas', first.canvasId, 'canvas.json'), 'utf8'),
    )
    expect(record.sessionId).toBe(MINE)
    expect(record.cwd).toBe(PROJECT)
  })

  it('is idempotent — re-opening the ALREADY active canvas still succeeds', () => {
    const only = renderAs(MINE, PROJECT, 'one')
    const again = store.adoptCanvasForSession(MINE, only.canvasId, { isSessionCurrent: allCurrent })
    expect(again?.canvasId).toBe(only.canvasId)
  })

  it('STILL refuses another live session\'s canvas — the guard is not weakened', () => {
    const theirs = renderAs(THEIRS, PROJECT, 'theirs')
    renderAs(MINE, PROJECT, 'mine')

    // The asking session holds its own canvas AND the target belongs to a
    // session that is still current. Both reasons to refuse; it must refuse.
    const stolen = store.adoptCanvasForSession(MINE, theirs.canvasId, { isSessionCurrent: allCurrent })
    expect(stolen).toBeNull()

    const record = JSON.parse(
      fs.readFileSync(path.join(getResourcesDirectory(), 'canvas', theirs.canvasId, 'canvas.json'), 'utf8'),
    )
    expect(record.sessionId).toBe(THEIRS)
  })
})

describe('the ACCOUNT does not decide anything about a canvas (ADR-017)', () => {
  // A canvas belongs to the PROJECT it was made for. Which Claude account was
  // signed in when it was drawn is not part of its identity: a session id
  // outlives an in-tile account switch, so making the account an adoption key
  // left a tile unable to re-open the canvases it had drawn itself.
  const P1 = 'profile-one'

  it('opens a canvas drawn under a DIFFERENT account', () => {
    const first = renderAs(MINE, PROJECT, 'under account one', P1)
    renderAs(MINE, PROJECT, 'two', P1)
    const reopened = store.adoptCanvasForSession(MINE, first.canvasId, { isSessionCurrent: allCurrent })
    expect(reopened?.canvasId).toBe(first.canvasId)
    expect(store.getCanvasStateForSession(MINE)?.canvasId).toBe(first.canvasId)
  })

  it('badges it as yours in the library too, so list and action agree', () => {
    const authored = renderAs(MINE, PROJECT, 'under account one', P1)
    const row = store.listAllCanvases([], PROJECT, MINE).find((e) => e.canvasId === authored.canvasId)
    expect(row?.ownedByThisSession).toBe(true)
  })

  it('opens an UNSTAMPED legacy canvas just the same', () => {
    const legacy = renderAs(MINE, PROJECT, 'no account stamp')
    expect(store.adoptCanvasForSession(MINE, legacy.canvasId, { isSessionCurrent: allCurrent })?.canvasId)
      .toBe(legacy.canvasId)
  })

  it('mentions the account nowhere in what the library hands back', () => {
    // The stamp may still exist on records written before ADR-017. Nothing
    // reads it, and it must not leak into a row the renderer draws.
    renderAs(MINE, PROJECT, 'under account one', P1)
    for (const row of store.listAllCanvases([], PROJECT, MINE)) {
      expect(Object.keys(row)).not.toContain('profileId')
    }
  })
})

describe('the library is scoped to the project', () => {
  it('lists only canvases rendered in the given directory', () => {
    const here = renderAs(MINE, PROJECT, 'here')
    const elsewhere = renderAs(MINE, OTHER, 'elsewhere')

    const ids = store.listAllCanvases([], PROJECT).map((e) => e.canvasId)
    expect(ids).toContain(here.canvasId)
    expect(ids).not.toContain(elsewhere.canvasId)
  })

  it('lists everything when no project is given (fail-open, not fail-shut)', () => {
    const here = renderAs(MINE, PROJECT, 'here')
    const elsewhere = renderAs(MINE, OTHER, 'elsewhere')

    const ids = store.listAllCanvases([]).map((e) => e.canvasId)
    expect(ids).toEqual(expect.arrayContaining([here.canvasId, elsewhere.canvasId]))
  })

  it('keeps a canvas that has no cwd of its own rather than hiding it', () => {
    // Pre-dates the cwd stamp, or was rendered with no resolver. Hiding it would
    // make it unreachable forever, since the library is the only way back to it.
    const unstamped = renderAs(MINE, undefined, 'no cwd')
    const ids = store.listAllCanvases([], PROJECT).map((e) => e.canvasId)
    expect(ids).toContain(unstamped.canvasId)
  })
})

describe('project scope does not strand a session on a respelling', () => {
  // The record's cwd is stamped once at first render and never drifts. The
  // asking side is whatever the LATEST spawn recorded, and on the relaunch path
  // that is a different source entirely (the transcript JSONL, not the config).
  // So the two keys can differ by spelling alone, for one unchanged project.

  it('matches through a trailing separator', () => {
    const c = renderAs(MINE, PROJECT, 'trailing')
    const ids = store.listAllCanvases([], PROJECT + path.sep, THEIRS).map((e) => e.canvasId)
    expect(ids).toContain(c.canvasId)
  })

  it('matches through mixed separators', () => {
    const c = renderAs(MINE, PROJECT, 'slashes')
    const swapped = PROJECT.split(path.sep).join('/')
    const ids = store.listAllCanvases([], swapped, THEIRS).map((e) => e.canvasId)
    // On win32 path.resolve normalises the separator; elsewhere the two spellings
    // are genuinely different paths and staying strict is correct.
    if (process.platform === 'win32') expect(ids).toContain(c.canvasId)
    else expect(swapped).toBe(PROJECT)
  })

  it('matches through a case difference where the filesystem is case-insensitive', () => {
    const c = renderAs(MINE, PROJECT, 'case')
    const ids = store.listAllCanvases([], PROJECT.toUpperCase(), THEIRS).map((e) => e.canvasId)
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(ids).toContain(c.canvasId)
    } else {
      expect(ids).not.toContain(c.canvasId)
    }
  })

  it('still scopes out another project', () => {
    // The normalisation must not turn the filter off. Authored by MINE and asked
    // by THEIRS, so the own-canvas exemption is deliberately not in play here.
    const here = renderAs(MINE, PROJECT, 'here')
    const elsewhere = renderAs(MINE, OTHER, 'elsewhere')
    const ids = store.listAllCanvases([], PROJECT, THEIRS).map((e) => e.canvasId)
    expect(ids).toContain(here.canvasId)
    expect(ids).not.toContain(elsewhere.canvasId)
  })
})

describe('project scope never hides a session OWN canvas', () => {
  it('keeps every canvas the asking session authored, whatever project it asks from', () => {
    // The foreclosing case. ADR-017 says the reclaim list is the route back for
    // a canvas outside the current project; it is not — listOrphanCandidateCanvases
    // returns nothing once the session owns a canvas, and excludes its own anyway.
    // So the library is the only route and it must not drop these.
    const first = renderAs(MINE, OTHER, 'authored elsewhere')
    const active = renderAs(MINE, OTHER, 'still elsewhere')

    const ids = store.listAllCanvases([], PROJECT, MINE).map((e) => e.canvasId)
    expect(ids).toContain(first.canvasId)
    expect(ids).toContain(active.canvasId)
  })

  it('keeps the ACTIVE canvas visible after the project key respells', () => {
    // The worst version of the bug: the canvas currently on screen disappears
    // from the subject picker, which filters to ownedByThisSession || active.
    const active = renderAs(MINE, OTHER, 'the open one')
    const ids = store.listAllCanvases([], PROJECT, MINE).map((e) => e.canvasId)
    expect(ids).toContain(active.canvasId)
  })

  it('does not extend the exemption to another session', () => {
    // Own-canvas only. A different session's out-of-project canvas stays scoped
    // out, so this is a relevance fix and not a widening.
    const theirs = renderAs(THEIRS, OTHER, 'not mine')
    const ids = store.listAllCanvases([], PROJECT, MINE).map((e) => e.canvasId)
    expect(ids).not.toContain(theirs.canvasId)
  })

  it('reclaim really is closed as a route back, which is why the above matters', () => {
    // Pins the premise rather than asserting it in a comment: once MINE holds a
    // canvas, the reclaim list is empty, so the library is all there is.
    renderAs(MINE, OTHER, 'owned')
    expect(store.listOrphanCandidateCanvases(MINE, { isSessionCurrent: allCurrent })).toEqual([])
  })
})
