import { ipcMain, app, dialog } from 'electron'
import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { isUpdateAvailable, checkForUpdatesOnDemand, markUpdateInstalled, getProjectRootPath, setSourcePathInRegistry, hasSourcePath } from '../update-watcher'
import { getInstallerPath } from '../update-client'
import { checkGitHubRelease, downloadGitHubRelease } from '../github-update'
import { killAllPty } from '../pty-manager'
import { logInfo, logError } from '../debug-logger'

// Cache the latest release info from GitHub
let cachedRelease: { version: string; tagName: string; installerName: string | null } | null = null

export function registerUpdateHandlers(): void {
  ipcMain.handle('update:check', async () => {
    // 1. Check local source watcher first (dev workflow)
    const localUpdate = checkForUpdatesOnDemand()
    if (localUpdate) return true

    // 2. Check GitHub releases (production workflow)
    try {
      const release = await checkGitHubRelease()
      if (release) {
        cachedRelease = release
        return true
      }
    } catch { /* fall through */ }

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

    // 1. If we have a GitHub release cached, download the installer
    if (cachedRelease?.installerName && cachedRelease?.tagName) {
      logInfo(`[update] Downloading from GitHub: ${cachedRelease.installerName}`)
      installerPath = await downloadGitHubRelease(cachedRelease.tagName, cachedRelease.installerName)
    }

    // 2. Try installer path from WebSocket notification
    if (!installerPath) {
      const wsPath = getInstallerPath()
      if (wsPath && fs.existsSync(wsPath)) {
        installerPath = wsPath
        logInfo(`[update] Using installer from notification: ${installerPath}`)
      }
    }

    // 3. Fall back to SourcePath registry lookup (dev workflow)
    if (!installerPath) {
      const projectRoot = getProjectRootPath()
      if (projectRoot) {
        // Try latest naming (new name first, then old)
        let src = path.join(projectRoot, 'ClaudeCommandCenter-latest.exe')
        if (!fs.existsSync(src)) {
          src = path.join(projectRoot, 'ClaudeConductor-latest.exe')
        }
        if (!fs.existsSync(src)) {
          // Try versioned naming with Beta tag (new and old names)
          try {
            const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'))
            const candidates = [
              path.join(projectRoot, `ClaudeCommandCenter-Beta-${pkg.version}.exe`),
              path.join(projectRoot, 'dist', `ClaudeCommandCenter-Beta-${pkg.version}.exe`),
              path.join(projectRoot, `ClaudeConductor-Beta-${pkg.version}.exe`),
              path.join(projectRoot, 'dist', `ClaudeConductor-Beta-${pkg.version}.exe`),
            ]
            src = candidates.find(p => fs.existsSync(p)) || ''
          } catch { /* fall through */ }
        }
        if (src && fs.existsSync(src)) {
          // Copy to Downloads for consistency
          const downloadsDir = path.join(os.homedir(), 'Downloads')
          const dest = path.join(downloadsDir, path.basename(src))
          fs.copyFileSync(src, dest)
          installerPath = dest
          logInfo(`[update] Copied local installer to ${dest}`)
        }
      }
    }

    if (!installerPath || !fs.existsSync(installerPath)) {
      const msg = 'Installer not found. Check your internet connection or run "npm run release" from source.'
      logError('[update] ' + msg)
      throw new Error(msg)
    }

    logInfo(`[update] Found installer: ${installerPath}`)

    try {
      // Kill all PTY processes immediately
      logInfo('[update] Killing all PTYs...')
      killAllPty()

      // Launch the installer
      logInfo('[update] Launching installer...')
      const proc = spawn(installerPath, [], {
        detached: true,
        stdio: 'ignore',
      })
      proc.unref()

      markUpdateInstalled()

      // Exit immediately — installer handles the rest
      logInfo('[update] Exiting app for installer...')
      app.exit(0)

      return true
    } catch (err) {
      logError('[update] Failed:', err)
      throw err
    }
  })
}
