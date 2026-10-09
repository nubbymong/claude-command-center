/**
 * Cloud Agent Manager -- spawn/track/cancel headless background agents: Claude
 * Code (`claude -p`) and, from WP2 PR 4 (P4.5, row 57), the second provider's
 * headless run through its package's background port, in a launch the
 * accounts service prepared (kind `background`).
 */

import { spawn, spawnSync, ChildProcess } from 'child_process'
import { BrowserWindow } from 'electron'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { createReadFailureLatch, loadConfigLatched, saveConfigLatched, mergeById } from './persist-latch'
import { logInfo, logWarn, logError } from './debug-logger'
import { resolveVersionBinary, isVersionInstalled, installVersion, legacyCliPin } from './legacy-version-manager'
import { isValidLegacyVersion } from '../shared/legacy-version'
import { getProfileConfigDir, getPrimaryProfileId, setupProfileLinks, listProfiles, isValidProfileId } from './account-profiles'
import { withProfileHome } from './pty-manager'
import { gateManagedLaunch } from './managed-launch-diagnostics'
import type { ProjectGateResult, ProviderLaunchRefused, ProviderId } from '../shared/providers'
import { acquireProfileConsumer, waitForProfileRefresh } from './profile-consumers'
import { providerLaunchRefusal } from './provider-launch-gate'
import { getAccountsService } from './provider-accounts'
import { tryGetProviderPackage } from './providers/core'
import type { AccountLease, PreparedLaunchResult } from './providers/core'
import type { CloudAgentCodexOptions } from '../shared/types'
import { stripSpoofableText } from '../shared/safe-text'
import { randomId } from '../shared/id'
import { systemTool } from './windows-programs'

export interface CloudAgentData {
  id: string
  name: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  createdAt: number
  updatedAt: number
  projectPath: string
  configId?: string
  /** Account profile this agent ran under (multi-account). Undefined = default/global account. */
  profileId?: string
  /** Resolved account email at dispatch time. Drives the card label + account filter. */
  accountEmail?: string
  /** The assistant this agent runs on (WP2 PR 4, P4.5, row 57). Absent on
   *  every agent saved before PR 4, all of which ran Claude Code: readers
   *  MUST treat undefined as 'claude'. */
  provider?: ProviderId
  /** A second-provider agent's account (P4.5): the opaque registry id of
   *  the account its launch was prepared on (`acct-`), never a path or a
   *  credential. Claude agents name theirs by `profileId`. A launch
   *  acknowledgement is never stored. */
  providerAccountId?: string
  /** A second-provider agent's model and effort, from the config it was
   *  started from, kept so a Retry runs as the first run did. */
  codexOptions?: CloudAgentCodexOptions
  output: string
  cost?: number
  duration?: number
  tokenUsage?: { inputTokens: number; outputTokens: number }
  error?: string
  legacyVersion?: { enabled: boolean; version: string }
}

/**
 * Resolve the per-account spawn environment for a headless agent. Mirrors the
 * shell-only path in pty-manager: run under the profile's fake HOME so the
 * account identity (~/.claude.json + ~/.claude) is private to that account.
 * Falls back to the captured primary profile so an agent never silently runs on
 * the bare global login when multi-account is active; returns the bare env
 * (behaviour unchanged) for single-account users with no profiles.
 */
function resolveAgentEnv(profileId: string | undefined, projectPath: string, projectGate: ProjectGateResult, pinnedCli?: { version: string; installed: boolean }): {
  env: Record<string, string>
  resolvedProfileId: string | null
  accountEmail?: string
} {
  const baseEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) baseEnv[k] = v
  }

  let resolvedProfileId: string | null = null
  // Same guard as the insights/headless resolvers: validate before the join so a
  // crafted id can't resolve a home outside the profiles root (it becomes the
  // spawned agent's HOME).
  if (profileId && isValidProfileId(profileId) && fs.existsSync(getProfileConfigDir(profileId))) {
    resolvedProfileId = profileId
  } else {
    if (profileId) logWarn(`[cloud-agent] profile dir missing or invalid for profileId=${profileId}; falling back to primary/default`)
    const primary = getPrimaryProfileId()
    if (primary && fs.existsSync(getProfileConfigDir(primary))) resolvedProfileId = primary
  }

  if (!resolvedProfileId) return { env: baseEnv, resolvedProfileId: null }

  try { setupProfileLinks(resolvedProfileId) } catch (e) { logWarn(`[cloud-agent] home refresh failed for ${resolvedProfileId}: ${e}`) }
  const home = getProfileConfigDir(resolvedProfileId)
  const accountEmail = listProfiles().find(p => p.id === resolvedProfileId)?.accountEmail || undefined
  return { env: withProfileHome(baseEnv, home, { launchId: 'cloud-agent', cwd: projectPath, probe: false, projectGate, ...(pinnedCli ? { pinnedCli } : {}) }), resolvedProfileId, accountEmail }
}

