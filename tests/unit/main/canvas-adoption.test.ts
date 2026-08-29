// Canvas continuity across CCC session identities (2026-08-14, the VM "repush"
// bug): a canvas is keyed to the session id, but that id changes on a fresh
// tile / non-restored relaunch while the WORK (project dir, conversation)
// stays the same. renderVersion stamps the work's identity onto the record;
// resumeCanvasForSession moves an ownerless canvas to the new session; the
// review store follows (rebind + load-time self-heal).
//
// Observed failure being locked out: same conversation resumed the next day →
// pane empty → "repush" minted a second canvas, both called v1.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { vi } from 'vitest'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-adopt-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const reviews = await import('../../../src/main/canvas/canvas-review-store')

const SID_A = 'aaaa1111aaaa1111aaaa1111'
const SID_B = 'bbbb2222bbbb2222bbbb2222'
const SID_C = 'cccc3333cccc3333cccc3333'
const CONV_1 = '8c25bfdc-57d3-4894-8f4f-e234fb583791'
const CONV_2 = '59596c8b-1270-489b-8970-dcbc51a33e47'

const CWD = path.join(getResourcesDirectory(), 'project')
const OTHER_CWD = path.join(getResourcesDirectory(), 'elsewhere')

const notCurrent = () => false
const allCurrent = () => true

function canvasJson(canvasId: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json'), 'utf8'),
  )
}

function reviewsJson(canvasId: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json'), 'utf8'),
  )
}

/** Render one design version for a session with the given stamps in place. */
function renderAs(
  sessionId: string,
  cwd: string | undefined,
  conversationUuid: string | undefined,
  body: string,
) {
  store.setCanvasSessionInfoResolver(() => ({ cwd, conversationUuid }))
  return store.renderVersion(sessionId, { mode: 'design', html: `<!doctype html><p>${body}</p>` })
}

/** Simulate an app restart: all in-memory state gone, disk untouched. */
function restart() {
  store._resetCanvasStoreForTest()
  reviews._resetCanvasReviewStoreForTest()
}

/** Temp dirs made outside the mocked resources directory, so `afterAll` can
 *  still sweep them — the fixtures moved out of it in #371 and nothing was
 *  removing them. */
const extraTempDirs: string[] = []
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  extraTempDirs.push(dir)
  return dir
}

beforeEach(() => {
  restart()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})

