// A canvas.json must be one CCC WROTE (adversarial review, 2026-08-15).
//
// Shape validation was the only thing in front of the reload path, and shape is
// exactly what a hand-written file has. Plant `<resources>/canvas/<24-hex>/
// canvas.json` naming a victim session and a distRoot, restart, and the store
// loaded it: the reclaim card offered it to the user as their own earlier work
// and `getServableVersion` resolved its distRoot against the OWNER SESSION
// NAMED IN THE FILE — an unauthenticated on-disk field deciding whose allowlist
// applied. It survived restarts, which made it the one disk-persistent
// deception primitive in the feature.
//
// Every test here drives the real store against a real temp resources dir.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-provenance-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const { handleCccUxRequest } = await import('../../../src/main/canvas/ccc-ux-protocol')

const VICTIM = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const OTHER = 'ffffffffffffffffffffffff'
const notCurrent = () => false

function jsonPath(canvasId: string): string {
  return path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json')
}

function readRecord(canvasId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(jsonPath(canvasId), 'utf8'))
}

function writeRecord(canvasId: string, record: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(jsonPath(canvasId)), { recursive: true })
  fs.writeFileSync(jsonPath(canvasId), JSON.stringify(record, null, 2))
}

/** What an attacker with write access to the resources dir can produce: a
 *  well-shaped record naming someone else's session and a root of their
 *  choosing. Everything about it is valid except that CCC did not write it. */
function plantedRecord(canvasId: string, distRoot: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    canvasId,
    sessionId: VICTIM,
    createdAt: '2026-08-01T00:00:00.000Z',
    activeVersionId: 'v1',
    cwd: 'C:\\victim\\project',
    versions: [
      {
        id: 'v1',
        mode: 'uat',
        createdAt: '2026-08-01T00:00:00.000Z',
        source: { mode: 'uat', distRoot, entry: 'index.html' },
      },
    ],
    ...over,
  }
}

/** "Restart the app": drop memory so the lazy disk rescan runs again. */
function restart(): void {
  store._resetCanvasStoreForTest()
}

let distDir: string

beforeEach(() => {
  restart()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
  // Outside the resources directory: the floor now refuses a served root under
  // it, and served content has no business living beside CONFIG anyway (#371).
  distDir = path.join(os.tmpdir(), 'ccc-prov-planted-dist')
  fs.mkdirSync(distDir, { recursive: true })
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>planted</body></html>')
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort temp cleanup */
  }
})

describe('a planted canvas.json', () => {
  const CANVAS = 'planted00000000000000001'

  it('is not loaded, not offered for reclaim, and not served — even after a restart', async () => {
    writeRecord(CANVAS, plantedRecord(CANVAS, distDir))
    restart()

    // Not the victim session's canvas...
    expect(store.getCanvasStateForSession(VICTIM)).toBeNull()
    // ...not offered to anyone as "an earlier session"...
    expect(store.listOrphanCandidateCanvases(OTHER, { isSessionCurrent: notCurrent })).toEqual([])
    expect(store.adoptCanvasForSession(OTHER, CANVAS, { isSessionCurrent: notCurrent })).toBeNull()
    // ...and nothing about it is servable, whatever roots exist.
    expect(store.registerCanvasUatRoot(VICTIM, distDir)).toBe(true)
    expect(store.getServableVersion(CANVAS, 'v1')).toBeNull()
    expect((await handleCccUxRequest(new Request(`ccc-ux://${CANVAS}/v1/index.html`))).status).toBe(404)
  })

  it('cannot borrow a signature from another canvas', () => {
    // Sign a REAL record for a different canvas, then paste its mac across.
    const real = store.renderVersion(OTHER, { mode: 'design', html: '<!doctype html><p>mine</p>' })
    const stolenMac = readRecord(real.canvasId).mac
    expect(stolenMac).toBeTypeOf('string')
    writeRecord(CANVAS, { ...plantedRecord(CANVAS, distDir), mac: stolenMac })
    restart()
    expect(store.getCanvasStateForSession(VICTIM)).toBeNull()
  })

  it('cannot pass with a mac that is merely well-formed', () => {
    writeRecord(CANVAS, { ...plantedRecord(CANVAS, distDir), mac: 'a'.repeat(64) })
    restart()
    expect(store.getCanvasStateForSession(VICTIM)).toBeNull()
  })
})

