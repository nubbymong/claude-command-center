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

  const installer = best.release.assets.find((a) =>
    a.name.endsWith(INSTALLER_EXT) && a.name.startsWith('ClaudeCommandCenter-')
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
function httpsDownload(url: string, destPath: string, timeoutMs = 300000): Promise<boolean> {
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
            res.resume()
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

// ── Installer integrity (#111) ───────────────────────────────────────────
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
// THREAT MODEL, stated plainly so nobody over-trusts this. Same-origin
// checksums defend against corruption, truncation, a tampered CDN edge, and a
// partial compromise. They do NOT defend against an attacker holding GitHub
// release-write credentials -- such an attacker rewrites CHECKSUMS.txt to match
// their payload. Closing that requires SIGNING the manifest (ed25519/minisign
// in CI, public key pinned in the app). This is a floor, not a ceiling.

/** One `<sha256>  <filename>` line as emitted by `sha256sum *`. */
const CHECKSUM_LINE = /^([0-9a-f]{64})\s+\*?(.+)$/i

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
    const m = CHECKSUM_LINE.exec(line)
    if (!m) continue
    // `sha256sum *` emits bare names, but tolerate a path prefix.
    const name = m[2].trim().replace(/^.*[/\\]/, '')
    if (name !== assetName) continue
    // A second line for the same asset means the manifest is ambiguous or
    // doctored. Refuse rather than pick one.
    if (found !== null && found !== m[1].toLowerCase()) return null
    found = m[1].toLowerCase()
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

/** Fetch CHECKSUMS.txt for a release, via the same cascade as the installer. */
async function fetchChecksumManifest(tagName: string, directUrl?: string | null): Promise<string | null> {
  const tmpPath = path.join(os.tmpdir(), `ccc-CHECKSUMS-${Date.now()}.txt`)
  const cleanup = (): void => { try { fs.unlinkSync(tmpPath) } catch { /* best effort */ } }

  // 1. Direct HTTPS, deriving the manifest URL from the installer's own asset
  //    URL so it comes from the same release, same host.
  if (directUrl) {
    const manifestUrl = directUrl.replace(/\/[^/]*$/, '/CHECKSUMS.txt')
    if (manifestUrl !== directUrl && await httpsDownload(manifestUrl, tmpPath, 60000)) {
      try {
        const text = fs.readFileSync(tmpPath, 'utf-8')
        cleanup()
        return text
      } catch { cleanup() }
    }
  }

  // 2. gh CLI fallback (private repos, and when the derived URL 404s).
  const tmpDir = path.join(os.tmpdir(), `ccc-sums-${Date.now()}`)
  try {
    fs.mkdirSync(tmpDir, { recursive: true })
    await execFileAsync(
      'gh',
      ['release', 'download', tagName, '--repo', REPO, '--pattern', 'CHECKSUMS.txt', '--dir', tmpDir, '--clobber'],
      { encoding: 'utf-8', timeout: 60000, windowsHide: true }
    )
    const p = path.join(tmpDir, 'CHECKSUMS.txt')
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8')
  } catch (err) {
    logError('[github-update] CHECKSUMS.txt fetch via gh CLI failed:', err)
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  return null
}

/**
 * Verify a downloaded installer against the release's CHECKSUMS.txt.
 *
 * FAILS CLOSED. Every failure path -- manifest missing, asset absent from it,
 * unreadable file, digest mismatch -- deletes the download and returns false.
 * There is deliberately no "could not verify, proceed anyway" branch: an
 * attacker who can tamper with the installer can usually also make the manifest
 * fetch fail, so a soft check would be no check.
 */
async function verifyInstaller(
  filePath: string,
  assetName: string,
  tagName: string,
  directUrl?: string | null,
): Promise<boolean> {
  const discard = (why: string): false => {
    logError(`[github-update] INTEGRITY CHECK FAILED (${why}) -- discarding ${assetName}`)
    try { fs.unlinkSync(filePath) } catch { /* best effort */ }
    return false
  }

  const manifest = await fetchChecksumManifest(tagName, directUrl)
  if (!manifest) return discard('CHECKSUMS.txt could not be fetched')

  const expected = digestForAsset(manifest, assetName)
  if (!expected) return discard(`no SHA-256 entry for ${assetName} in CHECKSUMS.txt`)

  const actual = await sha256File(filePath)
  if (!actual) return discard('could not hash the downloaded file')

  if (actual !== expected) {
    return discard(`sha256 mismatch: expected ${expected}, got ${actual}`)
  }

  logInfo(`[github-update] Integrity OK: ${assetName} sha256=${actual}`)
  return true
}

/**
 * Download the installer from the latest GitHub release and verify it.
 * Returns the path to the downloaded file, or null on failure.
 *
 * Verification happens HERE rather than at the call site so every caller
 * inherits it -- this function is the only way an installer enters the app, and
 * a returned path is a verified path.
 */
export async function downloadGitHubRelease(tagName: string, assetName: string, directUrl?: string | null): Promise<string | null> {
  const downloadsDir = path.join(os.homedir(), 'Downloads')
  try { fs.mkdirSync(downloadsDir, { recursive: true }) } catch {}
  const destPath = path.join(downloadsDir, assetName)

  logInfo(`[github-update] Downloading ${assetName} to ${destPath}`)

  // 1. Try direct HTTPS download (works for public repo)
  if (directUrl) {
    const ok = await httpsDownload(directUrl, destPath)
    if (ok && fs.existsSync(destPath)) {
      logInfo(`[github-update] Downloaded via direct HTTPS: ${destPath}`)
      if (!await verifyInstaller(destPath, assetName, tagName, directUrl)) return null
      return destPath
    }
    logInfo('[github-update] Direct HTTPS download failed, trying gh CLI')
  }

  // 2. Fall back to gh CLI (works for private repo)
  try {
    await execFileAsync(
      'gh',
      ['release', 'download', tagName, '--repo', REPO, '--pattern', assetName, '--dir', downloadsDir, '--clobber'],
      { encoding: 'utf-8', timeout: 300000, windowsHide: true }
    )
    if (fs.existsSync(destPath)) {
      logInfo(`[github-update] Downloaded via gh CLI: ${destPath}`)
      if (!await verifyInstaller(destPath, assetName, tagName, directUrl)) return null
      return destPath
    }
  } catch (err) {
    logError('[github-update] gh CLI download failed:', err)
  }

  return null
}

/**
 * Best-effort check: is `targetPath` on a filesystem mounted `noexec`?
 *
 * `fs.accessSync(X_OK)` inspects the file's permission bits, not the mount, so
 * on a hardened box where ~/Downloads (or /home) is mounted `noexec` a freshly
 * chmod'd AppImage passes the access check yet `execve` fails EACCES at launch.
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
 * and launching it from ~/Downloads would leave the user's "real" copy stale.
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
export function prepareLinuxAppImageUpdate(
  downloadedPath: string,
  currentAppImage: string | undefined = process.env.APPIMAGE,
): string {
  try { fs.chmodSync(downloadedPath, 0o755) } catch (err) {
    logError('[github-update] chmod +x on downloaded AppImage failed:', err)
  }

  if (!currentAppImage) return downloadedPath

  // Resolve symlinks / `..`: the AppImage runtime sets $APPIMAGE to the real
  // mounted file, but a user may launch via a stable symlink whose target we
  // must replace (and whose link we must not leave dangling).
  let real: string
  try { real = fs.realpathSync(currentAppImage) } catch { return downloadedPath }

  // Only ever replace a plain *.AppImage FILE — never unlink a directory or a
  // non-AppImage file (e.g. a wrapper that set $APPIMAGE to some unrelated
  // path). We can't require our own name prefix here because users legitimately
  // rename the AppImage to a stable custom name (the case finding #1 preserves);
  // the .AppImage + regular-file check is the safe, name-agnostic guard.
  try {
    const st = fs.lstatSync(real)
    if (!st.isFile() || !path.basename(real).endsWith('.AppImage')) {
      logError(`[github-update] $APPIMAGE (${real}) is not an AppImage file — launching from download location`)
      return downloadedPath
    }
  } catch { return downloadedPath }

  try {
    const runningName = path.basename(real)
    const keepName = !/\d+\.\d+\.\d+/.test(runningName)   // unversioned = user's custom stable name
    const target = keepName ? real : path.join(path.dirname(real), path.basename(downloadedPath))

    if (path.resolve(target) === path.resolve(downloadedPath)) return downloadedPath

    // Unlink before writing when reusing the running file's own path: truncating
    // a mounted AppImage in place can corrupt the running mount, whereas removing
    // the directory entry is safe (the mount keeps the inode) and lets copy
    // recreate the file cleanly.
    if (path.resolve(target) === path.resolve(real)) {
      try { fs.unlinkSync(real) } catch { /* copy recreates it */ }
    }
    fs.copyFileSync(downloadedPath, target)
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
    logError('[github-update] In-place AppImage update failed — launching from download location:', err)
    return downloadedPath
  }
}
