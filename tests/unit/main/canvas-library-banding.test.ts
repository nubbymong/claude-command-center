// The canvas list, made usable at scale and honest about ownership.
//
// The list was a flat recency wall with one ownership hint ("some open tile owns
// it") that never said whether the ASKING session owned a row. The in-pane
// switcher offers only your own canvases, so it needs to know which those are —
// and a session may hold up to fifty while pointing at one, so "mine" and
// "the one I am showing" are two different questions.
//
// The flags are DISPLAY ONLY and this file says so on purpose: delete is id-only
// with no ownership check at the IPC seam, so a "mine" badge must never be read
// as a permission.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-banding-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')

const SID_A = 'aaaa1111aaaa1111aaaa1111'
const SID_B = 'bbbb2222bbbb2222bbbb2222'
const CONV = '8c25bfdc-57d3-4894-8f4f-e234fb583791'
const CWD = path.join(getResourcesDirectory(), 'proj')

function render(sessionId: string, title: string) {
  store.setCanvasSessionInfoResolver(() => ({ cwd: CWD, conversationUuid: CONV, profileId: undefined }))
  return store.renderVersion(sessionId, { mode: 'design', html: '<!doctype html><p>x</p>', title })
}

beforeEach(() => {
  store._resetCanvasStoreForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})

afterAll(() => {
  try { fs.rmSync(getResourcesDirectory(), { recursive: true, force: true }) } catch { /* best-effort */ }
})

describe('listAllCanvases — ownership flags', () => {
  it('marks the asking session\'s own canvases, and the one it is showing', () => {
    render(SID_A, 'Checkout flow')
    render(SID_A, 'Title bar logo')      // files the first, becomes active
    render(SID_B, 'Someone else')

    const list = store.listAllCanvases([], CWD, SID_A)
    const mine = list.filter((e) => e.ownedByThisSession)
    expect(mine).toHaveLength(2)
    const active = list.filter((e) => e.isActiveForThisSession)
    expect(active).toHaveLength(1)
    expect(active[0].title).toBe('Title bar logo')
    // The other session's canvas is neither.
    const theirs = list.find((e) => e.title === 'Someone else')!
    expect(theirs.ownedByThisSession).toBeUndefined()
    expect(theirs.isActiveForThisSession).toBeUndefined()
  })

  it('sets no ownership flags at all when nobody is asking', () => {
    render(SID_A, 'Checkout flow')
    const list = store.listAllCanvases([], CWD)
    expect(list[0].ownedByThisSession).toBeUndefined()
    expect(list[0].isActiveForThisSession).toBeUndefined()
  })

  it('ignores a malformed asking session id rather than matching on it', () => {
    render(SID_A, 'Checkout flow')
    const list = store.listAllCanvases([], CWD, '../../etc')
    expect(list[0].ownedByThisSession).toBeUndefined()
  })
})

describe('listAllCanvases — order', () => {
  it('bands: the canvas you are showing, then your others, then everyone else\'s', () => {
    render(SID_B, 'Theirs, newest')       // rendered LAST in time below
    render(SID_A, 'Mine, older')
    render(SID_A, 'Mine, active')
    // Their canvas is the oldest by render time, but banding puts the asking
    // session's rows above it regardless.
    const list = store.listAllCanvases([], CWD, SID_A)
    expect(list.map((e) => e.title)).toEqual(['Mine, active', 'Mine, older', 'Theirs, newest'])
  })

  it('is stable when two canvases share a timestamp', () => {
    render(SID_B, 'One')
    render(SID_B, 'Two')
    const a = store.listAllCanvases([], CWD, SID_A).map((e) => e.canvasId)
    const b = store.listAllCanvases([], CWD, SID_A).map((e) => e.canvasId)
    expect(a).toEqual(b)
  })
})
