import { ipcMain, app, dialog } from 'electron'
import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { checkForUpdatesOnDemand, markUpdateInstalled, getProjectRootPath, setSourcePathInRegistry, hasSourcePath, isPackagedApp } from '../update-watcher'
import { checkGitHubRelease, downloadGitHubRelease, prepareLinuxAppImageUpdate } from '../github-update'
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
    // Uses the same naming convention as electron-builder's `artifactName`:
    //   Windows: ClaudeCommandCenter-Beta-${version}.exe
    //   macOS:   ClaudeCommandCenter-Beta-${version}-mac.dmg
    // Checks both a `-latest` convenience file and the versioned file, in both
    // repo root and `dist/`.
    if (!installerPath && !isPackagedApp()) {
      const projectRoot = getProjectRootPath()
      if (projectRoot) {
        const isMac = process.platform === 'darwin'
        const ext = isMac ? '.dmg' : '.exe'
        const macSuffix = isMac ? '-mac' : ''
        const candidates: string[] = [
          path.join(projectRoot, `ClaudeCommandCenter-latest${macSuffix}${ext}`),
          path.join(projectRoot, 'dist', `ClaudeCommandCenter-latest${macSuffix}${ext}`),
        ]
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'))
          candidates.push(
            path.join(projectRoot, `ClaudeCommandCenter-Beta-${pkg.version}${macSuffix}${ext}`),
            path.join(projectRoot, 'dist', `ClaudeCommandCenter-Beta-${pkg.version}${macSuffix}${ext}`),
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

    // Linux: prepare and VERIFY the AppImage is executable BEFORE we kill the
    // user's terminals and exit. spawn() reports EACCES/ENOENT only via an async
    // 'error' event, so a doomed launch (a noexec ~/Downloads mount, a failed
    // chmod on vfat/exfat, an unwritable $APPIMAGE dir) would otherwise kill
    // every PTY, exit the app, and leave nothing running with no error shown.
    // Fail here instead — the outer catch surfaces it and the app stays alive.
    let linuxLaunchPath: string | null = null
    if (process.platform === 'linux' && installerPath.endsWith('.AppImage')) {
      linuxLaunchPath = prepareLinuxAppImageUpdate(installerPath)
      try {
        fs.accessSync(linuxLaunchPath, fs.constants.X_OK)
      } catch (err) {
        throw new Error(`Updated AppImage is not executable (${linuxLaunchPath}) — aborting before restart: ${(err as Error).message}`)
      }
    }

    try {
      logInfo('[update] Killing all PTYs...')
      killAllPty()

      logInfo('[update] Launching installer...')
      if (process.platform === 'darwin' && installerPath.endsWith('.dmg')) {
        // On macOS, open the DMG in Finder — user drags to Applications manually.
        // Auto-installing a DMG over a running app is not supported.
        spawn('open', [installerPath], { detached: true, stdio: 'ignore' }).unref()
      } else if (linuxLaunchPath) {
        logInfo(`[update] Launching updated AppImage: ${linuxLaunchPath}`)
        const child = spawn(linuxLaunchPath, [], { detached: true, stdio: 'ignore' })
        // Wait for the child to actually start before exiting — spawn surfaces
        // exec failures asynchronously, so exiting immediately would hide a
        // failure and strand the user with no running app. On 'spawn' we exit;
        // on 'error' we abort (outer catch surfaces it); a short timeout is the
        // safety net so we never hang the update forever.
        await new Promise<void>((resolve, reject) => {
          let done = false
          const settle = (fn: () => void) => { if (!done) { done = true; child.unref(); fn() } }
          child.once('spawn', () => settle(resolve))
          child.once('error', (err) => settle(() => reject(err)))
          setTimeout(() => settle(resolve), 3000)
        })
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