afterAll(() => {
  for (const d of extraTempDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('renderVersion stamps the work identity', () => {
  it('stamps cwd once and refreshes conversationUuid per render', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    let record = canvasJson(canvasId)
    expect(record.cwd).toBe(CWD)
    expect(record.conversationUuid).toBe(CONV_1)

    // Second render under a different resolver cwd + conversation: cwd holds
    // (the canvas belongs to the project it was born in), conversation follows.
    renderAs(SID_A, OTHER_CWD, CONV_2, 'two')
    record = canvasJson(canvasId)
    expect(record.cwd).toBe(CWD)
    expect(record.conversationUuid).toBe(CONV_2)
  })

  it('renders fine with no resolver and with a throwing resolver', () => {
    store.setCanvasSessionInfoResolver(null)
    const first = store.renderVersion(SID_A, { mode: 'design', html: '<!doctype html><p>a</p>' })
    expect(first.versionId).toBe('v1')
    expect(canvasJson(first.canvasId).cwd).toBeUndefined()

    store.setCanvasSessionInfoResolver(() => {
      throw new Error('resolver exploded')
    })
    const second = store.renderVersion(SID_A, { mode: 'design', html: '<!doctype html><p>b</p>' })
    expect(second.versionId).toBe('v2')
  })
})
describe('resume candidates + resumeCanvasForSession (user-chosen, compare-and-set)', () => {
  // MIGRATED (M4). This block used to drive `listOrphanCandidateCanvases` and
  // `adoptCanvasForSession`, which are gone: the lister returned [] the moment
  // the asking session owned anything, and the adopt had no compare-and-set, so
  // two sessions racing on one stranded canvas both "succeeded" and the second
  // silently took work the first had started. The rules the old block pinned
  // are all still rules, so the assertions moved rather than being deleted.
  //
  // Two rounds of adversarial review established that NO identity the main
  // process can infer is safe to move a canvas on: the project directory is
  // ambiguous (two tiles on one repo), the conversation uuid comes from the
  // transcript binder and is heuristic AND agent-writable, and "is the owner
  // still around" has no reliable oracle. A canvas carries the user's private
  // review notes, so the move is an authorization decision — the user makes it.

  const live = { isSessionLive: allCurrent }
  const dead = { isSessionLive: notCurrent }

  it('offers a candidate, and moves it only when the user names it by id', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    restart()

    const offered = store.listResumableCanvases(SID_B, dead)
    expect(offered).toEqual([
      {
        canvasId,
        // No subject was named, so the row falls back to the CONVERSATION —
        // the one thing that actually differs between two canvases from one
        // project, and the mis-click this row exists to prevent.
        title: `conversation ${CONV_1.slice(0, 8)}`,
        kind: 'mockup',
        noteCount: 0,
        lastRenderedAt: expect.any(String),
        // The compare-and-set token: the owner the user SAW on this row.
        expectedOwnerSessionId: SID_A,
      },
    ])

    const resumed = store.resumeCanvasForSession(SID_B, canvasId, SID_A, dead)
    expect(resumed).toEqual({ ok: true, canvasId, activeVersionId: 'v1' })
    expect(store.getCanvasStateForSession(SID_B)?.canvasId).toBe(canvasId)
    expect(store.getCanvasStateForSession(SID_A)).toBeNull()
    expect(canvasJson(canvasId).sessionId).toBe(SID_B)

    // THE bug being locked out: the next render is v2 on the SAME canvas, not
    // v1 on a parallel one.
    const next = renderAs(SID_B, CWD, CONV_1, 'two')
    expect(next).toEqual({ canvasId, versionId: 'v2', superseded: ['v1'] })
  })

  it('TWO RACERS: the first resume wins and the second is told the owner changed', () => {
    // The hole the compare-and-set closes, and the reason it must be
    // synchronous end to end. Both sessions listed the row while nobody was
    // live, so both hold `expectedOwnerSessionId: SID_A` and both pass the
    // liveness floor. Nothing awaits between the store reading the current
    // owner and persisting the new one, so the second call cannot interleave —
    // it observes SID_B and refuses instead of taking a canvas SID_B has
    // already started working in.
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'contended')
    restart()

    const rowsForB = store.listResumableCanvases(SID_B, dead)
    const rowsForC = store.listResumableCanvases(SID_C, dead)
    expect(rowsForB[0].expectedOwnerSessionId).toBe(SID_A)
    expect(rowsForC[0].expectedOwnerSessionId).toBe(SID_A)

    const first = store.resumeCanvasForSession(SID_B, canvasId, rowsForB[0].expectedOwnerSessionId, dead)
    const second = store.resumeCanvasForSession(SID_C, canvasId, rowsForC[0].expectedOwnerSessionId, dead)

    expect(first).toEqual({ ok: true, canvasId, activeVersionId: 'v1' })
    expect(second).toEqual({ ok: false, reason: 'changed' })
    expect(canvasJson(canvasId).sessionId).toBe(SID_B)
    expect(store.getCanvasStateForSession(SID_C)).toBeNull()
    // ...and on the loser's next refresh the row carries a NEW token. SID_B is
    // not live in this harness, so the canvas is legitimately ownerless again
    // and legitimately offered again — what has changed is who it says the
    // owner is, which is precisely what makes the stale token above refuse
    // instead of silently taking work SID_B has started.
    expect(store.listResumableCanvases(SID_C, dead).map((r) => r.expectedOwnerSessionId)).toEqual([SID_B])
    // In the real app SID_B is live the moment it holds the canvas, so the row
    // is not offered at all — the liveness floor, tested on its own below.
    expect(store.listResumableCanvases(SID_C, { isSessionLive: (sid) => sid === SID_B })).toEqual([])
  })

  it('refuses a stale token even when nothing else has changed', () => {
    // A row listed before some other session took and released the canvas
    // carries an owner that is no longer on the record. Refusing is what makes
    // "first wins" a promise rather than a coincidence of timing.
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    restart()
    expect(store.resumeCanvasForSession(SID_B, canvasId, SID_C, dead)).toEqual({ ok: false, reason: 'changed' })
    expect(canvasJson(canvasId).sessionId).toBe(SID_A)
  })

  it('strips every format control out of the cwd the LIBRARY displays', () => {
    // The resume row carries no directory at all now — a card that named one
    // was the surface this test guarded. The library row still shows the cwd,
    // its text AND its `title` tooltip, so anything that reorders or hides its
    // neighbours makes one directory read as another. The hand-written ranges
    // this replaced jumped 007F straight to 200B, so all five of these walked
    // through (measured, 2026-08-16): U+061C ARABIC LETTER MARK is a real
    // Bidi_Control, U+00AD SOFT HYPHEN and U+2028/U+2029 break the line, U+0085
    // is a C1 control. Built from code points — a literal control character
    // never goes into a tracked file.
    const ALM = String.fromCodePoint(0x061c)
    const SHY = String.fromCodePoint(0x00ad)
    const LS = String.fromCodePoint(0x2028)
    const PS = String.fromCodePoint(0x2029)
    const NEL = String.fromCodePoint(0x0085)
    const RLO = String.fromCodePoint(0x202e)
    renderAs(SID_A, `C:\\work\\${ALM}a${SHY}b${LS}c${PS}d${NEL}e${RLO}f`, CONV_1, 'one')
    restart()

    const [row] = store.listAllCanvases([], undefined, SID_A)
    expect(row.cwd).toBe('C:\\work\\abcdef')
    for (const control of [ALM, SHY, LS, PS, NEL, RLO]) {
      expect(row.cwd, `survived: U+${control.codePointAt(0)!.toString(16)}`).not.toContain(control)
    }
    // ...and the resume row simply has no directory to poison.
    const [resumable] = store.listResumableCanvases(SID_B, dead)
    expect(resumable).not.toHaveProperty('cwd')
  })

  it('moves NOTHING on its own — spawning a session in the same project resumes nothing', () => {
    // The theft scenario: tile A renders, the user writes private notes, A's
    // PTY exits, a second tile opens on the same repo. Nothing may move.
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'private work')
    restart()
    // A candidate may be OFFERED...
    expect(store.listResumableCanvases(SID_B, dead)).toHaveLength(1)
    // ...but ownership has not moved, and B has no canvas.
    expect(canvasJson(canvasId).sessionId).toBe(SID_A)
    expect(store.getCanvasStateForSession(SID_B)).toBeNull()
    expect(store.getCanvasStateForSession(SID_A)?.canvasId).toBe(canvasId)
  })

  it('refuses an id that is not a candidate: the owner is LIVE', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    restart()
    expect(store.listResumableCanvases(SID_B, live)).toEqual([])
    // Even named explicitly, with the right token, a live owner's canvas is
    // not takeable — in-flight work is private to the session holding it.
    expect(store.resumeCanvasForSession(SID_B, canvasId, SID_A, live)).toEqual({ ok: false, reason: 'owner-live' })
    expect(canvasJson(canvasId).sessionId).toBe(SID_A)
  })

  it('refuses an unknown / malformed canvas id', () => {
    renderAs(SID_A, CWD, CONV_1, 'one')
    restart()
    expect(store.resumeCanvasForSession(SID_B, 'deadbeefdeadbeefdeadbeef', SID_A, dead)).toEqual({ ok: false, reason: 'gone' })
    expect(store.resumeCanvasForSession(SID_B, '../../etc/passwd', SID_A, dead)).toEqual({ ok: false, reason: 'gone' })
    expect(store.resumeCanvasForSession(SID_B, '', SID_A, dead)).toEqual({ ok: false, reason: 'gone' })
  })

  it('does not care which ACCOUNT a canvas was drawn under (ADR-017)', () => {
    // A canvas belongs to the project it was made for, not to whichever
    // Claude account happened to be signed in. Requiring the account to match
    // meant a tile that had switched accounts could not open the mockups it
    // had drawn itself, which is an ordinary thing to want to do.
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'work account')
    restart()
    expect(store.listResumableCanvases(SID_B, dead).map((c) => c.canvasId)).toContain(canvasId)
    expect(store.resumeCanvasForSession(SID_B, canvasId, SID_A, dead)).toMatchObject({ ok: true, canvasId })
    expect(canvasJson(canvasId).sessionId).toBe(SID_B)
  })

  it('still refuses a canvas whose owner is live — the one floor left', () => {
    // Removing the account term must not weaken the guard that actually stops
    // one tile taking a live tile's canvas and its private notes.
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'still running')
    restart()
    expect(store.resumeCanvasForSession(SID_B, canvasId, SID_A, live)).toEqual({ ok: false, reason: 'owner-live' })
    expect(canvasJson(canvasId).sessionId).toBe(SID_A)
  })

  it('does not carry an unknown or retired field back out of a record', () => {
    // sanitizeRecord used to spread whatever was on disk, so a field this build
    // does not know about survived validation and was written back into a
    // freshly SIGNED record — the opposite of "a hand-edited file is never
    // repaired". It also kept the retired account stamp (ADR-017) alive
    // forever. The record is now built field by field.
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    const file = path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json')

    // A legitimately signed record that happens to carry extra keys.
    const planted = JSON.parse(fs.readFileSync(file, 'utf8'))
    delete planted.mac
    planted.profileId = 'profile-work'
    planted.hostileExtra = { secret: 'C:/Users/v/.ssh/id_ed25519' }
    planted.mac = store._canvasRecordMacForTest(planted)
    fs.writeFileSync(file, JSON.stringify(planted))

    restart()
    const row = store.listAllCanvases([], CWD, SID_A).find((e) => e.canvasId === canvasId)
    expect(row).toBeTruthy() // the record still loads; only the extras are dropped

    // Touch it so the store re-persists, then read what it wrote.
    renderAs(SID_A, CWD, CONV_1, 'two')
    const after = canvasJson(canvasId)
    expect(after).not.toHaveProperty('profileId')
    expect(after).not.toHaveProperty('hostileExtra')
  })

  it('never offers a session a canvas it already owns', () => {
    // Reachable, though it looks shadowed: a session that owns two canvases is
    // in the index under one of them, and DELETING that one clears the index
    // entry while leaving the other still stamped with the session. The resume
    // list then runs for a session that still owns a canvas — which must not be
    // offered back to it as somebody else's stranded work.
    store.setCanvasSessionInfoResolver(() => ({ cwd: CWD, conversationUuid: CONV_1 }))
    const first = store.renderVersion(SID_A, { mode: 'design', title: 'one', html: '<!doctype html><p>one</p>' })
    const second = store.renderVersion(SID_A, { mode: 'design', title: 'two', html: '<!doctype html><p>two</p>' })
    expect(second.canvasId).not.toBe(first.canvasId)
    store.deleteCanvas(second.canvasId)

    const offered = store.listResumableCanvases(SID_A, dead)
    expect(offered.map((c) => c.canvasId)).not.toContain(first.canvasId)
  })

  it('DOES offer a stranded canvas to a session that already owns one (M4 fix)', () => {
    // The old lister bailed on `sessionIndex.has(sessionId)`, so any session
    // that had ever rendered was shown nothing — and the only route back to
    // stranded work was the library, which is scoped to the project. Owning a
    // canvas is not a reason to be unable to pick up another.
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'stranded')
    restart()
    renderAs(SID_B, CWD, CONV_2, 'my own work')

    expect(store.listResumableCanvases(SID_B, dead).map((c) => c.canvasId)).toEqual([canvasId])
    expect(store.resumeCanvasForSession(SID_B, canvasId, SID_A, dead)).toMatchObject({ ok: true, canvasId })
    // The resumed canvas becomes CURRENT; the one B already had stays B's, it
    // is simply no longer what the pane points at.
    expect(store.getCanvasStateForSession(SID_B)?.canvasId).toBe(canvasId)
  })

  it('fails SAFE when the liveness check throws — uncertain means untouchable', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    restart()
    const throwing = {
      isSessionLive: () => {
        throw new Error('session registry unavailable')
      },
    }
    expect(store.listResumableCanvases(SID_B, throwing)).toEqual([])
    expect(store.resumeCanvasForSession(SID_B, canvasId, SID_A, throwing)).toEqual({ ok: false, reason: 'owner-live' })
    expect(canvasJson(canvasId).sessionId).toBe(SID_A)
  })

  it('leaves the resumed record\u2019s own stamps alone (the resumer does not redefine what the canvas is)', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    restart()
    store.resumeCanvasForSession(SID_B, canvasId, SID_A, dead)
    const record = canvasJson(canvasId)
    expect(record.sessionId).toBe(SID_B) // only the owner moves
    expect(record.cwd).toBe(CWD)
    expect(record.conversationUuid).toBe(CONV_1)
  })

  it('never offers or hands over a zero-version canvas', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    const record = canvasJson(canvasId)
    record.versions = []
    record.activeVersionId = null
    // Re-signed: an edited record fails its MAC and would be refused wholesale,
    // so the zero-version rule this test is about would never be consulted.
    delete record.mac
    fs.writeFileSync(
      path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json'),
      JSON.stringify({ ...record, mac: store._canvasRecordMacForTest(record) }, null, 2),
    )
    restart()
    expect(store.listResumableCanvases(SID_B, dead)).toEqual([])
    expect(store.resumeCanvasForSession(SID_B, canvasId, SID_A, dead)).toEqual({ ok: false, reason: 'gone' })
  })

  it('announces the move so the pane can repaint', () => {
    const seen: Array<{ sessionId: string; canvasId: string }> = []
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    restart()
    const off = store.onCanvasChanged((e) => seen.push({ sessionId: e.sessionId, canvasId: e.canvasId }))
    store.resumeCanvasForSession(SID_B, canvasId, SID_A, dead)
    off()
    expect(seen).toEqual([{ sessionId: SID_B, canvasId }])
  })

  it('fails closed when the durable write fails — memory never moves ahead of disk', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    restart()
    // Load the record into memory FIRST — the scan reads canvas.json, and the
    // sabotage below makes it unreadable.
    expect(store.getCanvasStateForSession(SID_A)?.canvasId).toBe(canvasId)
    const jsonPath = path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json')
    const saved = fs.readFileSync(jsonPath, 'utf8')
    fs.rmSync(jsonPath, { force: true })
    fs.mkdirSync(jsonPath)
    expect(() => store.resumeCanvasForSession(SID_B, canvasId, SID_A, dead)).toThrow()
    // Neither session's view moved.
    expect(store.getCanvasStateForSession(SID_B)).toBeNull()
    expect(store.getCanvasStateForSession(SID_A)?.canvasId).toBe(canvasId)
    fs.rmSync(jsonPath, { recursive: true, force: true })
    fs.writeFileSync(jsonPath, saved)
  })

  it('OPEN HERE is not a resume: a session re-opens its own canvas with no oracle at all', () => {
    store.setCanvasSessionInfoResolver(() => ({ cwd: CWD, conversationUuid: CONV_1 }))
    const first = store.renderVersion(SID_A, { mode: 'design', title: 'one', html: '<!doctype html><p>one</p>' })
    store.renderVersion(SID_A, { mode: 'design', title: 'two', html: '<!doctype html><p>two</p>' })

    expect(store.openOwnCanvasForSession(SID_A, first.canvasId)).toEqual({ canvasId: first.canvasId, activeVersionId: 'v1' })
    expect(store.getCanvasStateForSession(SID_A)?.canvasId).toBe(first.canvasId)
    // ...and it is emphatically NOT a way to take somebody else's.
    const theirs = renderAs(SID_B, CWD, CONV_2, 'theirs')
    expect(store.openOwnCanvasForSession(SID_A, theirs.canvasId)).toBeNull()
    expect(canvasJson(theirs.canvasId).sessionId).toBe(SID_B)
  })
})

