// ccc-ux:// protocol + canvas store — the serving-confinement suite.
//
// Real filesystem in a temp resources dir (the resolver's containment layers
// are exactly what mocked fs cannot exercise): traversal, encoding tricks,
// Windows colon forms, junction/symlink escape, SPA fallback, CSP + header
// discipline, and store round-trips including the restart rescan.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { vi } from 'vitest'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-ux-proto-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const { registerCanvasUatRoot } = store
const { handleCccUxRequest, injectBridgeTag, sanitizeContentPath } = await import(
  '../../../src/main/canvas/ccc-ux-protocol'
)

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const DESIGN_HTML = '<!doctype html><html><head><title>t</title></head><body><button data-ux-id="save">Save</button></body></html>'

function get(url: string, method = 'GET'): Promise<Response> {
  return handleCccUxRequest(new Request(url, { method }))
}

let outsideDir: string

beforeEach(() => {
  store._resetCanvasStoreForTest()
  // Memory reset alone is not isolation: the lazy disk rescan would resurrect
  // earlier tests' canvases from the shared temp resources dir.
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
    if (outsideDir) fs.rmSync(outsideDir, { recursive: true, force: true })
  } catch {
    /* best-effort temp cleanup */
  }
})

// ---------------------------------------------------------------------------
// sanitizeContentPath — the segment filter (layer 1)
// ---------------------------------------------------------------------------

