import { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import * as os from 'os'
import { execSync } from 'child_process'
import { startSessionLog, logSessionData, endSessionLog } from './session-logger'
import { logPtyOutput, isDebugModeEnabled } from './debug-capture'
import { logInfo, logDebug, logError } from './debug-logger'
import { writeCliSetupPty, getResourcesDirectory } from './ipc/setup-handlers'
import { isGlobalVisionRunning, getGlobalVisionConfig } from './vision-manager'
import { resolveVersionBinary } from './legacy-version-manager'

import * as path from 'path'
import * as fs from 'fs'

function escapeShellArg(str: string): string {
  return str.replace(/[\\"$`]/g, '\\$&')
}

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
 * Generate a single node script that handles ALL remote setup:
 * - Probes for mounted resources directory
 * - Configures statusline in settings.json
 * - Configures MCP vision server (if running) in settings.json
 * - Cleans up legacy CLAUDE.md vision markers
 *
 * Returns the script content to write to ~/.claude/conductor-setup.js
 * The PTY then only needs to write: `node ~/.claude/conductor-setup.js && claude`
 */
function generateRemoteSetupScript(sessionId: string): string {
  const hasVision = isGlobalVisionRunning()
  const mcpPort = getGlobalVisionConfig()?.mcpPort || 19333

  return `
const fs=require('fs'),path=require('path'),os=require('os');
const home=os.homedir(),claudeDir=path.join(home,'.claude');
try{fs.mkdirSync(claudeDir,{recursive:true})}catch{}

// Probe for mounted resources
let ccres='';
try{
  const dirs=['/mnt','/mnt'];
  for(const base of fs.readdirSync('/mnt')){
    const d=path.join('/mnt',base,'scripts');
    if(fs.existsSync(path.join(d,'claude-multi-statusline.js'))){ccres=d;break}
    try{for(const sub of fs.readdirSync(path.join('/mnt',base))){
      const d2=path.join('/mnt',base,sub,'scripts');
      if(fs.existsSync(path.join(d2,'claude-multi-statusline.js'))){ccres=d2;break}
    }}catch{}
    if(ccres)break;
  }
}catch{}
if(!ccres)ccres='/mnt/resources/scripts';

// Configure statusline + MCP vision in settings.json
const sp=path.join(claudeDir,'settings.json');
let s={};try{s=JSON.parse(fs.readFileSync(sp,'utf-8'))}catch{}
s.statusLine={type:'command',command:'CLAUDE_MULTI_SESSION_ID=${sessionId} node '+ccres+'/claude-multi-statusline.js'};
${hasVision ? `if(!s.mcpServers)s.mcpServers={};s.mcpServers['conductor-vision']={url:'http://localhost:${mcpPort}/sse'};` : `if(s.mcpServers&&s.mcpServers['conductor-vision'])delete s.mcpServers['conductor-vision'];`}
fs.writeFileSync(sp,JSON.stringify(s,null,2));

// Also clean conductor-vision from ~/.claude.json if present (wrong schema for that file)
try{const cj=path.join(home,'.claude.json');if(fs.existsSync(cj)){let c=JSON.parse(fs.readFileSync(cj,'utf-8'));if(c.mcpServers&&c.mcpServers['conductor-vision']){delete c.mcpServers['conductor-vision'];fs.writeFileSync(cj,JSON.stringify(c,null,2))}}}catch{}

// Clean up legacy CLAUDE.md vision markers
try{const md=path.join(claudeDir,'CLAUDE.md');let c=fs.readFileSync(md,'utf-8');const rx=/\\n?\\n?<!-- VISION-INSTRUCTIONS-START -->[\\s\\S]*?<!-- VISION-INSTRUCTIONS-END -->\\n?/g;if(rx.test(c)){c=c.replace(rx,'').trim();c?fs.writeFileSync(md,c+'\\n'):fs.unlinkSync(md)}}catch{}

process.stdout.write('setup ok\\n');
`.trim().replace(/\n/g, '')  // Single line for PTY safety
}

/**
 * Write the setup script to the remote, execute it, then clean up.
 * Uses a short write-and-run pattern to avoid PTY echo of the long script.
 */
function getRemoteSetupCommand(sessionId: string, remotePath: string): string {
  const script = generateRemoteSetupScript(sessionId)
  // Base64-encode the script so the PTY only echoes a short command
  const b64 = Buffer.from(script).toString('base64')
  return `echo '${b64}' | base64 -d | node 2>/dev/null; cd ${remotePath}`
}

/**
 * Resolve the claude command for PTY usage.
 * If legacyVersion is provided and enabled, uses the managed install binary.
 * Otherwise checks for native CLI (claude.exe) first, then npm wrapper (claude.cmd).
 */
export function resolveClaudeForPty(legacyVersion?: { enabled: boolean; version: string }): { cmd: string; args: string[] } {
  // Try legacy version binary first
  if (legacyVersion?.enabled && legacyVersion.version) {
    const legacyBin = resolveVersionBinary(legacyVersion.version)
    if (legacyBin) {
      logInfo(`[pty] Using legacy Claude CLI v${legacyVersion.version}: ${legacyBin}`)
      return { cmd: legacyBin, args: [] }
    }
    logInfo(`[pty] Legacy v${legacyVersion.version} binary not found, falling back to system claude`)
  }

  if (os.platform() !== 'win32') {
    return { cmd: 'claude', args: [] }
  }

  // Try native CLI first (.exe), then npm wrapper (.cmd)
  for (const bin of ['claude.exe', 'claude.cmd']) {
    try {
      const cmdPath = execSync(`where ${bin}`, { encoding: 'utf-8', timeout: 5000 })
        .trim().split('\n')[0].trim()
      return { cmd: cmdPath, args: [] }
    } catch { /* try next */ }
  }
  return { cmd: 'claude', args: [] }
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
  options?: { cwd?: string; cols?: number; rows?: number; ssh?: SSHOptions; shellOnly?: boolean; elevated?: boolean; configLabel?: string; useResumePicker?: boolean; legacyVersion?: { enabled: boolean; version: string }; agentsConfig?: Array<{ name: string; description: string; prompt: string; model?: string; tools?: string[] }>; flickerFree?: boolean; powershellTool?: boolean; effortLevel?: 'low' | 'medium' | 'high'; disableAutoMemory?: boolean }
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

    // Add reverse tunnel for MCP vision server so remote sessions can reach it
    if (isGlobalVisionRunning()) {
      const mcpPort = getGlobalVisionConfig()?.mcpPort || 19333
      sshArgs.push('-R', `${mcpPort}:localhost:${mcpPort}`)
    }

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
    const claudeEnvPrefix = [
      options?.flickerFree ? 'CLAUDE_CODE_NO_FLICKER=1' : '',
      options?.powershellTool ? 'CLAUDE_CODE_USE_POWERSHELL_TOOL=1' : '',
      options?.disableAutoMemory ? 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1' : '',
    ].filter(Boolean).join(' ')
    const claudeFlags = [
      options?.effortLevel ? `--effort ${options.effortLevel}` : '',
      options?.configLabel ? `--name "${escapeShellArg(options.configLabel)}"` : '',
    ].filter(Boolean).join(' ')
    const claudeCmd = [claudeEnvPrefix, 'claude', claudeFlags].filter(Boolean).join(' ')
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

      // After SSH login, cd to remotePath and optionally run postCommand.
      // Only match shell prompts at end of the last line (not MOTD/banners).
      const lastLine = data.split('\n').pop()?.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim() || ''
      if (!cdSent && lastLine.length < 200 && /[$#>~]\s*$/.test(lastLine)) {
        cdSent = true
        setTimeout(() => {
          // Run the consolidated setup script (statusline + vision + CLAUDE.md)
          // then cd to project and optionally start Claude
          const setupCmd = getRemoteSetupCommand(sessionId, remotePath)
          if (postCommand) {
            ptyProcess.write(`${setupCmd} && ${postCommand}\r`)
            postCommandSent = true
          } else if (startClaudeAfter && !options?.shellOnly) {
            claudeSent = true
            ptyProcess.write(`${setupCmd} && ${claudeCmd}\r`)
          } else {
            ptyProcess.write(`${setupCmd} && clear\r`)
          }
        }, 200)
        return
      }

      // After post-command completes (container shell ready), optionally start Claude
      if (postCommandSent && !claudeSent && startClaudeAfter && !options?.shellOnly) {
        const sudoHandled = !sudoPassword || sudoPasswordSent
        if (sudoHandled && !postCommandShellReady) {
          const trimmed = data.trimEnd()
          if (trimmed.endsWith('#') || trimmed.endsWith('$') || trimmed.endsWith('>')) {
            postCommandShellReady = true
            setTimeout(() => {
              claudeSent = true
              const setupCmd = getRemoteSetupCommand(sessionId, remotePath)
              ptyProcess.write(`${setupCmd} && ${claudeCmd}\r`)
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

      const shellEnv: Record<string, string> = { ...process.env, CLAUDE_MULTI_SESSION_ID: sessionId } as Record<string, string>
      if (options?.flickerFree) shellEnv.CLAUDE_CODE_NO_FLICKER = '1'
      if (options?.powershellTool) shellEnv.CLAUDE_CODE_USE_POWERSHELL_TOOL = '1'

      ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: resolvedCwd,
        env: shellEnv,
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
      const { cmd } = resolveClaudeForPty(options?.legacyVersion)
      const resolvedCwd = resolveCwd(options?.cwd)
      const shell = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash'
      console.log(`[pty-manager] Launching Claude via shell in PTY: ${shell} -> ${cmd} cwd=${resolvedCwd} (resumePicker=${!!options?.useResumePicker})`)

      const claudeEnv: Record<string, string> = { ...process.env, CLAUDE_MULTI_SESSION_ID: sessionId } as Record<string, string>
      if (options?.flickerFree) claudeEnv.CLAUDE_CODE_NO_FLICKER = '1'
      if (options?.powershellTool) claudeEnv.CLAUDE_CODE_USE_POWERSHELL_TOOL = '1'
      if (options?.disableAutoMemory) claudeEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'

      ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: resolvedCwd,
        env: claudeEnv,
        useConpty: false
      })

      // Explicitly cd to the project directory, then launch Claude.
      // The cd is critical — it ensures Claude sees the correct project directory
      // regardless of PowerShell profile scripts or PTY cwd propagation issues.
      const escapedCwd = resolvedCwd.replace(/'/g, "''")

      // Build extra CLI flags (--name, --effort)
      let extraFlags = ''
      if (options?.configLabel) {
        extraFlags += ` --name "${escapeShellArg(options.configLabel)}"`
      }
      if (options?.effortLevel) {
        extraFlags += ` --effort ${options.effortLevel}`
      }

      // Build --agents flag if agent templates are configured
      let agentsFlag = ''
      if (options?.agentsConfig && options.agentsConfig.length > 0) {
        const agentsJson = JSON.stringify(options.agentsConfig)
        if (os.platform() === 'win32') {
          // PowerShell: single-quote the JSON, escape internal single quotes by doubling
          const escaped = agentsJson.replace(/'/g, "''")
          agentsFlag = ` --agents '${escaped}'`
        } else {
          // Bash: single-quote the JSON, escape internal single quotes
          const escaped = agentsJson.replace(/'/g, "'\\''")
          agentsFlag = ` --agents '${escaped}'`
        }
        logInfo(`[pty] Agents flag for ${sessionId}: ${agentsFlag.slice(0, 200)}...`)
      }

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
            ? `Set-Location '${escapedCwd}'; & "${cmd}"${agentsFlag}${extraFlags}; exit`
            : `cd '${escapedCwd.replace(/'/g, "'\\''")}' && "${cmd}"${agentsFlag}${extraFlags}; exit`
        }
      } else {
        escapedCmd = os.platform() === 'win32'
          ? `Set-Location '${escapedCwd}'; & "${cmd}"${agentsFlag}${extraFlags}; exit`
          : `cd '${escapedCwd.replace(/'/g, "'\\''")}' && "${cmd}"${agentsFlag}${extraFlags}; exit`
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

// Large writes to WinPTY/ConPTY can overflow the console input buffer,
// causing truncation. Only chunk large writes (pastes); keystrokes go straight through.
const WRITE_CHUNK_SIZE = 256
const WRITE_CHUNK_DELAY = 12

function writeChunked(ptyProcess: pty.IPty, data: string): void {
  let offset = 0
  const writeNext = () => {
    if (offset >= data.length) return
    const end = Math.min(offset + WRITE_CHUNK_SIZE, data.length)
    ptyProcess.write(data.slice(offset, end))
    offset = end
    if (offset < data.length) {
      setTimeout(writeNext, WRITE_CHUNK_DELAY)
    }
  }
  writeNext()
}

// Track recent SUBMITTED writes per session to detect + suppress accidental double-sends.
// A prompt being submitted twice causes two Claude API calls and can trigger rate limits.
//
// Only writes that end in \r or \n are considered — those are "submitted" payloads:
//   - Command button clicks (`fullCommand + '\r'`)
//   - Screenshot path sends (`path + '\r'`)
//   - Storyboard line-by-line output
//   - Right-click paste of multi-line text
//
// Individual keystrokes and escape sequences (arrow keys, function keys, Unicode chars,
// ANSI sequences) do NOT end in \r and pass through unchanged — so terminal navigation,
// rapid typing, and non-Latin input work normally.
const DEDUPE_WINDOW_MS = 300
const recentWrites = new Map<string, { data: string; ts: number }>()

function isSubmittedPayload(data: string): boolean {
  // Multi-byte payload that ends in \r or \n — treat as an atomic "submit"
  if (data.length < 2) return false
  const last = data.charCodeAt(data.length - 1)
  return last === 13 /* \r */ || last === 10 /* \n */
}

export function writePty(sessionId: string, data: string): void {
  // Dedupe guard: suppress identical repeats of submitted payloads within a short window.
  // This protects against double-sends from double-clicks, React effect races, event
  // listeners firing twice, etc. Only applies to "submitted" writes (ending in \r or \n)
  // so keystrokes and escape sequences are never blocked.
  if (isSubmittedPayload(data)) {
    const recent = recentWrites.get(sessionId)
    const now = Date.now()
    if (recent && recent.data === data && (now - recent.ts) < DEDUPE_WINDOW_MS) {
      // Do NOT log the payload content — it can contain user prompts,
      // credentials, or other sensitive text that we don't want in log files.
      // Only log the metadata needed to diagnose the source of the duplicate.
      logInfo(`[pty] DUPLICATE SUBMIT SUPPRESSED for ${sessionId} (${now - recent.ts}ms apart, ${data.length} bytes)`)
      return
    }
    recentWrites.set(sessionId, { data, ts: now })
  }

  try {
    const session = ptySessions.get(sessionId)
    if (session) {
      if (data.length > WRITE_CHUNK_SIZE) {
        writeChunked(session.ptyProcess, data)
      } else {
        session.ptyProcess.write(data)
      }
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
  recentWrites.delete(sessionId)
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

    // Attach exit listener BEFORE writing to avoid race condition
    entry.ptyProcess.onExit(() => {
      clearTimeout(timeout)
      ptySessions.delete(sessionId)
      resolve()
    })

    const timeout = setTimeout(() => {
      // Timeout - force kill
      console.log(`[pty-manager] Graceful exit timeout for ${sessionId}, force killing`)
      killPty(sessionId)
      resolve()
    }, timeoutMs)

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