const MAX_OUTPUT_BYTES = 512 * 1024 // 500KB cap per agent
/** Ends output cut at the cap (the dash written as an escape keeps the
 *  source ASCII; the text is the one the Claude agent has always shown). */
const OUTPUT_TRUNCATED_MARKER = '\n\n[output truncated \u2014 exceeded 500KB]'

const activeProcesses = new Map<string, ChildProcess>()
/** P4.5: a second-provider agent's run, by agent id: what stops it (Stop,
 *  Remove, quit). Its process belongs to the provider's CLI runner. */
const backgroundRuns = new Map<string, AbortController>()
let agents: CloudAgentData[] = []
let getWindow: () => BrowserWindow | null = () => null
/** Dispatches past the launch gate whose record does not exist yet (the
 *  project scan is awaited first), by provider. */
const dispatching = new Map<ProviderId, number>()
/** P4.5: agents (by id) holding an account lease from the accounts service,
 *  which counts them in use itself while it is held. */
const leasedAgents = new Set<string>()

/** The provider an agent runs on: absent on every agent saved before PR 4,
 *  all of which ran Claude Code. */
export function agentProvider(agent: Pick<CloudAgentData, 'provider'>): ProviderId {
  return agent.provider ?? 'claude'
}

/** One provider's cloud agents in use without an account lease: every
 *  dispatch past its launch gate, from before its record exists, and every
 *  agent of it running or pending that holds no lease (a held lease is
 *  counted by the accounts service, so an agent counts once). */
function countAgentsInUse(providerId: ProviderId): number {
  return (dispatching.get(providerId) ?? 0) + agents.filter((a) => agentProvider(a) === providerId && (a.status === 'running' || a.status === 'pending') && !leasedAgents.has(a.id)).length
}

function beginDispatch(providerId: ProviderId): () => void {
  dispatching.set(providerId, (dispatching.get(providerId) ?? 0) + 1)
  let done = false
  return () => {
    if (done) return
    done = true
    dispatching.set(providerId, Math.max(0, (dispatching.get(providerId) ?? 0) - 1))
  }
}

/** WP2: cloud agents that are Claude Code in use, for the switch-off rule
 *  (provider-in-use.ts): every dispatch past the launch gate, from before its
 *  record exists, and every agent running or pending -- one waiting on its
 *  legacy CLI install or an account refresh included. A switch-off is
 *  refused while any is counted, as it is while a session runs. Agents of
 *  another provider are that provider's, never Claude Code's. */
export function countClaudeAgentsInUse(): number {
  return countAgentsInUse('claude')
}

/** P4.5: cloud agents that are Codex in use and hold no account lease yet:
 *  from the dispatch past the launch gate until the lease is held (its
 *  launch being prepared), and again once it is let go if the record is
 *  still open. While the lease is held the accounts service counts the
 *  agent through it, so one running agent counts once. */
export function countCodexAgentsInUse(): number {
  return countAgentsInUse('codex')
}

function generateId(): string {
  return randomId('ca-')
}

/** #371: a failed read of cloud-agents.json must not become an empty list that
 *  the very next `cleanupStuckAgents()` writes back over the file. */
const cloudAgentsLatch = createReadFailureLatch('cloud-agent')

/**
 * Returns false when the agent list did NOT reach disk. Callers must surface
 * that: `initCloudAgentManager` runs once, at boot, so before the retry inside
 * `saveConfigLatched` existed a single transient lock at startup silently
 * discarded every agent dispatched for the rest of the process.
 */
function persist(removedIds?: readonly string[]): boolean {
  return saveConfigLatched('cloudAgents', () => agents, cloudAgentsLatch, {
    onRecovered: (recovered) => {
      // The file is readable again: everything that was on disk before the
      // failed load comes back, and anything dispatched since wins on its id.
      agents = mergeById(recovered, agents)
      // …but a REMOVAL must not be undone by the merge — the removed row is
      // still on disk, so folding disk back in would resurrect it.
      if (removedIds && removedIds.length > 0) {
        const gone = new Set(removedIds)
        agents = agents.filter((a) => !gone.has(a.id))
      }
    },
  })
}

/** Why the last write did not land, in words a user can act on. */
function persistFailure(): string {
  return cloudAgentsLatch.failed()
    ? 'Your cloud agents could not be saved: the agents file could not be read, so it was left alone rather than overwritten. Nothing on disk was lost — try again once it is readable.'
    : 'Your cloud agents could not be written to disk.'
}

function broadcastStatus(agent: CloudAgentData): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('cloudAgent:statusChanged', agent)
  }
}

function broadcastOutputChunk(id: string, chunk: string): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('cloudAgent:outputChunk', { id, chunk })
  }
}

export function initCloudAgentManager(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  // Load persisted agents. A read FAILURE latches writes off (see persist-latch)
  // so the empty list below is never saved over a file we could not read.
  const saved = loadConfigLatched<CloudAgentData[]>('cloudAgents', cloudAgentsLatch)
  agents = Array.isArray(saved) ? saved : []
}

/** Test seam — the latch is module state and outlives a test file otherwise. */
export function _resetCloudAgentLatchForTest(): void {
  cloudAgentsLatch.reset()
}