describe('resolveInsideCanvasRoot (the htmlPath confinement)', () => {
  it('refuses everything when no root is registered, and confines to a registered one', () => {
    // Outside the resources directory: the floor now refuses a served root
    // under it (#371). Both dirs move together so the "outside" one stays
    // outside the registered root, which is what this test is about.
    // mkdtemp, not a fixed name: this repo mandates parallel sessions
    // (AGENTS.md, ADR-012), and two `npx vitest run`s sharing
    // `<tmp>/ccc-adopt-confine-proj` is an EPERM window on Windows. Both dirs
    // live under one parent so `outsideDir` stays a real sibling OUTSIDE the
    // registered root, which is what this test is about.
    const confineBase = tmpDir('ccc-adopt-confine-')
    const projectDir = path.join(confineBase, 'proj')
    const outsideDir = path.join(confineBase, 'outside')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.mkdirSync(outsideDir, { recursive: true })
    const inside = path.join(projectDir, 'mockup.html')
    const outside = path.join(outsideDir, 'secret.txt')
    fs.writeFileSync(inside, '<!doctype html><p>ok</p>')
    fs.writeFileSync(outside, 'PRIVATE KEY')

    // Default-empty allowlist: nothing resolves.
    expect(() => store.resolveInsideCanvasRoot(inside, SID_A)).toThrow(/registered canvas root/i)

    expect(store.registerCanvasUatRoot(SID_A, projectDir)).toBe(true)
    expect(store.resolveInsideCanvasRoot(inside, SID_A)).toBe(fs.realpathSync.native(inside))
    // The read that the adversarial pass drove to a private key.
    expect(() => store.resolveInsideCanvasRoot(outside, SID_A)).toThrow(/registered canvas root/i)
    // Traversal out of a registered root, and a relative path.
    // `outsideDir`, not a hardcoded basename: the fixtures moved and the literal
    // stopped naming the real file, so this normalised to a path that does not
    // exist and passed on the missing-file branch instead of the containment
    // one — it would have passed with the containment logic deleted (#371).
    expect(() => store.resolveInsideCanvasRoot(path.join(projectDir, '..', path.basename(outsideDir), 'secret.txt'), SID_A)).toThrow(
      /registered canvas root/i,
    )
    expect(() => store.resolveInsideCanvasRoot('mockup.html', SID_A)).toThrow(/registered canvas root/i)
  })
})

