/**
 * `claude` CLI probes + the help-workspace stager. Lifted out of `index.ts`
 * (2.1.1) as a pure move; called from inside the once-guarded
 * registerMainWindowIpc() block, never per window.
 */
import { ipcMain, app } from 'electron'
import { resolveClaudeForPty } from '../pty-manager'
import { spawnClaudeHeadless } from '../claude-headless'
import { parseClaudeVersion } from '../sentinel/sentinel-version'
import { ensureHelpWorkspace } from '../help-workspace'
import { getResourcesDirectory } from './setup-handlers'
import { IPC } from '../../shared/ipc-channels'

export function registerCliHandlers(): void {
  // Windows: tries native .exe then npm .cmd via 'where'
  // macOS/Linux: uses 'which' to find 'claude' in PATH
  ipcMain.handle(IPC.CLI_CHECK, async () => {
    // Async execFile (not execSync): this runs every 30s for the app's lifetime
    // from BottomBar, so a synchronous probe would stall PTY data delivery to
    // every terminal in lockstep. Same boolean result shape as before.
    const { execFile } = require('child_process')
    const { promisify } = require('util')
    const execFileAsync = promisify(execFile)
    try {
      if (process.platform === 'win32') {
        // windowsHide + piped stderr suppresses the "INFO: Could not find
        // files..." line `where` writes to stderr on a miss; execFile pipes
        // by default so the noise never reaches the parent's terminal between
        // the .exe and .cmd probes.
        const opts = { encoding: 'utf-8' as const, timeout: 5000, windowsHide: true }
        try {
          await execFileAsync('where', ['claude.exe'], opts)
          return true
        } catch { /* try .cmd */ }
        await execFileAsync('where', ['claude.cmd'], opts)
        return true
      } else {
        // Use login shell to pick up Homebrew/nvm PATH entries
        const shell = process.env.SHELL || '/bin/zsh'
        await execFileAsync(shell, ['-l', '-c', 'which claude'], { encoding: 'utf-8', timeout: 5000 })
        return true
      }
    } catch {
      return false
    }
  })

  // Onboarding "Find Claude": the resolved claude binary path (no command run).
  ipcMain.handle(IPC.CLI_PATH, async () => {
    try {
      return resolveClaudeForPty()?.cmd ?? null
    } catch {
      return null
    }
  })

  // Onboarding "Find Claude": run `claude --version` on demand (user-approved).
  ipcMain.handle(IPC.CLI_VERSION, async () => {
    try {
      const res = await spawnClaudeHeadless(['--version'], 10000)
      return parseClaudeVersion(res.stdout) ?? parseClaudeVersion(res.stderr) ?? null
    } catch {
      return null
    }
  })

  // "Ask Command Center": stage (refresh) the help workspace and return its
  // path; the renderer launches a normal Claude session with this cwd so the
  // CLAUDE.md + app-knowledge.md docs prime the session.
  ipcMain.handle(IPC.HELP_WORKSPACE, async () => {
    try {
      return ensureHelpWorkspace(getResourcesDirectory(), { appVersion: app.getVersion() })
    } catch {
      return null
    }
  })
}
