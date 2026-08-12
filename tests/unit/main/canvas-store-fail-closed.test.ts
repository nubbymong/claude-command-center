// Regression for the adversarial-review finding (2026-08-12): a render whose
// durable write (persist) throws must leave NOTHING behind — no active version,
// nothing servable, no counter skew. The old order mutated the in-memory maps
// and only then wrote canvas.json, so a persist failure committed the rejected
// document as the active, servable version while the caller was told the render
// failed. The canvas_render MCP tool makes that sink agent-reachable.
//
// Reverting the fix in renderVersion (persist-before-commit) makes this fail.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-store-fc-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'

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

describe('a render whose persist throws leaves nothing behind', () => {
  it('does not commit, serve, or count the version when canvas.json cannot be written', () => {
    // v1 renders cleanly and is the active, servable version.
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>one</p>' })
    expect(store.getServableVersion(canvasId, 'v1')).not.toBeNull()
    expect(store.getCanvasStateForSession(SID)?.activeVersionId).toBe('v1')

    // Make the next persist fail the way a held handle / ENOSPC would: turn the
    // canvas.json path into a directory so the atomic write cannot land.
    const jsonPath = path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json')
    fs.rmSync(jsonPath, { force: true })
    fs.mkdirSync(jsonPath)

    // The render is rejected — the throw propagates, which the MCP tool turns
    // into isError.
    expect(() => store.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>two</p>' })).toThrow()

    // The fail-closed property: v2 is not the active version and is not
    // servable. Before the fix it was both.
    expect(store.getCanvasStateForSession(SID)?.activeVersionId).toBe('v1')
    expect(store.getServableVersion(canvasId, 'v2')).toBeNull()

    // And the counter did not skew: with the write path restored, the next
    // render is v2, not v3.
    fs.rmSync(jsonPath, { recursive: true, force: true })
    const again = store.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>two-b</p>' })
    expect(again.versionId).toBe('v2')
    expect(store.getServableVersion(canvasId, 'v2')).not.toBeNull()
  })
})
