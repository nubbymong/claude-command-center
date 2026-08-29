// The canvas library: listing every canvas, and the one destructive operation
// the store has.
//
// Nothing was ever removable — renderVersion only appends and no code path
// deleted anything — so every canvas a user had rendered accumulated forever
// and the only place an old one surfaced was the reclaim list of a session that
// happened to have none of its own. Deleting touches files, so the path
// discipline is pinned here: an id-only surface, resolved and confined to the
// canvas store, refusing to follow a link that points out of it.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { vi } from 'vitest'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-library-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')

const SID_A = 'aaaa1111aaaa1111aaaa1111'
const SID_B = 'bbbb2222bbbb2222bbbb2222'
const CONV_1 = '8c25bfdc-57d3-4894-8f4f-e234fb583791'

const CWD = path.join(getResourcesDirectory(), 'my-project')

function canvasRoot(): string {
  return path.join(getResourcesDirectory(), 'canvas')
}

function renderDesign(sessionId: string, body: string, cwd: string = CWD) {
  store.setCanvasSessionInfoResolver(() => ({ cwd, conversationUuid: CONV_1, profileId: undefined }))
  return store.renderVersion(sessionId, { mode: 'design', html: `<!doctype html><p>${body}</p>` })
}

beforeEach(() => {
  store._resetCanvasStoreForTest()
  fs.rmSync(canvasRoot(), { recursive: true, force: true })
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('listAllCanvases', () => {
  it('lists EVERY canvas, not just what the asking session could resume', () => {
    renderDesign(SID_A, 'one')
    renderDesign(SID_B, 'two')
    // The resume list excludes the caller's OWN canvases (resuming your own is
    // Open here, not a transfer), so it is a strictly different question from
    // the library's — which is not an ownership question at all and shows both.
    expect(store.listResumableCanvases(SID_A, { isSessionLive: () => false }).map((r) => r.canvasId))
      .not.toContain(store.getCanvasStateForSession(SID_A)?.canvasId)
    expect(store.listAllCanvases()).toHaveLength(2)
  })

  it('carries the mode, version count and project so a row is identifiable', () => {
    const { canvasId } = renderDesign(SID_A, 'one')
    renderDesign(SID_A, 'two')
    const row = store.listAllCanvases().find((e) => e.canvasId === canvasId)
    expect(row).toBeDefined()
    expect(row!.versionCount).toBe(2)
    expect(row!.latestMode).toBe('design')
    expect(row!.cwd).toBe(CWD)
    expect(row!.conversationShortId).toBe(CONV_1.slice(0, 8))
  })

  it('marks rows whose owning session is on screen right now', () => {
    renderDesign(SID_A, 'one')
    expect(store.listAllCanvases([])[0].ownedByOpenSession).toBeUndefined()
    // Asked AS the owner: the privacy rule withholds another live session's
    // in-flight canvas, so a caller that is not SID_A would see nothing here —
    // which is the point of the next test rather than of this one.
    expect(store.listAllCanvases([SID_A], undefined, SID_A)[0].ownedByOpenSession).toBe(true)
  })

  it('WITHHOLDS another live session\u2019s in-flight canvas (the M4 privacy rule)', () => {
    // In flight is private to the live session holding it. Enforced in MAIN on
    // this channel as well as on the Library, because the totals sweep reads
    // this list — a row returned here would put somebody else's private work
    // into a count on the button.
    const { canvasId } = renderDesign(SID_A, 'one')
    const ids = (tiles: string[], asking: string) =>
      store.listAllCanvases(tiles, undefined, asking).map((e) => e.canvasId)

    expect(ids([SID_A], SID_B)).not.toContain(canvasId)
    // ...and it comes back the moment its owner is no longer live.
    expect(ids([], SID_B)).toContain(canvasId)
  })

  it('survives a restart — the library is what is on DISK', () => {
    renderDesign(SID_A, 'one')
    store._resetCanvasStoreForTest()
    expect(store.listAllCanvases()).toHaveLength(1)
  })
})

describe('deleteCanvas', () => {
  it('removes the record, the directory, and the session binding', () => {
    const { canvasId } = renderDesign(SID_A, 'one')
    expect(fs.existsSync(path.join(canvasRoot(), canvasId))).toBe(true)
    expect(store.getCanvasStateForSession(SID_A)).not.toBeNull()

    expect(store.deleteCanvas(canvasId)).toBe(true)

    expect(fs.existsSync(path.join(canvasRoot(), canvasId))).toBe(false)
    expect(store.listAllCanvases()).toHaveLength(0)
    expect(store.getCanvasStateForSession(SID_A)).toBeNull()
  })

  it('stays deleted across a restart', () => {
    const { canvasId } = renderDesign(SID_A, 'one')
    store.deleteCanvas(canvasId)
    store._resetCanvasStoreForTest()
    expect(store.listAllCanvases()).toHaveLength(0)
    expect(fs.existsSync(path.join(canvasRoot(), canvasId))).toBe(false)
  })

  it('deletes only the named canvas', () => {
    const a = renderDesign(SID_A, 'one').canvasId
    const b = renderDesign(SID_B, 'two').canvasId
    store.deleteCanvas(a)
    expect(store.listAllCanvases().map((e) => e.canvasId)).toEqual([b])
    expect(fs.existsSync(path.join(canvasRoot(), b))).toBe(true)
  })

  // The id is app-minted, so the charset gate only ever rejects something a
  // real id could not be — which is exactly what a caller trying to name a path
  // would have to send.
  it.each([
    ['traversal', '../..'],
    ['nested traversal', 'a/../../b'],
    ['absolute-ish', '/etc'],
    ['windows separator', 'a\\b'],
    ['empty', ''],
    ['device name', 'con'],
  ])('refuses a canvasId that is not an app-minted id: %s', (_label, bad) => {
    renderDesign(SID_A, 'one')
    expect(store.deleteCanvas(bad)).toBe(false)
    expect(store.listAllCanvases()).toHaveLength(1)
  })

  it('reports false for an id that names nothing', () => {
    expect(store.deleteCanvas('deadbeefdeadbeefdeadbeef')).toBe(false)
  })

  it('refuses to follow a symlink that points OUT of the canvas store', () => {
    // A directory inside the store whose name is a valid id but which is really
    // a link to somewhere else entirely. Deleting through it would recurse into
    // the target — a user's project — so the real path has to be confirmed to
    // sit inside the store before anything is removed.
    const outside = path.join(getResourcesDirectory(), 'precious')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'do not delete me')

    const planted = 'ffff9999ffff9999ffff9999'
    fs.mkdirSync(canvasRoot(), { recursive: true })
    let linked = true
    try {
      fs.symlinkSync(outside, path.join(canvasRoot(), planted), 'junction')
    } catch {
      linked = false // unprivileged Windows without developer mode
    }
    // If the platform will not let us plant the link at all there is nothing to
    // assert, but say so rather than passing silently: a guard test that
    // no-ops is indistinguishable from one that works.
    expect(linked, 'could not create the junction, so this guard went untested').toBe(true)

    expect(store.deleteCanvas(planted)).toBe(false)

    // The link is REFUSED, not followed and not removed. Asserting the target's
    // files survive is not enough on its own: fs.rmSync unlinks a junction
    // rather than recursing into it, so that assertion holds even with the
    // confinement check deleted, and the test could never fail. What the check
    // actually decides is whether rmSync runs on this path at all.
    expect(fs.existsSync(path.join(canvasRoot(), planted))).toBe(true)
    expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('do not delete me')
  })
})
