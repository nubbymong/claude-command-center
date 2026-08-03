import { ipcMain, app, dialog } from 'electron'
import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { checkForUpdatesOnDemand, markUpdateInstalled, getProjectRootPath, setSourcePathInRegistry, hasSourcePath, isPackagedApp } from '../update-watcher'
import { checkGitHubRelease, downloadGitHubRelease, prepareLinuxAppImageUpdate, isPathOnNoexecMount, InstallerIntegrityError, stillMatchesDigest, createInstallerDir } from '../github-update'
import { killAllPty } from '../pty-manager'
import { logInfo, logError } from '../debug-logger'

// Cache the latest release info from GitHub so installAndRestart can use it without a re-check
let cachedRelease: { version: string; tagName: string; installerName: string | null; installerUrl: string | null } | null = null

/** Reentrancy latch for update:installAndRestart — see the handler. */
let updateInProgress = false

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
    // ipcMain.handle serialises nothing. Two concurrent runs each prune the
    // staging root keeping only THEIR OWN directory, so each deletes the other's
    // in-flight installer. The renderer latches on `isUpdating`, but that is one
    // frame of protection and a scripted invoke has none.
    if (updateInProgress) {
      logInfo('[update] Ignoring a second install request — one is already running')
      throw new Error('An update is already in progress.')
    }
    updateInProgress = true
    try {
      return await runInstallAndRestart()
    } finally {
      updateInProgress = false
    }
  })

  async function runInstallAndRestart(): Promise<boolean> {
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
          // Same private staging directory as a real download (#174), not
          // ~/Downloads. This path is dev-only, but it ends in the same
          // spawn-with-elevation, so it gets the same directory -- and the same
          // guard, so a staging failure reads as "installer not found" below
          // rather than an unhandled ENOENT the renderer silently swallows.
          try {
            const stageDir = createInstallerDir()
            const dest = path.join(stageDir, path.basename(src))
            fs.copyFileSync(src, dest)
            installerPath = dest
            logInfo(`[update] Copied local installer to ${dest}`)
          } catch (err) {
            logError('[update] Could not stage the local installer:', err)
          }
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
    // at download time, but the file then sits on disk while we kill every PTY
    // -- tens of ms to seconds. The installer runs with `allowElevation`, so a
    // local process that wins that race gains admin on a UAC prompt the user is
    // already expecting. Costs ~1s for 150 MB and shrinks the window to
    // microseconds (#111). #174 did NOT make this redundant: the attacker in
    // that model runs as the user, so it does not have to guess the staging
    // directory -- it can watch the root and see it appear. This re-hash is the
    // control of record for the race; #174 removed the drive-by variant.
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
    // 'error' event, so a doomed launch (a noexec staging mount, a failed
    // chmod on vfat/exfat, an unwritable $APPIMAGE dir) would otherwise kill
    // every PTY, exit the app, and leave nothing running with no error shown.
    // Fail here instead — the outer catch surfaces it and the app stays alive.
    let linuxLaunchPath: string | null = null
    if (process.platform === 'linux' && installerPath.endsWith('.AppImage')) {
      linuxLaunchPath = prepareLinuxAppImageUpdate(installerPath)
      // The file we verified is NOT the file we are about to spawn: this call
      // copies the AppImage somewhere else. Re-hash the COPY. Without this, the
      // digest check covers a file that is then never executed, and everything
      // between the copy and the spawn is unverified (#174 adversarial review).
      if (verifiedSha256 && linuxLaunchPath !== installerPath) {
        if (!await stillMatchesDigest(linuxLaunchPath, verifiedSha256)) {
          const msg = `${path.basename(linuxLaunchPath)} does not match the verified installer after being copied into place. `
            + 'Aborting the update. Install manually from the GitHub release page.'
          logError('[update] ' + msg)
          try { dialog.showErrorBox('Update blocked - installer changed after verification', msg) } catch { /* ignore */ }
          throw new InstallerIntegrityError(msg)
        }
      }
      // Permission bits (fast, catches a failed chmod on vfat/exfat)...
      try {
        fs.accessSync(linuxLaunchPath, fs.constants.X_OK)
      } catch (err) {
        throw new Error(`Updated AppImage is not executable (${linuxLaunchPath}) — aborting before restart: ${(err as Error).message}`)
      }
      // ...and the mount, which accessSync can't see: a noexec staging dir (the
      // fallback launch location when $APPIMAGE is unset) would pass the bit
      // check yet fail execve. This is why #174 stages under userData rather
      // than /tmp, which is noexec on hardened systems far more often. The
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
      // Every branch waits for the child to actually start. spawn reports
      // EACCES/ENOENT only via an async 'error' event, and `app.exit(0)` below
      // runs first -- and with no 'error' listener at all that event is an
      // UNCAUGHT EXCEPTION in the main process, after every PTY is already dead.
      const awaitLaunch = async (child: ReturnType<typeof spawn>): Promise<void> => {
        await new Promise<void>((resolve, reject) => {
          let done = false
          const settle = (fn: () => void) => { if (!done) { done = true; child.unref(); fn() } }
          child.once('spawn', () => settle(resolve))
          child.once('error', (err) => settle(() => reject(err)))
          setTimeout(() => settle(resolve), 3000)
        })
      }

      if (process.platform === 'darwin' && installerPath.endsWith('.dmg')) {
        // On macOS, open the DMG in Finder — user drags to Applications manually.
        // Auto-installing a DMG over a running app is not supported.
        await awaitLaunch(spawn('open', [installerPath], { detached: true, stdio: 'ignore' }))
      } else if (linuxLaunchPath) {
        logInfo(`[update] Launching updated AppImage: ${linuxLaunchPath}`)
        await awaitLaunch(spawn(linuxLaunchPath, [], { detached: true, stdio: 'ignore' }))
      } else {
        // %LOCALAPPDATA% is a common target for "block executables outside
        // Program Files" policies, and since #174 the user no longer has a file
        // in ~/Downloads to fall back on — so a blocked launch has to be
        // reported, not swallowed.
        await awaitLaunch(spawn(installerPath, [], { detached: true, stdio: 'ignore' }))
      }

      markUpdateInstalled()

      logInfo('[update] Exiting app for installer...')
      app.exit(0)

      return true
    } catch (err) {
      logError('[update] Failed:', err)
      // Every PTY is already dead by the time we get here, and the renderer
      // swallows this rejection at all four call sites -- so showErrorBox is the
      // only channel that reaches the user. Name the staged path: since #174 the
      // installer is in a deliberately unpredictable directory, so without this
      // there is nothing for them to run by hand (#174 adversarial review).
      try {
        dialog.showErrorBox(
          'Update could not be launched',
          `${(err as Error).message}\n\nThe verified installer is at:\n${installerPath}\n\n`
          + 'Run it manually, or install from the GitHub release page.'
        )
      } catch { /* never let the dialog itself break the flow */ }
      throw err
    }
  }
}
