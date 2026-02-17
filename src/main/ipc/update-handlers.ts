import { ipcMain, app, dialog } from 'electron'
import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { isUpdateAvailable, checkForUpdatesOnDemand, markUpdateInstalled, getProjectRootPath, setSourcePathInRegistry, hasSourcePath } from '../update-watcher'
import { getInstallerPath } from '../update-client'
import { killAllPty } from '../pty-manager'
import { logInfo, logError } from '../debug-logger'

export function registerUpdateHandlers(): void {
  ipcMain.handle('update:check', async () => {
    return checkForUpdatesOnDemand()
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
      title: 'Select Claude Conductor Source Directory',
      message: 'Select the folder containing the Claude Conductor source code (with package.json)'
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

    // 1. Try installer path from WebSocket notification
    let installerSrc = getInstallerPath()
    if (installerSrc && fs.existsSync(installerSrc)) {
      logInfo(`[update] Using installer from notification: ${installerSrc}`)
    } else {
      // 2. Fall back to SourcePath registry lookup
      installerSrc = null
      const projectRoot = getProjectRootPath()
      if (projectRoot) {
        // Try latest naming
        installerSrc = path.join(projectRoot, 'ClaudeConductor-latest.exe')
        if (!fs.existsSync(installerSrc)) {
          // Try versioned naming with Beta tag
          try {
            const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'))
            const candidates = [
              path.join(projectRoot, `ClaudeConductor-Beta-${pkg.version}.exe`),
              path.join(projectRoot, `ClaudeConductor-${pkg.version}.exe`),
              path.join(projectRoot, 'dist', `ClaudeConductor-Beta-${pkg.version}.exe`),
              path.join(projectRoot, 'dist', `ClaudeConductor-${pkg.version}.exe`),
            ]
            installerSrc = candidates.find(p => fs.existsSync(p)) || null
          } catch { /* fall through */ }
        }
        // Legacy fallback
        if (!installerSrc || !fs.existsSync(installerSrc)) {
          const legacy = path.join(projectRoot, 'Claude Conductor Setup.exe')
          if (fs.existsSync(legacy)) installerSrc = legacy
        }
      }
    }

    if (!installerSrc || !fs.existsSync(installerSrc)) {
      const msg = 'Installer not found. Run "npm run release" from the source directory first.'
      logError('[update] ' + msg)
      throw new Error(msg)
    }

    logInfo(`[update] Found installer: ${installerSrc}`)

    try {
      // Copy installer to Downloads folder (like a real download)
      const downloadsDir = path.join(os.homedir(), 'Downloads')
      const installerDest = path.join(downloadsDir, path.basename(installerSrc))
      logInfo(`[update] Copying installer to ${installerDest}`)
      fs.copyFileSync(installerSrc, installerDest)

      // Kill all PTY processes immediately (no graceful exit — just kill)
      logInfo('[update] Killing all PTYs...')
      killAllPty()

      // Launch the installer from Downloads
      logInfo('[update] Launching installer...')
      const proc = spawn(installerDest, [], {
        detached: true,
        stdio: 'ignore',
      })
      proc.unref()

      markUpdateInstalled()

      // Exit immediately — installer handles the rest (install + relaunch)
      logInfo('[update] Exiting app for installer...')
      app.exit(0)

      return true
    } catch (err) {
      logError('[update] Failed:', err)
      throw err
    }
  })
}
