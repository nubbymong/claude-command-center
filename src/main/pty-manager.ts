import { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import * as os from 'os'
import { execSync } from 'child_process'
import { startSessionLog, logSessionData, endSessionLog } from './session-logger'
import { logPtyOutput, isDebugModeEnabled } from './debug-capture'
import { logInfo, logDebug, logError } from './debug-logger'
import { writeCliSetupPty, getResourcesDirectory } from './ipc/setup-handlers'

import * as path from 'path'
import * as fs from 'fs'

interface PtySession {
  ptyProcess: pty.IPty
  sessionId: string
}

// Buffer writes for PTYs that haven't spawned yet (e.g., partner terminal initially hidden)
const pendingWrites = new Map<string, string[]>()

/**
 * Resolve ~ to the user's home directory.
 * On Windows, ~ is not resolved by the OS — only by shells.
 */
function resolveCwd(cwd: string | undefined): string {
  if (!cwd || cwd === '.') return os.homedir()
  if (cwd === '~') return os.homedir()
  if (cwd.startsWith('~/') || cwd.startsWith('~\\')) {
    return path.join(os.homedir(), cwd.slice(2))
  }
  // Resolve any relative paths to absolute (prevents using Electron's process.cwd())
  return path.resolve(cwd)
}

export interface SSHOptions {
  host: string
  port: number
  username: string
  remotePath: string
  password?: string
  postCommand?: string
  sudoPassword?: string
  startClaudeAfter?: boolean
}

const ptySessions = new Map<string, PtySession>()

/**
 * Generate a shell command that configures Claude's settings.json on a remote machine
 * to use the mounted statusline script. The script is already deployed at
 * {ResourcesDir}/scripts/claude-multi-statusline.js and mounted at
 * /mnt/resources/scripts/ on the remote machine.
 */
function getRemoteStatuslineSetup(): string {
  const configCmd = 'const f=require("fs"),p=require("path").join(require("os").homedir(),".claude","settings.json");let s={};try{s=JSON.parse(f.readFileSync(p,"utf-8"))}catch{}s.statusLine={type:"command",command:"node /mnt/resources/scripts/claude-multi-statusline.js"};f.writeFileSync(p,JSON.stringify(s,null,2))'
  return `mkdir -p ~/.claude ~/.claude-multi/status 2>/dev/null; node -e '${configCmd}' 2>/dev/null`
}

/**
 * Resolve the claude command for PTY usage.
 * On Windows we need claude.cmd (the PTY handles .cmd wrappers properly unlike spawn).
 */
export function resolveClaudeForPty(): { cmd: string; args: string[] } {
  if (os.platform() !== 'win32') {
    return { cmd: 'claude', args: [] }
  }

  try {
    const cmdPath = execSync('where claude.cmd', { encoding: 'utf-8', timeout: 5000 })
      .trim().split('\n')[0].trim()
    return { cmd: cmdPath, args: [] }
  } catch {
    return { cmd: 'claude', args: [] }
  }
}

/**
 * Resolve path to the resume-picker.js script.
 * Deployed to ResourcesDirectory/scripts/ by deployStatuslineScript().
 */
function getResumePickerPath(): string | null {
  try {
    const scriptPath = path.join(getResourcesDirectory(), 'scripts', 'resume-picker.js')
    if (fs.existsSync(scriptPath)) return scriptPath
  } catch { /* resources dir may not be configured yet */ }
  return null
}

export function spawnPty(
  win: BrowserWindow,
  sessionId: string,
  options?: { cwd?: string; cols?: number; rows?: number; ssh?: SSHOptions; shellOnly?: boolean; elevated?: boolean; configLabel?: string; useResumePicker?: boolean }
): void {
  logInfo(`[pty] Spawning PTY for session ${sessionId} (ssh=${!!options?.ssh}, shellOnly=${!!options?.shellOnly}, cwd=${options?.cwd || 'default'})`)
  killPty(sessionId)

  const cols = options?.cols || 120
  const rows = options?.rows || 30

  let ptyProcess: pty.IPty

  if (options?.ssh) {
    // SSH session: spawn ssh command, then chain claude after cd
    const ssh = options.ssh
    const sshArgs = [
      `${ssh.username}@${ssh.host}`,
      '-p', String(ssh.port),
      '-t', // force TTY allocation
      '-o', 'StrictHostKeyChecking=accept-new'
    ]

    const sshBinary = os.platform() === 'win32' ? 'ssh.exe' : 'ssh'

    ptyProcess = pty.spawn(sshBinary, sshArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
      useConpty: false
    })

    let cdSent = false
    let passwordSent = false
    let postCommandSent = false
    let sudoPasswordSent = false
    let claudeSent = false
    let postCommandShellReady = false
    const remotePath = ssh.remotePath || '~'
    const password = ssh.password
    const postCommand = ssh.postCommand
    const sudoPassword = ssh.sudoPassword
    const startClaudeAfter = ssh.startClaudeAfter

    ptyProcess.onData((data) => {
      if (win.isDestroyed()) return
      win.webContents.send(`pty:data:${sessionId}`, data)

      const dataLower = data.toLowerCase()

      // Auto-type SSH password when prompted
      if (!passwordSent && password && dataLower.includes('password')) {
        passwordSent = true
        setTimeout(() => {
          ptyProcess.write(password + '\r')
        }, 100)
        return
      }

      // Auto-type sudo password when prompted (after postCommand)
      // Detect various sudo password prompts: "[sudo] password", "Password:", "password for"
      if (!sudoPasswordSent && sudoPassword && postCommandSent &&
          (dataLower.includes('[sudo]') || dataLower.includes('password:') || dataLower.includes('password for'))) {
        sudoPasswordSent = true
        setTimeout(() => {
          ptyProcess.write(sudoPassword + '\r')
        }, 100)
        return
      }

      // After SSH login, cd to remotePath and optionally run postCommand
      if (!cdSent && (data.includes('$') || data.includes('#') || data.includes('>') || data.includes('~'))) {
        cdSent = true
        setTimeout(() => {
          if (postCommand) {
            // cd to path and run post command
            ptyProcess.write(`cd ${remotePath} && ${postCommand}\r`)
            postCommandSent = true
          } else if (startClaudeAfter && !options?.shellOnly) {
            // Deploy statusline then start Claude
            claudeSent = true
            ptyProcess.write(`cd ${remotePath}; ${getRemoteStatuslineSetup()}; claude\r`)
          } else {
            // Shell only or no Claude — just cd and deploy statusline
            ptyProcess.write(`cd ${remotePath}; ${getRemoteStatuslineSetup()}; clear\r`)
          }
        }, 200)
        return
      }

      // After post-command completes (container shell ready), optionally start Claude
      // Detect shell prompt after postCommand was sent and sudo password handled (if needed)
      // Skip if shellOnly mode is enabled
      if (postCommandSent && !claudeSent && startClaudeAfter && !options?.shellOnly) {
        const sudoHandled = !sudoPassword || sudoPasswordSent
        if (sudoHandled && !postCommandShellReady) {
          // Look for container shell prompt (typically ends with # or $)
          // Check for common prompt patterns at end of output
          const trimmed = data.trimEnd()
          if (trimmed.endsWith('#') || trimmed.endsWith('$') || trimmed.endsWith('>')) {
            postCommandShellReady = true
            setTimeout(() => {
              claudeSent = true
              // Deploy statusline on remote for context tracking, then start Claude
              ptyProcess.write(`${getRemoteStatuslineSetup()}; claude\r`)
            }, 300)
          }
        }
      }
    })
  } else {
    // Local session
    const shellOnly = options?.shellOnly

    if (shellOnly) {
      // Shell only: spawn a shell without Claude
      const shell = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash'
      const elevated = options?.elevated

      let spawnCmd: string
      let spawnArgs: string[]

      if (elevated) {
        if (os.platform() === 'win32') {
          spawnCmd = 'gsudo'
          spawnArgs = [shell]
        } else {
          spawnCmd = 'sudo'
          spawnArgs = [shell]
        }
      } else {
        spawnCmd = shell
        spawnArgs = []
      }

      const resolvedCwd = resolveCwd(options?.cwd)
      console.log(`[pty-manager] Launching shell-only PTY: ${spawnCmd} ${spawnArgs.join(' ')} cwd=${resolvedCwd}${elevated ? ' (elevated)' : ''}`)

      ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: resolvedCwd,
        env: { ...process.env, CLAUDE_MULTI_SESSION_ID: sessionId } as Record<string, string>,
        useConpty: false
      })

      // Explicitly cd to ensure the shell is in the right directory
      // (PowerShell profiles can change cwd before the user sees the prompt)
      const escapedShellCwd = resolvedCwd.replace(/'/g, "''")
      const cdCmd = os.platform() === 'win32'
        ? `Set-Location '${escapedShellCwd}'`
        : `cd '${resolvedCwd.replace(/'/g, "'\\''")}' 2>/dev/null; clear`
      setTimeout(() => {
        ptyProcess.write(cdCmd + '\r')
      }, 300)
    } else {
      // Launch Claude Code interactive mode.
      // Spawn a shell first, explicitly cd to the project directory, then run claude.
      // We must cd explicitly because:
      //   1. PowerShell profiles can change the working directory before our command runs
      //   2. WinPTY may not always propagate cwd correctly
      //   3. Spawning claude.cmd directly via pty.spawn fails to propagate cwd on Windows
      // Without the explicit cd, conversations get stored under the wrong project hash
      // and won't appear when the user tries to /resume.
      const { cmd } = resolveClaudeForPty()
      const resolvedCwd = resolveCwd(options?.cwd)
      const shell = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash'
      console.log(`[pty-manager] Launching Claude via shell in PTY: ${shell} -> ${cmd} cwd=${resolvedCwd} (resumePicker=${!!options?.useResumePicker})`)

      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: resolvedCwd,
        env: { ...process.env, CLAUDE_MULTI_SESSION_ID: sessionId } as Record<string, string>,
        useConpty: false
      })

      // Explicitly cd to the project directory, then launch Claude.
      // The cd is critical — it ensures Claude sees the correct project directory
      // regardless of PowerShell profile scripts or PTY cwd propagation issues.
      const escapedCwd = resolvedCwd.replace(/'/g, "''")

      // When useResumePicker is true, run the resume-picker script instead of Claude directly.
      // The picker shows prior conversations and launches Claude with --resume or plain.
      let escapedCmd: string
      if (options?.useResumePicker) {
        const pickerScript = getResumePickerPath()
        if (pickerScript && os.platform() === 'win32') {
          const escapedScript = pickerScript.replace(/'/g, "''")
          escapedCmd = `Set-Location '${escapedCwd}'; node '${escapedScript}'; exit`
        } else if (pickerScript) {
          escapedCmd = `cd '${escapedCwd.replace(/'/g, "'\\''")}' && node '${pickerScript.replace(/'/g, "'\\''")}'; exit`
        } else {
          // Fallback: no picker script found, launch Claude directly
          escapedCmd = os.platform() === 'win32'
            ? `Set-Location '${escapedCwd}'; & "${cmd}"; exit`
            : `cd '${escapedCwd.replace(/'/g, "'\\''")}' && "${cmd}"; exit`
        }
      } else {
        escapedCmd = os.platform() === 'win32'
          ? `Set-Location '${escapedCwd}'; & "${cmd}"; exit`
          : `cd '${escapedCwd.replace(/'/g, "'\\''")}' && "${cmd}"; exit`
      }
      setTimeout(() => {
        ptyProcess.write(escapedCmd + '\r')
      }, 300)
    }

    ptyProcess.onData((data) => {
      if (win.isDestroyed()) return
      win.webContents.send(`pty:data:${sessionId}`, data)
    })
  }

  ptySessions.set(sessionId, { ptyProcess, sessionId })

  // Replay any buffered writes (from commands sent before PTY was ready)
  const pending = pendingWrites.get(sessionId)
  if (pending) {
    logInfo(`[pty] Replaying ${pending.length} buffered write(s) for ${sessionId}`)
    for (const data of pending) {
      ptyProcess.write(data)
    }
    pendingWrites.delete(sessionId)
  }

  // Start session logging
  const configLabel = options?.configLabel || 'default'
  startSessionLog(sessionId, configLabel)

  // Pipe PTY output to session logger and debug capture
  ptyProcess.onData((data) => {
    logSessionData(sessionId, data)
    if (isDebugModeEnabled()) {
      logPtyOutput(sessionId, data)
    }
  })

  ptyProcess.onExit(({ exitCode }) => {
    logInfo(`[pty] PTY exited for session ${sessionId} with code ${exitCode}`)
    endSessionLog(sessionId)
    ptySessions.delete(sessionId)
    if (win.isDestroyed()) {
      logDebug(`[pty] Window already destroyed, skipping exit notification for ${sessionId}`)
      return
    }
    win.webContents.send(`pty:exit:${sessionId}`, exitCode)
  })
}

