import { ipcMain, dialog, BrowserWindow } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { homedir } from 'os'
import * as pty from 'node-pty'
import { guardPtyIo } from '../pty-input-guard'
import { stripSpoofableText } from '../../shared/safe-text'
import { logInfo } from '../debug-logger'
import { getInstallPath } from '../update-watcher'
import { resolveClaudeForPty } from '../pty-manager'
import { probeClaudeCli } from '../claude-cli-probe'
import { afterPathRefresh } from '../windows-path-refresh'
import { defaultLoginShell } from '../login-shell'
import { withFullyQualifiedProgramLookup } from '../windows-programs'
import {
  getDataDirectory,
  getResourcesDirectory,
  setDataDirectory,
  setResourcesDirectory,
  isDataDirFromRegistry,
} from '../data-paths'

export { getDataDirectory, getResourcesDirectory } from '../data-paths'

/**
 * The environment the first-run Claude Code setup terminal runs under: `env`,
 * and on Windows with the child's own program lookup kept to the folders PATH
 * names in full (withFullyQualifiedProgramLookup: only fully qualified PATH
 * folders, and the lookup setting in one spelling). There Claude Code is
 * often an npm command shim, which starts `node` by a bare name; that name is
 * looked for only in those folders, never in the terminal's working folder nor
 * in one named relative to it. `env` itself is not changed.
 */
export function setupTerminalEnv(env: Record<string, string>, platform: NodeJS.Platform = process.platform): Record<string, string> {
  return platform === 'win32' ? withFullyQualifiedProgramLookup(env) : env
}

// Check if setup is complete (uses cached registry/config check)
export function isSetupComplete(): boolean {
  // Ensure getDataDirectory() has been called at least once to populate cache
  getDataDirectory()
  return isDataDirFromRegistry()
}

// Shared helper lives in utils/claude-project-path. Both this module and the
// GitHub transcript loader map cwd → Claude's ~/.claude/projects/<folder>/
// convention; keeping one source of truth avoids drift if the convention
// ever changes upstream.
import { pathToClaudeProjectFolder } from '../utils/claude-project-path'

/**
 * Check if the install path is already trusted by Claude CLI.
 * Looks for a matching folder in ~/.claude/projects/
 */
export function isCliReady(): boolean {
  const installPath = getInstallPath()
  if (!installPath) return false

  const claudeProjectsDir = path.join(homedir(), '.claude', 'projects')
  if (!fs.existsSync(claudeProjectsDir)) return false

  const expectedFolder = pathToClaudeProjectFolder(installPath)
  const projectFolders = fs.readdirSync(claudeProjectsDir)

  for (const folder of projectFolders) {
    if (folder === expectedFolder) {
      logInfo(`[setup] CLI is ready — found trusted project: ${folder}`)
      return true
    }
  }

  logInfo(`[setup] CLI not ready — expected ${expectedFolder} in ~/.claude/projects/`)
  return false
}

// Track CLI setup PTY
let cliSetupPty: pty.IPty | null = null

/** WP2: the CLI setup terminal runs Claude Code for as long as it is open, so
 *  it counts as Claude Code in use for the switch-off rule
 *  (provider-in-use.ts). It is registered in the same step as its launch
 *  check, and dropped when it exits or is killed. */
export function countCliSetupInUse(): number {
  return cliSetupPty ? 1 : 0
}

export function writeCliSetupPty(data: string): void {
  cliSetupPty?.write(data)
}