describe('a record CCC wrote', () => {
  it('survives a restart, so signing did not break persistence', () => {
    const { canvasId } = store.renderVersion(VICTIM, { mode: 'design', html: '<!doctype html><p>real</p>' })
    restart()
    const state = store.getCanvasStateForSession(VICTIM)
    expect(state?.canvasId).toBe(canvasId)
    expect(state?.versions).toHaveLength(1)
  })

  it('survives repeated load → mutate → persist round trips', () => {
    // The signature is an ENVELOPE, not a field: a loaded record must not carry
    // the old mac back into the next MAC's input, or the second write signs
    // something the third read cannot reproduce and the canvas evaporates on
    // the restart after next.
    const { canvasId } = store.renderVersion(VICTIM, { mode: 'design', html: '<!doctype html><p>one</p>' })
    restart()
    store.renderVersion(VICTIM, { mode: 'design', html: '<!doctype html><p>two</p>' })
    restart()
    store.setActiveVersion(VICTIM, 'v1')
    restart()
    expect(store.getCanvasStateForSession(VICTIM)?.canvasId).toBe(canvasId)
    expect(store.getCanvasStateForSession(VICTIM)?.versions).toHaveLength(2)
  })

  it('still verifies when its JSON is re-serialised with the keys in another order', () => {
    // The MAC is over a CANONICAL form. If it were over `JSON.stringify` output
    // the store would fail against its own records the first time a field was
    // added, moved, or round-tripped through a different writer.
    const { canvasId } = store.renderVersion(VICTIM, { mode: 'design', html: '<!doctype html><p>real</p>' })
    const record = readRecord(canvasId)
    const reordered = Object.fromEntries(Object.entries(record).reverse())
    writeRecord(canvasId, reordered)
    restart()
    expect(store.getCanvasStateForSession(VICTIM)?.canvasId).toBe(canvasId)
  })

  it('stops verifying the moment any authenticated field is edited', () => {
    const { canvasId } = store.renderVersion(VICTIM, { mode: 'design', html: '<!doctype html><p>real</p>' })
    const record = readRecord(canvasId)
    // The field that decides whose UAT roots apply.
    writeRecord(canvasId, { ...record, sessionId: OTHER })
    restart()
    expect(store.getCanvasStateForSession(OTHER)).toBeNull()
    expect(store.getCanvasStateForSession(VICTIM)).toBeNull()
  })

  it('stops verifying when a version\'s distRoot is edited', () => {
    const dist = path.join(os.tmpdir(), 'ccc-prov-real-dist')
    fs.mkdirSync(dist, { recursive: true })
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><p>ok</p>')
    expect(store.registerCanvasUatRoot(VICTIM, dist)).toBe(true)
    const { canvasId } = store.renderVersion(VICTIM, { mode: 'uat', distRoot: dist })
    const record = readRecord(canvasId)
    const versions = (record.versions as Array<Record<string, any>>).map((v) => ({
      ...v,
      source: { ...v.source, distRoot: distDir },
    }))
    writeRecord(canvasId, { ...record, versions })
    restart()
    expect(store.getCanvasStateForSession(VICTIM)).toBeNull()
  })
})

describe('lastRenderedAt is clamped to now', () => {
  it('a future stamp cannot outrank real work in the reclaim list', () => {
    // Signed, so this is not the planted case — it is a record whose clock ran
    // ahead. The list is sorted newest-first, so an unclamped year-3000 stamp
    // would sit above every genuine canvas.
    const futureId = 'future000000000000000001'
    const future = {
      canvasId: futureId,
      sessionId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      createdAt: '3000-01-01T00:00:00.000Z',
      activeVersionId: 'v1',
      versions: [
        {
          id: 'v1',
          mode: 'design',
          createdAt: '3000-01-01T00:00:00.000Z',
          source: { mode: 'design', entry: 'index.html' },
        },
      ],
    }
    writeRecord(futureId, { ...future, mac: store._canvasRecordMacForTest(future) })
    restart()

    const offered = store.listOrphanCandidateCanvases(OTHER, { isSessionCurrent: notCurrent })
    expect(offered).toHaveLength(1)
    expect(Date.parse(offered[0].lastRenderedAt)).toBeLessThanOrEqual(Date.now())
  })
})
