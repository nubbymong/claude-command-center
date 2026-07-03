import { BrowserWindow, nativeTheme } from 'electron'
import * as pty from 'node-pty'
import { PasteQueue } from './paste-queue'
import { runChunkedWrite, WRITE_CHUNK_SIZE } from './pty-chunked-write'
import * as os from 'os'
import { execSync } from 'child_process'
import { logPtyOutput, isDebugModeEnabled } from './debug-capture'
import { shouldRegisterRun } from './logging/should-register-run'
import { getLogSupervisor, getTranscriptBinder } from './logging/logging-service'
import { resolveResumeTargetFromTranscript, mangleCwdToProjectDir } from './logging/transcript-discovery'
import { buildClaudeLaunchCommand, resolveResumeLaunch, buildResumeTranscriptPath } from './spawn-claude-command'
import { ensureCompanionDir, nodeFsCompanionDeps } from './logging/companion-dir'
import { logInfo, logDebug, logError, logWarn } from './debug-logger'
import { writeCliSetupPty, getResourcesDirectory } from './ipc/setup-handlers'
import { buildRemoteSessionCleanupCommand } from './providers/claude/ssh-shim'
import { isGlobalVisionRunning, getGlobalVisionConfig, teardownVisionSession } from './vision-manager'
import { getConductorMcpPort } from './conductor-mcp-server'
import { resolveClaudeBinary, resolveHostColorScheme } from './providers/claude/spawn'
import { detectClaudeUi, lastPromptLineForClaude } from './providers/claude/ui-detection'
import { getProvider } from './providers'
import { isSshCapable } from './providers/types'
import type { TelemetrySource } from './providers/types'
import { resolveCwd } from './path-utils'
import { dispatchSSHStatuslineUpdate, cleanupStatusFile } from './statusline-watcher'
import { forgetSession } from './background-context'
import { decorateStatuslineWithColour } from './account-color'
import { getGateway } from './hooks'
import { injectHooks } from './hooks/session-hooks-writer'
import {
  writeLocalSessionSettings,
  removeLocalSessionSettings,
  writeLocalSessionMcpConfig,
  removeLocalSessionMcpConfig,
} from './hooks/per-session-settings'
import { registerCodexReviewSession, unregisterCodexReviewSession } from './conductor-mcp-server'
import { disposeSession as disposeCodexReviewUsage } from './codex-review-usage'
import { readCodexAccountEmail } from './account-identity'
import { getProfileConfigDir, setupProfileLinks, getPrimaryProfileId, backupProfileHomeToCanonical, syncPrimaryCredentialsWithGlobal } from './account-profiles'
import { captureClaudeAccount, clearClaudeAccount, getAccountIdentity, pushAccountIdentity, startWatchingAccountIdentity, stopWatchingAccountIdentity, getWatchedProfileId } from './claude-account-identity'
import type { AccountIdentity } from '../shared/types'
import { updateSessionMeta, clearSessionMeta } from './session-registry'
import { readConfig } from './config-manager'
import { getPtyIntegrityMonitor } from './services/pty-integrity-monitor'

import * as path from 'path'
import * as fs from 'fs'

/**
 * P8.8: per-session Codex spawn-time identity. Captured at PTY spawn,
 * read by tokenomics applyIdentityAtFlush() so claim-time drift on
 * ~/.codex/auth.json doesn't misattribute tokens.
 */
const codexSpawnIdentity = new Map<string, AccountIdentity>()

export function captureCodexSpawnIdentity(sessionId: string): void {
  const id = readCodexAccountEmail()
  if (id) codexSpawnIdentity.set(sessionId, id)
}

export function clearCodexSpawnIdentity(sessionId: string): void {
  codexSpawnIdentity.delete(sessionId)
}

export function getCodexSpawnIdentityMap(): Map<string, AccountIdentity> {
  return codexSpawnIdentity
}

/**
 * Per-process account isolation: run Claude under a per-account fake HOME so the
 * account identity (~/.claude.json, which follows USERPROFILE on Windows / HOME
 * on Unix) is private. CLAUDE_CONFIG_DIR alone does NOT isolate identity. Git/npm
 * are pointed back at the real home so shared dev tooling is unaffected. Returns
 * the env unchanged for the Default account (home == null).
 */
export function withProfileHome(env: Record<string, string>, home: string | null): Record<string, string> {
  if (!home) return env
  const realHome = os.homedir()
  const next: Record<string, string> = {
    ...env,
    USERPROFILE: home,
    // Belt-and-suspenders: keep git/npm reading the real shared config even if a
    // hard-linked dotfile ever desyncs (the mirror also links these through).
    GIT_CONFIG_GLOBAL: path.join(realHome, '.gitconfig'),
    npm_config_userconfig: path.join(realHome, '.npmrc'),
  }
  if (process.platform !== 'win32') next.HOME = home
  // Claude's native install lives at `$HOME/.local/bin`. With the home redirected,
  // CC computes that as `<home>/.local/bin` (a junction to the real ~/.local) but
  // PATH still carries the *real* home's `.local/bin`, so `/doctor` falsely warns
  // "Native installation ... is not in your PATH". Add the redirected bin dir
  // (deduped, under the env's existing path key) so the self-check passes. The
  // real entry stays first, so which `claude` actually resolves is unchanged.
  const localBin = path.join(home, '.local', 'bin')
  const pathKey = Object.keys(next).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  const curPath = next[pathKey] ?? ''
  const already = curPath.split(path.delimiter).some((p) => p.toLowerCase() === localBin.toLowerCase())
  if (!already) next[pathKey] = curPath ? `${curPath}${path.delimiter}${localBin}` : localBin
  return next
}

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

