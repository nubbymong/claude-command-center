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

describe('the account floor survives the "already mine" fast path', () => {
  // "A canvas must never cross accounts" (adversarial review 2026-08-14) is
  // enforced by isReclaimCandidate, which the own-canvas branch above runs
  // BEFORE. That matters because a session id outlives an account switch — the
  // tile is re-added with the same id — while the record's profileId is stamped
  // once, at birth. So after switching accounts in a tile, every canvas that
  // tile authored still says "mine" and would be one click from binding to a
  // session now running as somebody else.
  const P1 = 'profile-one'
  const P2 = 'profile-two'

  it('refuses a canvas stamped with a DIFFERENT account, even to its own session', () => {
    // Two subjects under account one, so the SECOND is what the session points
    // at and switching back to the first is a real re-point, not a no-op.
    const first = renderAs(MINE, PROJECT, 'under account one', P1)
    const second = renderAs(MINE, PROJECT, 'also under account one', P1)

    const crossed = store.adoptCanvasForSession(MINE, first.canvasId, {
      profileId: P2,
      isSessionCurrent: allCurrent,
    })
    expect(crossed).toBeNull()
    // ...and the refusal actually held: the session still points where it did.
    expect(store.getCanvasStateForSession(MINE)?.canvasId).toBe(second.canvasId)
  })

  it('refuses in the other direction too: an UNSTAMPED record into a profiled session', () => {
    const legacy = renderAs(MINE, PROJECT, 'no account stamp')
    expect(store.adoptCanvasForSession(MINE, legacy.canvasId, {
      profileId: P1,
      isSessionCurrent: allCurrent,
    })).toBeNull()
  })

  it('refuses a PROFILED record to the same session now on the DEFAULT account', () => {
    // The third direction, and the one a real user takes most often: switching
    // a tile BACK to the default account, where the query carries no profile at
    // all. A floor written as "only compare when a profile was given" passes
    // both cases above and lets this one through.
    const first = renderAs(MINE, PROJECT, 'one', P1)
    renderAs(MINE, PROJECT, 'two', P1)
    expect(store.adoptCanvasForSession(MINE, first.canvasId, {
      isSessionCurrent: allCurrent,
    })).toBeNull()
  })

  it('badges a row "mine" only when the action would actually open it', () => {
    // The library and the action must answer the same question. Badging on the
    // session id alone offered rows that Open here refuses, with a message
    // about a session that is still running — which is not what happened.
    const authored = renderAs(MINE, PROJECT, 'under account one', P1)

    const sameAccount = store.listAllCanvases([], PROJECT, MINE, P1)
      .find((e) => e.canvasId === authored.canvasId)
    expect(sameAccount?.ownedByThisSession).toBe(true)

    const afterSwitch = store.listAllCanvases([], PROJECT, MINE, P2)
      .find((e) => e.canvasId === authored.canvasId)
    // Still listed — the library shows everything — but not as this session's.
    expect(afterSwitch).toBeTruthy()
    expect(afterSwitch?.ownedByThisSession).toBeUndefined()
    expect(afterSwitch?.isActiveForThisSession).toBeUndefined()
  })

  it('still opens the session\'s own canvas when the account MATCHES', () => {
    // The floor must not cost the fix it sits inside: same session, same
    // account, an earlier canvas that a new subject filed.
    const first = renderAs(MINE, PROJECT, 'one', P1)
    renderAs(MINE, PROJECT, 'two', P1)
    const reopened = store.adoptCanvasForSession(MINE, first.canvasId, {
      profileId: P1,
      isSessionCurrent: allCurrent,
    })
    expect(reopened?.canvasId).toBe(first.canvasId)
    expect(store.getCanvasStateForSession(MINE)?.canvasId).toBe(first.canvasId)
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