describe('reviews follow the adoption', () => {
  function submitOneReview(sessionId: string): { reviewId: string } {
    const { annotationId, state } = reviews.upsertAnnotation(sessionId, {
      scope: 'general',
      note: 'the header wraps at 1280',
      versionId: 'v1',
    })
    const draft = state.reviews.find((r) => r.status === 'draft')!
    reviews.submitReview(sessionId, draft.id, [], 'reject')
    expect(annotationId).toBeTruthy()
    return { reviewId: draft.id }
  }

  it('rebindReviewsToSession moves reviews.json to the new owner', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    const { reviewId } = submitOneReview(SID_A)
    restart()

    const resumed = store.resumeCanvasForSession(SID_B, canvasId, SID_A, { isSessionLive: notCurrent })
    expect(resumed).toMatchObject({ ok: true, canvasId })
    reviews.rebindReviewsToSession(canvasId, SID_B)

    const onDisk = reviewsJson(canvasId)
    expect(onDisk.sessionId).toBe(SID_B)
    expect((onDisk.reviews as Array<{ canvas: { sessionId: string } }>)[0].canvas.sessionId).toBe(SID_B)

    // The adopted session reads its review history; the store is NOT broken.
    const state = reviews.getReviewStateForSession(SID_B)
    expect(state?.reviews.map((r) => r.id)).toEqual([reviewId])
    expect(reviews.getReviewPayload(SID_B, reviewId).payload.review.id).toBe(reviewId)
  })

  it('self-heals a stale owner on load (crash between the two rebind persists)', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    const { reviewId } = submitOneReview(SID_A)
    restart()

    // Canvas re-binds, then the app dies before the review rebind runs.
    store.resumeCanvasForSession(SID_B, canvasId, SID_A, { isSessionLive: notCurrent })
    restart()

    // Next launch: the canvas record says SID_B, reviews.json still says SID_A.
    // A plain read under the new owner self-heals instead of marking broken.
    expect(store.getCanvasStateForSession(SID_B)?.canvasId).toBe(canvasId)
    const state = reviews.getReviewStateForSession(SID_B)
    expect(state?.reviews.map((r) => r.id)).toEqual([reviewId])
    expect(reviewsJson(canvasId).sessionId).toBe(SID_B)

    // And mutations under the new owner work (the store never went broken).
    const upserted = reviews.upsertAnnotation(SID_B, {
      scope: 'general',
      note: 'second round note',
      versionId: 'v1',
    })
    expect(upserted.annotationId).toBeTruthy()
  })

  it('a genuinely corrupt reviews.json still refuses (adoption does not soften BROKEN)', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    submitOneReview(SID_A)
    fs.writeFileSync(
      path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json'),
      '{"canvasId": "someone-else", "sessionId": "x"}',
    )
    restart()

    store.resumeCanvasForSession(SID_B, canvasId, SID_A, { isSessionLive: notCurrent })
    reviews.rebindReviewsToSession(canvasId, SID_B)
    // Broken store: reads answer empty, mutations refuse, file untouched.
    expect(reviews.getReviewStateForSession(SID_B)?.reviews).toEqual([])
    expect(() =>
      reviews.upsertAnnotation(SID_B, { scope: 'general', note: 'x', versionId: 'v1' }),
    ).toThrow(/unreadable/i)
    expect((reviewsJson(canvasId) as { canvasId: string }).canvasId).toBe('someone-else')
  })
})