export function cleanupStuckAgents(): void {
  let changed = false
  for (const agent of agents) {
    if (agent.status === 'running' || agent.status === 'pending') {
      agent.status = 'failed'
      agent.error = 'Agent was interrupted (app restart)'
      agent.updatedAt = Date.now()
      changed = true
      logInfo(`[cloud-agent] Marked stuck agent as failed: ${agent.id} (${agent.name})`)
    }
  }
  if (changed) persist()
}

export interface DispatchAgentParams {
  name: string
  description: string
  projectPath: string
  configId?: string
  /** The assistant the agent runs on; absent means Claude Code. */
  provider?: ProviderId
  /** Claude Code: the account profile. */
  profileId?: string
  /** Claude Code: a pinned CLI version. */
  legacyVersion?: { enabled: boolean; version: string }
  // Per-run, ephemeral opt-in to skip permission prompts. Default OFF. Claude
  // Code runs --dangerously-skip-permissions; Codex runs its Auto sandbox
  // (section 10, question 7, default A; providers/codex/agent-run.ts).
  skipPermissions?: boolean
  /** Codex: the account (an `acct-` id); absent, the provider default. */
  providerAccountId?: string
  /** Codex: this one launch may use an unverified sign-in (the Codex sign-in
   *  already on this computer, or a realm-only one). Counts only with the
   *  account id it names; never stored. */
  acknowledgeRealmOnly?: boolean
  /** Codex: the config's model and effort. */
  codexOptions?: CloudAgentCodexOptions
}

