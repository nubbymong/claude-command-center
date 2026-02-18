/**
 * Cloud Agent Manager — spawn/track/cancel headless Claude CLI background agents
 */

import { spawn, execSync, ChildProcess } from 'child_process'
import { BrowserWindow } from 'electron'
import { readConfig, writeConfig } from './config-manager'
import { logInfo, logError } from './debug-logger'
import { resolveVersionBinary, isVersionInstalled, installVersion } from './legacy-version-manager'

export interface CloudAgentData {
  id: string
  name: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  createdAt: number
  updatedAt: number
  projectPath: string
  configId?: string
  output: string
  cost?: number
  duration?: number
  tokenUsage?: { inputTokens: number; outputTokens: number }
  error?: string
  legacyVersion?: { enabled: boolean; version: string }
}

const MAX_OUTPUT_BYTES = 512 * 1024 // 500KB cap per agent

const activeProcesses = new Map<string, ChildProcess>()
let agents: CloudAgentData[] = []
let getWindow: () => BrowserWindow | null = () => null

function generateId(): string {
  return 'ca-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function persist(): void {
  writeConfig('cloudAgents', agents)
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
  // Load persisted agents
  const saved = readConfig<CloudAgentData[]>('cloudAgents')
  agents = saved || []
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
  legacyVersion?: { enabled: boolean; version: string }
}): Promise<CloudAgentData> {
  const agent: CloudAgentData = {
    id: generateId(),
    name: params.name,
    description: params.description,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    projectPath: params.projectPath,
    configId: params.configId,
    output: '',
    legacyVersion: params.legacyVersion,
  }

  agents.unshift(agent)
  persist()
  broadcastStatus(agent)

  // Resolve Claude binary (use legacy version if configured)
  let claudeBin = 'claude'
  if (params.legacyVersion?.enabled && params.legacyVersion.version) {
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

  // Spawn the headless Claude process
  // Pipe prompt via stdin instead of -p arg to avoid shell quoting issues on Windows
  const child = spawn(claudeBin, ['--dangerously-skip-permissions'], {
    cwd: params.projectPath,
    shell: true,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Write prompt to stdin — Claude CLI auto-detects piped input as print mode
  child.stdin?.write(params.description)
  child.stdin?.end()

  activeProcesses.set(agent.id, child)
  logInfo(`[cloud-agent] Dispatched agent ${agent.id} (${agent.name}) pid=${child.pid}`)

  child.stdout?.on('data', (data: Buffer) => {
    const chunk = data.toString()
    const agentRef = agents.find(a => a.id === agent.id)
    if (agentRef) {
      if (agentRef.output.length < MAX_OUTPUT_BYTES) {
        agentRef.output += chunk
        if (agentRef.output.length > MAX_OUTPUT_BYTES) {
          agentRef.output = agentRef.output.slice(0, MAX_OUTPUT_BYTES) + '\n\n[output truncated — exceeded 500KB]'
        }
      }
      broadcastOutputChunk(agent.id, chunk)
    }
  })

  child.stderr?.on('data', (data: Buffer) => {
    const chunk = data.toString()
    const agentRef = agents.find(a => a.id === agent.id)
    if (agentRef) {
      if (agentRef.output.length < MAX_OUTPUT_BYTES) {
        agentRef.output += chunk
      }
      broadcastOutputChunk(agent.id, chunk)
    }
  })

  child.on('close', (code) => {
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
      logInfo(`[cloud-agent] Agent ${agentRef.id} finished: status=${agentRef.status} code=${code}`)
    }
  })

  child.on('error', (err) => {
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

export function removeAgent(id: string): boolean {
  const idx = agents.findIndex(a => a.id === id)
  if (idx < 0) return false

  // Cancel if running
  if (agents[idx].status === 'running') {
    cancelAgent(id)
  }

  agents.splice(idx, 1)
  persist()
  return true
}

export async function retryAgent(id: string): Promise<CloudAgentData | null> {
  const agent = agents.find(a => a.id === id)
  if (!agent) return null

  return dispatchAgent({
    name: agent.name,
    description: agent.description,
    projectPath: agent.projectPath,
    configId: agent.configId,
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

export function clearCompletedAgents(): number {
  const before = agents.length
  agents = agents.filter(a => a.status === 'running' || a.status === 'pending')
  const removed = before - agents.length
  if (removed > 0) persist()
  return removed
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
