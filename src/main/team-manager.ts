/**
 * Team Manager — pipeline orchestration for agent teams.
 * Executes multi-step agent pipelines with sequential/parallel batching
 * and automatic output forwarding between steps.
 */

import { BrowserWindow } from 'electron'
import { readConfig, writeConfig } from './config-manager'
import { dispatchAgent, cancelAgent, getAgentOutput, onAgentCompletion, CloudAgentData } from './cloud-agent-manager'
import { logInfo, logError } from './debug-logger'
import type { TeamTemplate, TeamRun, TeamRunStep, TeamRunStatus, TeamStep } from '../shared/types'
import { IPC } from '../shared/ipc-channels'

const MAX_CONTEXT_BYTES = 50 * 1024 // 50KB per prior step output

let teams: TeamTemplate[] = []
let runs: TeamRun[] = []
let getWindow: () => BrowserWindow | null = () => null

// Map from agentId → teamRunId for tracking active agents
const agentToRun = new Map<string, string>()

function generateTeamId(): string {
  return 'team-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function generateRunId(): string {
  return 'tr-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function persistTeams(): void {
  writeConfig('agentTeams', teams)
}

function persistRuns(): void {
  writeConfig('agentTeamRuns', runs)
}

function broadcastRunStatus(run: TeamRun): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.TEAM_RUN_STATUS_CHANGED, run)
  }
}

export function initTeamManager(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  teams = readConfig<TeamTemplate[]>('agentTeams') || []
  runs = readConfig<TeamRun[]>('agentTeamRuns') || []

  // Clean up stuck runs from previous app session
  let changed = false
  for (const run of runs) {
    if (run.status === 'running' || run.status === 'pending') {
      run.status = 'failed'
      run.error = 'Run was interrupted (app restart)'
      run.updatedAt = Date.now()
      for (const step of run.steps) {
        if (step.status === 'running' || step.status === 'pending') {
          step.status = 'failed'
        }
      }
      changed = true
    }
  }
  if (changed) persistRuns()

  // Listen for agent completions
  onAgentCompletion(handleAgentCompletion)
  logInfo(`[team-manager] Initialized: ${teams.length} teams, ${runs.length} runs`)
}

// ── CRUD ──

export function listTeams(): TeamTemplate[] {
  return teams
}

export function saveTeam(team: TeamTemplate): TeamTemplate {
  const idx = teams.findIndex(t => t.id === team.id)
  if (idx >= 0) {
    teams[idx] = { ...team, updatedAt: Date.now() }
  } else {
    team.id = team.id || generateTeamId()
    team.createdAt = team.createdAt || Date.now()
    team.updatedAt = Date.now()
    teams.unshift(team)
  }
  persistTeams()
  return idx >= 0 ? teams[idx] : team
}

export function deleteTeam(id: string): boolean {
  const idx = teams.findIndex(t => t.id === id)
  if (idx < 0) return false
  teams.splice(idx, 1)
  persistTeams()
  return true
}

export function listRuns(): TeamRun[] {
  return runs
}

// ── Execution ──

/**
 * Group consecutive steps into batches:
 * - Each sequential step forms its own single-step batch.
 * - Consecutive parallel steps are grouped into one batch.
 */
function buildBatches(steps: TeamStep[]): TeamStep[][] {
  const batches: TeamStep[][] = []
  let currentParallelBatch: TeamStep[] = []

  for (const step of steps) {
    if (step.mode === 'parallel') {
      currentParallelBatch.push(step)
    } else {
      // Flush any accumulated parallel batch
      if (currentParallelBatch.length > 0) {
        batches.push(currentParallelBatch)
        currentParallelBatch = []
      }
      batches.push([step])
    }
  }
  // Flush remaining parallel steps
  if (currentParallelBatch.length > 0) {
    batches.push(currentParallelBatch)
  }
  return batches
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_CONTEXT_BYTES) return output
  return output.slice(0, MAX_CONTEXT_BYTES) + '\n\n[...truncated to 50KB]'
}

function buildContextPrefix(run: TeamRun): string {
  const completedSteps = run.steps.filter(s => s.status === 'completed' && s.agentId)
  if (completedSteps.length === 0) return ''

  let context = '## Context from previous pipeline steps\n\n'
  for (const step of completedSteps) {
    const output = getAgentOutput(step.agentId!)
    if (output) {
      context += `### ${step.label}\n\n${truncateOutput(output)}\n\n---\n\n`
    }
  }
  return context
}