export function writePty(sessionId: string, data: string): void {
  try {
    const session = ptySessions.get(sessionId)
    if (session) {
      session.ptyProcess.write(data)
    } else if (sessionId === '__cli_setup__') {
      writeCliSetupPty(data)
    } else {
      // PTY not spawned yet — buffer the write (e.g., partner terminal command clicked before PTY ready)
      const pending = pendingWrites.get(sessionId) || []
      pending.push(data)
      pendingWrites.set(sessionId, pending)
      logInfo(`[pty] Buffered write for ${sessionId} (PTY not yet spawned, ${pending.length} pending)`)
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EPIPE' || code === 'EIO') {
      ptySessions.delete(sessionId)
    } else {
      throw err
    }
  }
}

export function resizePty(sessionId: string, cols: number, rows: number): void {
  try {
    ptySessions.get(sessionId)?.ptyProcess.resize(cols, rows)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EPIPE' || code === 'EIO') {
      ptySessions.delete(sessionId)
    }
    // ignore all resize errors
  }
}

export function killPty(sessionId: string): void {
  const entry = ptySessions.get(sessionId)
  if (entry) {
    logInfo(`[pty] Killing PTY for session ${sessionId}`)
    try { entry.ptyProcess.kill() } catch (err) {
      logError(`[pty] Error killing PTY ${sessionId}:`, err)
    }
    ptySessions.delete(sessionId)
  }
  pendingWrites.delete(sessionId)
}

