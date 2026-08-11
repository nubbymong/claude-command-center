// Regression suite for the adversarial-review findings (2026-08-11): UAT
// distRoot must be confined to a registered base (default-deny), the entry
// must be re-validated on the disk-reload path, and the Win32 device/trailing
// forms must be rejected by the boundary itself — not left to libuv.
//
// Each test corresponds to a confirmed attacker repro. Reverting the fix it
// guards makes it fail (verified during authoring).

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-ux-conf-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const { handleCccUxRequest, sanitizeContentPath } = await import('../../../src/main/canvas/ccc-ux-protocol')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'

function get(url: string): Promise<Response> {
  return handleCccUxRequest(new Request(url))
}

let secretDir: string

beforeEach(() => {
  store._resetCanvasStoreForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
    if (secretDir) fs.rmSync(secretDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

// The attacker's crown-jewel repro: point distRoot at a dir full of secrets.
function makeSecretDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-ux-secret-'))
  fs.writeFileSync(path.join(dir, 'id_rsa'), 'PRIVATE-KEY-BYTES')
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>x</body></html>')
  return dir
}

describe('UAT distRoot confinement (default-deny allowlist)', () => {
  it('refuses an arbitrary distRoot when no base is registered', () => {
    secretDir = makeSecretDir()
    expect(() => store.renderVersion(SID, { mode: 'uat', distRoot: secretDir })).toThrow(/registered canvas UAT root/i)
    expect(store.getCanvasStateForSession(SID)).toBeNull()
  })

  it('ignores a relative/empty base so it cannot silently allowlist cwd', () => {
    secretDir = makeSecretDir()
    // '' and '.' resolve to process.cwd(); registering them must be a no-op.
    store.registerCanvasUatRoot('')
    store.registerCanvasUatRoot('.')
    store.registerCanvasUatRoot('relative/path')
    expect(() => store.renderVersion(SID, { mode: 'uat', distRoot: secretDir })).toThrow(/registered canvas UAT root/i)
  })

  it('refuses a distRoot OUTSIDE a registered base', () => {
    secretDir = makeSecretDir()
    // Register an unrelated base; the secret dir is not under it.
    const otherBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-ux-base-'))
    store.registerCanvasUatRoot(otherBase)
    expect(() => store.renderVersion(SID, { mode: 'uat', distRoot: secretDir })).toThrow(/registered canvas UAT root/i)
    fs.rmSync(otherBase, { recursive: true, force: true })
  })

  it('accepts a distRoot UNDER a registered base and still confines serving to it', async () => {
    secretDir = makeSecretDir()
    store.registerCanvasUatRoot(path.dirname(secretDir))
    const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: secretDir })
    // The registered dir serves (it is the content root)…
    expect((await get(`ccc-ux://${canvasId}/v1/id_rsa`)).status).toBe(200)
    // …but serving never climbs above the content root, even though the base is a level up.
    expect((await get(`ccc-ux://${canvasId}/v1/../id_rsa`)).status).toBe(404)
  })

  it('drops a disk-poisoned UAT record whose distRoot is not under a registered base (restart)', async () => {
    secretDir = makeSecretDir()
    // Hand-write a well-formed record aimed at the secret dir — no base registered.
    const canvasId = 'poisoned0000000000000001'
    const dir = path.join(getResourcesDirectory(), 'canvas', canvasId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'canvas.json'),
      JSON.stringify({
        canvasId,
        sessionId: SID,
        createdAt: new Date(0).toISOString(),
        activeVersionId: 'v1',
        versions: [{ id: 'v1', mode: 'uat', createdAt: new Date(0).toISOString(), source: { mode: 'uat', distRoot: secretDir, entry: 'index.html' } }],
      }),
    )
    store._resetCanvasStoreForTest() // "restart" — lazy rescan will find it
    // The record loads (shape is valid) but nothing serves: distRoot is unconfined.
    expect((await get(`ccc-ux://${canvasId}/v1/id_rsa`)).status).toBe(404)
    expect((await get(`ccc-ux://${canvasId}/v1/index.html`)).status).toBe(404)
  })
})

describe('entry re-validation on the disk-reload path (ADS / traversal)', () => {
  it('drops a record whose entry carries an ADS colon', async () => {
    const canvasId = 'adsentry00000000000000001'
    const dir = path.join(getResourcesDirectory(), 'canvas', canvasId, 'versions', 'v1')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>ok</body></html>')
    fs.writeFileSync(
      path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json'),
      JSON.stringify({
        canvasId,
        sessionId: SID,
        createdAt: new Date(0).toISOString(),
        activeVersionId: 'v1',
        versions: [{ id: 'v1', mode: 'design', createdAt: new Date(0).toISOString(), source: { mode: 'design', entry: 'index.html:hidden' } }],
      }),
    )
    store._resetCanvasStoreForTest()
    // isValidRecord rejects the colon entry → the whole canvas is skipped.
    expect(store.getCanvasStateForSession(SID)).toBeNull()
    expect((await get(`ccc-ux://${canvasId}/v1/`)).status).toBe(404)
  })
})

describe('sanitizeContentPath is self-sufficient on Win32 forms', () => {
  it.each([
    [['index.html.']], // trailing dot (Win32 strips it)
    [['index.html%20'.replace('%20', ' ')]], // trailing space
    [['...']], // all-dot segment
    [['....']],
    [['con']], // reserved device basenames
    [['NUL']],
    [['com1']],
    [['LPT9.txt']], // device basename before extension
    [['aux']],
  ])('rejects %j without relying on the filesystem', (segments) => {
    expect(sanitizeContentPath(segments as string[])).toBeNull()
  })

  it('still accepts ordinary names that merely contain dots', () => {
    expect(sanitizeContentPath(['app.min.js'])).toEqual(['app.min.js'])
    expect(sanitizeContentPath(['v1.2.3', 'index.html'])).toEqual(['v1.2.3', 'index.html'])
  })
})