// T8b (bug #5): exact-conversation resume target captured at the TOP of a
// respawn (in-session Restart / Switch-account), keyed by sessionId. Captured
// BEFORE killPty so the live conversation's uuid + its real cwd are read off
// the just-bound transcript before the old run's async endRun clears the
// binder map. Consumed (and deleted) once in the Claude launch builder, and
// deleted in killPty so a stale target can never leak into an unrelated future
// spawn. Fail-open: a null/missing entry => unchanged existing resume behaviour.
const lastResumeTarget = new Map<string, { uuid: string; cwd: string }>()

function getLastResumeTarget(sessionId: string): { uuid: string; cwd: string } | undefined {
  return lastResumeTarget.get(sessionId)
}

function clearLastResumeTarget(sessionId: string): void {
  lastResumeTarget.delete(sessionId)
}

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
    /** Config id that owns the session. Stamped onto the session-log row for per-config filtering. */
    configId?: string
    /**
     * Task 9: per-config logging opt-out. DEFAULT-TRUE — only an explicit `false`
     * disables run registration for this session (the global settings flag and
     * shellOnly/ssh/provider gates still apply). The SessionDialog UI toggle that
     * binds this is a later task (T16); this field is plumbed end-to-end now.
     */
    loggingEnabled?: boolean
    useResumePicker?: boolean
    legacyVersion?: { enabled: boolean; version: string }
    agentsConfig?: Array<{ name: string; description: string; prompt: string; model?: string; tools?: string[] }>
    // Widened to string — the IPC schema's charset guard (/^[a-zA-Z0-9_-]+$/) is the real contract.
    effortLevel?: string
    disableAutoMemory?: boolean
    model?: string
    /** Per-session account isolation: spawn claude under this profile's CLAUDE_CONFIG_DIR. */
    profileId?: string
    /** v1.5 P6: when true, register session into MCP server's codex_review opt-in set. */
    enableCodexReview?: boolean
    /**
     * T8b (bug #5): app-relaunch exact-conversation resume. The renderer passes
     * the persisted {uuid,cwd} on a restored session so the respawn resumes the
     * SAME conversation it was on at quit (not the newest in the cwd's folder).
     * In-session Restart/Switch DO NOT set this — main self-captures via
     * lastResumeTarget. Fail-open: ignored if the transcript/cwd no longer exist.
     */
    resume?: { uuid: string; cwd: string }
    provider?: 'claude' | 'codex'
    codexOptions?: {
      model?: string
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
      permissionsPreset: 'read-only' | 'standard' | 'auto' | 'unrestricted'
    }
  }
): void {
  logInfo(`[pty] Spawning PTY for session ${sessionId} (ssh=${!!options?.ssh}, shellOnly=${!!options?.shellOnly}, cwd=${options?.cwd || 'default'})`)

  // T8b (bug #5): in-session Restart / Switch-account REUSE this sessionId and
  // call spawnPty synchronously after killing the old PTY. The old run's
  // endRun() (which clears the binder's per-session bind) fires ASYNC, after we
  // return — so READ the live conversation's resume target HERE, before
  // killPty, while the binder still holds it. Only for Claude non-shell, non-SSH
  // sessions (the binder only tracks Claude transcripts). Fail-open: any miss
  // leaves no entry and the spawn falls back to existing behaviour.
  // NOTE: stored into lastResumeTarget AFTER killPty (which clears the map), so
  // a fresh capture survives its own kill instead of being wiped by it.
  let capturedResumeTarget: { uuid: string; cwd: string } | null = null
  if (!options?.ssh && !options?.shellOnly && (options?.provider ?? 'claude') === 'claude') {
    try {
      const latest = getTranscriptBinder()?.getLatestTranscriptPath(sessionId)
      if (latest) {
        capturedResumeTarget = resolveResumeTargetFromTranscript(latest)
      }
    } catch (err) {
      logWarn(`[pty] T8b resume-target capture failed for ${sessionId}: ${(err as Error)?.message ?? err}`)
    }
  }

  killPty(sessionId)

  if (capturedResumeTarget) {
    lastResumeTarget.set(sessionId, capturedResumeTarget)
    logInfo(`[pty] T8b captured resume target for ${sessionId}: uuid=${capturedResumeTarget.uuid} cwd=${capturedResumeTarget.cwd}`)
  }

  const cols = options?.cols || 120
  const rows = options?.rows || 30

  let ptyProcess: pty.IPty

  // Hoisted to function scope so the shared post-spawn tail (session-log capture)
  // can read them for EVERY branch (ssh / codex / claude / shell-only). They were
  // previously declared inside the codex/claude branches and so were out of scope
  // at capture?.start() in the tail -> a latent ReferenceError on spawn-with-logging.
  const resolvedCwd = resolveCwd(options?.cwd)
  // FIX 4: the directory Claude is ACTUALLY launched in. Defaults to the
  // configured resolvedCwd, but the Claude branch overrides it to the resume
  // target's real cwd (claudeCwd) when an exact-resume applies. runStart()'s
  // projectCwd + the heuristic binder's registerRun() must use THIS so the run
  // is stamped with — and the 20s fallback scans — the folder Claude ran in.
  let effectiveLaunchCwd = resolvedCwd
  // Part A: the resume uuid an exact-resume applied (function-scoped so the
  // deterministic resume-bind at the registerRun site below can see it). Null
  // unless the Claude branch resolved an exact-resume launch.
  let resumeUuidForBind: string | null = null
  let resolvedProfileId: string | undefined = undefined

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
    // Clickable question options (CC >= 2.1.195) default OFF in CCC -- the
    // clickable layer misfires inside xterm.js. Read fresh per spawn so the
    // Settings toggle applies to the next session without a restart.
    const clickableQuestions = readConfig<{ clickableQuestions?: boolean }>('settings')?.clickableQuestions === true
    const claudeEnvPrefix = [
      options?.disableAutoMemory ? 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1' : '',
      clickableQuestions ? '' : 'CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1',
    ].filter(Boolean).join(' ')
    const claudeFlags = [
      // --settings loads per-session config so concurrent sessions to the same
      // host don't clobber each other's statusline sessionId binding.
      `--settings ${claudeProvider.getSshSettingsPath(sessionId)}`,
      // P7.8: --mcp-config carries the conductor MCP entry. Claude CLI ignores
      // mcpServers in --settings files (P7.7.3) so this is the canonical site
      // for the conductor registration on SSH. The URL bakes ?cccSessionId
      // (P7.7.10) so the host's MCP server can resolve the CCC session from
      // the SSE transport without trusting an LLM-supplied arg.
      `--mcp-config ${claudeProvider.getSshMcpConfigPath(sessionId)}`,
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
        const s = readConfig<{ statusLineEnabled?: boolean; conductorToolsEnabled?: boolean }>('settings')
        const setupCmd = claudeProvider.configureRemoteSettings(sessionId, remotePath, hooksConfig, {
          includeStatusLine: s?.statusLineEnabled !== false,
          includeConductorMcp: s?.conductorToolsEnabled !== false,
        })
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
        const s = readConfig<{ statusLineEnabled?: boolean; conductorToolsEnabled?: boolean }>('settings')
        const setupCmd = claudeProvider.configureRemoteSettings(sessionId, remotePath, hooksConfig, {
          includeStatusLine: s?.statusLineEnabled !== false,
          includeConductorMcp: s?.conductorToolsEnabled !== false,
        })
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
      getPtyIntegrityMonitor()?.recordPtyData(sessionId, data.length)
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
    captureCodexSpawnIdentity(sessionId)
    // Codex local session — spawn `codex` directly. Codex itself owns the
    // REPL, so there is no shell-wrap-then-cd-then-launch dance like Claude
    // requires. cwd is propagated through pty.spawn options.
    // shellOnly falls through to the Claude branch below so the user gets a
    // plain shell, regardless of provider selection.
    //
    // Copilot review on PR #31 (p9.15): buildSpawnCommand or pty.spawn can
    // throw before onExit is wired up (binary missing, ConPTY init failure,
    // node-pty resolver miss). Clean up the spawn-identity map entry on
    // failure so it doesn't leak.
    try {
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
        getPtyIntegrityMonitor()?.recordPtyData(sessionId, data.length)
        win.webContents.send(`pty:data:${sessionId}`, data)
      })
      // Start rollout watch-and-claim telemetry. Updates are dispatched to the
      // renderer (statusline:update) identically to how Claude statusline
      // updates flow through statusline-watcher.ts. (Tokenomics is no longer fed
      // from telemetry ticks — the indexing worker reads raw transcripts.)
      const codexTelSrc = provider.ingestSessionTelemetry(
        sessionId,
        { cwd: resolvedCwd, spawnTimestamp: codexSpawnTimestamp },
        (data) => {
          // Copilot review on PR #31 (p9.17): decorate at the send site so
          // the renderer receives accountColour. decorateStatuslineWithColour
          // is a no-op when the payload carries no accountEmail (Codex
          // telemetry currently does not), so this is safe + future-proof.
          // Tokenomics no longer ingests from telemetry ticks (the worker
          // indexes raw transcripts on its own timer); only the renderer send
          // remains.
          const decorated = decorateStatuslineWithColour(data)
          if (!win.isDestroyed()) win.webContents.send('statusline:update', decorated)
        },
      )
      codexTelemetrySources.set(sessionId, codexTelSrc)
    } catch (err) {
      clearCodexSpawnIdentity(sessionId)
      throw err
    }
  } else {
    // Local session — delegate binary + env construction to the provider.
    // The post-spawn shell-write (cd + claude command) stays here; only the
    // bare shell + env comes from the provider.
    const shellOnly = options?.shellOnly
    const provider = getProvider('claude')
    // Read classicTerminalCopyPaste + theme fresh on every spawn (default true /
    // dark when absent). The theme drives COLORFGBG so Claude's startup theme
    // auto-detection matches CCC; 'system' follows the OS via nativeTheme.
    const claudeSpawnSettings = readConfig<{ classicTerminalCopyPaste?: boolean; theme?: string; clickableQuestions?: boolean }>('settings')
    const classicTerminalCopyPaste = claudeSpawnSettings?.classicTerminalCopyPaste !== false
    // Clickable question options (CC >= 2.1.195) default OFF in CCC.
    const clickableQuestions = claudeSpawnSettings?.clickableQuestions === true
    const hostColorScheme = resolveHostColorScheme(
      claudeSpawnSettings?.theme,
      nativeTheme.shouldUseDarkColors,
    )
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
      classicTerminalCopyPaste,
      clickableQuestions,
      hostColorScheme,
    })
    const wantProfileId = options?.profileId
    if (wantProfileId && fs.existsSync(getProfileConfigDir(wantProfileId))) {
      resolvedProfileId = wantProfileId
    } else if (wantProfileId) {
      logWarn(`[profiles] session ${sessionId}: profile dir missing for profileId=${wantProfileId}; falling back to primary/default`)
    }
    // Clobber-proofing: a non-shell Claude session never runs on the bare global
    // home -- fall back to the captured primary profile.
    if (!shellOnly && !resolvedProfileId) {
      const primary = getPrimaryProfileId()
      if (primary && fs.existsSync(getProfileConfigDir(primary))) resolvedProfileId = primary
    }
    // Home selection (Bug 2): EVERY session of an account -- shell-only (plain
    // shells + the add-account login flow) AND interactive Claude -- runs in the
    // account's shared PROFILE home. That way concurrent sessions of one account
    // share ONE rotating-OAuth credential store and coordinate token refreshes the
    // way a normal single-account install does. The old per-session-home model gave
    // each session a private COPY of the credential; the first refresh rotated the
    // token and invalidated every other copy, forcing a re-auth on resume.
    // Auth-outside-CCC fix: before a session reads the primary account's profile
    // home, pull a fresher global token (e.g. a /login the user ran OUTSIDE CCC)
    // into it so this session starts on the live token. Primary-only + email-guarded;
    // no-op otherwise.
    try { syncPrimaryCredentialsWithGlobal() } catch { /* best-effort */ }
    let home: string | null = null
    if (resolvedProfileId) {
      try { setupProfileLinks(resolvedProfileId) } catch (e) { logWarn(`[profiles] session ${sessionId}: home refresh failed: ${e}`) }
      home = getProfileConfigDir(resolvedProfileId)
    }
    const finalSpawnEnv = withProfileHome(spawnEnv, home)
    logInfo(`[profiles] session ${sessionId} account spawn: requestedProfileId=${wantProfileId ?? '(none)'} resolvedProfileId=${resolvedProfileId ?? '(none/bare-global)'} shellOnly=${shellOnly} USERPROFILE=${home ?? '(real home)'}`)
    // Reliable, drift-immune account identity: capture once at spawn from the
    // session's profile (or the default ~/.claude.json), never re-read.
    // B3: capture is deferred until AFTER the interactive Claude pty.spawn
    // succeeds (see below) so a spawn throw can't leak the per-session map entry,
    // and shell-only sessions (no Claude) never capture.

    if (shellOnly) {
      logInfo(`[pty-manager] Launching shell-only PTY: ${spawnCmd} ${spawnArgs.join(' ')} cwd=${resolvedCwd}${options?.elevated ? ' (elevated)' : ''}`)

      ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: resolvedCwd,
        env: finalSpawnEnv,
        useConpty: true
      })

      // Explicitly cd to ensure the shell is in the right directory
      // (PowerShell profiles can change cwd before the user sees the prompt)
      const escapedShellCwd = resolvedCwd.replace(/'/g, "''")
      const cdCmd = os.platform() === 'win32'
        ? `Set-Location '${escapedShellCwd}'`
        : `cd '${resolvedCwd.replace(/'/g, "'\\''")}' 2>/dev/null; clear`
      setTimeout(() => {
        // Liveness guard: a kill / Restart / app-quit can land inside this 300ms
        // window — writing to a dead or already-replaced PTY here would throw
        // inside the timer (uncaught in main). Only write when our PTY is still
        // the registered one.
        if (ptySessions.get(sessionId)?.ptyProcess !== ptyProcess) return
        try { ptyProcess.write(cdCmd + '\r') } catch { /* session died mid-launch */ }
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

      // T8b (bug #5): EXACT-CONVERSATION RESUME.
      //
      // `claude --resume <uuid>` is cwd-SCOPED: it only resolves a conversation
      // from the LAUNCH cwd's mangled ~/.claude/projects/<mangled> folder, and
      // needs both <uuid>.jsonl AND a same-name companion dir there. The CLI only
      // creates that companion dir LAZILY (first subagent/workflow), so a
      // direct-work conversation lacks one — CCC therefore ENSURES it on demand
      // (see below) rather than requiring it. The default resume-picker /
      // newest-in-folder behaviour can also pick a STALE conversation when the
      // live one ran under a DIFFERENT cwd (e.g. a git worktree). So we must do
      // BOTH: pass --resume <uuid> AND override the launch cwd to the directory
      // the conversation actually ran in (read out of the JSONL — the mangled
      // folder name is lossy and not reversible).
      //
      // Effective target precedence (all fail-open):
      //   options.resume          (app-relaunch: persisted on the restored session)
      //   lastResumeTarget        (in-session Restart / Switch-account: self-captured)
      //
      // The whole override is gated by the pure resolveResumeLaunch() helper:
      // transcript file present AND the RAW target cwd is a real directory
      // (stat'd directly — NOT via the homedir-fallback resolveCwd). A missing
      // companion dir is NO LONGER a gate — the helper creates it best-effort so
      // a direct-work conversation stays resumable. ANY OTHER miss → drop resume
      // entirely and fall back to existing behaviour. We never launch --resume
      // from os.homedir() (a deleted worktree therefore falls back, it does not
      // silently retarget home).
      let resumeUuid: string | undefined = undefined
      let claudeCwd = resolvedCwd
      // Precedence: app-relaunch persisted target wins over the self-captured
      // one. The self-captured target is consumed unconditionally below so it
      // can never apply to a later, unrelated spawn of this sessionId.
      const persistedTarget = options?.resume
      const selfCapturedTarget = getLastResumeTarget(sessionId)
      clearLastResumeTarget(sessionId)
      const effectiveTarget = persistedTarget ?? selfCapturedTarget
      // FIX 3: `discoveryOn` (binder present == logging on) gates ONLY the
      // self-captured path — that path's target ORIGINATES from the binder, so
      // without it there is nothing to capture. The app-relaunch path uses the
      // PERSISTED options.resume + on-disk file checks and needs no binder, so
      // logging-off users still get exact-resume on relaunch. (When the target
      // is self-captured the binder is inherently present anyway.)
      const usingPersisted = !!persistedTarget
      const discoveryOn = usingPersisted || !!getTranscriptBinder()
      if (effectiveTarget && (options?.provider ?? 'claude') === 'claude' && discoveryOn) {
        // FIX 1 + FIX 2: the cwd/path existence gate lives in the pure, tested
        // resolveResumeLaunch() helper. It stats the RAW captured cwd directly
        // (no homedir-fallback resolver), so a DELETED worktree → null → fall
        // back to picker/direct. We never launch --resume from os.homedir().
        const launch = resolveResumeLaunch(effectiveTarget, {
          existsSync: fs.existsSync,
          statSync: (p) => fs.statSync(p),
          homedir: os.homedir,
          mangleCwdToProjectDir,
          projectsRoot: path.join(os.homedir(), '.claude', 'projects'),
          // Best-effort: ensure a direct-work conversation (no subagent/workflow,
          // hence no companion dir from the CLI) is resumable. Never throws.
          ensureCompanionDir: (projectDir, uuid) => { ensureCompanionDir(projectDir, uuid, nodeFsCompanionDeps) },
        })
        if (launch) {
          resumeUuid = launch.resumeUuid
          claudeCwd = launch.claudeCwd
          // FIX 4: propagate the override to function scope so the subsequent
          // runStart/registerRun stamp + scan the folder Claude actually ran in.
          effectiveLaunchCwd = claudeCwd
          // Part A: capture the resume uuid at function scope so the registerRun
          // site can bind the exact transcript IMMEDIATELY (deterministic
          // resume-bind), independent of the hooks/statusline/heuristic race.
          resumeUuidForBind = launch.resumeUuid
          logInfo(`[pty] T8b exact resume for ${sessionId}: uuid=${resumeUuid} cwd=${claudeCwd} (was ${resolvedCwd})`)
        } else {
          logInfo(`[pty] T8b resume target dropped for ${sessionId} (fail-open existence check) — uuid=${effectiveTarget.uuid}`)
        }
      }

      logInfo(`[pty-manager] Launching Claude via shell in PTY: ${spawnCmd} -> ${cmd} cwd=${claudeCwd} (resumePicker=${!!options?.useResumePicker}, resume=${resumeUuid ?? 'none'})`)

      ptyProcess = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: claudeCwd,
        env: finalSpawnEnv,
        useConpty: true
      })

      // B3: capture identity ONLY after the spawn succeeds — if pty.spawn throws,
      // no map entry is created (no leak), and shell-only sessions never reach
      // here. resolvedProfileId is undefined when no explicit or primary profile
      // resolved, so identity comes from the default account in that case.
      captureClaudeAccount(sessionId, resolvedProfileId)
      pushAccountIdentity(sessionId)
      // Watch for a mid-session account change (user runs /login in the terminal
      // without a respawn), so the strip/card/statusline follow the new account.
      startWatchingAccountIdentity(sessionId, resolvedProfileId)

      // P6: register for codex_review opt-in if the session config requested it.
      // Only Claude sessions can opt in; Codex sessions never reach this branch
      // (they go through the codex provider branch above).
      if (options?.enableCodexReview) {
        registerCodexReviewSession(sessionId, resolvedCwd)
      }

      // Explicitly cd to the project directory, then launch Claude.
      // The cd is critical — it ensures Claude sees the correct project directory
      // regardless of PowerShell profile scripts or PTY cwd propagation issues.
      // The command string + cwd escaping is built by the pure
      // buildClaudeLaunchCommand() helper below; it uses `claudeCwd` (the
      // resume-target override when active, else resolvedCwd).

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

      // P7.7.2: seed a per-session settings file for hooks/statusLine
      // overrides. P7.7.3: also seed a per-session MCP config file
      // (--mcp-config), because claude.exe ignores mcpServers in --settings
      // and reads it ONLY from --mcp-config or ~/.claude.json.
      const quoteForShell = (p: string): string =>
        os.platform() === 'win32' ? p.replace(/'/g, "''") : p.replace(/'/g, "'\\''")
      try {
        // v1.5.12: thread the CCC AppSettings.disableClaudeWorkflows flag
        // through so Claude Code's dynamic-workflow feature can be killed
        // at the per-session level without the user hand-editing
        // ~/.claude/settings.json. Read fresh on every spawn so a Settings
        // toggle takes effect on the next session without an app restart.
        const appSettings = readConfig<{ disableClaudeWorkflows?: boolean; statusLineEnabled?: boolean }>('settings')
        const disableWorkflows = !!appSettings?.disableClaudeWorkflows
        // Master status-line switch (onboarding p4 / Settings -> Status line):
        // absent means ON (pre-upgrade configs). Off = no resourcesDir, so the
        // per-session clone gets no statusLine key and Claude runs without the
        // bundled script. Read fresh per spawn; sessions already running keep
        // theirs until restarted.
        const statusLineOn = appSettings?.statusLineEnabled !== false
        const sesPath = writeLocalSessionSettings(sessionId, { disableWorkflows, resourcesDir: statusLineOn ? getResourcesDirectory() : undefined })
        // injectHooks rewrites the per-session settings file to point Claude's
        // hook events at our local gateway, which drives the session attention
        // pulse, statusline ingest, and conversation logging. Skipped only when
        // the gateway is down (port-bind failure, etc.) so Claude still spawns
        // cleanly.
        const gw = getGateway()
        const gwStatus = gw?.status()
        if (gw && gwStatus?.listening && gwStatus.port) {
          try {
            const secret = gw.registerSession(sessionId)
            injectHooks({ sessionId, settingsPath: sesPath, port: gwStatus.port, secret })
          } catch (err) {
            logError(`[pty] Failed to inject hooks for ${sessionId}: ${(err as Error)?.message ?? err}`)
          }
        }
        extraFlags += ` --settings '${quoteForShell(sesPath)}'`
      } catch (err) {
        logError(`[pty] Failed to seed per-session settings for ${sessionId}: ${(err as Error)?.message ?? err}`)
      }
      try {
        // Built-in tools master (onboarding p6 / Settings): off = the session's
        // mcp-config carries no conductor entry. Read fresh per spawn.
        const conductorOn = readConfig<{ conductorToolsEnabled?: boolean }>('settings')?.conductorToolsEnabled !== false
        const mcpCfgPath = writeLocalSessionMcpConfig(sessionId, conductorOn)
        extraFlags += ` --mcp-config '${quoteForShell(mcpCfgPath)}'`
      } catch (err) {
        logError(`[pty] Failed to seed per-session MCP config for ${sessionId}: ${(err as Error)?.message ?? err}`)
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

      // When useResumePicker is true, run the resume-picker script instead of
      // Claude directly. The picker shows prior conversations and launches Claude
      // with --resume or plain. Any claude flags we've already built up (notably
      // --settings for hooks) must be forwarded through the picker so the child
      // claude process sees them too.
      //
      // T8b: when an exact resume target resolved (resumeUuid set), the builder
      // BYPASSES the picker and launches `claude --resume <uuid>` directly from
      // claudeCwd (the conversation's real cwd). Otherwise the byte-identical
      // golden behaviour (picker / direct) is preserved.
      const escapedCmd = buildClaudeLaunchCommand({
        platform: os.platform() === 'win32' ? 'win32' : 'posix',
        cwd: claudeCwd,
        claudeBin: cmd,
        extraFlags,
        agentsFlag,
        useResumePicker: !!options?.useResumePicker,
        pickerScript: getResumePickerPath(),
        resumeUuid,
      })
      setTimeout(() => {
        // Liveness guard (see shell-only branch): the 300ms launch-write can race
        // a kill / Restart / app-quit; writing to a dead/replaced PTY from this
        // timer would crash main. Only write when our PTY is still registered.
        if (ptySessions.get(sessionId)?.ptyProcess !== ptyProcess) return
        try { ptyProcess.write(escapedCmd + '\r') } catch { /* session died mid-launch */ }
      }, 300)
    }

    ptyProcess.onData((data) => {
      if (win.isDestroyed()) return
      getPtyIntegrityMonitor()?.recordPtyData(sessionId, data.length)
      win.webContents.send(`pty:data:${sessionId}`, data)
    })
  }

  ptySessions.set(sessionId, { ptyProcess, sessionId })
  updateSessionMeta({ id: sessionId, label: options?.configLabel ?? sessionId, cwd: options?.cwd, provider: options?.provider ?? 'claude' })

  // Replay any buffered writes (from commands sent before PTY was ready)
  const pending = pendingWrites.get(sessionId)
  if (pending) {
    logInfo(`[pty] Replaying ${pending.length} buffered write(s) for ${sessionId}`)
    for (const data of pending) {
      ptyProcess.write(data)
    }
    pendingWrites.delete(sessionId)
  }

  // Record the run via the transcripts worker pipeline (Logs v2). Gated on the
  // live `loggingEnabled` setting (default-true) and never for shell-only
  // sessions (full gating refinement = Task 9). The captured account (set at
  // line ~950 for non-shell Claude sessions) + configId/profileId are stamped
  // so runs can be filtered by config/account.
  const configLabel = options?.configLabel || 'default'
  // Reading settings here (rather than relying solely on the supervisor's
  // existence) gives a LIVE disable: if logging was enabled at boot (so the
  // supervisor is running) but the user later turns it off in Settings, new
  // runs are skipped immediately — the worker keeps running idle. Asymmetry: if
  // logging was DISABLED at boot there is no supervisor, so a mid-run enable
  // needs a restart.
  const settings = readConfig<{ loggingEnabled?: boolean }>('settings') ?? {}
  // Single source of truth for the run-registration decision (Task 9):
  // claude-local-only (not codex/other), not shell-only, not SSH, per-config
  // loggingEnabled !== false, global loggingEnabled !== false. The matching
  // runEnd/endRun on exit are gated on this same `logSup` being non-null, so a
  // run is only ended if it was registered.
  const logSup = shouldRegisterRun(options ?? {}, settings) ? getLogSupervisor() : null
  logSup?.runStart({
    sessionId,
    configId: options?.configId,
    configLabel,
    // FIX 4: the effective launch cwd (resume override when active, else the
    // configured resolvedCwd) — not the bare resolvedCwd.
    projectCwd: effectiveLaunchCwd,
    // accountEmail is typically undefined here: identity is captured asynchronously
    // AFTER spawn (recheckSessionIdentity / startWatchingAccountIdentity wired in
    // pty-manager). The run row therefore stamps a null email; configId and
    // profileId ARE stamped correctly at spawn. runAccount() back-fills the email
    // once the identity poll resolves (wired in a later task).
    accountEmail: getAccountIdentity(sessionId)?.email,
    profileId: resolvedProfileId,
    provider: options?.provider ?? 'claude',
    startedAt: Date.now(),
  })
  // Logs v2 (Task 8): arm the heuristic transcript-discovery fallback for this run.
  // The exact sources (hooks + statusline) bind first; if neither has bound ~20s
  // later, the binder scans ~/.claude/projects for the newest matching JSONL.
  // Gated on logSup (the consolidated shouldRegisterRun decision — already
  // claude-local-only, so no separate provider re-check) + a known cwd.
  if (logSup && effectiveLaunchCwd) {
    // FIX 4: register with the effective launch cwd so the 20s heuristic
    // fallback scans the folder Claude ran in (the resume override when active).
    const binder = getTranscriptBinder()
    binder?.registerRun(sessionId, effectiveLaunchCwd, Date.now())
    // Part A: DETERMINISTIC RESUME-BIND. When an exact-resume applied we already
    // know the conversation's uuid + the real launch cwd, so we can bind that
    // exact transcript IMMEDIATELY — no waiting for the hooks/statusline exact
    // sources or the 20s heuristic. This fixes the observed first-/resumed-session
    // `nt=0` race at boot (the exact sources lose to boot wiring; the heuristic's
    // one-shot didn't recover it). Routed through notifyTranscriptPath so the
    // existing debounce + idempotent canonicalize apply; a stale path just no-ops.
    if (binder && resumeUuidForBind) {
      const resumePath = buildResumeTranscriptPath(effectiveLaunchCwd, resumeUuidForBind)
      if (resumePath) {
        logInfo(`[binder] resume-bind sid=${sessionId} path=${resumePath}`)
        binder.notifyTranscriptPath(sessionId, resumePath)
      }
    }
  }

  // Debug capture only — the transcripts worker tails Claude's own transcript
  // files, so PTY bytes are no longer recorded for logging.
  ptyProcess.onData((data) => {
    if (isDebugModeEnabled()) {
      logPtyOutput(sessionId, data)
    }
  })

  ptyProcess.onExit(({ exitCode }) => {
    logInfo(`[pty] PTY exited for session ${sessionId} with code ${exitCode}`)

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
      clearSessionMeta(sessionId)
      // Close the run (the worker final-drains + retires its transcript tails).
      // Gated on weAreCurrent so the restart-race stale exit can't end the
      // just-respawned session's run. No-op when logging is disabled / this
      // session was never recorded (logSup null).
      logSup?.runEnd(sessionId, Date.now(), exitCode === 0 ? 'exited' : 'crashed')
      // Logs v2 (Task 8): cancel any pending heuristic timer + clear the binder's
      // per-session bind state so a reused sessionId (restart) binds fresh.
      getTranscriptBinder()?.endRun(sessionId)
      getPtyIntegrityMonitor()?.endSession(sessionId)
      try {
        const gwExit = getGateway()
        if (gwExit) gwExit.unregisterSession(sessionId)
      } catch { /* gateway may have already stopped during shutdown */ }
      removeLocalSessionSettings(sessionId)
      removeLocalSessionMcpConfig(sessionId)
      // P6: clear opt-in registration and per-session usage record.
      unregisterCodexReviewSession(sessionId)
      disposeCodexReviewUsage(sessionId)
      // Locality fix: stop the Codex telemetry tail poller + drop the four
      // per-session write buffers (pasteQueues / pendingWrites / recentWrites /
      // sshOscBuffers) and the SSH flow on NATURAL exit too — previously only
      // killPty did this, so a session whose process exited on its own (Codex
      // exit/quit, crash) leaked the 2Hz full-file telemetry read + its maps
      // until the tab was closed.
      cleanupSessionResources(sessionId)
      // P8.8: clear spawn-time identity capture. Safe no-op for non-codex sessions.
      clearCodexSpawnIdentity(sessionId)
      // Phase R: clear spawn-time Claude account capture so the map can't grow unbounded.
      // Capture the watched profileId BEFORE stopWatching clears it.
      const exitProfileId = getWatchedProfileId(sessionId)
      clearClaudeAccount(sessionId)
      stopWatchingAccountIdentity(sessionId)
      // Bug 2: snapshot any token refresh from the shared profile home into the
      // account's canonical backup. Email-guarded, so a mid-session /login that
      // switched the home to a different account can never corrupt canonical.
      // No-op for default (no-profile) sessions.
      if (exitProfileId) { try { backupProfileHomeToCanonical(exitProfileId) } catch { /* best-effort */ } }
      // Auth-outside-CCC fix: this session may have rotated the primary account's
      // OAuth token; push the freshest token back to the real global ~/.claude so an
      // external `claude -p` keeps working. Freshest-wins + email-guarded; no-op when
      // the exiting session wasn't the primary account.
      try { syncPrimaryCredentialsWithGlobal() } catch { /* best-effort */ }
      // Bug 4: release this session's pinned vision browser target/context.
      try { teardownVisionSession(sessionId) } catch { /* best-effort */ }
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
// causing truncation. Only chunk large writes (pastes); keystrokes go straight
// through. Constants + the crash-safe loop live in pty-chunked-write.ts (pure,
// unit-tested without the pty-manager dependency graph).
function writeChunked(sessionId: string, ptyProcess: pty.IPty, data: string): void {
  // R-010: re-check liveness each chunk (a respawn replaces the PTY under the
  // same sessionId) and try/catch the write inside the helper, so a write to a
  // killed/replaced PTY from the timer can never throw an uncaught exception in
  // main. Mirrors writeEnvelopeChunked.
  runChunkedWrite(data, {
    write: (slice) => ptyProcess.write(slice),
    isAlive: () => ptySessions.get(sessionId)?.ptyProcess === ptyProcess,
  })
}

// Per-session FIFO paste queues for channel envelopes (P3.1).
const pasteQueues = new Map<string, PasteQueue>()

// Guard-free chunked write (channel envelopes carry a unique ts: and must not
// be deduped). Mirrors writeChunked's 256-byte/12ms cadence.
function writeEnvelopeChunked(sessionId: string, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    // Capture THIS pty up front and route through the R-010-tested
    // runChunkedWrite with an identity-guarded isAlive, so a respawn (new PTY
    // under the same sessionId) can't receive the tail of a half-written
    // envelope (P1.5 — mirrors writeChunked). onDone resolves the queue's writer.
    const proc = ptySessions.get(sessionId)?.ptyProcess
    if (!proc) return resolve()
    runChunkedWrite(data, {
      write: (slice) => proc.write(slice),
      isAlive: () => ptySessions.get(sessionId)?.ptyProcess === proc,
      onDone: resolve,
    })
  })
}

