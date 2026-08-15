// BLOCKER 1, second half (adversarial review, 2026-08-15) — the READ
// PRIMITIVE. Confining WHICH paths may be read is only half a boundary; the
// other half is what "read that path" actually does. Three defects:
//
//   5. any file was served as HTML — `isHtml = isEntryHtml || ext === '.html'`
//      forced the ENTRY to text/html whatever it was and injected the bridge,
//      so a `.credentials.json` entry came back 200 text/html with a working
//      bridge and was then read back out of the DOM by the pre-allowed
//      canvas_snapshot;
//   6. the ccc-ux:// protocol had NO link check at any layer — a hard link
//      planted inside a served root defeats realpath with nothing to delete
//      and nothing to see (an OAuth token was served through one);
//   7. the one link check that existed (conductor-mcp-server's readDesignFile)
//      failed OPEN when the volume did not report link counts, and was a
//      TOCTOU: `statSync(real)` then a separate `readFileSync(real)` resolved
//      one path twice.
//
// Hard links are the load-bearing mechanism here and they are created for real
// (`fs.linkSync`, no privilege needed on NTFS or POSIX). A run that cannot
// create one must FAIL, not skip quietly: the precondition is asserted.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-served-guards-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const { handleCccUxRequest, serveFile } = await import('../../../src/main/canvas/ccc-ux-protocol')
const { readCheckedFile } = await import('../../../src/main/utils/safe-file-read')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const SECRET = 'sk-ant-oat01-THE-OAUTH-TOKEN'

const tempDirs: string[] = []
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeProject(prefix: string): { project: string; dist: string } {
  const project = tmp(prefix)
  const dist = path.join(project, 'dist')
  fs.mkdirSync(dist)
  fs.writeFileSync(path.join(dist, 'index.html'), '<html><head></head><body>app</body></html>')
  store.registerCanvasUatRoot(SID, project)
  return { project, dist }
}

/** Create a hard link and PROVE it is one. A run whose filesystem silently
 *  copied instead would otherwise certify a guard it never exercised. */
function hardLink(target: string, link: string): void {
  fs.linkSync(target, link)
  expect(fs.statSync(link).nlink, 'precondition: the runner must support hard links').toBe(2)
}

beforeEach(() => {
  store._resetCanvasStoreForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

// ---------------------------------------------------------------------------
// Defect 5 — only a real .html file is a document
// ---------------------------------------------------------------------------

describe('a non-HTML entry is never served as HTML', () => {
  it('refuses the entry at render time', () => {
    const { dist } = makeProject('ccc-entry-render-')
    fs.writeFileSync(path.join(dist, '.credentials.json'), SECRET)
    expect(() => store.renderVersion(SID, { mode: 'uat', distRoot: dist, entry: '.credentials.json' })).toThrow(
      /entry must be an html file/i,
    )
    // A rejected render leaves nothing behind.
    expect(store.getCanvasStateForSession(SID)).toBeNull()
  })

  it('accepts the ordinary html entries (not a blanket refusal)', () => {
    const { dist } = makeProject('ccc-entry-ok-')
    fs.writeFileSync(path.join(dist, 'app.HTM'), '<html><head></head><body>x</body></html>')
    expect(() => store.renderVersion(SID, { mode: 'uat', distRoot: dist })).not.toThrow()
    expect(() => store.renderVersion(SID, { mode: 'uat', distRoot: dist, entry: 'app.HTM' })).not.toThrow()
  })

  it('drops a disk-poisoned record whose entry names a data file', async () => {
    const { dist } = makeProject('ccc-entry-disk-')
    fs.writeFileSync(path.join(dist, '.credentials.json'), SECRET)
    const canvasId = 'entrypoison00000000000001'
    const dir = path.join(getResourcesDirectory(), 'canvas', canvasId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'canvas.json'),
      JSON.stringify({
        canvasId,
        sessionId: SID,
        createdAt: new Date(0).toISOString(),
        activeVersionId: 'v1',
        versions: [
          {
            id: 'v1',
            mode: 'uat',
            createdAt: new Date(0).toISOString(),
            source: { mode: 'uat', distRoot: dist, entry: '.credentials.json' },
          },
        ],
      }),
    )
    store._resetCanvasStoreForTest()
    store.registerCanvasUatRoot(SID, path.dirname(dist))
    // The record never even loads: the entry is re-validated on the reload path
    // (isValidRecord → isSafeEntry → normalizeEntry), so the whole canvas is
    // skipped rather than repaired. Asserted separately from the 404 below
    // because the two are INDEPENDENT guards — the serve-side refusal would
    // answer 404 on its own, and a test pinned only to the status code cannot
    // tell which of them is still there.
    expect(store.getCanvasStateForSession(SID)).toBeNull()
    const res = await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v1/`))
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain(SECRET)
  })

  it('serveFile refuses to make a document out of a non-html file', () => {
    // The serve-side half, driven directly: reaching it end to end needs a FILE
    // symlink whose realpath changes the extension, which Windows refuses
    // without Developer Mode. Both halves exist so neither leans on the other.
    const { dist } = makeProject('ccc-entry-serve-')
    const data = path.join(dist, '.credentials.json')
    fs.writeFileSync(data, SECRET)
    const servable = { mode: 'uat' as const, contentRoot: dist, entry: 'index.html' }
    expect(serveFile(data, servable, true, 'GET')).toBeNull()
  })

  it('serves a non-html file as its own type, and never with the bridge', async () => {
    // The other side of the same coin: a data file requested BY NAME is an
    // ordinary asset of the dist, and it must arrive as itself — not dressed as
    // a document, and never with the bridge script attached.
    const { dist } = makeProject('ccc-entry-asset-')
    fs.writeFileSync(path.join(dist, 'data.json'), '{"a":1}')
    const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: dist })
    const res = await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v1/data.json`))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(await res.text()).not.toContain('canvas-bridge.js')
  })
})