export async function dispatchAgent(params: DispatchAgentParams): Promise<CloudAgentData | ProviderLaunchRefused> {
  // P4.5: an agent of another provider runs through that provider's package.
  if (agentProvider(params) !== 'claude') return dispatchBackgroundAgent(agentProvider(params), params)
  // WP2: a cloud agent is a Claude Code run, so none starts while Claude Code
  // is off -- refused here, before the project is scanned, a record is made,
  // a legacy CLI is installed or anything is spawned (provider-launch-gate.ts).
  // Every way in comes through here (dispatch, and retry below). Answered,
  // never thrown: the Cloud Agents page says why.
  const refused = providerLaunchRefusal('claude')
  if (refused) return { refused }
  // Claude Code in use from here (countClaudeAgentsInUse): counted in the
  // same step as the check above, so a switch-off cannot slip between them;
  // by its record once that exists (in the same step as this count ends).
  const endDispatch = beginDispatch('claude')
  let spawnEnvVars: Record<string, string>
  let agent: CloudAgentData
  let resolvedProfileId: string | null | undefined
  let accountEmail: string | undefined
  try {
    // The project gate FIRST: the agent runs `claude` in the project directory,
    // so that directory's own settings files are checked before anything is
    // composed, and a refusal is thrown from withProfileHome below -- before an
    // agent record exists to be stamped with a session that never started.
    const projectGate = await gateManagedLaunch(params.projectPath)
    // Resolve the per-account isolated environment up front so the agent record
    // is stamped with the account it actually ran under (drives the card label,
    // the account filter, and a consistent retry).
    //
    // A valid legacy pin is what the agent runs (below), so the preflight is told
    // about it -- installed or not: it is recorded BEFORE the pin's auto-install,
    // and the provider decides which version to check (a not-yet-installed pin
    // counts only when it is below the floor, so a failed install that falls
    // back to the installed CLI can only err loud, never a false "supported").
    const pinnedCli = params.legacyVersion?.enabled ? legacyCliPin(params.legacyVersion) : undefined
    ;({ env: spawnEnvVars, resolvedProfileId, accountEmail } = resolveAgentEnv(params.profileId, params.projectPath, projectGate, pinnedCli))

    agent = {
      id: generateId(),
      name: params.name,
      description: params.description,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectPath: params.projectPath,
      configId: params.configId,
      profileId: resolvedProfileId || undefined,
      accountEmail,
      provider: 'claude',
      output: '',
      legacyVersion: params.legacyVersion,
    }

    agents.unshift(agent)
  } finally {
    endDispatch()
  }
  persist()
  broadcastStatus(agent)

  // rc.15 review R5 (aicc_planning#49): a Cancel (or a Remove) can land while
  // dispatch is parked on an await below -- the legacy install, the account
  // refresh. cancelAgent finds no process then and marks the record cancelled;
  // the resumed dispatch must see that and spawn nothing, or the work runs
  // labelled cancelled with no control left to stop it. Checked after EVERY
  // pre-spawn await; `agent` is the very object in `agents`, so a cancel is
  // visible on it even after a Remove filtered it out of the list.
  const abandoned = (): boolean => agent.status === 'cancelled' || !agents.includes(agent)
  const abandon = (where: string): CloudAgentData => {
    logInfo(`[cloud-agent] Agent ${agent.id} was cancelled during ${where}; not spawning`)
    agent.updatedAt = Date.now()
    agent.duration = agent.updatedAt - agent.createdAt
    if (agents.includes(agent)) { persist(); broadcastStatus(agent) }
    return agent
  }
  /** Nothing was spawned, and nothing will be: the record says why. */
  const failBeforeSpawn = (why: string): CloudAgentData => {
    logInfo(`[cloud-agent] Agent ${agent.id} not started: ${why}`)
    agent.status = 'failed'
    agent.error = why
    agent.updatedAt = Date.now()
    agent.duration = agent.updatedAt - agent.createdAt
    if (agents.includes(agent)) { persist(); broadcastStatus(agent) }
    return agent
  }

  // Resolve Claude binary (use legacy version if configured)
  let claudeBin = 'claude'
  if (params.legacyVersion?.enabled && params.legacyVersion.version) {
    if (!isValidLegacyVersion(params.legacyVersion.version)) {
      // P0.3: never feed a non-semver version into install/spawn — fall back.
      logWarn(`[cloud-agent] Ignoring invalid legacy version ${JSON.stringify(params.legacyVersion.version)}; using system claude`)
    } else {
      // Auto-install if needed
      if (!isVersionInstalled(params.legacyVersion.version)) {
        logInfo(`[cloud-agent] Auto-installing legacy v${params.legacyVersion.version} for agent ${agent.id}`)
        const result = await installVersion(params.legacyVersion.version).catch((e: unknown) => ({ ok: false, error: (e as Error)?.message ?? String(e) }))
        if (!result.ok) {
          logInfo(`[cloud-agent] Legacy install failed, using system claude: ${result.error}`)
        }
        if (abandoned()) return abandon('the legacy CLI install')
      }
      const legacyBin = resolveVersionBinary(params.legacyVersion.version)
      if (legacyBin) {
        claudeBin = legacyBin
        logInfo(`[cloud-agent] Using legacy Claude CLI v${params.legacyVersion.version}: ${legacyBin}`)
      }
    }
  }

  // Write prompt to a temp file, then pipe it to Claude via shell.
  // This ensures Claude CLI reliably detects piped input (print mode).
  // Previous approach (child.stdin.write) broke on Windows because cmd.exe's
  // stdin passthrough doesn't always trigger Claude's pipe detection.
  const tmpFile = path.join(os.tmpdir(), `ccc-agent-${agent.id}.txt`)

  // P1.3 / FEAT-1: cloud-agent dispatch never reads a persisted skip-permissions
  // setting (the legacy global `skipPermissionsForAgents` was removed in Unit 3;
  // Insights no longer skips either). The dangerous skip is an explicit,
  // ephemeral PER-RUN opt-in from the New Agent dialog: default OFF.
  const skipPerms = params.skipPermissions === true

  const pipeCmd = process.platform === 'win32' ? 'type' : 'cat'
  const permFlag = skipPerms ? ' --dangerously-skip-permissions' : ''
  const shellCmd = `${pipeCmd} "${tmpFile}" | ${claudeBin}${permFlag}`

  let releaseProfile: () => void = () => { /* default home, or not held yet: nothing held */ }
  let child: ChildProcess
  // WP2: everything from here to the spawn is inside the try that fails the
  // agent: a throw anywhere (the prompt file, the account hold, the wait, the
  // spawn) must not leave the record "running" with no process -- it would
  // read as Claude Code in use and refuse a switch-off forever.
  try {
    fs.writeFileSync(tmpFile, params.description, 'utf8')
    // #48: the agent runs in the profile's credential home for as long as its
    // process lives, so the profile reads as in-use for exactly that long (the
    // usage refresh and the account delete defer to it). ACQUIRED FIRST: the hold
    // is what stops a new rotation from starting, and taking it before the wait
    // below closes the microtask between "the in-flight rotation settled" and
    // "we are registered" in which a fresh refresh could otherwise begin and
    // rotate the token this agent is about to read (adversarial pass on #598).
    // Released on 'close' and on 'error' -- one of which always fires for a
    // spawned child -- so the ref needs no leak clock; an agent that runs for an
    // hour is in use for an hour.
    if (resolvedProfileId) releaseProfile = acquireProfileConsumer(resolvedProfileId, { maxAgeMs: Infinity })
    // #49: if the usage page is rotating this profile's token right now, let
    // the new lineage land before the agent's claude reads the credential file.
    // The hold above means no OTHER rotation can begin while we wait.
    if (resolvedProfileId) await waitForProfileRefresh(resolvedProfileId)
    if (abandoned()) {
      releaseProfile()
      cleanupTmpFileFor(tmpFile)
      return abandon('the account refresh wait')
    }
    // WP2: the launch rule once more, right before the process starts, as
    // Insights asks before each step: Claude Code may have been switched off
    // while this dispatch waited (a counted agent refuses a switch-off in
    // Settings, but the saved setting can change or become unreadable). The
    // agent is then failed with the reason, and nothing runs.
    const refusedNow = providerLaunchRefusal('claude')
    if (refusedNow) {
      releaseProfile()
      cleanupTmpFileFor(tmpFile)
      return failBeforeSpawn(refusedNow.message)
    }
    child = spawn(shellCmd, [], {
      cwd: params.projectPath,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnvVars,
    })
  } catch (e) {
    // spawn() itself throws only synchronously (bad argv); a hold with no child
    // to release it would otherwise outlive the failure. The record must not
    // stay "running" either: it would read as Claude Code in use forever.
    releaseProfile()
    cleanupTmpFileFor(tmpFile)
    failBeforeSpawn(`The agent could not be started: ${(e as Error)?.message ?? String(e)}`)
    throw e
  }

  activeProcesses.set(agent.id, child)
  logInfo(`[cloud-agent] Dispatched agent ${agent.id} (${agent.name}) pid=${child.pid} profile=${resolvedProfileId ?? '(default/global)'} account=${accountEmail ?? '(none)'}`)
  logInfo(`[cloud-agent] Shell cmd: ${shellCmd}`)
  logInfo(`[cloud-agent] CWD: ${params.projectPath}, prompt length: ${params.description.length}`)

  const cleanupTmpFile = (): void => cleanupTmpFileFor(tmpFile)

  child.stdout?.on('data', (data: Buffer) => {
    const chunk = data.toString()
    logInfo(`[cloud-agent] ${agent.id} stdout: ${chunk.length} bytes`)
    const agentRef = agents.find(a => a.id === agent.id)
    if (agentRef) {
      appendCappedOutput(agentRef, chunk)
      broadcastOutputChunk(agent.id, chunk)
    }
  })

  child.stderr?.on('data', (data: Buffer) => {
    const chunk = data.toString()
    logInfo(`[cloud-agent] ${agent.id} stderr: ${chunk.length} bytes — ${chunk.slice(0, 200)}`)
    const agentRef = agents.find(a => a.id === agent.id)
    if (agentRef) {
      if (agentRef.output.length < MAX_OUTPUT_BYTES) {
        agentRef.output += chunk
      }
      broadcastOutputChunk(agent.id, chunk)
    }
  })

  child.on('close', (code) => {
    releaseProfile()
    cleanupTmpFile()
    activeProcesses.delete(agent.id)
    const agentRef = agents.find(a => a.id === agent.id)
    if (agentRef) {
      if (agentRef.status === 'cancelled') {
        // Already cancelled — keep cancelled status
      } else {
        agentRef.status = code === 0 ? 'completed' : 'failed'
        if (code !== 0) {
          agentRef.error = `Process exited with code ${code}`
        }
      }
      agentRef.updatedAt = Date.now()
      agentRef.duration = agentRef.updatedAt - agentRef.createdAt
      parseCostFromOutput(agentRef)
      persist()
      broadcastStatus(agentRef)
      logInfo(`[cloud-agent] Agent ${agentRef.id} finished: status=${agentRef.status} code=${code} output=${agentRef.output.length}b`)
    }
  })

  child.on('error', (err) => {
    releaseProfile()
    cleanupTmpFile()
    activeProcesses.delete(agent.id)
    const agentRef = agents.find(a => a.id === agent.id)
    if (agentRef) {
      agentRef.status = 'failed'
      agentRef.error = err.message
      agentRef.updatedAt = Date.now()
      agentRef.duration = agentRef.updatedAt - agentRef.createdAt
      persist()
      broadcastStatus(agentRef)
      logError(`[cloud-agent] Agent ${agentRef.id} error: ${err.message}`)
    }
  })

  return agent
}

