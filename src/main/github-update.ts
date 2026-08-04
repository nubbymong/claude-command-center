/**
 * GitHub Release update checker.
 *
 * Two update channels:
 *   - stable: only final releases (tags matching /^v\d+\.\d+\.\d+$/)
 *   - beta:   stable + pre-release betas (e.g. /^v\d+\.\d+\.\d+-beta(?:\.\d+)?$/)
 *
 * Three ways to talk to GitHub (cascading):
 *   1. Public GitHub API (anonymous) — works for public repos
 *   2. Authenticated API (gh auth token) — works for private repos if gh CLI is authed
 *   3. gh CLI (`gh release list`) — last resort fallback
 *
 * Once the repo is public, step 1 succeeds and steps 2-3 are never called.
 *
 * Downloads use direct HTTPS (follows redirects) and `gh release download` as a fallback.
 */
import { app } from 'electron'
import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { logInfo, logError } from './debug-logger'
import { readConfig } from './config-manager'
import { readRegistry } from './registry'
import { getDataDirectory } from './data-paths'

const execFileAsync = promisify(execFile)

/**
 * Installer asset extension per platform. Pure + exported for unit tests —
 * INSTALLER_EXT itself is baked from process.platform at module load, so tests
 * can't exercise other platforms through it.
 *
 * Linux ships as an AppImage. Before this mapping existed, Linux fell into the
 * `.exe` default: the checker then found no matching asset on any release and
 * skipped every update, so Linux installs were silently frozen at whatever
 * version they first installed.
 */
export function installerExtForPlatform(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return '.dmg'
  if (platform === 'linux') return '.AppImage'
  return '.exe'
}

const INSTALLER_EXT = installerExtForPlatform(process.platform)

const DEFAULT_REPO = 'nubbymong/claude-command-center'

/**
 * Validate a GitHub `owner/repo` slug against a strict pattern.
 * Prevents shell/argument injection if the value comes from the registry.
 * Allowed: alphanumerics, dashes, underscores, dots; one slash separator.
 */
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/

function getRepo(): string {
  const fromRegistry = readRegistry('GitHubRepo')
  if (fromRegistry && REPO_PATTERN.test(fromRegistry)) return fromRegistry
  if (fromRegistry) {
    logError(`[github-update] Ignoring invalid GitHubRepo registry value: ${JSON.stringify(fromRegistry)}`)
  }
  return DEFAULT_REPO
}

const REPO = getRepo()

export type UpdateChannel = 'stable' | 'beta'

interface GitHubAsset {
  name: string
  browser_download_url?: string  // public API field
  url?: string                    // gh CLI field (also direct download when authenticated)
  size?: number
}

interface GitHubRelease {
  tag_name: string   // public API
  tagName?: string    // gh CLI
  prerelease?: boolean
  draft?: boolean
  assets: GitHubAsset[]
}

interface ReleaseInfo {
  version: string
  tagName: string
  channel: UpdateChannel
  installerUrl: string | null
  installerName: string | null
}

// ── Channel matching ─────────────────────────────────────────────────────

/** Which channel does this tag belong to? Release candidates (-rc.N) ride the
 *  beta channel: they are prereleases offered to beta-channel users, ordered
 *  above betas of the same base version (see parseTag prereleaseRank). */
function classifyTag(tag: string): UpdateChannel | null {
  const stripped = tag.replace(/^v/, '')
  if (/^\d+\.\d+\.\d+$/.test(stripped)) return 'stable'
  if (/^\d+\.\d+\.\d+-(?:beta|rc)(\.\d+)?$/.test(stripped)) return 'beta'
  return null  // unknown format — ignore
}

/** Does this tag satisfy the user's chosen channel? */
function tagMatchesChannel(tag: string, channel: UpdateChannel): boolean {
  const tagChannel = classifyTag(tag)
  if (!tagChannel) return false
  // beta sees stable + beta
  if (channel === 'beta') return tagChannel === 'stable' || tagChannel === 'beta'
  // stable sees stable only
  return tagChannel === 'stable'
}

/**
 * Parse the DISPLAY version from a tag (strips v prefix and any prerelease suffix).
 * This is what gets shown to the user — e.g. 'v1.2.3-beta.2' → '1.2.3'.
 */
function parseVersion(tag: string): string {
  return tag.replace(/^v/, '').replace(/-(?:beta|dev|rc)(?:\.\d+)?$/, '')
}

/**
 * Parse a tag into its components for ordering.
 *
 * Returns { major, minor, patch, prereleaseRank, prereleaseNum }.
 *
 * prereleaseRank follows semver convention: final releases outrank prereleases.
 *   final:  Infinity
 *   rc.N:   3 (release candidate — closest to final)
 *   rc:     3, num = 0
 *   beta.N: 2 (beta is closer to final than dev)
 *   beta:   2, num = 0
 *   dev.N:  1
 *   dev:    1, num = 0
 */
interface TagComponents {
  major: number
  minor: number
  patch: number
  prereleaseRank: number
  prereleaseNum: number
}

function parseTag(tag: string): TagComponents | null {
  const stripped = tag.replace(/^v/, '')
  const m = stripped.match(/^(\d+)\.(\d+)\.(\d+)(?:-(beta|rc)(?:\.(\d+))?)?$/)
  if (!m) return null
  const [, maj, min, pat, pre, preN] = m
  let prereleaseRank = Number.POSITIVE_INFINITY
  let prereleaseNum = 0
  if (pre === 'beta') { prereleaseRank = 2; prereleaseNum = preN ? parseInt(preN, 10) : 0 }
  if (pre === 'rc') { prereleaseRank = 3; prereleaseNum = preN ? parseInt(preN, 10) : 0 }
  return {
    major: parseInt(maj, 10),
    minor: parseInt(min, 10),
    patch: parseInt(pat, 10),
    prereleaseRank,
    prereleaseNum,
  }
}

/**
 * Compare two tags including prerelease ordering.
 *   1.2.3       > 1.2.3-beta.2
 *   1.2.3-beta.2 > 1.2.3-beta.1
 *   1.2.3-beta  > 1.2.3-dev
 *   1.2.4-dev   > 1.2.3
 */
function compareTags(aTag: string, bTag: string): number {
  const a = parseTag(aTag)
  const b = parseTag(bTag)
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.prereleaseRank !== b.prereleaseRank) return a.prereleaseRank - b.prereleaseRank
  return a.prereleaseNum - b.prereleaseNum
}

/**
 * Compare a GitHub tag against the currently-running app version.
 *
 * The running app version (from `app.getVersion()` which reads `package.json`)
 * does not carry a prerelease suffix — electron-builder strips it from the
 * packaged version. So we compare the running version as if it were a final
 * release at that base version.
 *
 * Implications:
 *   - A user on 1.2.3 running the stable channel will NOT be offered
 *     1.2.3-beta.1 (1.2.3 > 1.2.3-beta.1 under our ordering). ✓
 *   - A user on 1.2.3 running the beta channel will NOT be offered
 *     1.2.3-beta.2 either — they must wait for 1.2.4-beta.* or a newer
 *     final release.
 *
 * Release-process constraint: this means our release workflow CANNOT
 * publish hotfix prereleases with a `.N` suffix (v1.2.3-beta.1 →
 * v1.2.3-beta.2) and expect existing users to see them. Every release
 * must bump the base version. `.github/workflows/release.yml` enforces
 * this by only emitting `v${version}-beta` and `v${version}-dev` tags
 * with no `.N` suffix — so the edge case above cannot occur in practice.
 *
 * If that ever changes, we'd need to persist the installed tag (including
 * any prerelease suffix) in app-meta at install time and compare against
 * that instead of `app.getVersion()`.
 */
function compareTagToCurrentVersion(tag: string, currentVersion: string): number {
  // Build a synthetic "final release" tag from the current version for comparison
  return compareTags(tag, `v${currentVersion}`)
}