describe('sanitizeContentPath', () => {
  it('accepts plain nested names', () => {
    expect(sanitizeContentPath(['assets', 'app.js'])).toEqual(['assets', 'app.js'])
  })

  it.each([
    [['..']],
    [['.']],
    [['a', '..', 'b']],
    [['%2e%2e']], // decodes to '..'
    [['..%2f..']], // decodes to '../..'
    [['a\\b']],
    [['C:', 'windows']],
    [['file.txt::$DATA']], // NTFS alternate data stream
    [['a\0b']],
    [['%00']],
    [['%zz']], // malformed percent-encoding
  ])('rejects %j', (segments) => {
    expect(sanitizeContentPath(segments as string[])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// injectBridgeTag
// ---------------------------------------------------------------------------

describe('injectBridgeTag', () => {
  it('injects before </head> when present', () => {
    const out = injectBridgeTag('<html><head><title>x</title></head><body></body></html>')
    expect(out).toContain('canvas-bridge.js')
    expect(out.indexOf('canvas-bridge.js')).toBeLessThan(out.indexOf('</head>'))
  })

  it('falls back to </body>, then to append', () => {
    expect(injectBridgeTag('<body>hi</body>').indexOf('canvas-bridge.js')).toBeLessThan(
      injectBridgeTag('<body>hi</body>').indexOf('</body>'),
    )
    expect(injectBridgeTag('no tags at all')).toContain('canvas-bridge.js')
  })
})

// ---------------------------------------------------------------------------
// serving — design mode
// ---------------------------------------------------------------------------

describe('design serving', () => {
  it('serves the document with bridge injection, design CSP, and header discipline', async () => {
    const { canvasId, versionId } = store.renderVersion(SID, { mode: 'design', html: DESIGN_HTML })
    expect(versionId).toBe('v1')

    const res = await get(`ccc-ux://${canvasId}/v1/index.html`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('data-ux-id="save"')
    expect(body).toContain('/__ccc__/canvas-bridge.js')

    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self' 'unsafe-inline'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("object-src 'none'")
  })

  it('empty path serves the entry; HEAD returns headers without a body', async () => {
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: DESIGN_HTML })
    const res = await get(`ccc-ux://${canvasId}/v1/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('data-ux-id="save"')

    const head = await get(`ccc-ux://${canvasId}/v1/index.html`, 'HEAD')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('Content-Security-Policy')).toBeTruthy()
  })

  it('serves the bridge script on its reserved path', async () => {
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: DESIGN_HTML })
    const res = await get(`ccc-ux://${canvasId}/__ccc__/canvas-bridge.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('javascript')
    expect(await res.text()).toContain('__cccCanvasBridge')
  })

  it('serves the analysis chunk the bridge imports on demand, and keeps it OUT of the bridge', async () => {
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: DESIGN_HTML })
    const res = await get(`ccc-ux://${canvasId}/__ccc__/canvas-analysis.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('javascript')
    const analysis = await res.text()
    expect(analysis).toContain('axe')

    // The whole point of the split: the always-injected script must not carry
    // the rule engine. axe-core is ~10x the bridge.
    const bridge = await (await get(`ccc-ux://${canvasId}/__ccc__/canvas-bridge.js`)).text()
    expect(bridge.length * 4).toBeLessThan(analysis.length)
  })

  it('injects only the bridge tag — the analysis chunk is never planted in the document', async () => {
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: DESIGN_HTML })
    const body = await (await get(`ccc-ux://${canvasId}/v1/index.html`)).text()
    expect(body).toContain('/__ccc__/canvas-bridge.js')
    expect(body).not.toContain('/__ccc__/canvas-analysis.js')
  })

  it('design mode has no SPA fallback — extensionless miss is 404', async () => {
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: DESIGN_HTML })
    expect((await get(`ccc-ux://${canvasId}/v1/some/route`)).status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// serving — uat mode
// ---------------------------------------------------------------------------

function makeDist(): string {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-ux-dist-'))
  fs.writeFileSync(path.join(dist, 'index.html'), '<html><head></head><body>app</body></html>')
  fs.mkdirSync(path.join(dist, 'assets'))
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)')
  fs.writeFileSync(path.join(dist, 'secret-sibling.txt'), 'inside-ok')
  // UAT roots are default-deny: the base the dist sits under must be registered
  // before renderVersion will accept it (serving still stays inside `dist`).
  registerCanvasUatRoot(SID, path.dirname(dist))
  return dist
}

describe('uat serving', () => {
  it('serves dist files with the uat CSP (no unsafe-inline scripts)', async () => {
    const dist = makeDist()
    const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: dist })

    const html = await get(`ccc-ux://${canvasId}/v1/index.html`)
    expect(html.status).toBe(200)
    expect(await html.text()).toContain('canvas-bridge.js')
    expect(html.headers.get('Content-Security-Policy')).toContain("script-src 'self';")

    const js = await get(`ccc-ux://${canvasId}/v1/assets/app.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('Content-Type')).toContain('javascript')
    expect(await js.text()).toBe('console.log(1)')
  })

  it('SPA fallback: extensionless route serves the entry; dotted miss stays 404', async () => {
    const dist = makeDist()
    const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: dist })
    const route = await get(`ccc-ux://${canvasId}/v1/settings/profile`)
    expect(route.status).toBe(200)
    expect(await route.text()).toContain('app')
    expect((await get(`ccc-ux://${canvasId}/v1/missing.png`)).status).toBe(404)
  })

  it('refuses a distRoot that does not exist or is a file', () => {
    expect(() => store.renderVersion(SID, { mode: 'uat', distRoot: path.join(os.tmpdir(), 'nope-' + Date.now()) })).toThrow()
    const f = path.join(os.tmpdir(), `ccc-ux-file-${Date.now()}.txt`)
    fs.writeFileSync(f, 'x')
    try {
      expect(() => store.renderVersion(SID, { mode: 'uat', distRoot: f })).toThrow()
    } finally {
      fs.unlinkSync(f)
    }
  })
})

// ---------------------------------------------------------------------------
// confinement — the point of the suite
// ---------------------------------------------------------------------------

describe('confinement', () => {
  it('rejects traversal in every shape it can arrive', async () => {
    const dist = makeDist()
    const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: dist })
    // A juicy target OUTSIDE the dist root, sibling to it in tmp.
    const leakName = `ccc-leak-${process.pid}.txt`
    const leakPath = path.join(path.dirname(dist), leakName)
    fs.writeFileSync(leakPath, 'LEAKED')
    try {
      const attempts = [
        `ccc-ux://${canvasId}/v1/../${leakName}`,
        `ccc-ux://${canvasId}/v1/..%2f${leakName}`,
        `ccc-ux://${canvasId}/v1/%2e%2e/${leakName}`,
        `ccc-ux://${canvasId}/v1/%2e%2e%2f${leakName}`,
        `ccc-ux://${canvasId}/v1/a/../../${leakName}`,
        `ccc-ux://${canvasId}/v1/..\\${leakName}`,
        `ccc-ux://${canvasId}/v1/%2e%2e%5c${leakName}`,
        `ccc-ux://${canvasId}/v1/index.html::$DATA`,
        `ccc-ux://${canvasId}/v1/index.html%00.png`,
      ]
      for (const url of attempts) {
        const res = await get(url)
        expect(res.status, url).toBe(404)
        expect(await res.text(), url).not.toContain('LEAKED')
      }
    } finally {
      fs.unlinkSync(leakPath)
    }
  })

  it('does not follow a directory link inside the tree to outside it', async (ctx) => {
    const dist = makeDist()
    registerCanvasUatRoot(SID, path.dirname(dist))
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-ux-outside-'))
    fs.writeFileSync(path.join(outsideDir, 'leak.txt'), 'LEAKED')
    let linked = false
    try {
      // 'junction' works unprivileged on Windows; plain dir symlink elsewhere.
      fs.symlinkSync(outsideDir, path.join(dist, 'link'), 'junction')
      linked = true
    } catch {
      /* environment forbids link creation */
    }
    // NEVER silently pass: a green here would falsely certify layer-3. If this
    // runner can't create links, mark the test SKIPPED (visible), not passed.
    if (!linked) return ctx.skip()
    const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: dist })
    const res = await get(`ccc-ux://${canvasId}/v1/link/leak.txt`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('LEAKED')
  })

  it('does not follow a linked ENTRY out of the tree on the SPA-fallback path', async (ctx) => {
    // The symlink test above covers the direct path. The fallback resolves a
    // SECOND file — the entry — and re-checks containment on it separately;
    // that check was the one no test reached, so a mutation deleting it went
    // unnoticed while its twin one branch over was pinned.
    //
    // The shape is a swap after registration: the entry passes validation as an
    // ordinary file and becomes a link afterwards, which is what a containment
    // check re-run at serve time exists to catch.
    // The entry is a plain relative path and may name a subdirectory, so the
    // link goes on the DIRECTORY — a junction, which needs no privilege on
    // Windows, where a file symlink does.
    const dist = makeDist()
    registerCanvasUatRoot(SID, path.dirname(dist))
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-ux-outside-entry-'))
    fs.writeFileSync(path.join(outsideDir, 'index.html'), 'LEAKED')

    let linked = false
    try {
      fs.symlinkSync(outsideDir, path.join(dist, 'link'), 'junction')
      linked = true
    } catch {
      /* environment forbids link creation */
    }
    // Never silently pass: a green here without a link certifies nothing.
    if (!linked) return ctx.skip()

    const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: dist, entry: 'link/index.html' })
    // Extensionless, so the fallback runs rather than the direct path.
    const res = await get(`ccc-ux://${canvasId}/v1/settings/profile`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('LEAKED')
  })

  it('refuses a file past the served-size ceiling, and only past it', async () => {
    const dist = makeDist()
    // Sparse: the size is what the ceiling reads, and writing 64 MB of real
    // bytes to assert a refusal would cost more than the rest of the suite.
    const big = path.join(dist, 'big.bin')
    const fd = fs.openSync(big, 'w')
    fs.ftruncateSync(fd, 65 * 1024 * 1024)
    fs.closeSync(fd)
    const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: dist })

    expect((await get(`ccc-ux://${canvasId}/v1/big.bin`)).status).toBe(404)
    // A cap and not a blanket refusal: the ordinary file next to it still serves.
    expect((await get(`ccc-ux://${canvasId}/v1/assets/app.js`)).status).toBe(200)
  })

  it('applies the size ceiling to the ENTRY the SPA fallback reaches for', async () => {
    // Its own check on its own branch, and the one the direct-path test cannot
    // reach: the fallback resolves a second file and re-measures it there.
    const dist = makeDist()
    const fd = fs.openSync(path.join(dist, 'index.html'), 'w')
    fs.ftruncateSync(fd, 65 * 1024 * 1024)
    fs.closeSync(fd)
    const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: dist })

    expect((await get(`ccc-ux://${canvasId}/v1/settings/profile`)).status).toBe(404)
  })

  it('unknown canvas / version / malformed ids are uniform 404s', async () => {
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: DESIGN_HTML })
    expect((await get('ccc-ux://ffffffffffffffffffffffff/v1/index.html')).status).toBe(404)
    expect((await get(`ccc-ux://${canvasId}/v99/index.html`)).status).toBe(404)
    expect((await get(`ccc-ux://${canvasId}/not-a-version/index.html`)).status).toBe(404)
    expect((await get(`ccc-ux://${canvasId}/`)).status).toBe(404)
  })

  it('only GET and HEAD are allowed', async () => {
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: DESIGN_HTML })
    expect((await get(`ccc-ux://${canvasId}/v1/index.html`, 'POST')).status).toBe(405)
    expect((await get(`ccc-ux://${canvasId}/v1/index.html`, 'DELETE')).status).toBe(405)
  })
})