// Public API for the bus. Enqueues a fully-wrapped envelope for delivery.
// Returns dropped-count (>0 means overflow occurred).
export function pastePty(sessionId: string, envelope: string): number {
  let q = pasteQueues.get(sessionId)
  if (!q) { q = new PasteQueue((d) => writeEnvelopeChunked(sessionId, d), 16); pasteQueues.set(sessionId, q) }
  return q.enqueue(envelope)
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
        writeChunked(sessionId, session.ptyProcess, data)
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
    getPtyIntegrityMonitor()?.recordResizeApplied(sessionId, cols, rows)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EPIPE' || code === 'EIO') {
      ptySessions.delete(sessionId)
    }
    // ignore all resize errors
  }
}

/**
 * Per-session resource + map hygiene shared by killPty (explicit kill) and the
 * natural-exit onExit cleanup block. Idempotent — every step is a no-op when the
 * entry is already absent — so it is safe to run on both paths (a user-kill fires
 * killPty AND later the async onExit with weAreCurrent, and a natural exit fires
 * only onExit). Consolidating here is what fixes the locality minors: codex
 * telemetry + the four per-session buffers (pendingWrites / recentWrites /
 * sshOscBuffers / pasteQueues) used to be cleaned only by killPty, leaking on
 * naturally-exiting sessions.
 */
