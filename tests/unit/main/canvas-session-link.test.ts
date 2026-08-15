// The reclaim floor (adversarial review, 2026-08-15).
//
// canvas-session-link decides WHAT the user is offered when a session has no
// canvas, and it was imported by no test at all — the whole floor under a
// one-click transfer of the user's private review notes was uncovered. Three
// defects it had:
//
//   - a canvas was offered as "an earlier session" WHILE ITS OWN TILE WAS
//     OPEN. The saved-tile oracle answers from a file that exists only between
//     a graceful Save & Close and the next restore, so during a normal run it
//     returns "nobody is open" and a tile whose PTY merely exited looked gone;
//   - the list was uncapped;
//   - the displayed cwd carried whatever characters the path had, bidi
//     overrides included.
//
// Everything here drives the real module against a real temp resources dir;
// only the three ambient lookups it makes (PTY registry, saved-tile file,
// transcript binder) are stubbed, because those ARE the ambient state.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const h = vi.hoisted(() => ({
  livePtySessions: new Set<string>(),
  savedState: null as { sessions: Array<{ id: string }> } | null,
  savedStateFileExists: false,
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
vi.mock('../../../src/main/session-state', () => ({
  loadSessionState: () => h.savedState,
  hasSavedSessionState: () => h.savedStateFileExists,
}))
vi.mock('../../../src/main/logging/logging-service', () => ({ getTranscriptBinder: () => null }))

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const link = await import('../../../src/main/canvas/canvas-session-link')

const OWNER = 'aaaa1111aaaa1111aaaa1111'
const ASKER = 'bbbb2222bbbb2222bbbb2222'
const CONV = '8c25bfdc-57d3-4894-8f4f-e234fb583791'
const CONV_2 = '59596c8b-1270-489b-8970-dcbc51a33e47'
const PROJECT = 'C:\\work\\proj'

/** Spawn a session, render one design version as it, and hand back the canvas. */
function renderAs(sessionId: string, cwd: string, conversationUuid?: string): string {
  link.noteSessionSpawnForCanvas(sessionId, { cwd, resumeUuid: conversationUuid })
  return store.renderVersion(sessionId, { mode: 'design', html: '<!doctype html><p>x</p>' }).canvasId
}

/** "The app restarted": in-memory state gone, disk records intact. */
function restart(): void {
  store._resetCanvasStoreForTest()
  link._resetCanvasSessionLinkForTest()
  link.installCanvasSessionLink()
}

beforeEach(() => {
  h.livePtySessions.clear()
  // The COMMON runtime state, and the one the old oracle got wrong: no saved
  // state file at all, because one only exists between a graceful Save & Close
  // and the next restore.
  h.savedState = null
  h.savedStateFileExists = false
  store._resetCanvasStoreForTest()
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

    // The owner has no live PTY (it exited) and there is no saved-state file —
    // the state in which the old oracle said "nobody is open".
    const openTiles = [OWNER, ASKER]
    expect(link.listReclaimableCanvases(ASKER, openTiles)).toEqual([])
    expect(link.reclaimCanvasForSession(ASKER, canvasId, openTiles)).toBe(false)
    // ...and it is still the owner's.
    expect(store.getCanvasStateForSession(OWNER)?.canvasId).toBe(canvasId)
  })

  it('IS offered once that tile is closed', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV)
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })

    const offered = link.listReclaimableCanvases(ASKER, [ASKER])
    expect(offered.map((c) => c.canvasId)).toEqual([canvasId])
    expect(link.reclaimCanvasForSession(ASKER, canvasId, [ASKER])).toBe(true)
    expect(store.getCanvasStateForSession(ASKER)?.canvasId).toBe(canvasId)
  })

  it('is still protected by a live PTY when the renderer sends no hint at all', () => {
    const canvasId = renderAs(OWNER, PROJECT, CONV)
    restart()
    h.livePtySessions.add(OWNER)
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })
    expect(link.listReclaimableCanvases(ASKER)).toEqual([])
    expect(link.reclaimCanvasForSession(ASKER, canvasId)).toBe(false)
  })
})

describe('what the card is given to tell candidates apart', () => {
  it('carries the conversation short id, so two canvases from one project differ', () => {
    const first = renderAs(OWNER, PROJECT, CONV)
    const second = renderAs('cccc3333cccc3333cccc3333', PROJECT, CONV_2)
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })

    const offered = link.listReclaimableCanvases(ASKER, [ASKER])
    const byId = new Map(offered.map((c) => [c.canvasId, c]))
    expect(byId.get(first)?.conversationShortId).toBe(CONV.slice(0, 8))
    expect(byId.get(second)?.conversationShortId).toBe(CONV_2.slice(0, 8))
    // ...which is the ONLY field that differs between them.
    expect(byId.get(first)?.cwd).toBe(byId.get(second)?.cwd)
    expect(byId.get(first)?.versionCount).toBe(byId.get(second)?.versionCount)
  })

  it('strips bidi and format controls out of the displayed cwd', () => {
    // U+202E (RIGHT-TO-LEFT OVERRIDE) reverses everything after it, so a path
    // carrying one renders as a different directory than it is. Built from a
    // code point rather than written literally.
    const RLO = String.fromCodePoint(0x202e)
    const ZWSP = String.fromCodePoint(0x200b)
    renderAs(OWNER, `C:\\work\\${RLO}gnp.evil${ZWSP}\\dist`, CONV)
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })

    const [offered] = link.listReclaimableCanvases(ASKER, [ASKER])
    expect(offered.cwd).toBe('C:\\work\\gnp.evil\\dist')
    expect(offered.cwd).not.toContain(RLO)
    expect(offered.cwd).not.toContain(ZWSP)
  })

  it('marks the asking session\'s own project and floats it to the top', () => {
    renderAs(OWNER, 'C:\\work\\other', CONV)
    const mine = renderAs('cccc3333cccc3333cccc3333', PROJECT, CONV_2)
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })

    const offered = link.listReclaimableCanvases(ASKER, [ASKER])
    expect(offered[0].canvasId).toBe(mine)
    expect(offered[0].sameProject).toBe(true)
    expect(offered[1].sameProject).toBe(false)
  })
})

describe('the candidate list is bounded', () => {
  it('never hands the pane more than a dozen canvases to mis-click', () => {
    for (let i = 0; i < 20; i++) {
      renderAs(`dead${String(i).padStart(20, '0')}`, `C:\\work\\p${i}`, CONV)
    }
    restart()
    link.noteSessionSpawnForCanvas(ASKER, { cwd: PROJECT })

    const offered = link.listReclaimableCanvases(ASKER, [ASKER])
    expect(offered.length).toBeGreaterThan(0)
    expect(offered.length).toBeLessThanOrEqual(12)
  })
})