// ---------------------------------------------------------------------------
// store behaviour
// ---------------------------------------------------------------------------

describe('canvas store', () => {
  it('versions are monotonic, active follows the newest, state round-trips', () => {
    const first = store.renderVersion(SID, { mode: 'design', html: DESIGN_HTML })
    const second = store.renderVersion(SID, { mode: 'design', html: DESIGN_HTML.replace('Save', 'Send') })
    expect(first.canvasId).toBe(second.canvasId)
    expect(second.versionId).toBe('v2')

    const state = store.getCanvasStateForSession(SID)
    expect(state?.activeVersionId).toBe('v2')
    expect(state?.versions.map((v) => v.id)).toEqual(['v1', 'v2'])

    const switched = store.setActiveVersion(SID, 'v1')
    expect(switched.activeVersionId).toBe('v1')
    expect(() => store.setActiveVersion(SID, 'v9')).toThrow()
  })

  it('emits change events for renders and switches', () => {
    const events: string[] = []
    const off = store.onCanvasChanged((e) => events.push(`${e.sessionId}:${e.activeVersionId}`))
    store.renderVersion(SID, { mode: 'design', html: DESIGN_HTML })
    store.renderVersion(SID, { mode: 'design', html: DESIGN_HTML })
    store.setActiveVersion(SID, 'v1')
    off()
    store.renderVersion(SID, { mode: 'design', html: DESIGN_HTML })
    expect(events).toEqual([`${SID}:v1`, `${SID}:v2`, `${SID}:v1`])
  })

  it('survives a restart: cold store rescans canvases from disk', async () => {
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: DESIGN_HTML })
    store._resetCanvasStoreForTest() // "restart"
    const state = store.getCanvasStateForSession(SID)
    expect(state?.canvasId).toBe(canvasId)
    expect(state?.versions).toHaveLength(1)
    expect((await get(`ccc-ux://${canvasId}/v1/index.html`)).status).toBe(200)
  })

  it('ignores a corrupt canvas.json instead of serving it', async () => {
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: DESIGN_HTML })
    const jsonPath = path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json')
    fs.writeFileSync(jsonPath, '{ not json')
    store._resetCanvasStoreForTest()
    expect(store.getCanvasStateForSession(SID)).toBeNull()
    expect((await get(`ccc-ux://${canvasId}/v1/index.html`)).status).toBe(404)
  })

  it('rejects garbage session ids and design payloads', () => {
    expect(() => store.renderVersion('../evil', { mode: 'design', html: DESIGN_HTML })).toThrow()
    expect(() => store.renderVersion(SID, { mode: 'design', html: '' })).toThrow()
  })
})