export async function runTeam(teamId: string, projectPathOverride?: string): Promise<TeamRun | null> {
  const team = teams.find(t => t.id === teamId)
  if (!team || team.steps.length === 0) return null

  const run: TeamRun = {
    id: generateRunId(),
    teamId: team.id,
    teamName: team.name,
    status: 'running',
    steps: team.steps.map(s => ({
      stepId: s.id,
      agentId: null,
      status: 'pending' as TeamRunStatus,
      label: s.label,
    })),
    projectPath: projectPathOverride || team.projectPath,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  runs.unshift(run)
  persistRuns()
  broadcastRunStatus(run)

  // Execute batches asynchronously
  executePipeline(run, team).catch(err => {
    logError(`[team-manager] Pipeline error for run ${run.id}: ${err}`)
    run.status = 'failed'
    run.error = String(err)
    run.updatedAt = Date.now()
    persistRuns()
    broadcastRunStatus(run)
  })

  return run
}

async function executePipeline(run: TeamRun, team: TeamTemplate): Promise<void> {
  const batches = buildBatches(team.steps)

  for (const batch of batches) {
    // Check if run was cancelled
    if (run.status === 'cancelled') return

    const contextPrefix = buildContextPrefix(run)

    // Dispatch all agents in this batch
    const dispatched: Array<{ stepId: string; agentId: string }> = []

    for (const step of batch) {
      const runStep = run.steps.find(s => s.stepId === step.id)
      if (!runStep) continue

      const prompt = (contextPrefix ? contextPrefix + '\n\n' : '') + (step.promptOverride || step.label)

      try {
        runStep.status = 'running'
        runStep.startedAt = Date.now()
        run.updatedAt = Date.now()
        persistRuns()
        broadcastRunStatus(run)

        const agent = await dispatchAgent({
          name: `[Team] ${step.label}`,
          description: prompt,
          projectPath: run.projectPath,
        })

        runStep.agentId = agent.id
        agentToRun.set(agent.id, run.id)
        dispatched.push({ stepId: step.id, agentId: agent.id })
        persistRuns()
        broadcastRunStatus(run)
      } catch (err) {
        runStep.status = 'failed'
        runStep.completedAt = Date.now()
        run.status = 'failed'
        run.error = `Step "${step.label}" failed to dispatch: ${err}`
        run.updatedAt = Date.now()
        persistRuns()
        broadcastRunStatus(run)
        return
      }
    }

    // Wait for all agents in this batch to complete
    await waitForBatch(run, dispatched.map(d => d.stepId))

    // Check if any step failed — abort the pipeline
    const batchSteps = run.steps.filter(s => dispatched.some(d => d.stepId === s.stepId))
    const anyFailed = batchSteps.some(s => s.status === 'failed' || s.status === 'cancelled')
    if (anyFailed) {
      run.status = 'failed'
      run.error = 'A step in the pipeline failed'
      run.updatedAt = Date.now()
      run.duration = Date.now() - run.createdAt
      persistRuns()
      broadcastRunStatus(run)
      return
    }
  }

  // All batches complete
  if (run.status === 'running') {
    run.status = 'completed'
    run.updatedAt = Date.now()
    run.duration = Date.now() - run.createdAt
    persistRuns()
    broadcastRunStatus(run)
    logInfo(`[team-manager] Team run ${run.id} completed in ${run.duration}ms`)
  }
}

function waitForBatch(run: TeamRun, stepIds: string[]): Promise<void> {
  return new Promise<void>(resolve => {
    const check = () => {
      const steps = run.steps.filter(s => stepIds.includes(s.stepId))
      const allDone = steps.every(s =>
        s.status === 'completed' || s.status === 'failed' || s.status === 'cancelled'
      )
      if (allDone || run.status === 'cancelled') resolve()
    }

    // Check immediately in case already done
    check()

    // Poll periodically (agent completion callback also triggers state updates)
    const interval = setInterval(() => {
      check()
      if (run.status !== 'running') {
        clearInterval(interval)
        resolve()
      }
    }, 500)

    // Also check on state (the interval handles it, but this is a safety net)
    const timeout = setTimeout(() => {
      clearInterval(interval)
      resolve()
    }, 30 * 60 * 1000) // 30min safety timeout

    // Store cleanup in a way check() can clear
    const origCheck = check
    const wrappedCheck = () => {
      origCheck()
      const steps = run.steps.filter(s => stepIds.includes(s.stepId))
      const allDone = steps.every(s =>
        s.status === 'completed' || s.status === 'failed' || s.status === 'cancelled'
      )
      if (allDone || run.status !== 'running') {
        clearInterval(interval)
        clearTimeout(timeout)
      }
    }
    // Replace the interval check
    clearInterval(interval)
    const newInterval = setInterval(wrappedCheck, 500)
    // Final safety
    setTimeout(() => clearInterval(newInterval), 30 * 60 * 1000)
  })
}

function handleAgentCompletion(agent: CloudAgentData): void {
  const runId = agentToRun.get(agent.id)
  if (!runId) return

  const run = runs.find(r => r.id === runId)
  if (!run) {
    agentToRun.delete(agent.id)
    return
  }

  const step = run.steps.find(s => s.agentId === agent.id)
  if (!step) return

  step.status = agent.status === 'completed' ? 'completed'
    : agent.status === 'cancelled' ? 'cancelled' : 'failed'
  step.completedAt = Date.now()
  run.updatedAt = Date.now()

  agentToRun.delete(agent.id)
  persistRuns()
  broadcastRunStatus(run)

  logInfo(`[team-manager] Step "${step.label}" in run ${run.id} → ${step.status}`)
}

export function cancelRun(runId: string): boolean {
  const run = runs.find(r => r.id === runId)
  if (!run || run.status !== 'running') return false

  run.status = 'cancelled'
  run.updatedAt = Date.now()
  run.duration = Date.now() - run.createdAt

  // Cancel all running/pending agent steps
  for (const step of run.steps) {
    if ((step.status === 'running' || step.status === 'pending') && step.agentId) {
      cancelAgent(step.agentId)
      step.status = 'cancelled'
      step.completedAt = Date.now()
      agentToRun.delete(step.agentId)
    } else if (step.status === 'pending') {
      step.status = 'cancelled'
    }
  }

  persistRuns()
  broadcastRunStatus(run)
  logInfo(`[team-manager] Run ${runId} cancelled`)
  return true
}
