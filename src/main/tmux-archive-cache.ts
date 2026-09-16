import { app } from 'electron'
import * as https from 'https'
import * as crypto from 'crypto'
import * as path from 'path'
import * as fs from 'fs'
import { TMUX_STAGE_SHA256, tmuxStageAssetUrl, type TmuxStageTarget } from './ssh-tmux-stage'
import { logError } from './debug-logger'

// === #242 tier 4: host-side tmux archive cache ===
//
// Tier 4 pushes the SAME v3.7b release asset tier 3 would have curled, over
// the SSH tunnel itself, for remotes with no outbound egress at all. The
// host downloads each arch's archive AT MOST ONCE (per app install) into
// `app.getPath('userData')/tmux-cache/`, sha256-verifying it against the
// SAME `TMUX_STAGE_SHA256` constants ssh-tmux-stage.ts uses, and reuses the
// cached file for every later session that needs that arch. `userData`
// (not `getDataDirectory()`, the pattern github-update.ts uses for the
// ~100-200MB installer) is fine here — this archive is a few hundred KB and
// is not itself an executable staged for direct execution on THIS machine.

function tmuxCacheDir(): string {
  return path.join(app.getPath('userData'), 'tmux-cache')
}

function tmuxCachePath(arch: TmuxStageTarget): string {
  return path.join(tmuxCacheDir(), `tmux-${arch}.tar.gz`)
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * Read a previously-cached archive for `arch`, re-verifying its sha256
 * before trusting it. A cache file that fails verification (disk
 * corruption, a manual edit, a leftover from a since-changed pinned tag) is
 * deleted rather than returned, so the caller re-downloads instead of
 * repeatedly pushing a bad archive down every future session to this arch.
 */
function readCachedTmuxArchive(arch: TmuxStageTarget): Buffer | null {
  try {
    const p = tmuxCachePath(arch)
    if (!fs.existsSync(p)) return null
    const buf = fs.readFileSync(p)
    if (sha256Hex(buf) !== TMUX_STAGE_SHA256[arch]) {
      try { fs.unlinkSync(p) } catch { /* best-effort */ }
      return null
    }
    return buf
  } catch {
    return null
  }
}

/**
 * Per-request timeout for the tier-4 archive fetch -- applied to BOTH the
 * initial request and the redirect hop. Matches httpsDownload's shape
 * (github-update.ts:515, its 'timeout' handler ~:640) rather than inventing
 * a second one: a bare `https.get(url, cb)` with no `timeout` option and no
 * `req.on('timeout')` handler never gives up on a stalled connection on its
 * own (#242 finding F1). A few-hundred-KB release asset over a healthy link
 * completes in low single-digit seconds; 20s is generous without eating
 * meaningfully into DOWNLOAD_TIMEOUT_MS's 45s flow-level backstop
 * (pty-manager.ts's SSH branch, attemptTmuxPush).
 */
const TMUX_DOWNLOAD_REQUEST_TIMEOUT_MS = 20000

/**
 * Hard ceiling on the accumulated response body -- mirrors httpsDownload's
 * `maxBytes` parameter (github-update.ts:515). The real v3.7b release asset
 * is a few hundred KB; capping at a few MB catches a hostile/misbehaving
 * host serving an unbounded body long before it becomes a meaningful memory
 * concern (#242 finding F5). Checked ON THE WIRE in the `data` handler, not
 * after landing -- same reasoning as httpsDownload's own comment on this.
 */
const TMUX_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024

/**
 * Follow-up adversarial pass (coverage MAJOR): exported for tests.
 *
 * Every guard in this function was previously unreachable from the suite --
 * `attemptTmuxPush` goes through the `tmuxArchiveResolver` seam, which tests
 * stub ABOVE this level, so raising TMUX_ARCHIVE_MAX_BYTES to
 * Number.MAX_SAFE_INTEGER, or deleting the https-only redirect refusal
 * outright, left the entire targeted suite green. This is the function whose
 * unbounded body was a round-4 BLOCKER; its guards must be able to fail a test.
 * Exported (rather than reached through a new seam) so the tests drive the real
 * https path with a mocked `https.get`.
 */
export function _downloadAndCacheTmuxArchiveForTest(arch: TmuxStageTarget): Promise<Buffer | null> {
  return downloadAndCacheTmuxArchive(arch)
}

/**
 * Download the v3.7b release asset for `arch` from the SAME pinned URL
 * ssh-tmux-stage.ts's remote script would have curled, sha256-verify it
 * against the SAME embedded digest, and cache it on success. Resolves
 * `null` (never rejects) on ANY failure -- network error, non-2xx status,
 * or a digest mismatch -- so the caller's fallback path (fall through to the
 * unwrapped launch) is a single, uniform check regardless of WHY the bytes
 * couldn't be obtained.
 */
function downloadAndCacheTmuxArchive(arch: TmuxStageTarget): Promise<Buffer | null> {
  // #242 finding F6: same URL parts buildTmuxStageScript's remote curl/wget
  // fragment builds its `_url` from (ssh-tmux-stage.ts) -- see
  // ssh-tmux-push.test.ts's regression test tying the two together.
  const url = tmuxStageAssetUrl(arch)
  const collect = (res: import('http').IncomingMessage, resolve: (v: Buffer | null) => void, redirectsLeft: number, currentUrl: string): void => {
    // GitHub release assets 302 to a signed S3 URL -- one redirect hop is
    // the real-world shape; refuse to follow more than a couple to avoid an
    // unbounded chain against a misbehaving/hostile host.
    const loc = res.headers.location
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc && redirectsLeft > 0) {
      res.resume()
      // #242 round-2 MAJOR fix: `https.get` THROWS SYNCHRONOUSLY (not via
      // 'error') when its URL argument is not https or is relative/malformed
      // -- verified in this worktree (`https.get('http://x')` ->
      // ERR_INVALID_PROTOCOL; `https.get('/relative')` -> ERR_INVALID_URL).
      // `loc` here is a `Location` header taken straight from the response,
      // i.e. attacker/proxy-controlled -- a captive portal or misbehaving
      // proxy answering with a 302 to an `http://` login page or a relative
      // path would throw OUT of this response callback, past the try/catch
      // that wraps only the FIRST request below, into
      // process.on('uncaughtException') (debug-logger.ts) which re-throws
      // anything that isn't EPIPE/EIO -> Electron main process death.
      // Resolve `loc` against the CURRENT request's URL first (so a
      // relative Location is handled the way browsers/curl handle it, not
      // rejected outright) and refuse anything that resolves to a
      // non-https scheme, THEN wrap the redirect `https.get` call itself in
      // a try/catch -- the initial call already has one; this hop must not
      // be the exception.
      let nextUrl: URL
      try {
        nextUrl = new URL(loc, currentUrl)
      } catch {
        resolve(null)
        return
      }
      if (nextUrl.protocol !== 'https:') {
        resolve(null)
        return
      }
      try {
        // #242 finding F1: the redirect hop needs the SAME timeout handling
        // as the initial request below -- httpsDownload's shape
        // (github-update.ts:640) covers both hops, not just the first.
        const redirectReq = https.get(nextUrl, { timeout: TMUX_DOWNLOAD_REQUEST_TIMEOUT_MS }, (res2) => collect(res2, resolve, redirectsLeft - 1, nextUrl.toString()))
        redirectReq.on('error', () => resolve(null))
        redirectReq.on('timeout', () => { try { redirectReq.destroy(new Error('tmux tier-4 download timeout')) } catch {} })
      } catch {
        resolve(null)
      }
      return
    }
    if (!res.statusCode || res.statusCode >= 400) {
      res.resume()
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    // #242 finding F5: track accumulated length on the wire and bail past
    // TMUX_ARCHIVE_MAX_BYTES -- destroy(), not resume(), so the socket
    // actually stops instead of draining an unbounded body to /dev/null.
    let received = 0
    let overLimit = false
    res.on('data', (c: Buffer) => {
      if (overLimit) return
      received += c.length
      if (received > TMUX_ARCHIVE_MAX_BYTES) {
        overLimit = true
        logError(`[ssh] tmux tier-4 download for arch=${arch} exceeded the ${TMUX_ARCHIVE_MAX_BYTES}-byte cap -- discarding`)
        res.destroy()
        resolve(null)
        return
      }
      chunks.push(c)
    })
    res.on('end', () => {
      if (overLimit) return

      const buf = Buffer.concat(chunks)
      if (sha256Hex(buf) !== TMUX_STAGE_SHA256[arch]) {
        logError(`[ssh] tmux tier-4 download for arch=${arch} failed sha256 verification -- discarding`)
        resolve(null)
        return
      }
      try {
        fs.mkdirSync(tmuxCacheDir(), { recursive: true })
        fs.writeFileSync(tmuxCachePath(arch), buf)
      } catch (err) {
        // Cache write failing doesn't invalidate the verified bytes already
        // in hand -- this session's push still proceeds, just re-downloads
        // next time.
        logError(`[ssh] tmux tier-4 cache write failed for arch=${arch}: ${(err as Error)?.message ?? err}`)
      }
      resolve(buf)
    })
    res.on('error', () => resolve(null))
  }
  return new Promise((resolve) => {
    try {
      // #242 finding F1: httpsDownload's shape (github-update.ts:515/:640) --
      // the `timeout` option alone does not abort anything; only this
      // `req.on('timeout')` handler, destroying the request, actually does.
      const req = https.get(url, { timeout: TMUX_DOWNLOAD_REQUEST_TIMEOUT_MS }, (res) => collect(res, resolve, 2, url))
      req.on('error', () => resolve(null))
      req.on('timeout', () => { try { req.destroy(new Error('tmux tier-4 download timeout')) } catch {} })
    } catch {
      resolve(null)
    }
  })
}

/** Cache hit first; only reaches the network on a miss/failed verification. */
async function getOrDownloadTmuxArchive(arch: TmuxStageTarget): Promise<Buffer | null> {
  const cached = readCachedTmuxArchive(arch)
  if (cached) return cached
  return downloadAndCacheTmuxArchive(arch)
}

// #242 round-3 MAJOR fix (test coverage): attemptTmuxPush calls this
// indirection rather than getOrDownloadTmuxArchive directly, so tests can
// stub the tier-4 archive source (cache hit or fresh download) without
// touching the real filesystem/network -- mirrors the `_set*ForTest` seam
// pattern already used elsewhere in this codebase (see
// claude-account-identity.ts's `_setRootsForTest`). Reassigned ONLY by
// `_setTmuxArchiveResolverForTest`; every production code path always goes
// through the real `getOrDownloadTmuxArchive`.
let tmuxArchiveResolver: (arch: TmuxStageTarget) => Promise<Buffer | null> = getOrDownloadTmuxArchive

export function resolveTmuxArchive(arch: TmuxStageTarget): Promise<Buffer | null> {
  return tmuxArchiveResolver(arch)
}

/** Test-only: override (or, passing `null`, restore) the tier-4 archive
 *  source `attemptTmuxPush` calls, so a test can drive a full push without
 *  hitting disk or the network. */
export function _setTmuxArchiveResolverForTest(fn: ((arch: TmuxStageTarget) => Promise<Buffer | null>) | null): void {
  tmuxArchiveResolver = fn ?? getOrDownloadTmuxArchive
}
