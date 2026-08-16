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

/** Write a canvas.json straight to disk — the reload path, which is the only
 *  way a record the current write ingress would refuse can exist at all.
 *
 *  SIGNED, with the store's own key. Records now carry a MAC and an unsigned
 *  one is refused before any of these guards runs — an unsigned fixture would
 *  make every test below pass without exercising the thing it names. What is
 *  under test here is a record CCC WROTE (under an older, laxer build) whose
 *  contents are dangerous, not a planted one. */
function writeCanvasJson(
  canvasId: string,
  versions: Array<{ id: string; mode: 'uat' | 'design'; source: Record<string, unknown> }>,
  activeVersionId?: string,
): void {
  const dir = path.join(getResourcesDirectory(), 'canvas', canvasId)
  fs.mkdirSync(dir, { recursive: true })
  const record = {
    canvasId,
    sessionId: SID,
    createdAt: new Date(0).toISOString(),
    activeVersionId: activeVersionId ?? versions[versions.length - 1]?.id ?? null,
    versions: versions.map((v) => ({ ...v, createdAt: new Date(0).toISOString() })),
  }
  fs.writeFileSync(
    path.join(dir, 'canvas.json'),
    JSON.stringify({ ...record, mac: store._canvasRecordMacForTest(record) }),
  )
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

  it('never serves a disk-poisoned version whose entry names a data file', async () => {
    const { dist } = makeProject('ccc-entry-disk-')
    fs.writeFileSync(path.join(dist, '.credentials.json'), SECRET)
    const canvasId = 'entrypoison00000000000001'
    writeCanvasJson(canvasId, [
      { id: 'v1', mode: 'uat', source: { mode: 'uat', distRoot: dist, entry: '.credentials.json' } },
    ])
    store._resetCanvasStoreForTest()
    store.registerCanvasUatRoot(SID, path.dirname(dist))

    // The version is refused at serve time — one version, by itself, and by two
    // independent guards (getServableVersion's own HTML check, and serveFile's).
    // Asserted separately from the 404 because a test pinned only to the status
    // code cannot tell which of them is still there.
    expect(store.getServableVersion(canvasId, 'v1')).toBeNull()
    const res = await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v1/`))
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain(SECRET)
  })

  it('drops only the poisoned VERSION — the good ones beside it survive the load', async () => {
    // Regression: `isValidRecord` returned false for the whole record when any
    // one version failed, so a single legacy entry the current build will not
    // accept discarded every good design version beside it, and the user's
    // canvas came back empty after a restart.
    const { dist } = makeProject('ccc-entry-mixed-')
    fs.writeFileSync(path.join(dist, '.credentials.json'), SECRET)
    fs.writeFileSync(path.join(dist, 'good.html'), '<html><head></head><body>GOOD</body></html>')
    const canvasId = 'entrymixed00000000000001'
    writeCanvasJson(
      canvasId,
      [
        { id: 'v1', mode: 'uat', source: { mode: 'uat', distRoot: dist, entry: 'good.html' } },
        // not html — kept, never served
        { id: 'v2', mode: 'uat', source: { mode: 'uat', distRoot: dist, entry: '.credentials.json' } },
        // structurally dangerous — dropped from the record entirely
        { id: 'v3', mode: 'uat', source: { mode: 'uat', distRoot: dist, entry: '../escape.html' } },
      ],
      'v3',
    )
    store._resetCanvasStoreForTest()
    store.registerCanvasUatRoot(SID, path.dirname(dist))

    const state = store.getCanvasStateForSession(SID)
    expect(state).not.toBeNull()
    expect(state!.versions.map((v) => v.id)).toEqual(['v1', 'v2'])
    // The active version named a dropped one; it re-points to a surviving one
    // rather than leaving the pane pointed at nothing.
    expect(state!.activeVersionId).toBe('v2')

    // The good version really serves…
    const ok = await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v1/`))
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('GOOD')
    // …the non-html one never does…
    expect((await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v2/`))).status).toBe(404)
    // …and the traversing one is not in the record at all.
    expect(store.getServableVersion(canvasId, 'v3')).toBeNull()

    const { versionId } = store.renderVersion(SID, { mode: 'design', html: '<html><body>next</body></html>' })
    expect(versionId).toBe('v3')
  })

  it('a render after a dropped MIDDLE version does not reuse a surviving id', async () => {
    // Dropping versions puts gaps in the list, and `v${versions.length + 1}` —
    // which was correct only for a contiguous list — then mints an id a
    // surviving version already holds. Two versions, one serve key: the second
    // render would overwrite the first in every lookup.
    const { dist } = makeProject('ccc-entry-gap-')
    fs.writeFileSync(path.join(dist, 'two.html'), '<html><head></head><body>TWO</body></html>')
    fs.writeFileSync(path.join(dist, 'three.html'), '<html><head></head><body>THREE</body></html>')
    const canvasId = 'entrygap0000000000000001'
    writeCanvasJson(canvasId, [
      { id: 'v1', mode: 'uat', source: { mode: 'uat', distRoot: dist, entry: '../escape.html' } }, // dropped
      { id: 'v2', mode: 'uat', source: { mode: 'uat', distRoot: dist, entry: 'two.html' } },
      { id: 'v3', mode: 'uat', source: { mode: 'uat', distRoot: dist, entry: 'three.html' } },
    ])
    store._resetCanvasStoreForTest()
    store.registerCanvasUatRoot(SID, path.dirname(dist))
    expect(store.getCanvasStateForSession(SID)!.versions.map((v) => v.id)).toEqual(['v2', 'v3'])

    const { versionId } = store.renderVersion(SID, { mode: 'design', html: '<html><head></head><body>FOUR</body></html>' })
    expect(versionId).toBe('v4')
    // v3 still serves its own content, not the new render's.
    expect(await (await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v3/`))).text()).toContain('THREE')
    expect(await (await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v4/`))).text()).toContain('FOUR')
  })

  it('refuses an entry of ".html" — one predicate decides, at both ends', () => {
    // `/\.(html|htm)$/i` matches the whole string '.html'; `path.extname('.html')`
    // is ''. The store used the first and the protocol the second, so this entry
    // rendered and could never be served. Now both call isHtmlDocumentPath.
    const { dist } = makeProject('ccc-entry-dotonly-')
    fs.writeFileSync(path.join(dist, '.html'), '<html><head></head><body>x</body></html>')
    expect(() => store.renderVersion(SID, { mode: 'uat', distRoot: dist, entry: '.html' })).toThrow(
      /entry must be an html file/i,
    )
    const servable = { mode: 'uat' as const, contentRoot: dist, entry: '.html' }
    expect(serveFile(path.join(dist, '.html'), servable, true, 'GET')).toBeNull()
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
  it('serves a multiply-linked SUBORDINATE asset, and says so', async () => {
    // DELIBERATE SCOPE, not an oversight. Applying the link refusal to every
    // file of a served dist broke hardlink-deduplicated build output (pnpm,
    // `cp -al`, Nx/Turbo/Bazel cache restores): every chunk 404'd and the outer
    // catch logged nothing that named the file, so the user got a blank UAT
    // pane with no diagnosis. Containment still holds for these — lexical,
    // realpath, and the per-session root — and the anomaly is logged.
    //
    // What is NOT relaxed is the two objects the boundary exists for: the entry
    // document (below) and readDesignFile's model-named htmlPath.
    const { project, dist } = makeProject('ccc-link-serve-')
    const victim = path.join(project, 'chunk-source.js')
    fs.writeFileSync(victim, 'console.log(1)')
    hardLink(victim, path.join(dist, 'chunk.js'))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: dist })
      const res = await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v1/chunk.js`))
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('console.log(1)')
      // Diagnosable: the log names the file and the link count, not a shrug.
      const lines = warn.mock.calls.map((c) => String(c[0]))
      expect(lines.some((l) => l.includes('multiply-linked') && l.includes('chunk.js') && l.includes('nlink=2'))).toBe(
        true,
      )
    } finally {
      warn.mockRestore()
    }
    // Realpath says the link lives inside the root — that is precisely why
    // layers 1-3 all passed and a fourth was needed for the entry.
    expect(fs.realpathSync.native(path.join(dist, 'chunk.js')).startsWith(fs.realpathSync.native(dist))).toBe(true)
  })

  it('refuses a multiply-linked file in a DESIGN version, subordinate or not', async () => {
    // A design version's content root is CCC's own
    // `<resources>/canvas/<id>/versions/<vid>/`, written by the store itself. No
    // build tool populates it, so a second name for an inode there is never
    // ordinary — the build-output exemption has no reason to reach it.
    const { project } = makeProject('ccc-link-design-')
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: '<html><head></head><body>d</body></html>' })
    const victim = path.join(project, 'token.json')
    fs.writeFileSync(victim, SECRET)
    const versionDir = path.join(getResourcesDirectory(), 'canvas', canvasId, 'versions', 'v1')
    hardLink(victim, path.join(versionDir, 'aside.json'))

    const res = await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v1/aside.json`))
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain(SECRET)
  })

  it('refuses a hard-linked ENTRY document too, and names it in the log', async () => {
    const { project, dist } = makeProject('ccc-link-entry-')
    const victim = path.join(project, 'secret.html')
    fs.writeFileSync(victim, `<html><body>${SECRET}</body></html>`)
    fs.rmSync(path.join(dist, 'index.html'))
    hardLink(victim, path.join(dist, 'index.html'))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: dist })
      const res = await handleCccUxRequest(new Request(`ccc-ux://${canvasId}/v1/`))
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain(SECRET)
      // A uniform 404 is right for the CALLER and useless for the operator. The
      // refusal that is kept has to be diagnosable from the main-process log:
      // which file, which reason. (It stays in the log — never in the response
      // — so nothing about it reaches the model.)
      const lines = warn.mock.calls.map((c) => String(c[0]))
      expect(
        lines.some((l) => l.includes('refused to serve') && l.includes('index.html') && l.includes('entry=true')),
      ).toBe(true)
    } finally {
      warn.mockRestore()
    }
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