// ---------------------------------------------------------------------------
// Defect 6 — the protocol refuses a hard link inside a served root
// ---------------------------------------------------------------------------

describe('a hard link planted inside a served root is refused by the protocol', () => {
  it('does not serve an OAuth token hard-linked into the dist', async () => {
    const { project, dist } = makeProject('ccc-link-serve-')
    const victim = path.join(project, 'stand-in-for-dot-claude.json')
    fs.writeFileSync(victim, SECRET)
    hardLink(victim, path.join(dist, 'assets.json'))

    const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: dist })
    const res = await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v1/assets.json`))
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain(SECRET)
    // Realpath says the link lives inside the root — that is precisely why
    // layers 1-3 all passed and a fourth was needed.
    expect(fs.realpathSync.native(path.join(dist, 'assets.json')).startsWith(fs.realpathSync.native(dist))).toBe(true)
  })

  it('refuses a hard-linked ENTRY document too', async () => {
    const { project, dist } = makeProject('ccc-link-entry-')
    const victim = path.join(project, 'secret.html')
    fs.writeFileSync(victim, `<html><body>${SECRET}</body></html>`)
    fs.rmSync(path.join(dist, 'index.html'))
    hardLink(victim, path.join(dist, 'index.html'))

    const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: dist })
    const res = await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v1/`))
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain(SECRET)
  })

  it('still serves the ordinary single-named files beside it', async () => {
    const { project, dist } = makeProject('ccc-link-ok-')
    fs.writeFileSync(path.join(project, 'victim.txt'), SECRET)
    hardLink(path.join(project, 'victim.txt'), path.join(dist, 'linked.txt'))
    fs.writeFileSync(path.join(dist, 'plain.txt'), 'ordinary')
    const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: dist })
    expect((await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v1/plain.txt`))).status).toBe(200)
    expect((await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v1/index.html`))).status).toBe(200)
  })
})

// (Defect 7 — the reader itself — is safe-file-read.test.ts: proving it needs
// the fs module instrumented, which has to be a module mock, which has to be
// its own file.)

// ---------------------------------------------------------------------------
// The design-file read (canvas_render htmlPath) uses the same primitive
// ---------------------------------------------------------------------------

describe('the htmlPath read is confined AND link-checked', () => {
  it('refuses a hard link inside the project, and reads the real mockup', () => {
    const { project } = makeProject('ccc-html-path-')
    const victim = path.join(project, 'credentials.json')
    fs.writeFileSync(victim, SECRET)
    const planted = path.join(project, 'mockup.html')
    hardLink(victim, planted)
    const genuine = path.join(project, 'real-mockup.html')
    fs.writeFileSync(genuine, '<html><body>ok</body></html>')

    // What conductor-mcp-server's readDesignFile does, in order.
    const read = (p: string): Buffer => readCheckedFile(store.resolveInsideCanvasRoot(p, SID), 2 * 1024 * 1024)
    expect(() => read(planted)).toThrow(/not a regular file/i)
    expect(read(genuine).toString('utf8')).toContain('ok')
    // …and the confinement still bites first for anything outside.
    const outside = tmp('ccc-html-outside-')
    fs.writeFileSync(path.join(outside, 'x.html'), SECRET)
    expect(() => read(path.join(outside, 'x.html'))).toThrow(/registered canvas root/i)
  })
})
