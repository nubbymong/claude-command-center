/**
 * GitHub Release update checker.
 *
 * Three update channels:
 *   - stable: only final releases (tags matching /^v\d+\.\d+\.\d+$/)
 *   - beta:   stable + pre-release betas (tags matching /^v\d+\.\d+\.\d+(-beta)?$/)
 *   - dev:    all releases including dev builds (any tag)
 *
 * Two ways to talk to GitHub:
 *   1. Public GitHub API — tried first (zero auth, works for public repos)
 *   2. `gh` CLI fallback — tried if the public call returns 404 (private repo)
 *
 * Once the repo is public, step 2 is silently skipped. No code changes needed.
 *
 * Downloads use direct HTTPS (follows redirects) and `gh release download` as a fallback.
 */
import { app } from 'electron'
import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync } from 'child_process'
import { logInfo, logError } from './debug-logger'
import { readConfig } from './config-manager'
import { readRegistry } from './registry'

const STDERR_NULL = process.platform === 'win32' ? '2>nul' : '2>/dev/null'
const INSTALLER_EXT = process.platform === 'darwin' ? '.dmg' : '.exe'

const DEFAULT_REPO = 'nubbymong/claude-command-center'
const REPO = readRegistry('GitHubRepo') || DEFAULT_REPO

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

/** Parse the numeric version from a tag (strips v prefix and -beta/-dev suffix) */
function parseVersion(tag: string): string {
  return tag.replace(/^v/, '').replace(/-(?:beta|dev)(?:\.\d+)?$/, '')
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
  }
  return 0
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

function httpGetJson<T = unknown>(url: string, timeoutMs = 10000): Promise<{ status: number; body: T | null }> {
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
        try {
          const body = status >= 200 && status < 300 ? JSON.parse(text) as T : null
          resolve({ status, body })
        } catch {
          resolve({ status, body: null })
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
  })
}

/**
 * Fetch releases via the public GitHub API.
 * Returns null (not throw) if the repo is private/not found so callers can fall back.
 */
async function fetchReleasesPublic(limit = 30): Promise<GitHubRelease[] | null> {
  try {
    const url = `https://api.github.com/repos/${REPO}/releases?per_page=${limit}`
    const { status, body } = await httpGetJson<GitHubRelease[]>(url)
    if (status === 404 || status === 403) {
      logInfo(`[github-update] Public API returned ${status} — repo may be private`)
      return null
    }
    if (status >= 200 && status < 300 && Array.isArray(body)) {
      return body
    }
    logInfo(`[github-update] Public API unexpected status ${status}`)
    return null
  } catch (err) {
    logInfo(`[github-update] Public API error: ${(err as Error).message}`)
    return null
  }
}

// ── gh CLI fallback (for private repos during dev) ───────────────────────

async function fetchReleasesGhCli(limit = 30): Promise<GitHubRelease[] | null> {
  try {
    const result = execSync(
      `gh release list --repo ${REPO} --limit ${limit} --json tagName,isPrerelease,isDraft,assets ${STDERR_NULL}`,
      { encoding: 'utf-8', timeout: 15000, windowsHide: true }
    )
    const releases = JSON.parse(result) as Array<{
      tagName: string
      isPrerelease: boolean
      isDraft: boolean
      assets: Array<{ name: string; url: string; size: number }>
    }>
    // Normalize to GitHubRelease shape
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

/** Try public API first, fall back to gh CLI if it fails. */
async function fetchReleases(): Promise<GitHubRelease[] | null> {
  const publicResult = await fetchReleasesPublic()
  if (publicResult && publicResult.length > 0) return publicResult

  // Only fall back to gh CLI if public API returned no usable data (private repo, etc)
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

  // Pick the newest release matching the channel that is newer than current
  let best: { release: GitHubRelease; version: string; channel: UpdateChannel } | null = null

  for (const rel of releases) {
    if (rel.draft) continue
    const tag = rel.tag_name || rel.tagName
    if (!tag) continue
    if (!tagMatchesChannel(tag, channel)) continue

    const version = parseVersion(tag)
    if (compareSemver(version, currentVersion) <= 0) continue

    if (!best || compareSemver(version, best.version) > 0) {
      best = { release: rel, version, channel: classifyTag(tag)! }
    }
  }

  if (!best) {
    logInfo(`[github-update] Up to date (channel: ${channel})`)
    return null
  }

  const tag = best.release.tag_name || best.release.tagName!
  const installer = best.release.assets.find((a) =>
    a.name.endsWith(INSTALLER_EXT) && a.name.startsWith('ClaudeCommandCenter-')
  )

  logInfo(`[github-update] Update available: v${best.version} (tag: ${tag}, channel: ${best.channel}, installer: ${installer?.name || 'none'})`)

  return {
    version: best.version,
    tagName: tag,
    channel: best.channel,
    installerUrl: installer?.browser_download_url || installer?.url || null,
    installerName: installer?.name || null,
  }
}

// ── Download ─────────────────────────────────────────────────────────────

/**
 * Download a file from a URL to a destination path, following redirects.
 * Returns true on success.
 */
function httpsDownload(url: string, destPath: string, timeoutMs = 300000): Promise<boolean> {
  return new Promise((resolve) => {
    const tmpPath = destPath + '.part'
    const file = fs.createWriteStream(tmpPath)

    const doRequest = (reqUrl: string, hopsLeft: number) => {
      if (hopsLeft <= 0) {
        file.close(() => {
          try { fs.unlinkSync(tmpPath) } catch {}
          resolve(false)
        })
        return
      }
      const req = https.get(reqUrl, {
        headers: { 'User-Agent': 'claude-command-center-updater' },
        timeout: timeoutMs,
      }, (res) => {
        // Follow redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          doRequest(res.headers.location, hopsLeft - 1)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          file.close(() => {
            try { fs.unlinkSync(tmpPath) } catch {}
            logError(`[github-update] Download HTTP ${res.statusCode}`)
            resolve(false)
          })
          return
        }
        res.pipe(file)
        file.on('finish', () => {
          file.close(() => {
            try { fs.renameSync(tmpPath, destPath) } catch (err) { logError('[github-update] rename failed', err); resolve(false); return }
            resolve(true)
          })
        })
      })
      req.on('error', (err) => {
        file.close(() => {
          try { fs.unlinkSync(tmpPath) } catch {}
          logError('[github-update] Download error:', err)
          resolve(false)
        })
      })
      req.on('timeout', () => req.destroy(new Error('download timeout')))
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
    execSync(
      `gh release download ${tagName} --repo ${REPO} --pattern "${assetName}" --dir "${downloadsDir}" --clobber`,
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
