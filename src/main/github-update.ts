/**
 * GitHub Release update checker.
 * Checks the GitHub repo for a newer release and downloads the installer.
 */
import { app } from 'electron'
import * as https from 'https'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync } from 'child_process'
import { logInfo, logError } from './debug-logger'

const REPO = 'nubbymong/claude_command_center_windows'

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
 * Check GitHub for the latest release using `gh` CLI (already authenticated).
 * Returns release info if a newer version exists, null otherwise.
 */
export async function checkGitHubRelease(): Promise<ReleaseInfo | null> {
  const currentVersion = app.getVersion()
  logInfo(`[github-update] Checking for updates (current: v${currentVersion})...`)

  try {
    // Use gh CLI to get latest release (works with private repos, already authenticated)
    const result = execSync(
      `gh release view --repo ${REPO} --json tagName,assets 2>nul`,
      { encoding: 'utf-8', timeout: 15000, windowsHide: true }
    )

    const release = JSON.parse(result)
    const tagName = release.tagName as string // e.g. "v1.2.80"
    const latestVersion = tagName.replace(/^v/, '')

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
