/**
 * GitHub Release update checker.
 *
 * Three update channels:
 *   - stable: only final releases (tags matching /^v\d+\.\d+\.\d+$/)
 *   - beta:   stable + pre-release betas (e.g. /^v\d+\.\d+\.\d+-beta(?:\.\d+)?$/)
 *   - dev:    stable + beta + dev (e.g. /^v\d+\.\d+\.\d+-(?:beta|dev)(?:\.\d+)?$/)
 *
 * Two ways to talk to GitHub:
 *   1. Public GitHub API — tried first (zero auth, works for public repos)
 *   2. `gh` CLI fallback — tried whenever the public API returns no usable
 *      release data (e.g. private-repo 404/403, network error, empty list)
 *
 * Once the repo is public and the public API returns usable data, step 2
 * is silently never called.
 *
 * Downloads use direct HTTPS (follows redirects) and `gh release download` as a fallback.
 */
import { app } from 'electron'
import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { logInfo, logError } from './debug-logger'
import { readConfig } from './config-manager'
import { readRegistry } from './registry'

const execFileAsync = promisify(execFile)

const INSTALLER_EXT = process.platform === 'darwin' ? '.dmg' : '.exe'

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

export type UpdateChannel = 'stable' | 'beta' | 'dev'

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

/** Which channel does this tag belong to? */
function classifyTag(tag: string): UpdateChannel | null {
  const stripped = tag.replace(/^v/, '')
  if (/^\d+\.\d+\.\d+$/.test(stripped)) return 'stable'
  if (/^\d+\.\d+\.\d+-beta(\.\d+)?$/.test(stripped)) return 'beta'
  if (/^\d+\.\d+\.\d+-dev(\.\d+)?$/.test(stripped)) return 'dev'
  return null  // unknown format — ignore
}

/** Does this tag satisfy the user's chosen channel? */
function tagMatchesChannel(tag: string, channel: UpdateChannel): boolean {
  const tagChannel = classifyTag(tag)
  if (!tagChannel) return false
  // dev sees everything
  if (channel === 'dev') return true
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
  return tag.replace(/^v/, '').replace(/-(?:beta|dev)(?:\.\d+)?$/, '')
}

/**
 * Parse a tag into its components for ordering.
 *
 * Returns { major, minor, patch, prereleaseRank, prereleaseNum }.
 *
 * prereleaseRank follows semver convention: final releases outrank prereleases.
 *   final:  Infinity
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
  const m = stripped.match(/^(\d+)\.(\d+)\.(\d+)(?:-(beta|dev)(?:\.(\d+))?)?$/)
  if (!m) return null
  const [, maj, min, pat, pre, preN] = m
  let prereleaseRank = Number.POSITIVE_INFINITY
  let prereleaseNum = 0
  if (pre === 'beta') { prereleaseRank = 2; prereleaseNum = preN ? parseInt(preN, 10) : 0 }
  else if (pre === 'dev') { prereleaseRank = 1; prereleaseNum = preN ? parseInt(preN, 10) : 0 }
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
 * packaged version. So we compare it as if it were a final release at that
 * base version.
 *
 * Implications:
 *   - A user on 1.2.3 running the stable channel will NOT be offered
 *     1.2.3-beta.1, because 1.2.3 > 1.2.3-beta.1 under our ordering. ✓
 *   - A user on 1.2.3 running the beta channel will NOT be offered
 *     1.2.3-beta.2 either, for the same reason. They must wait for 1.2.4-beta.*
 *     or a newer final release. ✓
 *   - A user with `package.json` version 1.2.3 WILL be offered 1.2.4-beta.1
 *     on the beta channel, 1.2.4 on stable, etc. ✓
 *
 * In other words: because the in-memory version never has a prerelease suffix,
 * prerelease ordering only matters when comparing two GitHub tags against
 * each other (to pick the newest candidate), not when comparing a tag to the
 * running app.
 */
function compareTagToCurrentVersion(tag: string, currentVersion: string): number {
  // Build a synthetic "final release" tag from the current version for comparison
  return compareTags(tag, `v${currentVersion}`)
}

/** Read the update channel from user settings */
function getUpdateChannel(): UpdateChannel {
  try {
    const settings = readConfig<{ updateChannel?: string }>('settings')
    if (settings?.updateChannel === 'dev') return 'dev'
    if (settings?.updateChannel === 'beta') return 'beta'
  } catch { /* fall through */ }
  return 'stable'
}

// ── Public GitHub API (anonymous) ────────────────────────────────────────

function httpGetJson<T = unknown>(url: string, timeoutMs = 10000): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: T | null }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'claude-command-center-updater',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
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
async function fetchReleasesPublic(limit = 30): Promise<PublicFetchResult> {
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

// ── gh CLI fallback (for private repos during dev) ───────────────────────

async function fetchReleasesGhCli(limit = 30): Promise<GitHubRelease[] | null> {
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
 * Try public API first, fall back to gh CLI when appropriate.
 *   - ok          → return releases
 *   - not-found   → try gh CLI (repo might be private)
 *   - error       → try gh CLI as a best-effort recovery
 *   - rate-limited → give up (gh CLI won't help, user should wait)
 */
async function fetchReleases(): Promise<GitHubRelease[] | null> {
  const publicResult = await fetchReleasesPublic()

  if (publicResult.kind === 'ok') return publicResult.releases
  if (publicResult.kind === 'rate-limited') return null

  // not-found or error — try gh CLI
  logInfo('[github-update] Falling back to gh CLI')
  return fetchReleasesGhCli()
}

// ── Main API ─────────────────────────────────────────────────────────────

/**
 * Check GitHub for the latest release matching the current channel.
 * Returns release info if a newer version exists, null otherwise.
 */
export async function checkGitHubRelease(): Promise<ReleaseInfo | null> {
  const currentVersion = app.getVersion()
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

/**
 * Download the installer from the latest GitHub release.
 * Returns the path to the downloaded file, or null on failure.
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
      return destPath
    }
  } catch (err) {
    logError('[github-update] gh CLI download failed:', err)
  }

  return null
}