function cleanupSessionResources(sessionId: string): void {
  pendingWrites.delete(sessionId)
  recentWrites.delete(sessionId)
  sshOscBuffers.delete(sessionId)
  pasteQueues.get(sessionId)?.cancel() // stop draining + drop pending before dropping the ref (P1.5)
  pasteQueues.delete(sessionId)
  // Delete the per-session statusline status file so the watcher's poll
  // fan-out stays bounded between boot sweeps (the reaper only unlinks
  // files older than 3 days).
  cleanupStatusFile(sessionId)
  // Drop the session's background-context state (subagent depth + main
  // transcript anchor) so those maps don't grow for the life of the install.
  forgetSession(sessionId)
  // T8b: drop any captured resume target so it can't leak into a future,
  // unrelated spawn of the same sessionId. The respawn path captures fresh
  // BEFORE calling killPty, so the just-captured target survives this clear.
  clearLastResumeTarget(sessionId)
  // Stop Codex telemetry source if one was registered for this session. On a
  // natural Codex exit (user typed exit/quit, Ctrl+D, crash) this is the ONLY
  // place that stops the 500ms full-file-read tail poller — killPty isn't hit
  // until the tab is closed, so without this the poller ran for the dead tab.
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
    sshFlows.delete(sessionId)
  }
}