// The authoritative running version. Baked from package.json at build time
// (__APP_VERSION__) so it carries the FULL prerelease suffix (e.g.
// "2.0.0-beta.1") regardless of whether electron-builder preserves it in
// app.getVersion() -- this is what makes numbered betas (beta.1 -> beta.2)
// detectable by the updater. Falls back to app.getVersion() in dev/tests where
// the define isn't injected.
declare const __APP_VERSION__: string
function getRunningVersion(): string {
  try {
    if (typeof __APP_VERSION__ === 'string' && __APP_VERSION__) return __APP_VERSION__
  } catch { /* not defined in this build/test context */ }
  return app.getVersion()
}

/** Read the update channel from user settings */
function getUpdateChannel(): UpdateChannel {
  try {
    const settings = readConfig<{ updateChannel?: string }>('settings')
    if (settings?.updateChannel === 'beta') return 'beta'
  } catch { /* fall through */ }
  return 'stable'
}

// ── Public GitHub API (anonymous) ────────────────────────────────────────

function httpGetJson<T = unknown>(url: string, timeoutMs = 10000, authToken?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: T | null }> {
  return new Promise((resolve, reject) => {
    const hdrs: Record<string, string> = {
      'User-Agent': 'claude-command-center-updater',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (authToken) hdrs['Authorization'] = `Bearer ${authToken}`
    const req = https.get(url, {
      headers: hdrs,
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        const status = res.statusCode || 0
        const headers = res.headers as Record<string, string | string[] | undefined>
        try {
          const body = status >= 200 && status < 300 ? JSON.parse(text) as T : null
          resolve({ status, headers, body })
        } catch {
          resolve({ status, headers, body: null })
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
  })
}

/** Public API fetch result — lets callers distinguish "should fall back" from "give up". */
type PublicFetchResult =
  | { kind: 'ok'; releases: GitHubRelease[] }
  | { kind: 'not-found' }        // 404 — repo might be private, try gh CLI
  | { kind: 'rate-limited' }     // 403 with rate-limit header — don't fall back, just wait
  | { kind: 'error' }            // Network error or unexpected status — try gh CLI as best-effort

/**
 * Fetch releases via the public GitHub API.
 *
 * Distinguishes between:
 *   - 404: the repo doesn't exist or is private — try the gh CLI fallback
 *   - 403 with rate-limit header: API rate limit hit, gh CLI won't help — give up
 *   - 403 otherwise: treated as "error" and fall through to gh CLI
 */
// Fetch well beyond the total release count. GitHub's /releases (and `gh release
// list`) return releases in created_at order, and a release's created_at is the
// tagged commit's date — so a release tagged on an old commit sorts far down the
// list. Fetching a large page means we still see every release regardless of that
// ordering; selection is then purely by version tag (compareTags). Defense in
// depth alongside the release.yml `--target` fix. Shared by all three fetch paths.
const RELEASE_FETCH_LIMIT = 100

async function fetchReleasesPublic(limit = RELEASE_FETCH_LIMIT): Promise<PublicFetchResult> {
  try {
    const url = `https://api.github.com/repos/${REPO}/releases?per_page=${limit}`
    const { status, headers, body } = await httpGetJson<GitHubRelease[]>(url)

    if (status >= 200 && status < 300 && Array.isArray(body)) {
      return { kind: 'ok', releases: body }
    }

    if (status === 404) {
      logInfo('[github-update] Public API returned 404 — repo not found or private, will try gh CLI')
      return { kind: 'not-found' }
    }

    if (status === 403) {
      // Distinguish "you hit the rate limit" from other 403s by checking the header.
      // Anonymous rate limit is 60 req/hour for public API — easy to exceed in dev.
      const remainingHeader = headers['x-ratelimit-remaining']
      const remaining = typeof remainingHeader === 'string' ? parseInt(remainingHeader, 10) : NaN
      if (!isNaN(remaining) && remaining === 0) {
        const resetHeader = headers['x-ratelimit-reset']
        const reset = typeof resetHeader === 'string' ? parseInt(resetHeader, 10) : 0
        const resetDate = reset ? new Date(reset * 1000).toISOString() : 'unknown'
        logError(`[github-update] Public API rate-limited (resets at ${resetDate}) — skipping update check`)
        return { kind: 'rate-limited' }
      }
      // Not a rate limit — could be anything else. Try gh CLI as a best effort.
      logInfo('[github-update] Public API returned 403 (not rate-limited) — will try gh CLI')
      return { kind: 'error' }
    }

    logInfo(`[github-update] Public API unexpected status ${status}`)
    return { kind: 'error' }
  } catch (err) {
    logInfo(`[github-update] Public API error: ${(err as Error).message}`)
    return { kind: 'error' }
  }
}

// ── Authenticated API fallback (for private repos) ──────────────────────

/** Try to get a GitHub token from `gh auth token` */
async function getGhToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    })
    const token = stdout.trim()
    return token.length > 0 ? token : null
  } catch {
    return null
  }
}

/** Fetch releases using an authenticated GitHub API call */
async function fetchReleasesAuthenticated(limit = RELEASE_FETCH_LIMIT): Promise<GitHubRelease[] | null> {
  const token = await getGhToken()
  if (!token) {
    logInfo('[github-update] No gh auth token available — skipping authenticated API')
    return null
  }

  try {
    const url = `https://api.github.com/repos/${REPO}/releases?per_page=${limit}`
    const { status, body } = await httpGetJson<GitHubRelease[]>(url, 10000, token)

    if (status >= 200 && status < 300 && Array.isArray(body)) {
      logInfo(`[github-update] Authenticated API returned ${body.length} releases`)
      return body
    }

    logInfo(`[github-update] Authenticated API returned status ${status}`)
    return null
  } catch (err) {
    logInfo(`[github-update] Authenticated API error: ${(err as Error).message}`)
    return null
  }
}

// ── gh CLI fallback (for private repos during dev) ───────────────────────

async function fetchReleasesGhCli(limit = RELEASE_FETCH_LIMIT): Promise<GitHubRelease[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['release', 'list', '--repo', REPO, '--limit', String(limit), '--json', 'tagName,isPrerelease,isDraft,assets'],
      { encoding: 'utf-8', timeout: 15000, windowsHide: true }
    )
    const releases = JSON.parse(stdout) as Array<{
      tagName: string
      isPrerelease: boolean
      isDraft: boolean
      assets: Array<{ name: string; url: string; size: number }>
    }>
    return releases.map((r) => ({
      tag_name: r.tagName,
      tagName: r.tagName,
      prerelease: r.isPrerelease,
      draft: r.isDraft,
      assets: r.assets.map((a) => ({ name: a.name, url: a.url, size: a.size })),
    }))
  } catch (err) {
    logInfo(`[github-update] gh CLI error: ${(err as Error).message}`)
    return null
  }
}

/**
 * Cascading release fetch:
 *   1. Public API (anonymous) — works for public repos
 *   2. Authenticated API (gh auth token) — works for private repos if user has gh CLI auth
 *   3. gh CLI (`gh release list`) — last resort, may fail if gh isn't on PATH
 *
 * Rate-limited → give up (no fallback will help, user should wait)
 */
async function fetchReleases(): Promise<GitHubRelease[] | null> {
  const publicResult = await fetchReleasesPublic()

  if (publicResult.kind === 'ok') return publicResult.releases
  if (publicResult.kind === 'rate-limited') return null

  // not-found or error — try authenticated API first, then gh CLI
  logInfo('[github-update] Falling back to authenticated API')
  const authed = await fetchReleasesAuthenticated()
  if (authed) return authed

  logInfo('[github-update] Falling back to gh CLI')
  return fetchReleasesGhCli()
}

// ── Main API ─────────────────────────────────────────────────────────────

/**
 * Check GitHub for the latest release matching the current channel.
 * Returns release info if a newer version exists, null otherwise.
 */
