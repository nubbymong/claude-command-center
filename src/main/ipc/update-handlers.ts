import { ipcMain, app, dialog } from 'electron'
import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { checkForUpdatesOnDemand, markUpdateInstalled, getProjectRootPath, setSourcePathInRegistry, hasSourcePath, isPackagedApp } from '../update-watcher'
import { checkGitHubRelease, downloadGitHubRelease, prepareLinuxAppImageUpdate, isPathOnNoexecMount, InstallerIntegrityError, stillMatchesDigest } from '../github-update'
import { killAllPty } from '../pty-manager'
import { logInfo, logError } from '../debug-logger'

// Cache the latest release info from GitHub so installAndRestart can use it without a re-check
let cachedRelease: { version: string; tagName: string; installerName: string | null; installerUrl: string | null } | null = null

export function registerUpdateHandlers(): void {
  ipcMain.handle('update:check', async () => {
    // In dev mode, check the local source watcher first (live-reload workflow).
    // In production, always go straight to GitHub.
    if (!isPackagedApp()) {
      const localUpdate = await checkForUpdatesOnDemand()
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
    // SHA-256 of the installer as verified at download time, kept so it can be
    // re-checked immediately before exec (#111). Null for the dev-only local
    // build path, which has no manifest to check against.
    let verifiedSha256: string | null = null

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
      try {
        const verified = await downloadGitHubRelease(
          cachedRelease.tagName,
          cachedRelease.installerName,
          cachedRelease.installerUrl
        )
        if (verified) {
          installerPath = verified.path
          verifiedSha256 = verified.sha256
        }
      } catch (err) {
        // An integrity failure is NOT "installer not found" (#111). Surfacing it
        // as a network problem sends the user to re-click forever and blame
        // their connection, and on a genuine tamper event gives them no signal
        // at all.
        //
        // Adversarial review found the rethrow alone was inert: EVERY renderer
        // path swallows the error (console.error or a bare state reset), and
        // there is no toast component -- so the user saw the "Updating..."
        // overlay vanish and nothing else. showErrorBox is the one channel that
        // cannot be dropped on the way out.
        if (err instanceof InstallerIntegrityError) {
          logError(`[update] ${err.message}`)
          try {
            dialog.showErrorBox('Update blocked - integrity check failed', err.message)
          } catch { /* never let the dialog itself break the flow */ }
        }
        throw err
      }
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

    // Re-hash immediately before the point of no return. Verification happened
    // at download time, but the file then sits at a predictable path in
    // ~/Downloads while we kill every PTY -- tens of ms to seconds, and every
    // browser writes into that directory. The installer runs with
    // `allowElevation`, so a non-elevated local process that wins that race
    // gains admin on a UAC prompt the user is already expecting. Costs ~1s for
    // 150 MB and shrinks the window to microseconds (#111).
    if (verifiedSha256) {
      if (!await stillMatchesDigest(installerPath, verifiedSha256)) {
        const msg = `${path.basename(installerPath)} changed on disk after it was verified. `
          + 'Aborting the update. Install manually from the GitHub release page.'
        logError('[update] ' + msg)
        try { dialog.showErrorBox('Update blocked - installer changed after verification', msg) } catch { /* ignore */ }
        throw new InstallerIntegrityError(msg)
      }
    }

    // Linux: prepare and VERIFY the AppImage is executable BEFORE we kill the
    // user's terminals and exit. spawn() reports EACCES/ENOENT only via an async
    // 'error' event, so a doomed launch (a noexec ~/Downloads mount, a failed
    // chmod on vfat/exfat, an unwritable $APPIMAGE dir) would otherwise kill
    // every PTY, exit the app, and leave nothing running with no error shown.
    // Fail here instead — the outer catch surfaces it and the app stays alive.
    let linuxLaunchPath: string | null = null
    if (process.platform === 'linux' && installerPath.endsWith('.AppImage')) {
      linuxLaunchPath = prepareLinuxAppImageUpdate(installerPath)
      // Permission bits (fast, catches a failed chmod on vfat/exfat)...
      try {
        fs.accessSync(linuxLaunchPath, fs.constants.X_OK)
      } catch (err) {
        throw new Error(`Updated AppImage is not executable (${linuxLaunchPath}) — aborting before restart: ${(err as Error).message}`)
      }
      // ...and the mount, which accessSync can't see: a noexec ~/Downloads (the
      // fallback launch location) would pass the bit check yet fail execve. The
      // single-instance lock means we can't confirm the relaunch by spawning it
      // first, so catch this here — before the PTYs are killed — not after.
      if (isPathOnNoexecMount(linuxLaunchPath)) {
        throw new Error(`Updated AppImage is on a noexec mount (${linuxLaunchPath}) — cannot relaunch. Move the app to a filesystem that allows execution, or update manually.`)
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
