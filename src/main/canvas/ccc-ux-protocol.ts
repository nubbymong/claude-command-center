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
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'"

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
  }
  if (csp) headers['Content-Security-Policy'] = csp
  return headers
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
    const html = injectBridgeTag(data.toString('utf8'))
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