export async function checkGitHubRelease(): Promise<ReleaseInfo | null> {
  const currentVersion = getRunningVersion()
  const channel = getUpdateChannel()
  logInfo(`[github-update] Checking for updates (current: v${currentVersion}, channel: ${channel})`)

  const releases = await fetchReleases()
  if (!releases || releases.length === 0) {
    logInfo('[github-update] No releases fetched')
    return null
  }

  // Pick the newest release matching the channel that is strictly newer than current.
  // Uses full-tag comparison so prereleases of the same base version order deterministically
  // (1.2.3-beta.2 > 1.2.3-beta.1 > 1.2.3-dev.5, and 1.2.3 > any 1.2.3-prerelease).
  let best: { release: GitHubRelease; tag: string; version: string; channel: UpdateChannel } | null = null

  for (const rel of releases) {
    if (rel.draft) continue
    const tag = rel.tag_name || rel.tagName
    if (!tag) continue
    if (!tagMatchesChannel(tag, channel)) continue

    // Filter out tags whose format we don't understand
    if (!parseTag(tag)) continue

    // Strictly newer than the currently running app
    if (compareTagToCurrentVersion(tag, currentVersion) <= 0) continue

    if (!best || compareTags(tag, best.tag) > 0) {
      best = { release: rel, tag, version: parseVersion(tag), channel: classifyTag(tag)! }
    }
  }

  if (!best) {
    logInfo(`[github-update] Up to date (channel: ${channel})`)
    return null
  }

  // Accept either the legacy artifact prefix or the current brand one.
  //
  // Releases currently publish the SAME installer under both names: every client
  // in the wild matches the legacy prefix literally, so dropping it would make
  // them see "no matching asset" — which is indistinguishable from "up to date"
  // and unfixable, because the fix would only ship in the build they can no
  // longer see. Tolerating both here is what eventually lets the legacy name be
  // retired: once installs predating this build are gone, releases can publish
  // the brand name alone. Until then the legacy asset must keep being published.
  const INSTALLER_PREFIXES = ['ClaudeCommandCenter-', 'AI-Code-Conductor-']
  const installer = best.release.assets.find((a) =>
    a.name.endsWith(INSTALLER_EXT) && INSTALLER_PREFIXES.some((p) => a.name.startsWith(p))
  )

  // If there's no installer for the current platform, don't offer the update.
  // Otherwise the user would see "update available" but clicking Install fails.
  if (!installer) {
    logInfo(`[github-update] Skipping v${best.version} (tag: ${best.tag}) — no ${INSTALLER_EXT} asset for current platform`)
    return null
  }

  logInfo(`[github-update] Update available: v${best.version} (tag: ${best.tag}, channel: ${best.channel}, installer: ${installer.name})`)

  return {
    version: best.version,
    tagName: best.tag,
    channel: best.channel,
    installerUrl: installer.browser_download_url || installer.url || null,
    installerName: installer.name,
  }
}

// ── Download ─────────────────────────────────────────────────────────────

/**
 * Download a file from a URL to a destination path, following redirects.
 * Resolves true on success, false on any failure. Never throws or rejects.
 *
 * Robustness:
 *  - Handles file-stream errors (permission, disk full, etc.) without crashing.
 *  - Tracks a `settled` flag so we never resolve twice.
 *  - Cleans up the .part file on every failure path.
 *  - Aborts the active HTTP request when something fails mid-stream.
 */
function httpsDownload(url: string, destPath: string, timeoutMs = 300000, maxBytes?: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tmpPath = destPath + '.part'
    let file: fs.WriteStream
    try {
      file = fs.createWriteStream(tmpPath)
    } catch (err) {
      logError('[github-update] Failed to open .part file:', err)
      resolve(false)
      return
    }

    let settled = false
    let activeReq: ReturnType<typeof https.get> | null = null

    const cleanupTmp = () => { try { fs.unlinkSync(tmpPath) } catch {} }

    const fail = (reason?: unknown) => {
      if (settled) return
      settled = true
      if (reason !== undefined) logError('[github-update] Download error:', reason)
      if (activeReq) { try { activeReq.destroy() } catch {}; activeReq = null }
      const finish = () => { cleanupTmp(); resolve(false) }
      if (file.closed) finish()
      else file.close(() => finish())
    }

    file.on('error', (err) => fail(err))

    const doRequest = (reqUrl: string, hopsLeft: number) => {
      if (settled) return
      if (hopsLeft <= 0) { fail(new Error('too many redirects')); return }
      // Validate that the URL we're about to fetch is HTTPS. Prevents downgrade
      // to plaintext http:// and rejects anything exotic (ftp:, file:, etc).
      let parsedUrl: URL
      try {
        parsedUrl = new URL(reqUrl)
      } catch {
        fail(new Error(`invalid URL: ${reqUrl}`))
        return
      }
      if (parsedUrl.protocol !== 'https:') {
        fail(new Error(`refusing non-HTTPS URL: ${parsedUrl.protocol}`))
        return
      }
      try {
        activeReq = https.get(reqUrl, {
          headers: { 'User-Agent': 'claude-command-center-updater' },
          timeout: timeoutMs,
        }, (res) => {
          if (settled) { res.resume(); return }
          // Follow redirects — resolve against the current URL so relative
          // Location headers work, and re-validate the protocol on each hop.
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            // destroy(), not resume(). resume() DRAINS the redirect body and
            // discards it -- uncounted against maxBytes and, because activeReq
            // is nulled just below, no longer reachable by fail(). A 3xx with an
            // endless body then makes the main process read and throw away data
            // forever, on up to `hopsLeft` leaked sockets, past the point the
            // promise has already settled.
            res.destroy()
            activeReq = null
            let nextUrl: string
            try {
              nextUrl = new URL(res.headers.location, reqUrl).toString()
            } catch {
              fail(new Error(`invalid redirect Location: ${res.headers.location}`))
              return
            }
            doRequest(nextUrl, hopsLeft - 1)
            return
          }
          if (res.statusCode !== 200) {
            res.resume()
            fail(new Error(`HTTP ${res.statusCode}`))
            return
          }
          // Enforce the byte limit ON THE WIRE, not after landing (#174).
          // readManifest checks MAX_MANIFEST_BYTES by stat-ing the finished
          // file, which is too late: a hostile manifest endpoint can fill the
          // disk before that check ever runs. Content-Length is a fast reject
          // when honest; the running count is what actually holds, because the
          // header is attacker-supplied and a chunked response has none.
          if (maxBytes !== undefined) {
            const declared = Number(res.headers['content-length'])
            if (Number.isFinite(declared) && declared > maxBytes) {
              res.resume()
              fail(new Error(`response declares ${declared} bytes, over the ${maxBytes}-byte limit`))
              return
            }
            let received = 0
            res.on('data', (chunk: Buffer | string) => {
              received += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
              if (received > maxBytes) {
                // fail() destroys the request and unlinks the .part file, so
                // nothing past the limit is kept and the socket stops.
                fail(new Error(`response exceeded the ${maxBytes}-byte limit`))
              }
            })
          }
          res.on('error', (err) => fail(err))
          res.pipe(file)
          file.on('finish', () => {
            if (settled) return
            settled = true
            activeReq = null
            file.close(() => {
              try {
                // On Windows, renameSync fails if the destination already exists.
                // Remove any stale file (e.g. from a previous failed install attempt)
                // before the rename so retries work reliably on every platform.
                if (fs.existsSync(destPath)) {
                  try { fs.unlinkSync(destPath) } catch { /* non-fatal */ }
                }
                fs.renameSync(tmpPath, destPath)
                resolve(true)
              } catch (err) {
                logError('[github-update] rename failed:', err)
                cleanupTmp()
                resolve(false)
              }
            })
          })
        })
        activeReq.on('error', (err) => fail(err))
        activeReq.on('timeout', () => { try { activeReq?.destroy(new Error('download timeout')) } catch {} })
      } catch (err) {
        fail(err)
      }
    }

    doRequest(url, 5)
  })
}