export function killAllPty(): void {
  logInfo(`[pty] Killing all PTYs (${ptySessions.size} active)`)
  for (const [id] of ptySessions) {
    killPty(id)
  }
}

/**
 * Gracefully exit a Claude session by sending /exit command.
 * Returns a promise that resolves when the PTY exits, or rejects on timeout.
 */
export function gracefulExitPty(sessionId: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const entry = ptySessions.get(sessionId)
    if (!entry) {
      resolve() // Already gone
      return
    }

    const timeout = setTimeout(() => {
      // Timeout - force kill
      console.log(`[pty-manager] Graceful exit timeout for ${sessionId}, force killing`)
      killPty(sessionId)
      resolve()
    }, timeoutMs)

    // Listen for exit
    entry.ptyProcess.onExit(() => {
      clearTimeout(timeout)
      ptySessions.delete(sessionId)
      resolve()
    })

    // Send Escape (cancel any pending input), then /exit
    entry.ptyProcess.write('\x1b')  // Escape
    setTimeout(() => {
      if (ptySessions.has(sessionId)) {
        entry.ptyProcess.write('\x03')  // Ctrl+C to interrupt anything
      }
    }, 100)
    setTimeout(() => {
      if (ptySessions.has(sessionId)) {
        entry.ptyProcess.write('/exit\r')
      }
    }, 300)
  })
}

/**
 * Gracefully exit all PTY sessions.
 * Returns when all have exited or timed out.
 */
export async function gracefulExitAllPty(timeoutMs = 5000): Promise<void> {
  const sessionIds = Array.from(ptySessions.keys())
  if (sessionIds.length === 0) return

  console.log(`[pty-manager] Gracefully exiting ${sessionIds.length} sessions...`)
  await Promise.all(sessionIds.map(id => gracefulExitPty(id, timeoutMs)))
  console.log('[pty-manager] All sessions exited')
}

/**
 * Get list of active session IDs
 */
export function getActivePtySessionIds(): string[] {
  return Array.from(ptySessions.keys())
}