/** Appends to an agent's kept output up to the cap, which the last append
 *  marks as cut. */
function appendCappedOutput(agentRef: CloudAgentData, chunk: string): void {
  if (agentRef.output.length >= MAX_OUTPUT_BYTES) return
  agentRef.output += chunk
  if (agentRef.output.length > MAX_OUTPUT_BYTES) {
    let cut = MAX_OUTPUT_BYTES
    // Don't end mid-surrogate-pair: a trailing lone high surrogate
    // renders as U+FFFD and is invalid JSON-string content for some
    // consumers.
    const c = agentRef.output.charCodeAt(cut - 1)
    if (c >= 0xd800 && c <= 0xdbff) cut--
    agentRef.output = agentRef.output.slice(0, cut) + OUTPUT_TRUNCATED_MARKER
  }
}

/** The account's name for the agent's card and the account filter: its
 *  provider label when that is an email, made prose-safe. Never throws. */
function backgroundAccountEmail(accountId: string): string | undefined {
  try {
    const snap = getAccountsService()?.snapshot()
    const label = snap?.accounts.find((a) => a.id === accountId)?.providerLabel?.trim()
    if (!label || !label.includes('@')) return undefined
    return stripSpoofableText(label, 254).trim() || undefined
  } catch {
    return undefined
  }
}

/** A project folder as a full path, never relative to wherever the app runs:
 *  on Windows a drive or a share; on POSIX, absolute. */
function isFullProjectPath(p: string): boolean {
  if (typeof p !== 'string' || !p || p.includes('\0')) return false
  return process.platform === 'win32' ? /^([A-Za-z]:[\\/]|[\\/]{2}[^\\/?.])/.test(p) : path.posix.isAbsolute(p)
}

