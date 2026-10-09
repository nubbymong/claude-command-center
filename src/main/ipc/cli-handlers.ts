/**
 * `claude` CLI probes + the help-workspace stager. Lifted out of `index.ts`
 * (2.1.1) as a pure move; called from inside the once-guarded
 * registerMainWindowIpc() block, never per window.
 */
import { ipcMain, app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolveClaudeForPty } from '../pty-manager'
import { spawnClaudeHeadless } from '../claude-headless'
import { parseClaudeVersion } from '../sentinel/sentinel-version'
import { ensureHelpWorkspace } from '../help-workspace'
import { getResourcesDirectory } from './setup-handlers'
import { loginShellWithOwnPath, shFamilyLoginShell } from '../login-shell'
import { claudeInLoginShellPathAsync, findClaudeOnWindowsAsync } from '../claude-cli-probe'
import { IPC } from '../../shared/ipc-channels'
import { providerProbeRefusal } from '../provider-launch-gate'

export function registerCliHandlers(): void {
  // Off Windows, a login shell outside the sh family is asked once at start
  // for the PATH it builds, off the event loop, so the first Claude session
  // finds the answer ready (claudeInLoginShellPathForLaunch); the check below
  // keeps it fresh. Nothing is asked on Windows or of a sh-family shell.
  void claudeInLoginShellPathAsync(process.env, process.platform).catch(() => null)
  // Windows: claude.exe, claude.cmd, claude.bat (claude-cli-probe.ts
  // CLAUDE_WINDOWS_NAMES), found in-process in PATH's folders
  // macOS/Linux: what a Claude session's launcher will run (claude-cli-probe.ts
  // claudeInLoginShellPathAsync, else `which` in the launcher's login shell)
  ipcMain.handle(IPC.CLI_CHECK, async () => {
    // Async (not sync): this runs every 30s for the app's lifetime from
    // BottomBar, so a synchronous probe would stall PTY data delivery to
    // every terminal in lockstep. Same boolean result shape as before.
    const execFileAsync = promisify(execFile)
    try {
      if (process.platform === 'win32') {
        // No process is started: the same PATH walk the launch uses
        // (claude-cli-probe.ts CLAUDE_WINDOWS_NAMES, in that order), one stat
        // at a time off the event loop. Its answer is what the next launch
        // uses while it is recent (findClaudeOnWindows).
        return (await findClaudeOnWindowsAsync(process.env)) !== null
      } else {
        // A login shell outside the sh family: Claude Code in the PATH it
        // builds, which the launcher carries and names. Otherwise, or when it
        // is not there, the launcher's own sh-family login shell, to pick up
        // Homebrew/nvm PATH entries. The platform is passed explicitly and is
        // the same source as the gate above.
        if (loginShellWithOwnPath(process.env, process.platform) && (await claudeInLoginShellPathAsync(process.env, process.platform))?.claude) return true
        const shell = shFamilyLoginShell(process.env, process.platform)
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
  // WP2: it runs the Claude CLI, so not while Claude Code is switched off:
  // the answer says why instead (the consent card shows it).
  ipcMain.handle(IPC.CLI_VERSION, async () => {
    const refused = providerProbeRefusal('claude')
    if (refused) return { refused }
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
