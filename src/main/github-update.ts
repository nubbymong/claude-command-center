/**
 * GitHub Release update checker.
 * Checks the GitHub repo for a newer release and downloads the installer.
 * Supports stable/beta update channels.
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

// Read from registry first (allows user override), fall back to default
const DEFAULT_REPO = 'nubbymong/claude_command_center_windows'
const REPO = readRegistry('GitHubRepo') || DEFAULT_REPO

interface ReleaseInfo {
  version: string
  tagName: string
  installerUrl: string | null
  installerName: string | null
}

/**
 * Compare two semver strings. Returns:
 *  1 if a > b, -1 if a < b, 0 if equal
 */
function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
  }
  return 0
}

/**
 * Read the update channel from user settings.
 * Returns 'stable' or 'beta'. Defaults to 'stable'.
 */
function getUpdateChannel(): 'stable' | 'beta' {
  try {
    const settings = readConfig<{ updateChannel?: string }>('settings')
    if (settings?.updateChannel === 'beta') return 'beta'
  } catch { /* fall through */ }
  return 'stable'
}

/**
 * Check GitHub for the latest release using `gh` CLI (already authenticated).
 * Respects the updateChannel setting:
 *   - 'stable': only considers non-prerelease releases
 *   - 'beta': considers ALL releases including prereleases
 * Returns release info if a newer version exists, null otherwise.
 */
export async function checkGitHubRelease(): Promise<ReleaseInfo | null> {
  const currentVersion = app.getVersion()
  const channel = getUpdateChannel()
  logInfo(`[github-update] Checking for updates (current: v${currentVersion}, channel: ${channel})...`)

  try {
    if (channel === 'beta') {
      // Beta channel: list all releases (including prereleases) and pick the newest
      const listResult = execSync(
        `gh release list --repo ${REPO} --limit 10 --json tagName,isPrerelease,assets 2>nul`,
        { encoding: 'utf-8', timeout: 15000, windowsHide: true }
      )

      const releases = JSON.parse(listResult) as Array<{ tagName: string; isPrerelease: boolean; assets: Array<{ name: string; url: string }> }>
      if (!releases || releases.length === 0) {
        logInfo('[github-update] No releases found')
        return null
      }

      // Find the newest release (by semver) that is newer than current
      let bestRelease: (typeof releases)[0] | null = null
      let bestVersion = ''

      for (const rel of releases) {
        const ver = rel.tagName.replace(/^v/, '').replace(/-beta$/, '')
        if (compareSemver(ver, currentVersion) > 0) {
          if (!bestRelease || compareSemver(ver, bestVersion) > 0) {
            bestRelease = rel
            bestVersion = ver
          }
        }
      }

      if (!bestRelease) {
        logInfo(`[github-update] Up to date (channel: beta)`)
        return null
      }

      const installer = bestRelease.assets?.find((a: { name: string }) =>
        a.name.endsWith('.exe') && a.name.startsWith('ClaudeCommandCenter-')
      )

      logInfo(`[github-update] Update available: v${bestVersion} (tag: ${bestRelease.tagName}, installer: ${installer?.name || 'none'})`)

      return {
        version: bestVersion,
        tagName: bestRelease.tagName,
        installerUrl: installer?.url || null,
        installerName: installer?.name || null
      }
    } else {
      // Stable channel: use gh release view which returns the latest non-draft, non-prerelease release
      const result = execSync(
        `gh release view --repo ${REPO} --json tagName,assets,isPrerelease 2>nul`,
        { encoding: 'utf-8', timeout: 15000, windowsHide: true }
      )

      const release = JSON.parse(result)

      // Double-check: skip if it's a prerelease (gh release view shouldn't return them, but be safe)
      if (release.isPrerelease) {
        logInfo('[github-update] Latest release is a prerelease, skipping (stable channel)')
        return null
      }

      const tagName = release.tagName as string // e.g. "v1.2.80" or "v1.2.80-beta"
      const latestVersion = tagName.replace(/^v/, '').replace(/-beta$/, '')

      if (compareSemver(latestVersion, currentVersion) <= 0) {
        logInfo(`[github-update] Up to date (latest: v${latestVersion})`)
        return null
      }

      // Find the .exe installer asset
      const assets = release.assets as Array<{ name: string; url: string }>
      const installer = assets?.find((a: { name: string }) =>
        a.name.endsWith('.exe') && a.name.startsWith('ClaudeCommandCenter-')
      )

      logInfo(`[github-update] Update available: v${latestVersion} (installer: ${installer?.name || 'none'})`)

      return {
        version: latestVersion,
        tagName,
        installerUrl: installer?.url || null,
        installerName: installer?.name || null
      }
    }
  } catch (err) {
    logError('[github-update] Failed to check GitHub releases:', err)
    return null
  }
}

/**
 * Download the installer from the latest GitHub release using `gh` CLI.
 * Returns the path to the downloaded file, or null on failure.
 */
export async function downloadGitHubRelease(tagName: string, assetName: string): Promise<string | null> {
  const downloadsDir = path.join(os.homedir(), 'Downloads')
  const destPath = path.join(downloadsDir, assetName)

  logInfo(`[github-update] Downloading ${assetName} to ${destPath}...`)

  try {
    execSync(
      `gh release download ${tagName} --repo ${REPO} --pattern "${assetName}" --dir "${downloadsDir}" --clobber`,
      { encoding: 'utf-8', timeout: 300000, windowsHide: true }
    )

    if (fs.existsSync(destPath)) {
      logInfo(`[github-update] Downloaded: ${destPath}`)
      return destPath
    }

    logError('[github-update] Download completed but file not found')
    return null
  } catch (err) {
    logError('[github-update] Download failed:', err)
    return null
  }
}
