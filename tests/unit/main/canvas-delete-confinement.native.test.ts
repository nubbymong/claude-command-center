// Canvas deletion must never escape the canvas store — verified on the runtime
// that SHIPS, which is the whole point of this file living in the native suite.
//
// WHY THIS IS NOT IN canvas-library.test.ts
// -----------------------------------------
// `fs.rmSync(dir, { recursive: true })` behaves DIFFERENTLY in the two runtimes
// this repo runs code under:
//
//   plain Node 24.18.0   — unlinks a nested junction, leaves its target alone
//   Electron 43.2.0      — RECURSES THROUGH it and deletes the target's contents
//
// Same Node version underneath; opposite outcome. vitest's normal run executes
// under plain Node, so a test there asserting "the victim directory survived"
// passes whether or not the escape exists — an unfailable test, and one that
// already certified this exact code path as "confined" during review. Running
// the assertion under Electron-as-Node (`npm run test:unit:native`, which CI
// runs on every PR) is what makes it able to fail.
//
// The guard being pinned is `removeTreeNoFollow` in canvas-store.ts: the top of
// the tree is realpath-confined, and every entry beneath it is lstat'd so a
// link is removed AS a link rather than walked.
//
// MUTATION RECORD (each guard reverted in turn, native suite re-run)
// ------------------------------------------------------------------
//   removeTreeNoFollow -> fs.rmSync(recursive)        2 FAIL (the nested tests)
//   identity check     -> containment check           98 pass
//   drop the dirIsReal guard on the canvas.json unlink 98 pass
//   BOTH of the last two together                     1 FAIL (the sibling test)
//
// The last three lines are the interesting ones. The top-level identity check
// and the lstat before the canvas.json unlink are each individually redundant
// given the other, so reverting one alone is still safe and the suite is right
// not to fail. They are both kept on purpose, and the sibling test fails the
// moment both are gone — which was the real pre-fix state, where unlinking
// canvas.json reached THROUGH a junction planted at `<root>/<id>` and deleted a
// different canvas's record.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { vi } from 'vitest'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-confine-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')

const SID = 'cccc3333cccc3333cccc3333'
const CONV = '8c25bfdc-57d3-4894-8f4f-e234fb583791'
const CWD = path.join(getResourcesDirectory(), 'my-project')

function canvasRoot(): string {
  return path.join(getResourcesDirectory(), 'canvas')
}

function renderDesign(body: string) {
  store.setCanvasSessionInfoResolver(() => ({ cwd: CWD, conversationUuid: CONV, profileId: undefined }))
  return store.renderVersion(SID, { mode: 'design', html: `<!doctype html><p>${body}</p>` })
}

/** A directory link: an NTFS junction on Windows (no admin needed), a plain
 *  directory symlink elsewhere. Returns false if the platform refused. */
function linkDir(from: string, to: string): boolean {
  try {
    fs.symlinkSync(to, from, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}

/** The user's project — what an escape would destroy. */
function makeVictim(name: string): { dir: string; file: string } {
  const dir = path.join(getResourcesDirectory(), name)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'precious.txt')
  fs.writeFileSync(file, 'a real file belonging to the user')
  return { dir, file }
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

describe('deleteCanvas confinement, on the shipped runtime', () => {
  it('does not follow a junction planted INSIDE the canvas directory', () => {
    const { canvasId } = renderDesign('one')
    const victim = makeVictim('victim-nested')

    // The plant: a link one level down, inside the canvas's own version tree —
    // somewhere the top-level realpath check never looks.
    const versions = path.join(canvasRoot(), canvasId, 'versions')
    const entries = fs.readdirSync(versions)
    expect(entries.length).toBeGreaterThan(0)
    const planted = path.join(versions, entries[0], 'nested')
    if (!linkDir(planted, victim.dir)) return // platform refused links; nothing to assert

    expect(fs.lstatSync(planted).isSymbolicLink()).toBe(true)

    expect(store.deleteCanvas(canvasId)).toBe(true)

    // The canvas is gone...
    expect(fs.existsSync(path.join(canvasRoot(), canvasId))).toBe(false)
    // ...and the thing it pointed at is untouched. This is the assertion that
    // fails on Electron when the removal goes through rmSync(recursive).
    expect(fs.existsSync(victim.file)).toBe(true)
    expect(fs.readFileSync(victim.file, 'utf8')).toBe('a real file belonging to the user')
  })

  it('does not follow a junction planted deep inside the canvas directory', () => {
    const { canvasId } = renderDesign('one')
    const victim = makeVictim('victim-deep')

    const deep = path.join(canvasRoot(), canvasId, 'versions', 'a', 'b', 'c')
    fs.mkdirSync(deep, { recursive: true })
    const planted = path.join(deep, 'nested')
    if (!linkDir(planted, victim.dir)) return

    expect(store.deleteCanvas(canvasId)).toBe(true)
    expect(fs.existsSync(path.join(canvasRoot(), canvasId))).toBe(false)
    expect(fs.existsSync(victim.file)).toBe(true)
  })

  it('refuses a canvas directory that is itself a link out of the store', () => {
    const victim = makeVictim('victim-top')
    // No canvas record; just a link sitting where a canvas directory would be.
    const id = 'deadbeefdeadbeefdeadbeef'
    fs.mkdirSync(canvasRoot(), { recursive: true })
    if (!linkDir(path.join(canvasRoot(), id), victim.dir)) return

    // Nothing was deleted: no record, and the directory resolves out of the root.
    expect(store.deleteCanvas(id)).toBe(false)
    expect(fs.existsSync(victim.file)).toBe(true)
    // The link itself is left in place — refusing means not touching it at all.
    expect(fs.existsSync(path.join(canvasRoot(), id))).toBe(true)
  })

  it('does not delete a SIBLING canvas reached through a top-level link', () => {
    // The in-root variant: <root>/<idA> is a link to <root>/<idB>. `path.relative`
    // sees a single in-root segment, so the top-level check alone would allow it.
    const { canvasId: real } = renderDesign('the sibling that must survive')
    const realDir = path.join(canvasRoot(), real)
    const realFile = path.join(realDir, 'canvas.json')
    expect(fs.existsSync(realFile)).toBe(true)

    const impostor = 'feedfacefeedfacefeedface'
    if (!linkDir(path.join(canvasRoot(), impostor), realDir)) return

    store.deleteCanvas(impostor)

    // The sibling's files are still there.
    expect(fs.existsSync(realFile)).toBe(true)
    expect(store.listAllCanvases().some((e) => e.canvasId === real)).toBe(true)
  })
})