/**
 * P4.5 (row 57): an agent of a provider other than Claude Code (Codex). The
 * same contract as a Claude agent -- refused while its provider is off,
 * counted as that provider in use from the dispatch on, the record kept with
 * the output, the per-run permission choice, Stop and Retry -- run as its
 * package's headless background run (ProviderPackage.background): one
 * process in a launch the accounts service prepared, kind `background`, on
 * the account named (else the provider default), which holds that account's
 * lease until the process and anything still being killed have ended. So the
 * account cannot be signed out, archived or switched off under the run, and
 * no usage read runs on it meanwhile. The project is the run's working
 * folder; nothing is written into the account's own settings.
 */
async function dispatchBackgroundAgent(providerId: ProviderId, params: DispatchAgentParams): Promise<CloudAgentData | ProviderLaunchRefused> {
  // Refused while the provider is off, before a record exists, an account is
  // chosen or anything runs. Answered, never thrown.
  const refused = providerLaunchRefusal(providerId)
  if (refused) return { refused }
  const endDispatch = beginDispatch(providerId)
  let agent: CloudAgentData
  try {
    agent = {
      id: generateId(),
      name: params.name,
      description: params.description,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectPath: params.projectPath,
      configId: params.configId,
      provider: providerId,
      ...(params.providerAccountId ? { providerAccountId: params.providerAccountId } : {}),
      ...(params.codexOptions ? { codexOptions: params.codexOptions } : {}),
      output: '',
    }
    agents.unshift(agent)
  } finally {
    endDispatch()
  }
  persist()
  broadcastStatus(agent)

  const abandoned = (): boolean => agent.status === 'cancelled' || !agents.includes(agent)
  const finishRecord = (status: 'failed' | 'cancelled', why?: string): CloudAgentData => {
    if (status === 'failed') {
      logInfo(`[cloud-agent] Agent ${agent.id} not started: ${why}`)
      agent.status = 'failed'
      agent.error = why
    } else {
      logInfo(`[cloud-agent] Agent ${agent.id} was cancelled while its launch was prepared; not starting`)
    }
    agent.updatedAt = Date.now()
    agent.duration = agent.updatedAt - agent.createdAt
    if (agents.includes(agent)) { persist(); broadcastStatus(agent) }
    return agent
  }

  if (!isFullProjectPath(params.projectPath)) return finishRecord('failed', 'The project folder must be a full path.')
  const svc = getAccountsService()
  const background = tryGetProviderPackage(providerId)?.background
  if (!background || typeof background.run !== 'function') {
    return finishRecord('failed', 'This agent could not start: this assistant does not run cloud agents in this version of the app.')
  }
  if (!svc || typeof svc.prepareLaunch !== 'function') {
    return finishRecord('failed', 'This agent could not start: accounts are not ready yet. Try again in a moment.')
  }
  const named = typeof params.providerAccountId === 'string' && params.providerAccountId ? params.providerAccountId : undefined
  let prepared: PreparedLaunchResult
  try {
    prepared = await svc.prepareLaunch({
      kind: 'background', providerId, ownerId: `cloud-agent:${agent.id}`, remote: false,
      ...(named ? { providerAccountId: named } : {}),
      // An acknowledgement counts only with the account it names.
      ...(named && params.acknowledgeRealmOnly === true ? { acknowledgeRealmOnly: true } : {}),
    })
  } catch {
    prepared = { ok: false, code: 'internal', message: 'The launch could not be prepared.' }
  }
  if (!prepared.ok) {
    if (abandoned()) return finishRecord('cancelled')
    return finishRecord('failed', `This agent could not start: ${prepared.message}`)
  }
  const launch = prepared
  const lease: AccountLease = launch.lease
  // In use through the lease from here (countCodexAgentsInUse), not twice.
  leasedAgents.add(agent.id)
  const letGo = (): void => {
    leasedAgents.delete(agent.id)
    try { lease.release() } catch { /* a release never throws the record away */ }
  }
  // Stamped with the account it actually runs on (the card, the filter, a
  // consistent Retry).
  agent.providerAccountId = launch.binding.providerAccountId
  const email = backgroundAccountEmail(launch.binding.providerAccountId)
  if (email) agent.accountEmail = email
  if (abandoned()) { letGo(); return finishRecord('cancelled') }
  // The launch rule once more, right before the process starts.
  const refusedNow = providerLaunchRefusal(providerId)
  if (refusedNow) { letGo(); return finishRecord('failed', refusedNow.message) }

  const controller = new AbortController()
  backgroundRuns.set(agent.id, controller)
  persist()
  broadcastStatus(agent)
  logInfo(`[cloud-agent] Dispatched ${providerId} agent ${agent.id} (${agent.name}) account=${agent.providerAccountId} permissions=${params.skipPermissions === true ? 'skip' : 'default'}`)
  logInfo(`[cloud-agent] CWD: ${params.projectPath}, prompt length: ${params.description.length}`)

  /** Text the run hands on, kept and streamed as a Claude agent's is. A
   *  reply, and diagnostics that follow a reply, start a paragraph of their
   *  own; diagnostics arriving in pieces are kept as they come. */
  let last: 'reply' | 'diagnostic' | null = null
  const take = (text: string, kind: 'reply' | 'diagnostic'): void => {
    const agentRef = agents.find((a) => a.id === agent.id)
    if (!agentRef || !text) return
    const out = agentRef.output
    const apart = !!out && (kind === 'reply' || last === 'reply') && !out.endsWith('\n\n')
    const chunk = apart ? `${out.endsWith('\n') ? '\n' : '\n\n'}${text}` : text
    last = kind
    appendCappedOutput(agentRef, chunk)
    broadcastOutputChunk(agent.id, chunk)
  }

  void (async () => {
    let killSettled: Promise<void> | undefined
    try {
      const r = await background.run({
        executable: launch.executable, env: launch.env, cwd: params.projectPath, prompt: params.description,
        skipPermissions: params.skipPermissions === true,
        ...(params.codexOptions?.model ? { model: params.codexOptions.model } : {}),
        ...(params.codexOptions?.reasoningEffort ? { effort: params.codexOptions.reasoningEffort } : {}),
        signal: controller.signal,
        onText: (t) => take(t, 'reply'),
        onDiagnostic: (t) => take(t, 'diagnostic'),
      })
      if (!r.ok && r.killSettled instanceof Promise) killSettled = r.killSettled
      const agentRef = agents.find((a) => a.id === agent.id)
      if (agentRef) {
        // A Stop that came after the CLI had exited on its own (the run's
        // settle window) does not make a finished run a cancelled one: the
        // run's own result stands.
        if (agentRef.status !== 'cancelled' || r.ok || r.code !== 'cancelled') {
          agentRef.status = r.ok ? 'completed' : r.code === 'cancelled' ? 'cancelled' : 'failed'
          if (!r.ok && r.code !== 'cancelled') agentRef.error = r.message
        }
        if (r.usage) agentRef.tokenUsage = { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens }
        if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)) agentRef.cost = r.costUsd
        agentRef.updatedAt = Date.now()
        agentRef.duration = agentRef.updatedAt - agentRef.createdAt
        persist()
        broadcastStatus(agentRef)
        logInfo(`[cloud-agent] Agent ${agentRef.id} finished: status=${agentRef.status} output=${agentRef.output.length}b`)
      }
    } catch (e) {
      const agentRef = agents.find((a) => a.id === agent.id)
      if (agentRef && agentRef.status !== 'cancelled') {
        agentRef.status = 'failed'
        agentRef.error = `The agent could not be run: ${(e as Error)?.message ?? String(e)}`
        agentRef.updatedAt = Date.now()
        agentRef.duration = agentRef.updatedAt - agentRef.createdAt
        persist()
        broadcastStatus(agentRef)
      }
    } finally {
      backgroundRuns.delete(agent.id)
      // The account is let go only once the process, and any kill still
      // under way, has ended.
      if (killSettled) void killSettled.then(letGo, letGo)
      else letGo()
    }
  })()

  return agent
}

