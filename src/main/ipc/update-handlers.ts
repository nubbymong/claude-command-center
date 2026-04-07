import { ipcMain, app, dialog } from 'electron'
import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { checkForUpdatesOnDemand, markUpdateInstalled, getProjectRootPath, setSourcePathInRegistry, hasSourcePath, isPackagedApp } from '../update-watcher'
import { checkGitHubRelease, downloadGitHubRelease } from '../github-update'
import { killAllPty } from '../pty-manager'
import { logInfo, logError } from '../debug-logger'

// Cache the latest release info from GitHub so installAndRestart can use it without a re-check
let cachedRelease: { version: string; tagName: string; installerName: string | null; installerUrl: string | null } | null = null

export function registerUpdateHandlers(): void {
  ipcMain.handle('update:check', async () => {
    // In dev mode, check the local source watcher first (live-reload workflow).
    // In production, always go straight to GitHub.
    if (!isPackagedApp()) {
      const localUpdate = checkForUpdatesOnDemand()
      if (localUpdate) return true
    }

    try {
      const release = await checkGitHubRelease()
      if (release) {
        cachedRelease = release
        return true
      }
    } catch (err) {
      logError('[update] GitHub check failed:', err)
    }

    return false
  })

  ipcMain.handle('update:getVersion', async () => {
    return cachedRelease?.version || null
  })

  ipcMain.handle('update:hasSourcePath', async () => {
    return hasSourcePath()
  })

  ipcMain.handle('update:getSourcePath', async () => {
    return getProjectRootPath()
  })

  ipcMain.handle('update:setSourcePath', async (_event, sourcePath: string) => {
    return setSourcePathInRegistry(sourcePath)
  })

  ipcMain.handle('update:selectSourcePath', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Claude Command Center Source Directory',
      message: 'Select the folder containing the Claude Command Center source code (with package.json)'
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const selectedPath = result.filePaths[0]
    const packageJson = path.join(selectedPath, 'package.json')
    if (!fs.existsSync(packageJson)) {
      return { error: 'Selected folder does not contain package.json' }
    }

    setSourcePathInRegistry(selectedPath)
    return { path: selectedPath }
  })

  ipcMain.handle('update:installAndRestart', async () => {
    logInfo('[update] Starting update...')

    let installerPath: string | null = null

    // 1. Re-check GitHub for the latest release (cached info may be stale)
    try {
      const latestRelease = await checkGitHubRelease()
      if (latestRelease) {
        cachedRelease = latestRelease
        logInfo(`[update] Latest GitHub release: v${latestRelease.version} (channel: ${latestRelease.channel})`)
      }
    } catch (err) {
      logInfo(`[update] GitHub re-check failed, using cached info: ${err}`)
    }

    // 2. Download from GitHub if we have release info
    if (cachedRelease?.installerName && cachedRelease?.tagName) {
      logInfo(`[update] Downloading from GitHub: ${cachedRelease.installerName}`)
      installerPath = await downloadGitHubRelease(
        cachedRelease.tagName,
        cachedRelease.installerName,
        cachedRelease.installerUrl
      )
    }

    // 3. Dev-only fallback: look for a locally-built installer in the source folder.
    // Checks both a `-latest` convention file and a versioned file, in both repo root
    // and `dist/`, using the correct extension for the current platform.
    if (!installerPath && !isPackagedApp()) {
      const projectRoot = getProjectRootPath()
      if (projectRoot) {
        const ext = process.platform === 'darwin' ? '.dmg' : '.exe'
        const candidates: string[] = [
          path.join(projectRoot, `ClaudeCommandCenter-latest${ext}`),
          path.join(projectRoot, 'dist', `ClaudeCommandCenter-latest${ext}`),
        ]
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'))
          candidates.push(
            path.join(projectRoot, `ClaudeCommandCenter-Beta-${pkg.version}${ext}`),
            path.join(projectRoot, 'dist', `ClaudeCommandCenter-Beta-${pkg.version}${ext}`),
          )
        } catch { /* fall through */ }

        const src = candidates.find((p) => fs.existsSync(p))
        if (src) {
          const downloadsDir = path.join(os.homedir(), 'Downloads')
          try { fs.mkdirSync(downloadsDir, { recursive: true }) } catch {}
          const dest = path.join(downloadsDir, path.basename(src))
          fs.copyFileSync(src, dest)
          installerPath = dest
          logInfo(`[update] Copied local installer to ${dest}`)
        }
      }
    }

    if (!installerPath || !fs.existsSync(installerPath)) {
      const msg = 'Installer not found. Check your internet connection or update channel.'
      logError('[update] ' + msg)
      throw new Error(msg)
    }

    logInfo(`[update] Found installer: ${installerPath}`)

    try {
      logInfo('[update] Killing all PTYs...')
      killAllPty()

      logInfo('[update] Launching installer...')
      if (process.platform === 'darwin' && installerPath.endsWith('.dmg')) {
        // On macOS, open the DMG in Finder — user drags to Applications manually.
        // Auto-installing a DMG over a running app is not supported.
        spawn('open', [installerPath], { detached: true, stdio: 'ignore' }).unref()
      } else {
        const proc = spawn(installerPath, [], { detached: true, stdio: 'ignore' })
        proc.unref()
      }

      markUpdateInstalled()

      logInfo('[update] Exiting app for installer...')
      app.exit(0)

      return true
    } catch (err) {
      logError('[update] Failed:', err)
      throw err
    }
  })
}
