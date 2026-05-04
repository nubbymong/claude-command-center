import { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import * as os from 'os'
import { execSync } from 'child_process'
import { startSessionLog, logSessionData, endSessionLog } from './session-logger'
import { logPtyOutput, isDebugModeEnabled } from './debug-capture'
import { logInfo, logDebug, logError } from './debug-logger'
import { writeCliSetupPty, getResourcesDirectory } from './ipc/setup-handlers'
import { isGlobalVisionRunning, getGlobalVisionConfig, getConductorMcpPort } from './vision-manager'
import { resolveClaudeBinary } from './providers/claude/spawn'
import { detectClaudeUi, lastPromptLineForClaude } from './providers/claude/ui-detection'
import { getProvider } from './providers'
import { isSshCapable } from './providers/types'
import type { TelemetrySource } from './providers/types'
import { resolveCwd } from './path-utils'
import { dispatchSSHStatuslineUpdate } from './statusline-watcher'
import { handleStatuslineUpdate } from './tokenomics-manager'
import { getGateway } from './hooks'
import { injectHooks } from './hooks/session-hooks-writer'
import {
  writeLocalSessionSettings,
  removeLocalSessionSettings,
} from './hooks/per-session-settings'

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

export interface SSHOptions {
  host: string
  port: number
  username: string
  remotePath: string
  password?: string
  postCommand?: string
  sudoPassword?: string
}

/**
 * Per-session SSH flow controller exposed via IPC. Renderer triggers
 * stage transitions in manual mode by calling these.
 */
export interface SshFlowController {
  runPostCommand: () => void
  launchClaude: () => void
  skip: () => void
  destroy: () => void
  /** Returns the latest emitted state, used by the renderer overlay
   * on mount to catch up if it missed earlier emits. */
  getState: () => { state: SshFlowState; info?: string }
}

const sshFlows = new Map<string, SshFlowController>()

/** Public accessor for IPC handlers. */
export function getSshFlow(sessionId: string): SshFlowController | undefined {
  return sshFlows.get(sessionId)
}

export type SshFlowState =
  | 'connecting'           // SSH still starting / authenticating
  | 'awaiting-postcommand' // host shell ready, postCommand configured, awaiting user click
  | 'awaiting-claude'      // host or inner shell ready, awaiting user click to launch claude
  | 'running-postcommand'  // postCommand in flight
  | 'running-setup'        // setup blob in flight
  | 'running-claude'       // claudeCmd written, claude UI not yet detected
  | 'claude-running'       // claude UI confirmed; no more prompts needed
  | 'shell-only'           // session is shell-only and we're done
  | 'skipped'              // user clicked skip; pty is theirs to drive manually
  | 'failed'               // setup timed out or post-command errored

function emitSshFlowState(win: BrowserWindow, sessionId: string, state: SshFlowState, info?: string): void {
  if (win.isDestroyed()) return
  try {
    win.webContents.send(`ssh:flowState:${sessionId}`, { state, info })
  } catch { /* renderer gone */ }
}

const ptySessions = new Map<string, PtySession>()

// Codex-provider telemetry sources: keyed by sessionId, stopped on PTY exit / kill.
const codexTelemetrySources = new Map<string, TelemetrySource>()

// === SSH OSC sentinel parser ===
//
// Remote SSH sessions can't write status files to the local host, so the
// SSH statusline shim (deployed during remote setup; lives in
// providers/claude/ssh-shim.ts) emits an OSC sentinel to /dev/tty containing
// the status JSON. The sentinel travels back through the SSH PTY stream to
// this process.
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
 * Resolve the claude command for PTY usage.
 * If legacyVersion is provided and enabled, uses the managed install binary.
 * Otherwise checks for native CLI (claude.exe) first, then npm wrapper (claude.cmd).
 */
export function resolveClaudeForPty(legacyVersion?: { enabled: boolean; version: string }): { cmd: string; args: string[] } {
  return resolveClaudeBinary(legacyVersion)
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
  options?: {
    cwd?: string
    cols?: number
    rows?: number
    ssh?: SSHOptions
    shellOnly?: boolean
    elevated?: boolean
    configLabel?: string
    useResumePicker?: boolean
    legacyVersion?: { enabled: boolean; version: string }
    agentsConfig?: Array<{ name: string; description: string; prompt: string; model?: string; tools?: string[] }>
    effortLevel?: 'low' | 'medium' | 'high'
    disableAutoMemory?: boolean
    model?: string
    provider?: 'claude' | 'codex'
    codexOptions?: {
      model?: string
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
      permissionsPreset: 'read-only' | 'standard' | 'auto' | 'unrestricted'
    }
  }
): void {
  logInfo(`[pty] Spawning PTY for session ${sessionId} (ssh=${!!options?.ssh}, shellOnly=${!!options?.shellOnly}, cwd=${options?.cwd || 'default'})`)
  killPty(sessionId)

  const cols = options?.cols || 120
  const rows = options?.rows || 30

  let ptyProcess: pty.IPty

  if (options?.ssh) {
    // Defensive guard: Codex over SSH is not yet supported. The renderer-side
    // dialog prevents this combination, but guard here in case of direct IPC calls.
    if ((options?.provider ?? 'claude') === 'codex') {
      throw new Error('Codex over SSH is not supported in v1.5.0 (planned for v1.5.x). Switch the session to local or pick the Claude provider.')
    }

    // SSH session: spawn ssh command, then chain claude after cd
    const ssh = options.ssh
    // Lift: SSH setup script + per-session settings path live on the
    // ClaudeProvider's SSH-capable surface (see providers/claude/ssh-shim.ts).
    const claudeProvider = getProvider('claude')
    if (!isSshCapable(claudeProvider)) throw new Error('Claude provider must be SSH-capable')
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

    // HTTP Hooks Gateway: when enabled, tunnel the gateway's loopback port so
    // Claude Code inside the SSH session can reach it via http://localhost:<port>.
    // Register the session secret up-front so the generated setup script can
    // bake the URL + X-CCC-Hook-Token header into the remote settings file.
    // HOOKS INJECTION DISABLED — the Live Activity feed UI was cut in
    // commit c957e5d, leaving the gateway running with no consumer. We
    // were still injecting `hooks` blocks into per-session settings,
    // which made every Pre/PostToolUse call from Claude Code fire at
    // http://localhost:<port>/hook/<sid> — fine on local sessions, but
    // on SSH the `-R port:localhost:port` reverse tunnel often can't be
    // established (sshd's AllowTcpForwarding etc.) and every tool call
    // logs a ECONNREFUSED. Re-enable when a consumer feature ships
    // (live activity v2, hook-driven analytics, etc.) and revisit the
    // SSH tunnel-failure UX.
    const gw = getGateway()
    const gwStatus = gw?.status()
    void gw; void gwStatus
    const hooksConfig: { port: number; secret: string } | null = null

    const sshBinary = os.platform() === 'win32' ? 'ssh.exe' : 'ssh'

    ptyProcess = pty.spawn(sshBinary, sshArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
      useConpty: true
    })

    // SSH manual flow state machine. The renderer shows an in-pane
    // overlay with explicit "Run post-connect command" / "Launch Claude"
    // / "Skip" buttons. Each click triggers one of the writer helpers
    // below via SshFlowController IPC. An idle-data fallback timer
    // (1.5 s of no PTY data) advances "running-X → next" automatically
    // once the user-gated chain has started, so users never have to
    // click more than twice per session.
    //
    // The legacy auto-detection state machine has been removed — manual
    // flow + idle fallback covers every permutation (vanilla SSH,
    // SSH+postCommand, shellOnly variants) without watching the PTY
    // stream for shell-prompt regexes, eliminating the entire class of
    // "setup blob pasted into running Claude" bugs.

    let passwordSent = false
    let sudoPasswordSent = false
    let setupSent = false
    let setupDone = false
    let setupShellReady = false
    let postCommandSent = false
    let postCommandShellReady = false
    let containerSetupSent = false
    let containerSetupDone = false
    let containerSetupShellReady = false
    let claudeSent = false
    let claudeRunning = false
    // Tracks whether we're now in the inner shell (after postCommand
    // completed — e.g. inside the docker container). Drives whether
    // launchClaude() runs the container-setup re-run path or the
    // direct host setup path.
    let inInnerShell = false
    let currentFlowState: SshFlowState = 'connecting'
    let currentFlowInfo: string | undefined = undefined
    const SETUP_TIMEOUT_MS = 10000
    let setupTimeoutHandle: ReturnType<typeof setTimeout> | null = null

    const setFlowState = (s: SshFlowState, info?: string) => {
      currentFlowState = s
      currentFlowInfo = info
      logInfo(`[ssh] ${sessionId}: flow → ${s}${info ? ` (${info})` : ''}`)
      emitSshFlowState(win, sessionId, s, info)
    }

    // Idle-data fallback. Every onData re-arms a 1.5 s timer; when it
    // fires (no PTY data for 1.5 s), we advance state based on the
    // current sentinel/flag state. This is independent of the
    // shell-prompt regex — bash prompts with non-standard PS1s
    // sometimes never match the regex, and silence after a burst of
    // setup/MOTD output is a robust "shell is idle, ready for next
    // command" signal regardless of styling.
    const IDLE_FALLBACK_MS = 1500
    let idleFallbackHandle: ReturnType<typeof setTimeout> | null = null
    let receivedAnyData = false
    const armIdleFallback = () => {
      if (idleFallbackHandle) clearTimeout(idleFallbackHandle)
      idleFallbackHandle = setTimeout(() => {
        idleFallbackHandle = null
        if (!receivedAnyData) return
        logInfo(`[ssh] ${sessionId}: idle timer fired in state=${currentFlowState} info=${currentFlowInfo ?? 'none'} flags={setupSent:${setupSent},setupDone:${setupDone},postCommandSent:${postCommandSent},postCommandShellReady:${postCommandShellReady},containerSetupSent:${containerSetupSent},containerSetupDone:${containerSetupDone},claudeSent:${claudeSent},sudoPassword:${!!sudoPassword},sudoPasswordSent:${sudoPasswordSent}}`)

        // connecting → awaiting-{postcommand|claude} or shell-only.
        if (currentFlowState === 'connecting') {
          logInfo(`[ssh] ${sessionId}: idle ${IDLE_FALLBACK_MS}ms → advancing from connecting`)
          if (ssh.postCommand) setFlowState('awaiting-postcommand', 'idle-fallback')
          else if (options?.shellOnly) setFlowState('shell-only', 'idle-fallback')
          else setFlowState('awaiting-claude', 'host (fallback)')
          return
        }

        // running-setup (host) + setupDone → write next stage.
        if (
          currentFlowState === 'running-setup'
          && currentFlowInfo === 'host'
          && setupDone
          && !setupShellReady
        ) {
          setupShellReady = true
          logInfo(`[ssh] ${sessionId}: idle after host setup ok → writing claudeCmd`)
          // Host setup runs only because user clicked Launch Claude (on
          // host). Write claudeCmd — don't chain to postCommand even if
          // configured. shellOnly is ignored: the click is consent.
          if (!claudeSent) writeClaudeCmd()
          return
        }

        // running-postcommand + we've seen the inner shell idle →
        // advance to awaiting-claude (manual) or container setup (auto).
        // sudoGate dropped: 1.5 s of true idle is sufficient signal
        // that the user is past any sudo prompt (sudo would still be
        // generating output until accepted). Stale keychain creds
        // were also producing false negatives here.
        if (
          currentFlowState === 'running-postcommand'
          && postCommandSent
          && !postCommandShellReady
        ) {
          postCommandShellReady = true
          inInnerShell = true
          logInfo(`[ssh] ${sessionId}: idle after postCommand → inner shell ready`)
          // User decides next via overlay (Launch Claude vs Skip).
          setFlowState('awaiting-claude', 'inner')
          return
        }

        // running-setup (container) + containerSetupDone → write claudeCmd.
        // shellOnly is intentionally not gated here: in manual flow the
        // user clicked Launch Claude (which is what triggered container
        // setup); in auto flow we only reach this branch via
        // writeContainerSetupCmd() which is already shellOnly-gated upstream.
        if (
          currentFlowState === 'running-setup'
          && currentFlowInfo === 'container'
          && containerSetupDone
          && !containerSetupShellReady
          && !claudeSent
        ) {
          containerSetupShellReady = true
          logInfo(`[ssh] ${sessionId}: idle after container setup ok → writing claudeCmd`)
          writeClaudeCmd()
          return
        }

        // running-claude → claude-running (fallback). Lenient
        // box-drawing detection above usually catches Claude's UI
        // rendering, but some output paths (alternate screen buffer
        // with NO_FLICKER, slow terminals, etc.) don't expose those
        // markers in our data stream. Once claudeCmd has been
        // written and the PTY has gone quiet for 1.5 s, Claude is
        // almost certainly running — flip the latch so the overlay
        // can disappear and no more auto-writes ever fire.
        if (currentFlowState === 'running-claude' && claudeSent) {
          logInfo(`[ssh] ${sessionId}: idle after claudeCmd → assuming claude-running (fallback)`)
          claudeRunning = true
          setFlowState('claude-running', 'idle-fallback')
          return
        }
      }, IDLE_FALLBACK_MS)
    }
    const remotePath = ssh.remotePath || '~'
    const claudeEnvPrefix = [
      options?.disableAutoMemory ? 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1' : '',
    ].filter(Boolean).join(' ')
    const claudeFlags = [
      // --settings loads per-session config so concurrent sessions to the same
      // host don't clobber each other's statusline sessionId binding.
      `--settings ${claudeProvider.getSshSettingsPath(sessionId)}`,
      options?.effortLevel ? `--effort ${options.effortLevel}` : '',
      // --model pins the Claude model for this session. Empty string in
      // the config form means "no override" — the CLI picks whatever
      // the user's plan exposes by default.
      options?.model ? `--model ${options.model}` : '',
    ].filter(Boolean).join(' ')
    const claudeCmd = [claudeEnvPrefix, 'claude', claudeFlags].filter(Boolean).join(' ')
    const password = ssh.password
    const postCommand = ssh.postCommand
    const sudoPassword = ssh.sudoPassword

    // Tight password-prompt match: `password:` or `password?` at the trimmed
    // end of the last line. Previously we matched any chunk containing the
    // word "password", which fires on MOTDs like "Your password expires in
    // 30 days" — the password then gets written into the PTY as stray input
    // before the real prompt arrives, leaking it visibly into the terminal.
    const PASSWORD_PROMPT_RE = /password[:?]\s*$/i
    // Shell prompt match for the cd/setup gate. Real bash PS1s usually end
    // `$`/`#`/`>`/`~` with no whitespace before the sigil (e.g. `user@h:~$ `),
    // so we can't require pre-whitespace — but we DO exclude lines containing
    // Claude Code's `❯` glyph via lastPromptLineForClaude below. setupDone is the
    // hard latch that prevents any retrigger regardless.
    const SHELL_PROMPT_RE = /[$#>~]\s*$/

    /**
     * Writers for the four discrete SSH stages. The manual
     * SshFlowController calls these on user button clicks; the idle
     * fallback calls them when chaining the next stage of an already
     * user-consented sequence. Every writer is idempotent — subsequent
     * calls are no-ops once its `*Sent` flag is set, so an over-eager
     * renderer click or repeated idle fire can't double-fire.
     */
    const writeHostSetupCmd = () => {
      if (setupSent) return
      setupSent = true
      setFlowState('running-setup', 'host')
      logInfo(`[ssh] ${sessionId}: writing host setupCmd`)
      setupTimeoutHandle = setTimeout(() => {
        setupTimeoutHandle = null
        if (!setupDone) {
          logError(`[ssh] ${sessionId}: setup ok not received within ${SETUP_TIMEOUT_MS}ms`)
          setFlowState('failed', 'host setup timeout')
        }
      }, SETUP_TIMEOUT_MS)
      setTimeout(() => {
        const setupCmd = claudeProvider.configureRemoteSettings(sessionId, remotePath, hooksConfig)
        ptyProcess.write(setupCmd + '\r')
      }, 200)
    }

    const writePostCommand = () => {
      if (postCommandSent || !postCommand) return
      postCommandSent = true
      setFlowState('running-postcommand')
      logInfo(`[ssh] ${sessionId}: writing post-command`)
      setTimeout(() => ptyProcess.write(postCommand + '\r'), 200)
    }

    const writeContainerSetupCmd = () => {
      if (containerSetupSent) return
      containerSetupSent = true
      setFlowState('running-setup', 'container')
      logInfo(`[ssh] ${sessionId}: re-running setup inside container`)
      setupTimeoutHandle = setTimeout(() => {
        setupTimeoutHandle = null
        if (!containerSetupDone) {
          logError(`[ssh] ${sessionId}: container setup ok not received within ${SETUP_TIMEOUT_MS}ms`)
          setFlowState('failed', 'container setup timeout')
        }
      }, SETUP_TIMEOUT_MS)
      setTimeout(() => {
        const setupCmd = claudeProvider.configureRemoteSettings(sessionId, remotePath, hooksConfig)
        ptyProcess.write(setupCmd + '\r')
      }, 300)
    }

    const writeClaudeCmd = () => {
      // Idempotent. shellOnly is intentionally NOT gated: this writer
      // only runs after the user clicked Launch Claude (or after a
      // user-consented chain reached this stage), so the click is
      // their explicit consent regardless of any saved shellOnly flag.
      if (claudeSent) return
      claudeSent = true
      setFlowState('running-claude')
      logInfo(`[ssh] ${sessionId}: writing claudeCmd`)
      setTimeout(() => ptyProcess.write(claudeCmd + '\r'), 200)
    }

    /**
     * Manual-flow controller. Renderer triggers stage transitions via
     * IPC; main calls these to advance.
     */
    const flowController: SshFlowController = {
      getState: () => ({ state: currentFlowState, info: currentFlowInfo }),
      runPostCommand: () => {
        // postCommand flows (e.g. asustor `sudo docker exec -it ctr bash`)
        // SKIP host setup entirely. Reasoning:
        //   - claude runs inside the container, not the host. The
        //     ~/.claude/settings file claude reads is the one inside
        //     the container, written by the container-setup step.
        //   - NAS hosts (Asustor, Synology, etc.) often don't have
        //     `node` installed on the bare host. Setup blob silently
        //     fails (2>/dev/null), no `setup ok` arrives, the 10 s
        //     timeout fires and the flow goes 'failed' — even though
        //     the user only wanted to enter the container.
        // Users who want claude on the bare HOST can use "Launch
        // Claude on host" instead, which DOES run host setup.
        if (currentFlowState !== 'awaiting-postcommand') return
        writePostCommand()
      },
      launchClaude: () => {
        // Two paths depending on whether we already entered the inner
        // shell. Inner shell → container setup + claudeCmd. Host shell
        // (no postCommand or user skipped it) → host setup + claudeCmd.
        // shellOnly is intentionally ignored: the user just clicked
        // Launch Claude — that IS their consent, overriding any saved
        // shellOnly preference on the config.
        if (inInnerShell) {
          writeContainerSetupCmd()
        } else if (!setupSent) {
          writeHostSetupCmd()
        } else if (setupDone) {
          // Setup already done from a prior runPostCommand → claude now.
          writeClaudeCmd()
        }
      },
      skip: () => {
        setFlowState('skipped')
      },
      destroy: () => {
        if (setupTimeoutHandle) {
          clearTimeout(setupTimeoutHandle)
          setupTimeoutHandle = null
        }
        if (idleFallbackHandle) {
          clearTimeout(idleFallbackHandle)
          idleFallbackHandle = null
        }
        sshFlows.delete(sessionId)
      },
    }
    sshFlows.set(sessionId, flowController)

    ptyProcess.onData((rawData) => {
      if (win.isDestroyed()) return
      // Strip SSH statusline OSC sentinels before forwarding to xterm.
      // Parsed sentinels are dispatched to the statusline pipeline as a side effect.
      const data = extractSshOscSentinels(sessionId, rawData)
      win.webContents.send(`pty:data:${sessionId}`, data)

      // Arm the idle-data fallback. Re-arms on every chunk so the timer
      // tracks the most recent activity. The handler itself decides
      // whether to advance state — many of our transitions are gated on
      // sentinel flags (setupDone, containerSetupDone, etc.) that only
      // become true after specific output. We re-arm here for all
      // states except claude-running (handled by the backstop below)
      // since once Claude is running we never want auto-writes again.
      if (data.length > 0 && !claudeRunning) {
        receivedAnyData = true
        armIdleFallback()
      }

      // HARD LATCH: detect Claude Code UI. Two regexes, gated on phase:
      //
      //   STRICT (any phase): long box-drawing rules `╭─{5,}` or
      //   `╰─{5,}`. Required to be conservative before claudeSent so
      //   a fancy bash prompt (Powerlevel10k uses `╭─` with 1-2
      //   dashes) doesn't latch us early and block setup.
      //
      //   LENIENT (claudeSent only): single-dash `╭─` / `╰─` / any
      //   `❯` / vertical `┃│`. Safe at this stage — we've already
      //   written claudeCmd, so any box drawing is almost certainly
      //   Claude rendering its UI rather than the original bash
      //   prompt (which would have already triggered state advance
      //   earlier).
      if (!claudeRunning) {
        if (detectClaudeUi(data, claudeSent)) {
          claudeRunning = true
          if (setupTimeoutHandle) {
            clearTimeout(setupTimeoutHandle)
            setupTimeoutHandle = null
          }
          logInfo(`[ssh] ${sessionId}: Claude UI detected — claudeRunning latched`)
          if (currentFlowState !== 'claude-running') setFlowState('claude-running')
        }
      }

      // Step 1 completion sentinel: the remote node script writes
      // `setup ok\n` to stdout right before exiting. We only treat
      // sentinels seen AFTER setupSent as completion — otherwise an
      // earlier sentinel echoed by a previous session in the same
      // long-running shell could spuriously latch this on connect.
      if (setupSent && !setupDone && data.includes('setup ok')) {
        setupDone = true
        if (setupTimeoutHandle) {
          clearTimeout(setupTimeoutHandle)
          setupTimeoutHandle = null
        }
        logInfo(`[ssh] ${sessionId}: host setup ok received`)
      }

      // Container setup completion: same sentinel, but we only consider
      // it after the second setupCmd was written (inside the container).
      if (containerSetupSent && !containerSetupDone && data.includes('setup ok')) {
        containerSetupDone = true
        if (setupTimeoutHandle) {
          clearTimeout(setupTimeoutHandle)
          setupTimeoutHandle = null
        }
        logInfo(`[ssh] ${sessionId}: container setup ok received`)
      }

      // Auto-type SSH password only on a real password prompt, not any MOTD
      // line containing the word.
      if (!passwordSent && password && PASSWORD_PROMPT_RE.test(lastPromptLineForClaude(data))) {
        passwordSent = true
        setTimeout(() => {
          ptyProcess.write(password + '\r')
        }, 100)
        return
      }

      // Auto-type sudo password on a real sudo prompt only. Variants sudo
      // emits: `[sudo] password for X:`, `password for X:`, `Password:`.
      // End-of-line match avoids false-triggering on a log message that
      // happens to mention `[sudo]` or `password for`.
      if (!sudoPasswordSent && sudoPassword && postCommandSent && !claudeSent) {
        const promptLine = lastPromptLineForClaude(data)
        if (promptLine && /(\[sudo\].*password.*:|password for .+:|^password:)\s*$/i.test(promptLine)) {
          sudoPasswordSent = true
          setTimeout(() => {
            ptyProcess.write(sudoPassword + '\r')
          }, 100)
          return
        }
      }

      // BACKSTOP — once Claude is running, no more auto-writes EVER.
      if (claudeRunning) {
        if (currentFlowState !== 'claude-running') setFlowState('claude-running')
        return
      }

      const lastLine = lastPromptLineForClaude(data)
      const sawShellPrompt = !!lastLine && SHELL_PROMPT_RE.test(lastLine)

      // ---- STAGE TRANSITION DETECTION ----
      // Manual flow: shell-prompt detection only emits "awaiting-X"
      // states. The user's overlay click triggers the next writer.
      // Once a user-consented chain has started (host setup or
      // postCommand fired), the chain auto-continues on prompt
      // detection — the user already consented at the start.

      // First shell prompt after login → emit awaiting-postcommand /
      // awaiting-claude / shell-only and wait for user click.
      if (
        !setupSent
        && !postCommandSent
        && sawShellPrompt
        && (currentFlowState === 'connecting' || currentFlowState === 'skipped')
      ) {
        if (postCommand) {
          setFlowState('awaiting-postcommand')
        } else if (options?.shellOnly) {
          setFlowState('shell-only')
        } else {
          setFlowState('awaiting-claude', 'host')
        }
        return
      }

      // Host setup done + fresh shell prompt → write claudeCmd.
      // Setup ran because user clicked Launch Claude on the host;
      // claude is the only sensible next stage.
      if (setupSent && setupDone && !setupShellReady && sawShellPrompt) {
        setupShellReady = true
        if (!claudeSent) writeClaudeCmd()
        return
      }

      // Inner shell prompt after postCommand → emit awaiting-claude.
      // User picks Launch Claude (→ container setup → claudeCmd) or
      // Skip (→ drops to inner shell).
      if (
        postCommandSent
        && !postCommandShellReady
        && sawShellPrompt
        && (!sudoPassword || sudoPasswordSent)
      ) {
        postCommandShellReady = true
        inInnerShell = true
        setFlowState('awaiting-claude', 'inner')
        return
      }

      // Container setup done + inner shell prompt → write claudeCmd.
      // Reaches here only via launchClaude() in the inner shell, so
      // the user already consented to claude.
      if (
        containerSetupSent
        && containerSetupDone
        && !containerSetupShellReady
        && !claudeSent
        && sawShellPrompt
      ) {
        containerSetupShellReady = true
        writeClaudeCmd()
      }
    })
  } else if ((options?.provider ?? 'claude') === 'codex' && !options?.shellOnly) {
    // Codex local session — spawn `codex` directly. Codex itself owns the
    // REPL, so there is no shell-wrap-then-cd-then-launch dance like Claude
    // requires. cwd is propagated through pty.spawn options.
    // shellOnly falls through to the Claude branch below so the user gets a
    // plain shell, regardless of provider selection.
    const provider = getProvider('codex')
    const { cmd: spawnCmd, args: spawnArgs, env: spawnEnv } = provider.buildSpawnCommand({
      sessionId,
      provider: 'codex',
      cwd: options?.cwd,
      cols,
      rows,
      useResumePicker: options?.useResumePicker,
      codexOptions: options?.codexOptions,
    })
    const resolvedCwd = resolveCwd(options?.cwd)
    logInfo(`[pty-manager] Launching Codex PTY: ${spawnCmd} ${spawnArgs.join(' ')} cwd=${resolvedCwd}`)
    // Capture timestamp before spawn so the watch-and-claim window starts no later than PTY launch.
    const codexSpawnTimestamp = Date.now()
    ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: resolvedCwd,
      env: spawnEnv,
      useConpty: true,
    })
    ptyProcess.onData((data) => {
      if (win.isDestroyed()) return
      win.webContents.send(`pty:data:${sessionId}`, data)
    })
    // Start rollout watch-and-claim telemetry. Updates are dispatched to the
    // renderer (statusline:update) and tokenomics-manager identically to how
    // Claude statusline updates flow through statusline-watcher.ts.
    const codexTelSrc = provider.ingestSessionTelemetry(
      sessionId,
      { cwd: resolvedCwd, spawnTimestamp: codexSpawnTimestamp },
      (data) => {
        if (!win.isDestroyed()) win.webContents.send('statusline:update', data)
        handleStatuslineUpdate(data)
      },
    )
    codexTelemetrySources.set(sessionId, codexTelSrc)
  } else {
    // Local session — delegate binary + env construction to the provider.
    // The post-spawn shell-write (cd + claude command) stays here; only the
    // bare shell + env comes from the provider.
    const shellOnly = options?.shellOnly
    const provider = getProvider('claude')
    const { cmd: spawnCmd, args: spawnArgs, env: spawnEnv } = provider.buildSpawnCommand({
      sessionId,
      cwd: options?.cwd,
      cols,
      rows,
      shellOnly: options?.shellOnly,
      elevated: options?.elevated,
      legacyVersion: options?.legacyVersion,
      effortLevel: options?.effortLevel,
      disableAutoMemory: options?.disableAutoMemory,
      model: options?.model,
      useResumePicker: options?.useResumePicker,
      agentsConfig: options?.agentsConfig,
    })
    const resolvedCwd = resolveCwd(options?.cwd)

    if (shellOnly) {
      logInfo(`[pty-manager] Launching shell-only PTY: ${spawnCmd} ${spawnArgs.join(' ')} cwd=${resolvedCwd}${options?.elevated ? ' (elevated)' : ''}`)

      ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: resolvedCwd,
        env: spawnEnv,
        useConpty: true
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
      logInfo(`[pty-manager] Launching Claude via shell in PTY: ${spawnCmd} -> ${cmd} cwd=${resolvedCwd} (resumePicker=${!!options?.useResumePicker})`)

      ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: resolvedCwd,
        env: spawnEnv,
        useConpty: true
      })

      // Explicitly cd to the project directory, then launch Claude.
      // The cd is critical — it ensures Claude sees the correct project directory
      // regardless of PowerShell profile scripts or PTY cwd propagation issues.
      const escapedCwd = resolvedCwd.replace(/'/g, "''")

      // Build extra CLI flags (--effort, --settings). --name is deliberately
      // NOT passed: the current Claude CLI treats `--name "<label>"` as the
      // [prompt] positional, so the label gets sent as the user's first
      // message. Our own UI already shows the session label — there's no
      // benefit to passing it to Claude.
      let extraFlags = ''
      if (options?.effortLevel) {
        extraFlags += ` --effort ${options.effortLevel}`
      }
      if (options?.model) {
        extraFlags += ` --model ${options.model}`
      }

      // HOOKS INJECTION DISABLED — see the SSH branch above for the same
      // gate. With no consumer feature attached, every Pre/PostToolUse
      // call was firing at a localhost URL nobody listens to, logging
      // ECONNREFUSED on every Bash/Read/Edit. Re-enable when a hook
      // consumer (live activity v2, analytics, etc.) ships.
      void getGateway, writeLocalSessionSettings, injectHooks
      if (false as boolean) {
        try {
          const sesPath = writeLocalSessionSettings(sessionId)
          if (os.platform() === 'win32') {
            const escapedSesPath = sesPath.replace(/'/g, "''")
            extraFlags += ` --settings '${escapedSesPath}'`
          } else {
            const escapedSesPath = sesPath.replace(/'/g, "'\\''")
            extraFlags += ` --settings '${escapedSesPath}'`
          }
        } catch (err) {
          logError(`[hooks] Failed to seed per-session settings for ${sessionId}: ${(err as Error)?.message ?? err}`)
        }
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
      // Any claude flags we've already built up (notably --settings for hooks) must be
      // forwarded through the picker so the child claude process sees them too.
      let escapedCmd: string
      if (options?.useResumePicker) {
        const pickerScript = getResumePickerPath()
        if (pickerScript && os.platform() === 'win32') {
          const escapedScript = pickerScript.replace(/'/g, "''")
          escapedCmd = `Set-Location '${escapedCwd}'; node '${escapedScript}'${extraFlags}; exit`
        } else if (pickerScript) {
          escapedCmd = `cd '${escapedCwd.replace(/'/g, "'\\''")}' && node '${pickerScript.replace(/'/g, "'\\''")}'${extraFlags}; exit`
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

    // Restart-race guard: the renderer's restart flow kills the old PTY
    // and re-spawns synchronously with the SAME sessionId. node-pty's
    // exit callback is async — by the time it fires, the new PTY has
    // already written its settings file, registered its hook secret,
    // and replaced the ptySessions entry. If we ran the old exit's
    // cleanup unconditionally we'd:
    //   - delete the NEW PTY's settings file → claude --settings fails
    //     with "Settings file not found" on the new spawn
    //   - unregister the NEW PTY's hook secret in the gateway → 404s
    //   - delete the ptySessions entry pointing at the new ptyProcess
    // Identity-check the map: only run cleanup when the entry still
    // points at OUR ptyProcess (or there's no entry at all).
    const current = ptySessions.get(sessionId)
    const weAreCurrent = !current || current.ptyProcess === ptyProcess
    if (weAreCurrent) {
      ptySessions.delete(sessionId)
      try {
        const gwExit = getGateway()
        if (gwExit) gwExit.unregisterSession(sessionId)
      } catch { /* gateway may have already stopped during shutdown */ }
      removeLocalSessionSettings(sessionId)
    } else {
      logInfo(`[pty] Stale exit for ${sessionId} — newer PTY has taken over, skipping cleanup`)
    }

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
  // Stop Codex telemetry source if one was registered for this session.
  const codexTel = codexTelemetrySources.get(sessionId)
  if (codexTel) {
    try { codexTel.stop() } catch { /* noop */ }
    codexTelemetrySources.delete(sessionId)
  }
  // Clear the SSH flow controller too -- otherwise a stale entry keeps
  // a closure over the old ptyProcess and a renderer click after
  // session restart would write to a dead pty.
  const flow = sshFlows.get(sessionId)
  if (flow) {
    try { flow.destroy() } catch { /* noop */ }
  }
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