export function registerSetupHandlers(): void {
  ipcMain.handle('setup:isComplete', async () => {
    return isSetupComplete()
  })

  ipcMain.handle('setup:getDefaultDataDir', async () => {
    const dir = getDataDirectory()
    logInfo(`[setup] IPC getDefaultDataDir returning: ${dir}`)
    return dir
  })

  ipcMain.handle('setup:selectDataDir', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Data Directory',
      defaultPath: getDataDirectory()
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('setup:setDataDir', async (_event, dataDir: string) => {
    return setDataDirectory(dataDir)
  })

  ipcMain.handle('setup:getDataDir', async () => {
    return getDataDirectory()
  })

  ipcMain.handle('setup:getResourcesDir', async () => {
    const dir = getResourcesDirectory()
    logInfo(`[setup] IPC getResourcesDir returning: ${dir}`)
    return dir
  })

  ipcMain.handle('setup:selectResourcesDir', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Resources Directory',
      defaultPath: getResourcesDirectory()
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('setup:setResourcesDir', async (_event, resourcesDir: string) => {
    return setResourcesDirectory(resourcesDir)
  })

  ipcMain.handle('setup:isCliReady', async () => {
    return isCliReady()
  })

  // Is the CLI INSTALLED at all? Distinct from isCliReady (which asks whether
  // the install folder is trusted, and answers "no" identically for "missing
  // binary" and "binary present, folder not trusted yet"). First-run setup
  // hard-stops on this one. Fail CLOSED: a probe that throws reports "not
  // installed" with the reason, and the step offers Retry.
  // ASYNC and coalescing since the 2026-09-01 adversarial pass: the probe used
  // to be `execFileSync`, so this ungated renderer channel blocked the main
  // process for up to 24s (three sequential 8s probes) on demand. `probeClaudeCli`
  // now runs on the event loop and collapses overlapping calls onto one probe;
  // this handler must AWAIT it so a rejection still lands in the catch below
  // rather than escaping as an unhandled rejection.
  // Owner decision D4 (2026-10-10): every probe here is one the setup screen
  // asked for (on entry, Retry, the check after its install ends), so on
  // Windows this process's PATH is brought up to date from the registry
  // first (windows-path-refresh.ts: folders appended, never dropped), and a
  // Claude Code installed since the app started is found without a restart.
  ipcMain.handle('setup:probeCli', async () => {
    try {
      return await afterPathRefresh(probeClaudeCli)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logInfo(`[setup] Claude CLI probe failed: ${message}`)
      return { installed: false, probe: `probe failed: ${message}` }
    }
  })

  ipcMain.handle('setup:spawnCliSetup', async (event, cols: number, rows: number) => {
    // WP2: this terminal runs Claude Code itself (its folder-trust prompt), so
    // it is refused while Claude Code is off, before anything is spawned
    // (provider-launch-gate.ts). The renderer skips this step then anyway
    // (skipsClaudeCliSetup); this is the authority behind it. Answered, so
    // the setup terminal says why. Loaded lazily: config-manager imports this
    // module, and the gate's accounts graph imports config-manager.
    const { providerLaunchRefusal } = await import('../provider-launch-gate')
    const refused = providerLaunchRefusal('claude')
    if (refused) return { refused }
    const sessionId = '__cli_setup__'
    const installPath = getInstallPath()
    const cwd = installPath && fs.existsSync(installPath) ? installPath : homedir()

    const { cmd } = resolveClaudeForPty()

    // The log line names what this terminal runs on each platform.
    if (process.platform === 'win32') {
      // Windows: spawn claude directly; a program it starts by a bare name is
      // found only in the folders PATH names (setupTerminalEnv).
      logInfo(`[setup] Spawning CLI setup PTY: ${cmd} in ${cwd}`)
      cliSetupPty = pty.spawn(cmd, [], {
        name: 'xterm-256color',
        cols: cols || 100,
        rows: rows || 20,
        cwd,
        env: setupTerminalEnv(process.env as Record<string, string>),
      })
    } else {
      // macOS/Linux: spawn interactive login shell so PATH includes Homebrew etc.
      // The platform is passed explicitly and is the same source as the gate above.
      const shell = defaultLoginShell(process.env, process.platform)
      logInfo(`[setup] Spawning CLI setup PTY: ${shell} -l in ${cwd}, then claude by name`)
      cliSetupPty = pty.spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols: cols || 100,
        rows: rows || 20,
        cwd,
        env: process.env as Record<string, string>,
      })
      // Send the claude command after a brief delay for shell init. The
      // user's own login shell runs this terminal and finds Claude Code by
      // name; with fish or PowerShell 7.3 or later that is the Claude Code the
      // CLI check found in the PATH it reports.
      setTimeout(() => {
        if (cliSetupPty) cliSetupPty.write('claude\r')
      }, 500)
    }

    // P3.15 round 4 (P2): an error on this terminal's input (the user types
    // into it) or output never quits the app; it ends on its own exit.
    guardPtyIo(cliSetupPty, (side, err) => logInfo(`[setup] CLI setup PTY ${side} failed (${stripSpoofableText(String(err?.code ?? err?.message ?? err), 120)})`))

    const win = BrowserWindow.fromWebContents(event.sender)

    cliSetupPty.onData((data) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send(`pty:data:${sessionId}`, data)
      }
    })

    cliSetupPty.onExit(({ exitCode }) => {
      logInfo(`[setup] CLI setup PTY exited with code ${exitCode}`)
      if (win && !win.isDestroyed()) {
        win.webContents.send(`pty:exit:${sessionId}`, exitCode)
      }
      cliSetupPty = null
    })

    return sessionId
  })

  ipcMain.handle('setup:killCliSetup', async () => {
    if (cliSetupPty) {
      try {
        cliSetupPty.kill()
      } catch { /* ignore */ }
      cliSetupPty = null
      logInfo('[setup] CLI setup PTY killed')
    }
    return true
  })
}
