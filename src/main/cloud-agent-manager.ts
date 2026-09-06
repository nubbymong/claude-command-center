/**
 * Cloud Agent Manager — spawn/track/cancel headless Claude CLI background agents
 */

import { spawn, execSync, ChildProcess } from 'child_process'
import { BrowserWindow } from 'electron'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { createReadFailureLatch, loadConfigLatched, saveConfigLatched, mergeById } from './persist-latch'
import { logInfo, logWarn, logError } from './debug-logger'
import { resolveVersionBinary, isVersionInstalled, installVersion } from './legacy-version-manager'
import { isValidLegacyVersion } from '../shared/legacy-version'
import { getProfileConfigDir, getPrimaryProfileId, setupProfileLinks, listProfiles, isValidProfileId } from './account-profiles'
import { withProfileHome } from './pty-manager'
import { acquireProfileConsumer, waitForProfileRefresh } from './profile-consumers'
import { randomId } from '../shared/id'

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
function resolveAgentEnv(profileId: string | undefined): {
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
  return { env: withProfileHome(baseEnv, home), resolvedProfileId, accountEmail }
}

const MAX_OUTPUT_BYTES = 512 * 1024 // 500KB cap per agent

const activeProcesses = new Map<string, ChildProcess>()
let agents: CloudAgentData[] = []
let getWindow: () => BrowserWindow | null = () => null

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

export async function dispatchAgent(params: {
  name: string
  description: string
  projectPath: string
  configId?: string
  profileId?: string
  legacyVersion?: { enabled: boolean; version: string }
  // Per-run, ephemeral opt-in to --dangerously-skip-permissions. Default OFF.
  skipPermissions?: boolean
}): Promise<CloudAgentData> {
  // Resolve the per-account isolated environment up front so the agent record
  // is stamped with the account it actually ran under (drives the card label,
  // the account filter, and a consistent retry).
  const { env: spawnEnvVars, resolvedProfileId, accountEmail } = resolveAgentEnv(params.profileId)

  const agent: CloudAgentData = {
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
    output: '',
    legacyVersion: params.legacyVersion,
  }

  agents.unshift(agent)
  persist()
  broadcastStatus(agent)

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
        const result = await installVersion(params.legacyVersion.version)
        if (!result.ok) {
          logInfo(`[cloud-agent] Legacy install failed, using system claude: ${result.error}`)
        }
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
  fs.writeFileSync(tmpFile, params.description, 'utf8')

  // P1.3 / FEAT-1: cloud-agent dispatch never reads a persisted skip-permissions
  // setting (the legacy global `skipPermissionsForAgents` was removed in Unit 3;
  // Insights no longer skips either). The dangerous skip is an explicit,
  // ephemeral PER-RUN opt-in from the New Agent dialog: default OFF.
  const skipPerms = params.skipPermissions === true

  const pipeCmd = process.platform === 'win32' ? 'type' : 'cat'
  const permFlag = skipPerms ? ' --dangerously-skip-permissions' : ''
  const shellCmd = `${pipeCmd} "${tmpFile}" | ${claudeBin}${permFlag}`

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
  const releaseProfile = resolvedProfileId ? acquireProfileConsumer(resolvedProfileId, { maxAgeMs: Infinity }) : () => { /* default home: nothing held */ }
  let child: ChildProcess
  try {
    // #49: if the usage page is rotating this profile's token right now, let
    // the new lineage land before the agent's claude reads the credential file.
    // The hold above means no OTHER rotation can begin while we wait.
    if (resolvedProfileId) await waitForProfileRefresh(resolvedProfileId)
    child = spawn(shellCmd, [], {
      cwd: params.projectPath,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnvVars,
    })
  } catch (e) {
    // spawn() itself throws only synchronously (bad argv); a hold with no child
    // to release it would otherwise outlive the failure.
    releaseProfile()
    cleanupTmpFileFor(tmpFile)
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
      if (agentRef.output.length < MAX_OUTPUT_BYTES) {
        agentRef.output += chunk
        if (agentRef.output.length > MAX_OUTPUT_BYTES) {
          let cut = MAX_OUTPUT_BYTES
          // Don't end mid-surrogate-pair: a trailing lone high surrogate
          // renders as U+FFFD and is invalid JSON-string content for some
          // consumers.
          const c = agentRef.output.charCodeAt(cut - 1)
          if (c >= 0xd800 && c <= 0xdbff) cut--
          agentRef.output = agentRef.output.slice(0, cut) + '\n\n[output truncated — exceeded 500KB]'
        }
      }
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

    // On Windows, shell:true processes need taskkill /T to kill the entire process tree
    // SIGTERM only kills the shell wrapper, not the child claude process
    if (process.platform === 'win32' && proc.pid) {
      try {
        execSync(`taskkill /pid ${proc.pid} /T /F`, { windowsHide: true, timeout: 5000 })
      } catch {
        // Process may have already exited
      }
    } else {
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

export async function retryAgent(id: string): Promise<CloudAgentData | null> {
  const agent = agents.find(a => a.id === id)
  if (!agent) return null

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

export function killAllAgents(): void {
  for (const [id, proc] of activeProcesses) {
    try {
      if (process.platform === 'win32' && proc.pid) {
        execSync(`taskkill /pid ${proc.pid} /T /F`, { windowsHide: true, timeout: 5000 })
      } else {
        proc.kill('SIGTERM')
      }
    } catch {
      // ignore — process may have already exited
    }
    activeProcesses.delete(id)
  }
}