function cleanupTmpFileFor(tmpFile: string): void {
  try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
}

function parseCostFromOutput(agent: CloudAgentData): void {
  // Best-effort parse cost and token usage from Claude CLI output
  try {
    const costMatch = agent.output.match(/\$(\d+\.?\d*)/g)
    if (costMatch && costMatch.length > 0) {
      const lastCost = parseFloat(costMatch[costMatch.length - 1].replace('$', ''))
      if (!isNaN(lastCost) && lastCost < 100) {
        agent.cost = lastCost
      }
    }

    const inputMatch = agent.output.match(/(\d[\d,]+)\s*input\s*tokens?/i)
    const outputMatch = agent.output.match(/(\d[\d,]+)\s*output\s*tokens?/i)
    if (inputMatch || outputMatch) {
      agent.tokenUsage = {
        inputTokens: inputMatch ? parseInt(inputMatch[1].replace(/,/g, '')) : 0,
        outputTokens: outputMatch ? parseInt(outputMatch[1].replace(/,/g, '')) : 0,
      }
    }
  } catch {
    // ignore parse errors
  }
}

export function cancelAgent(id: string): boolean {
  const agent = agents.find(a => a.id === id)
  if (!agent || (agent.status !== 'running' && agent.status !== 'pending')) return false

  const proc = activeProcesses.get(id)
  if (proc) {
    agent.status = 'cancelled'
    agent.updatedAt = Date.now()
    agent.duration = agent.updatedAt - agent.createdAt

    // On Windows taskkill /T ends the whole tree (a batch install's cmd.exe and
    // the CLI below it, and the CLI's own children); SIGTERM would end only the
    // first process.
    const treeEnded = process.platform === 'win32' && !!proc.pid && taskkillTree(proc.pid)
    if (!treeEnded) {
      proc.kill('SIGTERM')
      // Force kill after 5s if still alive
      setTimeout(() => {
        if (activeProcesses.has(id)) {
          try { proc.kill('SIGKILL') } catch {}
          activeProcesses.delete(id)
        }
      }, 5000)
    }

    persist()
    broadcastStatus(agent)
    return true
  }

  // P4.5: another provider's run is stopped through its runner, which ends
  // the whole tree below the CLI; the run's own end lets its account go.
  const run = backgroundRuns.get(id)
  if (run) {
    agent.status = 'cancelled'
    agent.updatedAt = Date.now()
    agent.duration = agent.updatedAt - agent.createdAt
    try { run.abort() } catch { /* the run settles on its own */ }
    persist()
    broadcastStatus(agent)
    return true
  }

  // No process but agent marked running — just mark cancelled
  agent.status = 'cancelled'
  agent.updatedAt = Date.now()
  persist()
  broadcastStatus(agent)
  return true
}