// -- Installer integrity (#111) -------------------------------------------
//
// The updater downloads an installer and hands it to the OS to execute. That
// is a code-execution path on the user's machine, and until this landed there
// was NO client-side integrity check on any platform: Windows .exe is not
// code-signed here and SmartScreen only gates on Mark-of-the-Web (which a Node
// https download never sets); macOS .dmg has `dmg.sign: false` and a
// programmatic download carries no quarantine xattr; .AppImage has no OS check
// at all. `CHECKSUMS.txt` was already generated and attached to every release
// by the release workflow -- the client simply never read it.
//
// THREAT MODEL, stated narrowly so nobody over-trusts it. The manifest is
// fetched from the SAME host and the SAME release as the installer, so this
// does NOT defend against a tampered CDN edge, nor against anyone holding
// GitHub release-write credentials -- either of those rewrites both files
// together. What it DOES defend against is corruption, truncation, an
// interrupted or resumed download, and a partial compromise that replaces only
// the installer asset. Closing the rest requires SIGNING the manifest
// (ed25519/minisign in CI, public key pinned in the app). A floor, not a
// ceiling.

/** Hex digest shape. Anchored, fixed length, no quantifier to backtrack on. */
const HEX64 = /^[0-9a-f]{64}$/i

/**
 * Split one `sha256sum` line into [digest, filename] without a regex that can
 * backtrack.
 *
 * The obvious pattern -- `/^([0-9a-f]{64})\s+\*?(.+)$/i` -- is QUADRATIC, and
 * this repo has already paid for that once. A LINE SEPARATOR (U+2028) matches
 * `\s` but not `.`, so `<digest><many spaces>x\u2028y` forces the greedy `.+`
 * to fail and `\s+` to give back a character for every position in the run;
 * the non-whitespace tail defeats the outer `.trim()` that would otherwise
 * neuter it. Measured on the first version of this file: 1666 ms at 64k spaces,
 * 27 s at 256k, and the 1 MiB manifest cap put the ceiling around SEVEN MINUTES
 * of a fully blocked Electron main process -- every terminal frozen.
 *
 * That is the same shape as the Authorization-header bug fixed in #151
 * (`tests/unit/main/conductor-mcp-auth-redos.test.ts`), and it is worse here:
 * that one was capped by llhttp and `http.maxHeaderSize`, this one has no such
 * limiter and needs only CHECKSUMS.txt bytes -- strictly less than the
 * release-write access the threat model already concedes.
 *
 * So: index-based. Single pass, no backtracking, linear whatever the input.
 */
/** SP or HTAB -- the only separators `sha256sum` emits. */
function isSpOrHtab(c: string): boolean {
  return c === ' ' || c === '	'
}

function splitChecksumLine(line: string): [string, string] | null {
  const sp = line.search(/\s/)
  if (sp !== 64) return null
  const digest = line.slice(0, 64)
  if (!HEX64.test(digest)) return null
  let rest = line.slice(64)
  // Only SP/HTAB separate the digest from the name -- that is what sha256sum
  // emits. Any OTHER whitespace here means a hand-edited or hostile manifest,
  // so refuse the line rather than normalise it. Same narrowing as the
  // Authorization-header separator in #151, and for the same reason: a lenient
  // separator is one more shape a parser and a reader can disagree about.
  let i = 0
  while (i < rest.length && isSpOrHtab(rest[i])) i++
  if (i === 0) return null
  if (i < rest.length && /\s/.test(rest[i])) return null
  rest = rest.slice(i)
  if (rest.startsWith('*')) rest = rest.slice(1)
  if (!rest) return null
  return [digest, rest]
}

/** Refuse a manifest larger than this. A real one is a few hundred bytes, the
 *  read is synchronous, and it lands in the main process -- so an oversized
 *  body would be an OOM rather than a parse failure.
 *
 *  Exported so `scripts/verify-release-manifest.js` can be pinned to the SAME
 *  cap by test (#173). A release gate that accepts a manifest this client
 *  refuses is a release that passes CI and cannot be installed. */
export const MAX_MANIFEST_BYTES = 1024 * 1024

/**
 * Ceiling on the INSTALLER download. Generous on purpose -- the current assets
 * are 170-215 MB and this only exists so an unbounded response cannot fill the
 * disk before the digest check (which necessarily runs after the whole body has
 * landed) gets a chance to reject it. Sized so no plausible future build trips it
 * while still bounding the damage; the digest, not this, is what decides whether
 * the bytes are trustworthy.
 */
export const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024

/** A downloaded installer whose SHA-256 has been checked against the release
 *  manifest. Carries the digest so the caller can re-verify just before exec. */
export interface VerifiedInstaller {
  path: string
  sha256: string
}

/** Thrown when an installer was fetched but failed verification, so the caller
 *  can say THAT rather than blaming the user's network connection. */
export class InstallerIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallerIntegrityError'
  }
}

/**
 * Find the digest for `assetName` in a `sha256sum`-format manifest.
 *
 * Exported for tests. Returns null when the manifest is unparseable or does not
 * mention the asset -- callers MUST treat null as fatal, never as "skip the
 * check", or the whole control is bypassed by deleting one line.
 */
export function digestForAsset(manifest: string, assetName: string): string | null {
  if (!manifest || !assetName) return null
  let found: string | null = null
  for (const raw of manifest.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = splitChecksumLine(line)
    if (!parts) continue
    // `sha256sum *` emits bare names, but tolerate a path prefix.
    const name = parts[1].trim().replace(/^.*[/\\]/, '')
    if (name !== assetName) continue
    // A second line for the same asset means the manifest is ambiguous or
    // doctored. Refuse rather than pick one.
    if (found !== null && found !== parts[0].toLowerCase()) return null
    found = parts[0].toLowerCase()
  }
  return found
}

/** Stream the file through SHA-256. Streamed, not read into memory: installers
 *  are 100-200 MB and the main process should not buffer that. */
function sha256File(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const hash = crypto.createHash('sha256')
      const stream = fs.createReadStream(filePath)
      stream.on('error', () => resolve(null))
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('end', () => resolve(hash.digest('hex')))
    } catch {
      resolve(null)
    }
  })
}

