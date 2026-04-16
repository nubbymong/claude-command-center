import { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import * as os from 'os'
import { execSync } from 'child_process'
import { startSessionLog, logSessionData, endSessionLog } from './session-logger'
import { logPtyOutput, isDebugModeEnabled } from './debug-capture'
import { logInfo, logDebug, logError } from './debug-logger'
import { writeCliSetupPty, getResourcesDirectory } from './ipc/setup-handlers'
import { isGlobalVisionRunning, getGlobalVisionConfig, getConductorMcpPort } from './vision-manager'
import { resolveVersionBinary } from './legacy-version-manager'
import { dispatchSSHStatuslineUpdate } from './statusline-watcher'
import { checkForDevServer, clearDetectedServers } from './preview-manager'
import { IPC } from '../shared/ipc-channels'

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

// Buffer recent output per session for side chat context extraction
const ptyOutputBuffers = new Map<string, string>()
const MAX_OUTPUT_BUFFER = 50000 // ~50KB per session

// === SSH OSC sentinel parser ===
//
// Remote SSH sessions can't write status files to the local host, so the
// SSH_STATUSLINE_SHIM (deployed during remote setup) emits an OSC sentinel
// to /dev/tty containing the status JSON. The sentinel travels back through
// the SSH PTY stream to this process.
//
// We extract sentinels from each chunk before forwarding the cleaned data to
// xterm, then dispatch the parsed JSON via statusline-watcher's existing pipeline.
const SSH_OSC_PREFIX = '\x1b]9999;CMSTATUS='
const SSH_OSC_TERMINATOR = '\x07'
const MAX_OSC_BUFFER = 32 * 1024  // cap to prevent runaway memory on malformed streams
const sshOscBuffers = new Map<string, string>()

/**
 * Strip SSH OSC sentinels from a PTY data chunk.
 * Returns the cleaned chunk (sentinels removed). Parsed sentinel payloads
 * are dispatched to statusline-watcher synchronously.
 *
 * Handles partial sentinels split across chunks via per-session buffering.
 */
function extractSshOscSentinels(sessionId: string, chunk: string): string {
  const combined = (sshOscBuffers.get(sessionId) || '') + chunk
  let cleaned = ''
  let i = 0
  while (i < combined.length) {
    const start = combined.indexOf(SSH_OSC_PREFIX, i)
    if (start === -1) {
      cleaned += combined.slice(i)
      sshOscBuffers.delete(sessionId)
      return cleaned
    }
    cleaned += combined.slice(i, start)
    const end = combined.indexOf(SSH_OSC_TERMINATOR, start + SSH_OSC_PREFIX.length)
    if (end === -1) {
      // Partial sentinel — buffer the leftover for the next chunk
      const leftover = combined.slice(start)
      if (leftover.length > MAX_OSC_BUFFER) {
        // Likely a false start or junk — drop the buffer
        sshOscBuffers.delete(sessionId)
      } else {
        sshOscBuffers.set(sessionId, leftover)
      }
      return cleaned
    }
    const json = combined.slice(start + SSH_OSC_PREFIX.length, end)
    try { dispatchSSHStatuslineUpdate(json) } catch { /* ignore */ }
    i = end + SSH_OSC_TERMINATOR.length
  }
  sshOscBuffers.delete(sessionId)
  return cleaned
}

/**
 * SSH statusline shim — Node.js script written to the REMOTE host at
 * ~/.claude/conductor-ssh-statusline.js during SSH setup.
 *
 * Claude Code on the remote runs this as its statusLine command. The shim
 * receives JSON status data on stdin (from Claude's statusline hook), then
 * emits an OSC sentinel directly to the controlling TTY (/dev/tty).
 *
 * The OSC sentinel travels back through the SSH PTY to the local Conductor,
 * where pty-manager's OSC parser extracts and dispatches it to the renderer.
 *
 * /dev/tty is used (not stdout) because Claude captures the script's stdout
 * for its own statusline display — writing the sentinel there would either
 * be re-rendered visibly or stripped. /dev/tty bypasses Claude entirely.
 */
const SSH_STATUSLINE_SHIM = `#!/usr/bin/env node
const fs=require('fs'),https=require('https');
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>input+=c);
process.stdin.on('end',async()=>{
try{
const data=JSON.parse(input);
const sid=process.env.CLAUDE_MULTI_SESSION_ID||'unknown';
const cw=data.context_window||{};
const u=cw.current_usage||{};
const it=(u.input_tokens||0)+(u.cache_creation_input_tokens||0)+(u.cache_read_input_tokens||0);
const cost=data.cost||{};
const m=data.model||{};
const s={sessionId:sid,model:m.display_name||m.id,contextUsedPercent:cw.used_percentage,contextRemainingPercent:cw.remaining_percentage,contextWindowSize:cw.context_window_size,inputTokens:it||undefined,outputTokens:u.output_tokens,costUsd:cost.total_cost_usd,totalDurationMs:cost.total_duration_ms,linesAdded:cost.total_lines_added,linesRemoved:cost.total_lines_removed,timestamp:Date.now()};
const cacheFile='/tmp/claude-command-center-usage-cache.json';
let limits=null;
try{const st=fs.statSync(cacheFile);if((Date.now()-st.mtimeMs)/1000<60)limits=JSON.parse(fs.readFileSync(cacheFile,'utf-8'));}catch{}
if(!limits){try{const home=require('os').homedir();const creds=JSON.parse(fs.readFileSync(home+'/.claude/.credentials.json','utf-8'));const tok=creds.claudeAiOauth?.accessToken;if(tok){limits=await new Promise((res)=>{const req=https.get('https://api.anthropic.com/api/oauth/usage',{headers:{Authorization:'Bearer '+tok},timeout:5000},(r)=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{res(JSON.parse(b));}catch{res(null);}});});req.on('error',()=>res(null));req.on('timeout',()=>{req.destroy();res(null);});});if(limits)try{fs.writeFileSync(cacheFile,JSON.stringify(limits));}catch{}}}catch{}}
if(limits){if(limits.five_hour){s.rateLimitCurrent=Math.round(Number(limits.five_hour.utilization)||0);s.rateLimitCurrentResets=limits.five_hour.resets_at||'';}if(limits.seven_day){s.rateLimitWeekly=Math.round(Number(limits.seven_day.utilization)||0);s.rateLimitWeeklyResets=limits.seven_day.resets_at||'';}if(limits.extra_usage&&limits.extra_usage.is_enabled){s.rateLimitExtra={enabled:true,utilization:Math.round(Number(limits.extra_usage.utilization)||0),usedUsd:Math.round(Number(limits.extra_usage.used_credits||0))/100,limitUsd:Math.round(Number(limits.extra_usage.monthly_limit||0))/100};}}
const now=new Date();const yr=now.getUTCFullYear();const m2=new Date(Date.UTC(yr,2,8));m2.setUTCDate(8+(7-m2.getUTCDay())%7);const n1=new Date(Date.UTC(yr,10,1));n1.setUTCDate(1+(7-n1.getUTCDay())%7);const ptOff=(now>=m2&&now<n1)?-7:-8;const ptH=(now.getUTCHours()+ptOff+24)%24;const ptD=new Date(now.getTime()+ptOff*3600000).getUTCDay();s.isPeak=(ptD>=1&&ptD<=5&&ptH>=5&&ptH<11);
const sentinel='\\x1b]9999;CMSTATUS='+JSON.stringify(s)+'\\x07';
try{fs.writeFileSync('/dev/tty',sentinel);}catch(e){process.stdout.write(sentinel);}
process.stdout.write(' ');
}catch(e){process.stdout.write(' ');}
});
`

/**
 * Generate a single node script that handles ALL remote setup:
 * - Writes the SSH statusline shim to ~/.claude/conductor-ssh-statusline.js
 * - Configures statusline in settings.json to invoke the shim
 * - Configures MCP vision server (if running) in settings.json
 * - Cleans up legacy CLAUDE.md vision markers
 *
 * Returns the script content. The PTY base64-encodes and pipes it to node.
 */
function generateRemoteSetupScript(sessionId: string): string {
  // Conductor MCP server is always running (independent of browser/vision config),
  // so SSH sessions always get the conductor-vision MCP entry pointing at the
  // reverse-tunneled MCP port. The fetch_host_screenshot tool is always available;
  // browser tools fall back to "vision not connected" if no browser is attached.
  const mcpPort = getConductorMcpPort() || 19333
  const hasVision = mcpPort > 0
  // Embed the shim as a JSON string literal — Node parses it back to source
  const shimLiteral = JSON.stringify(SSH_STATUSLINE_SHIM)

  // Build as semicolon-separated statements — NO comments (they break single-lining)
  const lines = [
    `const fs=require('fs'),path=require('path'),os=require('os')`,
    `const home=os.homedir(),claudeDir=path.join(home,'.claude')`,
    `try{fs.mkdirSync(claudeDir,{recursive:true})}catch{}`,
    `const shimPath=path.join(claudeDir,'conductor-ssh-statusline.js')`,
    `try{fs.writeFileSync(shimPath,${shimLiteral},{mode:0o755})}catch{}`,
    `const sp=path.join(claudeDir,'settings.json')`,
    `let s={};try{s=JSON.parse(fs.readFileSync(sp,'utf-8'))}catch{}`,
    `s.statusLine={type:'command',command:'CLAUDE_MULTI_SESSION_ID=${sessionId} node '+shimPath}`,
    hasVision
      ? `if(!s.mcpServers)s.mcpServers={};s.mcpServers['conductor-vision']={url:'http://localhost:${mcpPort}/sse'}`
      : `if(s.mcpServers&&s.mcpServers['conductor-vision'])delete s.mcpServers['conductor-vision']`,
    `fs.writeFileSync(sp,JSON.stringify(s,null,2))`,
    `try{const cj=path.join(home,'.claude.json');if(fs.existsSync(cj)){let c=JSON.parse(fs.readFileSync(cj,'utf-8'));if(c.mcpServers&&c.mcpServers['conductor-vision']){delete c.mcpServers['conductor-vision'];fs.writeFileSync(cj,JSON.stringify(c,null,2))}}}catch{}`,
    `try{const md=path.join(claudeDir,'CLAUDE.md');let c=fs.readFileSync(md,'utf-8');const rx=/\\n?\\n?<!-- VISION-INSTRUCTIONS-START -->[\\s\\S]*?<!-- VISION-INSTRUCTIONS-END -->\\n?/g;if(rx.test(c)){c=c.replace(rx,'').trim();c?fs.writeFileSync(md,c+'\\n'):fs.unlinkSync(md)}}catch{}`,
    `process.stdout.write('setup ok\\n')`,
  ]
  return lines.join(';')
}

/**
 * Write the setup script to the remote, execute it, then clean up.
 * Uses a short write-and-run pattern to avoid PTY echo of the long script.
 */
/**
 * Build the shell command that runs the setup script on the remote host.
 *
 * Why base64? The setup script is a multi-line Node.js program that configures
 * the statusline shim and MCP vision in ~/.claude/settings.json. Sending it
 * directly through the PTY would be unreliable (quoting, line breaks, echo).
 * Instead we base64-encode it and pipe through `base64 -d | node`:
 *
 *   stty -echo          ← suppress terminal echo so the blob isn't visible
 *   echo '<base64>' | base64 -d | node   ← decode and execute
 *   stty echo           ← restore echo
 *   cd <path> && clear  ← navigate to project and clean the screen
 *
 * The script itself is generated by generateRemoteSetupScript() above.
 * All errors are suppressed (2>/dev/null) so a failed setup doesn't break
 * the SSH session — the user can still use Claude, just without statusline.
 */
function getRemoteSetupCommand(sessionId: string, remotePath: string): string {
  const script = generateRemoteSetupScript(sessionId)
  const b64 = Buffer.from(script).toString('base64')
  return `stty -echo 2>/dev/null; echo '${b64}' | base64 -d | node 2>/dev/null; stty echo 2>/dev/null; cd ${remotePath} && clear`
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

    // Add reverse tunnel for the Conductor MCP server so remote sessions can reach
    // both fetch_host_screenshot (always) and vision tools (when browser connected).
    const mcpPort = getConductorMcpPort()
    if (mcpPort > 0) {
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

    ptyProcess.onData((rawData) => {
      if (win.isDestroyed()) return
      // Strip SSH statusline OSC sentinels before forwarding to xterm.
      // Parsed sentinels are dispatched to the statusline pipeline as a side effect.
      const data = extractSshOscSentinels(sessionId, rawData)
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
          } else if (!options?.shellOnly) {
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
    const resolvedCwd = resolveCwd(options?.cwd)

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
      logInfo(`[pty-manager] Launching shell-only PTY: ${spawnCmd} ${spawnArgs.join(' ')} cwd=${resolvedCwd}${elevated ? ' (elevated)' : ''}`)

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
      const shell = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash'
      logInfo(`[pty-manager] Launching Claude via shell in PTY: ${shell} -> ${cmd} cwd=${resolvedCwd} (resumePicker=${!!options?.useResumePicker})`)

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
      // Buffer output for side chat context extraction
      const existing = ptyOutputBuffers.get(sessionId) || ''
      const updated = existing + data
      ptyOutputBuffers.set(sessionId, updated.length > MAX_OUTPUT_BUFFER ? updated.slice(-MAX_OUTPUT_BUFFER) : updated)
      // Detect dev server URLs for Preview Pane
      const devUrl = checkForDevServer(sessionId, data, resolvedCwd)
      if (devUrl) {
        win.webContents.send(IPC.PREVIEW_DEV_SERVER_DETECTED, sessionId, devUrl)
      }
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
  sshOscBuffers.delete(sessionId)
  ptyOutputBuffers.delete(sessionId)
  clearDetectedServers(sessionId)
}

export function killAllPty(): void {
  logInfo(`[pty] Killing all PTYs (${ptySessions.size} active)`)
  for (const [id] of ptySessions) {
    killPty(id)
  }
}

export function getPtyOutputBuffer(sessionId: string): string | undefined {
  return ptyOutputBuffers.get(sessionId)
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
      logInfo(`[pty-manager] Graceful exit timeout for ${sessionId}, force killing`)
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

  logInfo(`[pty-manager] Gracefully exiting ${sessionIds.length} sessions...`)
  await Promise.all(sessionIds.map(id => gracefulExitPty(id, timeoutMs)))
  logInfo('[pty-manager] All sessions exited')
}

/**
 * Get list of active session IDs
 */
export function getActivePtySessionIds(): string[] {
  return Array.from(ptySessions.keys())
}