export function removeAgent(id: string): { ok: boolean; removed: boolean; error?: string } {
  const idx = agents.findIndex(a => a.id === id)
  if (idx < 0) return { ok: true, removed: false }

  // Cancel if running
  if (agents[idx].status === 'running') {
    cancelAgent(id)
  }

  const snapshot = agents
  agents = agents.filter(a => a.id !== id)
  // #371 BLOCKER-1: a refused write used to return true, so the row vanished
  // from the UI and came back on restart. Roll the in-memory list back so the
  // screen keeps matching the disk.
  if (!persist([id])) {
    agents = snapshot
    return { ok: false, removed: false, error: persistFailure() }
  }
  return { ok: true, removed: true }
}

/** A retry is a new run of the same task, on the same provider and account.
 *  The skip-permissions choice is per run and never kept, so a retry runs
 *  with the default. `acknowledgeRealmOnly`: this one retry may use the
 *  agent's unverified sign-in (asked again for every launch; never stored). */
export async function retryAgent(id: string, opts: { acknowledgeRealmOnly?: boolean } = {}): Promise<CloudAgentData | null | ProviderLaunchRefused> {
  const agent = agents.find(a => a.id === id)
  if (!agent) return null

  const provider = agentProvider(agent)
  if (provider !== 'claude') {
    return dispatchAgent({
      name: agent.name,
      description: agent.description,
      projectPath: agent.projectPath,
      configId: agent.configId,
      provider,
      ...(agent.providerAccountId ? { providerAccountId: agent.providerAccountId } : {}),
      ...(agent.providerAccountId && opts.acknowledgeRealmOnly === true ? { acknowledgeRealmOnly: true } : {}),
      ...(agent.codexOptions ? { codexOptions: agent.codexOptions } : {}),
    })
  }

  return dispatchAgent({
    name: agent.name,
    description: agent.description,
    projectPath: agent.projectPath,
    configId: agent.configId,
    profileId: agent.profileId,
    legacyVersion: agent.legacyVersion,
  })
}

export function listAgents(): CloudAgentData[] {
  return agents
}

export function getAgentOutput(id: string): string {
  const agent = agents.find(a => a.id === id)
  return agent?.output || ''
}

export function clearCompletedAgents(): { ok: boolean; removed: number; error?: string } {
  const snapshot = agents
  const clearedIds = agents.filter(a => a.status !== 'running' && a.status !== 'pending').map(a => a.id)
  if (clearedIds.length === 0) return { ok: true, removed: 0 }
  agents = agents.filter(a => a.status === 'running' || a.status === 'pending')
  if (!persist(clearedIds)) {
    agents = snapshot
    return { ok: false, removed: 0, error: persistFailure() }
  }
  return { ok: true, removed: clearedIds.length }
}

/** End a Windows process tree by pid with taskkill, started by its full path in
 *  the system folder. False when the system folder cannot be named (nothing
 *  was started; the caller signals the process itself). Never throws: a tree
 *  that already ended is not an error. */
function taskkillTree(pid: number): boolean {
  let taskkill: string
  try { taskkill = systemTool('taskkill.exe') } catch { return false }
  try {
    spawnSync(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' })
  } catch {
    // the process may have already exited
  }
  return true
}

export function killAllAgents(): void {
  for (const [id, proc] of activeProcesses) {
    try {
      const treeEnded = process.platform === 'win32' && !!proc.pid && taskkillTree(proc.pid)
      if (!treeEnded) proc.kill('SIGTERM')
    } catch {
      // ignore — process may have already exited
    }
    activeProcesses.delete(id)
  }
  stopBackgroundAgentRuns()
}

/** P4.5: stops every running agent of another provider through its runner,
 *  which ends the tree below the CLI. At quit main calls this BEFORE it
 *  flushes the runner's kills still reading a process table
 *  (flushPendingProviderCliKills), so the flush ends these runs' whole
 *  trees too, as killAllAgents ends a Claude agent's. Idempotent. */
export function stopBackgroundAgentRuns(): void {
  for (const run of backgroundRuns.values()) {
    try { run.abort() } catch { /* ignore */ }
  }
}