/** Read a fetched manifest, refusing anything implausibly large. */
function readManifest(filePath: string): string | null {
  try {
    if (fs.statSync(filePath).size > MAX_MANIFEST_BYTES) {
      logError('[github-update] CHECKSUMS.txt is implausibly large; refusing to parse')
      return null
    }
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Derive the CHECKSUMS.txt URL from the installer's own asset URL, pinned to
 * the same origin.
 *
 * A plain `replace(/\/[^/]*$/, ...)` is not safe here: with no path it produces
 * `https://CHECKSUMS.txt` (a DIFFERENT HOST), and with a fragment or query it
 * rewrites inside those instead of the path -- `https://h/r/App.exe#/x/y`
 * becomes `...App.exe#/x/CHECKSUMS.txt`, and since `https.get` drops the
 * fragment, that FETCHES THE INSTALLER as the manifest. GitHub always supplies
 * a clean path today, so this is not reachable in production -- but the
 * function is exported, REPO is registry-overridable, and the guarantee is
 * stated unconditionally, so parse properly instead of pattern-matching.
 */
function deriveManifestUrl(directUrl?: string | null): string | null {
  if (!directUrl) return null
  try {
    const src = new URL(directUrl)
    const out = new URL(directUrl)
    out.hash = ''
    out.search = ''
    if (!out.pathname.includes('/')) return null
    out.pathname = out.pathname.replace(/[^/]*$/, 'CHECKSUMS.txt')
    if (out.origin !== src.origin) return null
    if (out.href === src.href) return null
    return out.href
  } catch {
    return null
  }
}

/**
 * Fetch CHECKSUMS.txt for a release, via the same cascade as the installer.
 *
 * Staged in the SAME kind of private mkdtemp directory as the installer (#174),
 * not `os.tmpdir()` under a `Date.now()` name. That old shape was worse than the
 * installer's, not better: on a multi-user POSIX box /tmp's sticky bit stops
 * another user UNLINKING our entry but not their pre-planting a SYMLINK at a
 * millisecond-guessable name, and `createWriteStream` opens without O_NOFOLLOW,
 * so the write follows the link -- and `renameSync` then moves the LINK to the
 * destination, leaving the attacker in control of the bytes `readManifest` reads.
 * This is the file that decides which digest counts as "verified", so it is the
 * last one that should have been left in a shared directory.
 */
async function fetchChecksumManifest(tagName: string, stageDir: string, directUrl?: string | null): Promise<string | null> {
  const tmpPath = path.join(stageDir, 'CHECKSUMS.txt')

  try {
    // 1. Direct HTTPS, deriving the manifest URL from the installer's own asset
    //    URL so it comes from the same release, same host.
    const manifestUrl = deriveManifestUrl(directUrl)
    if (manifestUrl) {
      if (await httpsDownload(manifestUrl, tmpPath, 60000, MAX_MANIFEST_BYTES)) {
        const text = readManifest(tmpPath)
        if (text) return text
      }
      try { fs.unlinkSync(tmpPath) } catch { /* best effort */ }
    }

    // 2. gh CLI fallback (private repos, and when the derived URL 404s).
    //    gh writes the whole body before we can see it, so readManifest's
    //    stat-based MAX_MANIFEST_BYTES check is the only limit on this leg --
    //    the post-hoc shape the direct leg no longer uses. Acceptable: it takes
    //    release-write access to publish an oversized CHECKSUMS.txt, which the
    //    threat model already concedes.
    await execFileAsync(
      'gh',
      ['release', 'download', tagName, '--repo', REPO, '--pattern', 'CHECKSUMS.txt', '--dir', stageDir, '--clobber'],
      { encoding: 'utf-8', timeout: 60000, windowsHide: true }
    )
    if (fs.existsSync(tmpPath)) return readManifest(tmpPath)
  } catch (err) {
    logError('[github-update] CHECKSUMS.txt fetch via gh CLI failed:', err)
  } finally {
    // Only the manifest file. The directory is the caller's, and the installer
    // is about to be downloaded into it.
    try { fs.unlinkSync(tmpPath) } catch { /* best effort */ }
  }

  return null
}

/**
 * Resolve the expected SHA-256 for `assetName` BEFORE downloading it.
 *
 * Deliberately front-loaded: an installer is 100-200 MB and the manifest a few
 * hundred bytes, so discovering "this release has no usable manifest" after the
 * big download wastes the user's bandwidth and delays the failure by minutes.
 * Returns null when no trustworthy digest exists -- callers must abort.
 */
async function resolveExpectedDigest(
  tagName: string,
  assetName: string,
  stageDir: string,
  directUrl?: string | null,
): Promise<string | null> {
  const manifest = await fetchChecksumManifest(tagName, stageDir, directUrl)
  if (!manifest) {
    logError('[github-update] CHECKSUMS.txt could not be fetched for this release')
    return null
  }
  const expected = digestForAsset(manifest, assetName)
  if (!expected) {
    logError(`[github-update] No SHA-256 entry for ${assetName} in CHECKSUMS.txt`)
    return null
  }
  return expected
}

/**
 * Hash the downloaded file and compare it against the expected digest.
 *
 * FAILS CLOSED. On mismatch or an unreadable file the download is destroyed and
 * false returned. If unlink fails (Windows file lock) the file is renamed to
 * `.INVALID` instead -- leaving an unverified installer under its expected name
 * is how someone ends up double-clicking it. Since #174 it is staged in a
 * private directory rather than ~/Downloads, which makes that far less likely to
 * be stumbled upon, but the file is still destroyed rather than trusted.
 */
async function confirmDigest(filePath: string, assetName: string, expected: string): Promise<boolean> {
  const actual = await sha256File(filePath)
  if (actual === expected) {
    logInfo(`[github-update] Integrity OK: ${assetName} sha256=${actual}`)
    return true
  }

  logError(
    `[github-update] INTEGRITY CHECK FAILED for ${assetName}: ` +
    `expected ${expected}, got ${actual ?? 'unreadable'} -- discarding`
  )
  // Truncate FIRST. We just wrote this file, so we can nearly always shrink it,
  // and a 0-byte file is inert no matter what unlink/rename do next. Without
  // this, a read-only attribute or a denied ACL leaves the tampered installer
  // sitting under its expected name -- while the error tells the user it was
  // discarded and points them at the release page.
  try { fs.truncateSync(filePath, 0) } catch { /* best effort */ }
  try {
    fs.unlinkSync(filePath)
  } catch {
    try {
      fs.renameSync(filePath, `${filePath}.INVALID`)
      logError(`[github-update] Could not delete it; renamed to ${filePath}.INVALID`)
    } catch (err) {
      logError('[github-update] Could not delete OR rename the failed download:', err)
    }
  }
  return false
}

/** Both integrity failure modes produce the same user-facing advice. */
function integrityFailure(assetName: string, why: string): InstallerIntegrityError {
  return new InstallerIntegrityError(
    `${assetName} ${why}. Install manually from the GitHub release page.`
  )
}

// -- Where an installer is staged (#174) ----------------------------------
//
// NOT ~/Downloads. The updater verifies the installer, kills every PTY, then
// spawns it with `allowElevation`, so the user is about to approve a UAC prompt
// for whatever sits at that path. In ~/Downloads the path is fully PREDICTABLE
// (the asset name is public in the release feed) and the directory is one every
// browser writes into.
//
// BE PRECISE ABOUT WHAT THIS BUYS. The stated attacker is a non-elevated process
// in the USER'S OWN SESSION -- which means it is the owner, so it does not have
// to guess the name: it can watch the root and see the new directory appear in
// milliseconds, and 0700 excludes only OTHER users. What moving out of
// ~/Downloads removes is the code-execution-free variant (a hostile page driving
// a browser download onto the publicly-known asset name), collisions with
// anything else writing that directory, and the chance of someone stumbling on a
// stale unverified installer and double-clicking it. `stillMatchesDigest`
// remains the control of record for the verify->spawn race. Do not read this as
// making the re-hash redundant.
//
// `updates/` under the app's OWN data directory (`getDataDirectory()`), not
// Electron's `userData` and not the system temp dir:
//   - not `temp`: on Linux that is the shared, world-writable /tmp, and it is
//     `noexec` on hardened boxes -- for a file we intend to EXECUTE.
//   - not `app.getPath('userData')`: on Windows that is %APPDATA%, which ROAMS.
//     Staging a 200 MB installer there syncs it to a file share at sign-out and
//     can trip a profile quota. `getDataDirectory()` uses %LOCALAPPDATA%, which
//     is what the rest of this app already uses for bulk data.
//   - and it honours CCC_DEV_DATA_DIR / CCC_E2E_DATA_DIR, so a dev instance
//     stages inside its own data root instead of the installed copy's.

const INSTALLER_DIR_PREFIX = 'ccc-upd-'

/**
 * Assert `dir` is a real directory, at the path we asked for, owned by us and
 * not group/other-writable.
 *
 * The parent of the staging directory is what an attacker actually needs: with
 * write access to it they can `rename()` the 0700 leaf away and substitute their
 * own. `mkdirSync(..., {recursive: true})` swallows EEXIST, so without this a
 * pre-planted SYMLINK (POSIX) or JUNCTION (Windows -- no admin required) at
 * `<dataDir>/updates` is followed silently and every future installer is staged
 * inside a directory the planter controls. Plant once, harvest every update.
 *
 * Only the FINAL component is checked against realpath: legitimate symlinks
 * higher up are normal (macOS /var -> /private/var), and rejecting those would
 * break the update for no security gain.
 */
export function assertPrivateDir(dir: string): void {
  const st = fs.lstatSync(dir)
  if (!st.isDirectory()) {
    throw new Error(`${dir} is not a directory (symlink or file) — refusing to stage an installer there`)
  }
  // NOTE ON COVERAGE: on every platform a planted redirect (POSIX symlink,
  // Windows junction) fails the check above, because lstat reports it as a link
  // rather than a directory. The realpath comparison below therefore has no
  // portable test -- the input that needs it (a bind mount or volume mount point
  // AT the final component, where lstat says "directory" and realpath diverges)
  // cannot be created without root. It is kept as the belt to that braces, not
  // because a test pins it.
  const resolvedParent = fs.realpathSync(path.dirname(dir))
  const expected = path.join(resolvedParent, path.basename(dir))
  const actual = fs.realpathSync(dir)
  if (path.resolve(actual) !== path.resolve(expected)) {
    throw new Error(`${dir} resolves to ${actual} — refusing to stage an installer through a redirected path`)
  }
  // POSIX only: Windows has no mode bits worth reading here (see chmod note in
  // createInstallerDir) and the profile ACL is what scopes it.
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    if (st.uid !== process.getuid()) {
      throw new Error(`${dir} is owned by uid ${st.uid}, not ${process.getuid()} — refusing to stage an installer there`)
    }
    if ((st.mode & 0o022) !== 0) {
      throw new Error(`${dir} is group- or world-writable (mode ${(st.mode & 0o777).toString(8)}) — refusing to stage an installer there`)
    }
  }
}

/**
 * The staging root. THROWS rather than falling back.
 *
 * There is deliberately no fallback chain. Every candidate a fallback could
 * reach is either shared (/tmp) or roaming (%APPDATA%), so "try the next one"
 * means "silently downgrade to the state this change exists to leave".
 *
 * A throw propagates: `downloadGitHubRelease` turns it into a plain Error (never
 * an InstallerIntegrityError -- a local storage problem is not a tamper event),
 * and `update-handlers` shows it in an "Update could not be downloaded" dialog.
 */
export function installerRoot(): string {
  return privateSubdir('updates')
}

/**
 * `<dataDir>/<name>`, created and validated.
 *
 * The data directory's OWN final component is lstat-checked too -- not the full
 * ownership/mode test (it may legitimately live on a mount or share whose uid
 * differs), just enough to refuse a symlink or junction dropped in its place.
 * That check is load-bearing rather than redundant: with the data directory
 * itself junctioned, `assertPrivateDir` on the subdirectory PASSES, because both
 * realpath calls resolve through the same junction and therefore agree.
 *
 * A redirect at a HIGHER component (e.g. %LOCALAPPDATA%) is not caught, and is
 * not meant to be: an attacker who can relocate the live data directory already
 * has the config, sessions and transcripts. The point is only that a file we are
 * about to EXECUTE must not be written through a redirect we could have seen.
 */
function privateSubdir(name: string): string {
  const base = getDataDirectory()
  fs.mkdirSync(base, { recursive: true })
  if (!fs.lstatSync(base).isDirectory()) {
    throw new Error(`${base} is not a directory (symlink or file) — refusing to stage an installer under it`)
  }
  const dir = path.join(base, name)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // TIGHTEN, then validate. `mkdirSync`'s mode is masked by the process umask,
  // so on a umask-002 box (per-user-group setups, many container images) the
  // directory lands 0775 -- and assertPrivateDir's group-write check then
  // rejects it. Because there is deliberately no fallback, that turned into a
  // PERMANENT, unrecoverable update failure for those users: the control this
  // change exists to add would have doubled as an update-killer. chmod is not
  // umask-masked, so this is what actually holds. It also repairs a directory an
  // older build left loose.
  // Unguarded by platform: chmod is a documented no-op on Windows (the same
  // reason createInstallerDir does it unguarded), and guarding it meant the line
  // could only be covered by a POSIX-only test.
  try { fs.chmodSync(dir, 0o700) } catch { /* validated below either way */ }

  // A filesystem with no POSIX mode bits (exFAT/vfat, CIFS with a fixed
  // dir_mode, a 9p/virtiofs VM share) accepts the chmod and changes nothing, so
  // the validation below would refuse with "group- or world-writable" and no hint
  // that we tried. The data directory is user-chosen at first run, so "on an
  // external drive or a network share" is a supported configuration -- say what
  // is actually wrong and what to do about it.
  if (process.platform !== 'win32') {
    try {
      if ((fs.statSync(dir).mode & 0o022) !== 0) {
        throw new Error(
          `${dir} is on a filesystem that cannot restrict permissions, so an installer `
          + 'cannot be staged there privately. Choose a data directory on a local disk in '
          + 'Settings, or install the update manually from the GitHub release page.'
        )
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('cannot restrict permissions')) throw err
      // A stat failure is assertPrivateDir's problem, not ours.
    }
  }

  assertPrivateDir(dir)
  return dir
}

/**
 * A fresh, owner-only, unpredictably-named directory to stage one download in.
 *
 * `mkdtemp` supplies the unpredictable name. 0700 keeps it to the owner on
 * POSIX. On Windows `chmod` is a documented NO-OP -- it succeeds and changes
 * nothing, so the catch never fires -- and containment there comes from the
 * inherited per-user profile ACL instead.
 *
 * `root` is injectable so tests can use a real scratch directory.
 */
export function createInstallerDir(root?: string): string {
  const base = root || installerRoot()
  const dir = fs.mkdtempSync(path.join(base, INSTALLER_DIR_PREFIX))
  try { fs.chmodSync(dir, 0o700) } catch { /* no-op on Windows */ }
  return dir
}

/**
 * Remove staging directories from previous updates, keeping `keep`.
 *
 * The successful path cannot clean up after itself: CCC spawns the installer and
 * exits, so the file must outlive the process. Pruning on the way IN bounds the
 * accumulation instead. Best-effort throughout -- a running installer holds a
 * lock on Windows, and a leftover directory is untidy, never unsafe. The inner
 * catch is load-bearing: the call site is not wrapped, so a throw here would
 * abort the whole update over a tidy-up.
 *
 * An entry that is NOT a real directory is unlinked, never recursed into. Node's
 * rimraf happens to lstat first and do the same, but this is a recursive delete
 * driven by `readdir` of a directory the attacker can write to, so the guard is
 * explicit here rather than inherited from an implementation detail: a
 * `ccc-upd-evil` symlink pointing at $HOME must cost the link, not the home
 * directory.
 */
export function pruneStaleInstallerDirs(root: string, keep?: string): number {
  let removed = 0
  let entries: string[]
  try { entries = fs.readdirSync(root) } catch { return 0 }
  for (const name of entries) {
    if (!name.startsWith(INSTALLER_DIR_PREFIX)) continue
    const full = path.join(root, name)
    if (keep && path.resolve(full) === path.resolve(keep)) continue
    try {
      if (!fs.lstatSync(full).isDirectory()) {
        fs.unlinkSync(full)
        removed += 1
        continue
      }
      fs.rmSync(full, { recursive: true, force: true })
      removed += 1
    } catch { /* locked by a running installer, or gone already */ }
  }
  return removed
}

/**
 * Where a launched AppImage is parked so the next update's prune cannot delete
 * the running application.
 *
 * `prepareLinuxAppImageUpdate` relocates the AppImage next to the running one
 * when $APPIMAGE is set, but returns the DOWNLOAD path unchanged when it cannot
 * (dev/extracted runs, an unwritable target, $APPIMAGE pointing at something
 * that is not a plain .AppImage). Before #174 that download path was
 * ~/Downloads, which nothing pruned. Inside the staging root it is
 * prune-eligible, so update N+1 would unlink the very file the user is running
 * -- and the app's location would change to a fresh random name every time,
 * orphaning any .desktop entry or dock pin.
 */
function appImageParkingPath(downloadedPath: string): string {
  // VALIDATED, like the staging root. This is the directory CCC will EXECUTE
  // from, so leaving it as a bare recursive mkdir would reintroduce the exact
  // plantable-redirect hole assertPrivateDir exists to close -- at the worst
  // possible place.
  return path.join(privateSubdir('bin'), path.basename(downloadedPath))
}

/**
 * Transport half: fetch the asset into a private staging directory, direct HTTPS
 * first then gh CLI. Performs NO integrity check -- callers must use
 * downloadGitHubRelease, which wraps this with verification. Exported only so
 * the download mechanics are unit-testable on their own.
 */
export async function downloadInstallerFile(tagName: string, assetName: string, directUrl?: string | null, existingStageDir?: string): Promise<string | null> {
  // The asset name comes from the release feed and is interpolated into a
  // filesystem path, so a name carrying a separator would escape the staging
  // directory and undo the point of it. REFUSE rather than silently basename it
  // down: a real asset never contains a separator, so a name that needs
  // sanitising means the feed is wrong and downloading whatever is left of it is
  // not the right recovery.
  // Both separators, on every platform. `path.basename` is platform-aware: on
  // POSIX a backslash is an ordinary filename character, so `..\evil.exe` came
  // back unchanged and passed the `safeName !== rawName` test. It stayed inside
  // the staging directory there (POSIX reads it as one long filename), so nothing
  // escaped -- but a guard whose verdict depends on the host is a guard that will
  // be wrong on one of them. The macOS CI leg caught this; the Windows leg could
  // not. A real asset name contains neither separator.
  const rawName = String(assetName || '')
  const safeName = path.basename(rawName)
  if (!safeName || safeName !== rawName || /[/\\]/.test(rawName) || safeName === '.' || safeName === '..') {
    logError(`[github-update] Refusing to download an asset with an unusable name: ${JSON.stringify(rawName)}`)
    return null
  }

  // downloadGitHubRelease creates ONE staging directory and passes it in, so the
  // manifest and the installer share it: two independent directories meant the
  // installer's prune could delete the one the manifest fetch was still using.
  let stageDir: string
  try {
    const root = installerRoot()
    stageDir = existingStageDir || createInstallerDir(root)
    pruneStaleInstallerDirs(root, stageDir)
  } catch (err) {
    logError('[github-update] Could not create a staging directory for the download:', err)
    return null
  }

  const destPath = path.join(stageDir, safeName)

  logInfo(`[github-update] Downloading ${safeName} to ${destPath}`)

  // 1. Try direct HTTPS download (works for public repo)
  if (directUrl) {
    const ok = await httpsDownload(directUrl, destPath, 300000, MAX_INSTALLER_BYTES)
    if (ok && fs.existsSync(destPath)) {
      logInfo(`[github-update] Downloaded via direct HTTPS: ${destPath}`)
      return destPath
    }
    logInfo('[github-update] Direct HTTPS download failed, trying gh CLI')
  }

  // 2. Fall back to gh CLI (works for private repo)
  try {
    await execFileAsync(
      'gh',
      ['release', 'download', tagName, '--repo', REPO, '--pattern', safeName, '--dir', stageDir, '--clobber'],
      { encoding: 'utf-8', timeout: 300000, windowsHide: true }
    )
    if (fs.existsSync(destPath)) {
      logInfo(`[github-update] Downloaded via gh CLI: ${destPath}`)
      return destPath
    }
  } catch (err) {
    logError('[github-update] gh CLI download failed:', err)
  }

  // Nothing usable landed. Only clean up a directory WE created: when the caller
  // supplied one it owns the lifetime (and may have other files in it).
  if (!existingStageDir) {
    try { fs.rmSync(stageDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  return null
}

/**
 * Download the installer for a release AND verify it. This is the function the
 * app uses; `downloadInstallerFile` above is the transport half, split out so
 * the download mechanics (redirects, gh fallback, stale-path handling) stay
 * testable without standing up a fake CHECKSUMS.txt for every case.
 *
 * Returns the verified path, or null if nothing could be downloaded.
 * Throws {@link InstallerIntegrityError} when the release cannot be verified,
 * or when a file WAS fetched and failed its digest -- outcomes the caller must
 * not conflate with "download failed", because the user-facing advice differs.
 */
export async function downloadGitHubRelease(tagName: string, assetName: string, directUrl?: string | null): Promise<VerifiedInstaller | null> {
  // ONE staging directory for the manifest and the installer.
  //
  // Created here, and a failure raises a PLAIN Error rather than an
  // InstallerIntegrityError. That distinction is user-facing: when the manifest
  // fetch owned its own directory, a disk-full mkdtemp or an unwritable data dir
  // returned null and the caller showed "Update blocked - integrity check
  // failed" -- reporting a local storage problem as a release TAMPER event.
  // False tamper signals are how real ones get ignored.
  let stageDir: string
  try {
    stageDir = createInstallerDir()
  } catch (err) {
    throw new Error(
      `Could not prepare a private folder to download the update into: ${(err as Error).message}. `
      + 'Check free disk space and that the data directory is writable.'
    )
  }

  const discard = (): void => {
    try { fs.rmSync(stageDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  // Manifest first -- see resolveExpectedDigest. No digest, no download.
  const expected = await resolveExpectedDigest(tagName, assetName, stageDir, directUrl)
  if (!expected) {
    discard()
    throw integrityFailure(assetName, `has no verified SHA-256 in release ${tagName}`)
  }

  const filePath = await downloadInstallerFile(tagName, assetName, directUrl, stageDir)
  if (!filePath) {
    discard()
    return null
  }

  if (!await confirmDigest(filePath, assetName, expected)) {
    // confirmDigest destroys the file; take the now-empty directory too.
    discard()
    throw integrityFailure(assetName, 'failed its SHA-256 check and was discarded')
  }
  return { path: filePath, sha256: expected }
}

/**
 * Re-hash a previously-verified installer immediately before executing it.
 *
 * The gap between verification and `spawn` is not small: the caller kills every
 * PTY in between, which takes tens of milliseconds to seconds. The installer is
 * launched with `allowElevation`, so a local process that wins that race gains
 * admin on a UAC prompt the user is already expecting. Re-hashing costs about a
 * second for 150 MB and shrinks the window to microseconds.
 *
 * #174 moved staging out of ~/Downloads but did NOT retire this. The attacker in
 * this model runs as the user, so an unpredictable directory name buys nothing
 * against it: the attacker owns the root and can watch it. What #174 removed is
 * the drive-by variant (a hostile page steering a browser download onto the
 * publicly-known asset name in a directory every browser writes into). THIS is
 * the control of record for the verify->spawn race.
 */
export async function stillMatchesDigest(filePath: string, expectedSha256: string): Promise<boolean> {
  const actual = await sha256File(filePath)
  if (actual === expectedSha256) return true
  logError(
    `[github-update] Installer changed between verification and launch ` +
    `(expected ${expectedSha256}, got ${actual ?? 'unreadable'})`
  )
  return false
}

/**
 * Best-effort check: is `targetPath` on a filesystem mounted `noexec`?
 *
 * `fs.accessSync(X_OK)` inspects the file's permission bits, not the mount, so
 * on a hardened box where the staging directory (or /home, or /tmp) is mounted
 * `noexec` a freshly chmod'd AppImage passes the access check yet `execve` fails
 * EACCES at launch. This is also why #174 stages under userData rather than the
 * system temp dir: /tmp is `noexec` far more often than $HOME.
 * Because CCC holds a single-instance lock, we cannot verify the relaunch by
 * spawning it first (the new instance can't start until we exit), so the update
 * flow uses this to abort BEFORE killing the user's terminals rather than after.
 *
 * Parses /proc/mounts and returns the `noexec` state of the longest mount point
 * that is a prefix of `targetPath`. Returns false whenever it can't tell (no
 * /proc/mounts, parse failure) — never block an update on a best-effort probe.
 * `procMounts` is injectable for tests.
 */
export function isPathOnNoexecMount(targetPath: string, procMounts?: string): boolean {
  let text: string | undefined
  try {
    text = procMounts ?? fs.readFileSync('/proc/mounts', 'utf-8')
  } catch { return false }
  if (typeof text !== 'string') return false

  let bestPointLen = -1
  let noexec = false
  for (const line of text.split('\n')) {
    const parts = line.split(/\s+/)
    if (parts.length < 4) continue
    const point = parts[1]
    const opts = parts[3]
    const prefix = point.endsWith('/') ? point : point + '/'
    if (targetPath === point || targetPath.startsWith(prefix)) {
      if (point.length > bestPointLen) {
        bestPointLen = point.length
        noexec = /(^|,)noexec(,|$)/.test(opts)
      }
    }
  }
  return noexec
}

// ── Linux AppImage apply ─────────────────────────────────────────────────

/**
 * Prepare a downloaded AppImage for launch and, when possible, put it where
 * the running AppImage lives. Returns the path the caller should spawn.
 *
 * Unlike Windows (the .exe IS an installer that installs over the old copy),
 * a downloaded AppImage is just a file: it arrives without the execute bit,
 * and launching it from the staging directory would leave the user's "real" copy
 * stale.
 * So: chmod +x always; then, when we're running AS an AppImage (AppImage
 * runtimes export $APPIMAGE = the file's own path), replace it in place.
 *
 * Replacement follows electron-updater's convention (electron-builder #2964) so
 * we don't orphan the user's launcher:
 *   - If the running file's name has NO version (the user renamed it to a stable
 *     path that a .desktop entry / dock pin / alias points at), overwrite AT THE
 *     SAME PATH — keep their name.
 *   - Only when the running name is itself versioned do we write the new
 *     versioned name and remove the old file.
 *   - $APPIMAGE is resolved through symlinks first (a stable `~/bin/ccc` link),
 *     the real file is replaced, and the symlink is re-pointed at the new file.
 * Deleting the running AppImage is safe on Linux — the mounted squashfs holds
 * the inode until the process exits.
 *
 * Guarded: $APPIMAGE is an environment variable a wrapper could point anywhere,
 * so we only ever unlink/overwrite a plain *.AppImage FILE — name-agnostic,
 * because users legitimately rename the image to a stable custom name (that's
 * the case finding #1 preserves), so we can't require our own name prefix.
 * Every failure degrades to launching straight from the download location —
 * never block the update on the tidy-up. `currentAppImage` is a parameter
 * (defaulting to $APPIMAGE) so tests can exercise all paths on any platform.
 */
export async function prepareLinuxAppImageUpdate(
  downloadedPath: string,
  currentAppImage: string | undefined = process.env.APPIMAGE,
  verify?: (candidate: string) => Promise<boolean>,
): Promise<string> {
  try { fs.chmodSync(downloadedPath, 0o755) } catch (err) {
    logError('[github-update] chmod +x on downloaded AppImage failed:', err)
  }

  // Every early return below hands back a path OUTSIDE the prune-eligible
  // staging root -- see appImageParkingPath. Returning `downloadedPath` itself
  // would leave the running application in a directory the next update deletes.
  const park = (): string => {
    // Only files actually sitting in a staging directory need moving. A
    // re-download straight onto the running AppImage's own path, or any other
    // location, is already outside the prune root -- copying it would be a
    // pointless 200 MB write. Checked against the prune root's LOCATION, not by
    // name alone, so a legitimate `~/ccc-upd-backup/App.AppImage` does not
    // trigger a spurious copy. Derived from the same `getDataDirectory() +
    // 'updates'` as installerRoot() so the two cannot drift -- but WITHOUT
    // calling it, because this must not depend on the root validating: a hostile
    // root would otherwise silently switch parking off.
    const parent = path.dirname(downloadedPath)
    const pruneRoot = path.join(getDataDirectory(), 'updates')
    if (path.resolve(path.dirname(parent)) !== path.resolve(pruneRoot)) return downloadedPath
    if (!path.basename(parent).startsWith(INSTALLER_DIR_PREFIX)) return downloadedPath
    try {
      const parked = appImageParkingPath(downloadedPath)
      if (path.resolve(parked) === path.resolve(downloadedPath)) return downloadedPath
      fs.copyFileSync(downloadedPath, parked)
      fs.chmodSync(parked, 0o755)
      logInfo(`[github-update] AppImage parked outside the staging root: ${parked}`)
      return parked
    } catch (err) {
      // Launching from the staging dir still works TODAY; it is the next
      // update's prune that would remove it. Never block the update on tidy-up.
      logError('[github-update] Could not park the AppImage outside the staging root:', err)
      return downloadedPath
    }
  }

  if (!currentAppImage) return park()

  // Resolve symlinks / `..`: the AppImage runtime sets $APPIMAGE to the real
  // mounted file, but a user may launch via a stable symlink whose target we
  // must replace (and whose link we must not leave dangling).
  let real: string
  try { real = fs.realpathSync(currentAppImage) } catch { return park() }

  // Only ever replace a plain *.AppImage FILE — never unlink a directory or a
  // non-AppImage file (e.g. a wrapper that set $APPIMAGE to some unrelated
  // path). We can't require our own name prefix here because users legitimately
  // rename the AppImage to a stable custom name (the case finding #1 preserves);
  // the .AppImage + regular-file check is the safe, name-agnostic guard.
  try {
    const st = fs.lstatSync(real)
    if (!st.isFile() || !path.basename(real).endsWith('.AppImage')) {
      logError(`[github-update] $APPIMAGE (${real}) is not an AppImage file — launching from a parked copy`)
      return park()
    }
  } catch { return park() }

  // Declared outside the try so the catch can reclaim it. Randomising the name
  // removed the only thing that used to bound the leak (the pre-emptive unlink of
  // a FIXED `.new`), so without this a failed copy/chmod/rename leaves a ~200 MB
  // orphan next to the running AppImage that nothing ever cleans -- prune only
  // walks `ccc-upd-*` inside <dataDir>/updates.
  let staged: string | null = null
  try {
    const runningName = path.basename(real)
    const keepName = !/\d+\.\d+\.\d+/.test(runningName)   // unversioned = user's custom stable name
    const target = keepName ? real : path.join(path.dirname(real), path.basename(downloadedPath))

    // target == the download means $APPIMAGE already points into the staging
    // root, so relocating is a no-op but launching from there is still
    // prune-eligible. Park it.
    if (path.resolve(target) === path.resolve(downloadedPath)) return park()

    // VERIFY BEFORE COMMIT. Copy to a sibling `.new`, hash THAT, and only then
    // move it into place. The old order copied straight onto the target and let
    // the caller re-hash afterwards -- which detects a swap but cannot undo it:
    // the bad bytes are already at the user's .desktop/dock-pinned path and run
    // on next launch, while the UI says the update was "blocked".
    // Random suffix, not a fixed `.new`: a fixed name both clobbers whatever the
    // user happened to have there and gives an attacker a predictable path to
    // pre-plant a symlink at, which copyFileSync would follow, verify would hash
    // THROUGH, and renameSync would then move onto the launcher path. The unlink
    // stays as belt for the (now vanishingly unlikely) collision.
    staged = `${target}.new-${crypto.randomBytes(6).toString('hex')}`
    fs.copyFileSync(downloadedPath, staged)
    fs.chmodSync(staged, 0o755)
    if (verify && !await verify(staged)) {
      throw new Error(`the copy at ${staged} did not match the verified installer`)
    }

    // Unlink before writing when reusing the running file's own path: truncating
    // a mounted AppImage in place can corrupt the running mount, whereas removing
    // the directory entry is safe (the mount keeps the inode) and lets the rename
    // recreate the file cleanly.
    if (path.resolve(target) === path.resolve(real)) {
      try { fs.unlinkSync(real) } catch { /* the rename recreates it */ }
    }
    fs.renameSync(staged, target)
    staged = null   // committed; no longer an orphan to reclaim
    fs.chmodSync(target, 0o755)

    if (path.resolve(target) !== path.resolve(real)) {
      try { fs.unlinkSync(real) } catch { /* non-fatal: a stale old version is cosmetic */ }
      // Launched via a symlink? Re-point it so the user's stable launcher path
      // follows the new versioned file instead of dangling at the deleted one.
      if (path.resolve(currentAppImage) !== path.resolve(real)) {
        try { fs.unlinkSync(currentAppImage); fs.symlinkSync(target, currentAppImage) } catch { /* best-effort */ }
      }
    }
    logInfo(`[github-update] AppImage updated in place: ${target}`)
    return target
  } catch (err) {
    // Includes a failed verification of the staged copy. The user's installed
    // AppImage was never touched in that case, so falling back to a parked copy
    // of the (already-verified) download is safe.
    if (staged) {
      try { fs.unlinkSync(staged) } catch { /* best effort */ }
    }
    logError('[github-update] In-place AppImage update failed — launching from a parked copy:', err)
    return park()
  }
}