// U8: grace before killing an SSH PTY so the in-band remote-cleanup command has
// time to reach the remote shell and run before we tear the tunnel down.
const REMOTE_CLEANUP_GRACE_MS = 400

export function killPty(sessionId: string): void {
  const entry = ptySessions.get(sessionId)
  if (entry) {
    logInfo(`[pty] Killing PTY for session ${sessionId}`)
    if (sshFlows.has(sessionId)) {
      // U8: sweep the per-session files we planted on the remote, in-band down the
      // still-live PTY, then kill after a short grace so the `rm` runs before the
      // tunnel dies. No SSH creds retained. A crash / natural exit can't do this
      // (the tunnel is already gone), which is acceptable -- the files are inert.
      // ptySessions.delete below means the delayed kill's onExit no-ops.
      const proc = entry.ptyProcess
      try { proc.write(buildRemoteSessionCleanupCommand(sessionId)) } catch { /* best-effort */ }
      setTimeout(() => { try { proc.kill() } catch { /* already gone */ } }, REMOTE_CLEANUP_GRACE_MS)
    } else {
      try { entry.ptyProcess.kill() } catch (err) {
        logError(`[pty] Error killing PTY ${sessionId}:`, err)
      }
    }
    ptySessions.delete(sessionId)
  }
  cleanupSessionResources(sessionId)
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

// A session is writable for channel delivery iff a live PTY handle exists for
// it. The renderer status enum is UI-only; PTY presence is authoritative.
export function isSessionWritable(sessionId: string): boolean {
  return ptySessions.has(sessionId)
}
