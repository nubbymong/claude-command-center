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
//      mkdirSecure's trust roots).
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
import { getServableVersion, ServableVersion } from './canvas-store'
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

function serveFile(filePath: string, servable: ServableVersion, isEntryHtml: boolean, method: string): Response {
  const ext = path.extname(filePath).toLowerCase()
  const isHtml = isEntryHtml || ext === '.html' || ext === '.htm'
  const csp = servable.mode === 'design' ? DESIGN_CSP : UAT_CSP
  const contentType = isHtml ? MIME_BY_EXT['.html'] : (MIME_BY_EXT[ext] ?? 'application/octet-stream')

  if (isHtml) {
    const html = injectBridgeTag(fs.readFileSync(filePath, 'utf8'))
    return new Response(method === 'HEAD' ? null : html, { status: 200, headers: baseHeaders(contentType, csp) })
  }
  const data = fs.readFileSync(filePath)
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
      if (stat.isDirectory()) return notFound()
      const realEntry = fs.realpathSync.native(filePath)
      if (realEntry !== realRoot && !realEntry.startsWith(realRoot + path.sep)) return notFound()
      if (stat.size > MAX_SERVED_FILE_BYTES) return notFound()
      // Serve the canonical (link-resolved) path, matching the main branch — no
      // window between the containment check and the read where the lexical
      // path could resolve elsewhere.
      return serveFile(realEntry, servable, true, method)
    }

    let realTarget: string
    try {
      realTarget = fs.realpathSync.native(filePath)
    } catch {
      return notFound()
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return notFound()
    if (stat.size > MAX_SERVED_FILE_BYTES) return notFound()

    return serveFile(realTarget, servable, isEntryRequest, method)
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
