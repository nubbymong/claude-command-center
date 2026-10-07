import { create } from 'zustand'
import type { CloudAgent, CloudAgentStatus } from '../types/electron'
import type { CloudAgentDispatchParams } from '../../shared/types'
import { CLAUDE_OFF, isClaudeOff } from '../lib/claudeOff'
import { codexPreference, type ProviderChoiceView } from '../onboarding/provider-choice'
import { useSettingsStore } from './settingsStore'
import { useLaunchAckStore } from './launchAckStore'
import { launchRefusalOf, providerNotSetUpMessage, providerOffMessage } from '../../shared/providers'
import type { ProviderId } from '../../shared/providers'

type FilterType = 'all' | 'running' | 'completed' | 'failed'

// WP2 PR 4, P4.5 (row 57): a cloud agent runs on Claude Code or on Codex.
// Each is refused while its own provider is off, and only by its own
// provider's switch.

/** The provider an agent runs on: absent on every agent saved before PR 4,
 *  all of which ran Claude Code. Any other value is returned as it is: main
 *  starts no agent of a provider it has no package for (the record fails),
 *  and agentLaunchBlockedReason gates anything but Codex by Claude Code's
 *  switch. */
export function agentProviderOf(agent: Pick<CloudAgent, 'provider'> | null | undefined): ProviderId {
  return agent?.provider ?? 'claude'
}

/** Main's own sentences for a Codex agent that cannot start (launch-refusal.ts). */
export const CODEX_AGENT_OFF = providerOffMessage('Codex')
export const CODEX_AGENT_NOT_SET_UP = providerNotSetUpMessage('Codex')

/** The New agent dialog's per-run choice for a Codex agent: it runs as
 *  Codex's Auto preset (section 10, question 7, built as its default A). */
export const CODEX_AUTO_LABEL = 'Auto: workspace writes, no prompts, for this run'
/** Shown with that choice on Windows (the Feature Guide's known issue). */
export const CODEX_AGENT_WINDOWS_NOTE = 'On Windows, Codex makes no edits until its sandbox is set up for this Codex account, and with the non-admin sandbox its commands fail (PowerShell does not start there).'
/** Dispatch waits for the per-run confirmation of an unverified sign-in. */
export const CONFIRM_SIGN_IN = 'Confirm the sign-in for this run to continue.'

/** Why an agent of this provider cannot start now (its provider is off or,
 *  for Codex, not set up), in main's words; null when it can. */
export function agentLaunchBlockedReason(provider: ProviderId, settings: ProviderChoiceView = useSettingsStore.getState().settings): string | null {
  if (provider === 'codex') {
    const pref = codexPreference(settings)
    return pref === 'on' ? null : pref === 'off' ? CODEX_AGENT_OFF : CODEX_AGENT_NOT_SET_UP
  }
  return isClaudeOff(settings) ? CLAUDE_OFF : null
}

/** A retry of an agent whose account needs each launch confirmed (the Codex
 *  sign-in already on this computer, or an unverified one) asks first, with
 *  the same confirm a restarted session gets; nothing stores the answer.
 *  'go': nothing to ask; 'ack': confirmed for this one retry; 'cancel'. */
async function confirmRetrySignIn(agent: CloudAgent, provider: ProviderId): Promise<'go' | 'ack' | 'cancel'> {
  if (!agent.providerAccountId) return 'go'
  const { accountsSnapshotWhenLoaded, resolveLaunchAccount, launchStep } = await import('../utils/launchAccount')
  const snapshot = await accountsSnapshotWhenLoaded()
  const step = launchStep(snapshot, resolveLaunchAccount(snapshot, provider, agent.providerAccountId), false)
  if (step.kind === 'spawn') return 'go'
  const yes = await useLaunchAckStore.getState().request({
    sessionId: `cloud-agent:${agent.id}`,
    sessionLabel: agent.name,
    accountName: step.question.accountName,
    ...(step.question.email ? { email: step.question.email } : {}),
    external: step.question.external,
    unknown: step.question.unknown,
    retryAgent: true,
  })
  return yes ? 'ack' : 'cancel'
}

/**
 * Outcome of a persisting mutation. `ok:false` means main REFUSED or FAILED the
 * disk write (#371 BLOCKER-1) — the agent is still on disk, so the row must
 * stay on screen rather than vanish and reappear on the next restart.
 */
export interface CloudAgentMutationResult {
  ok: boolean
  error?: string
}

interface CloudAgentState {
  agents: CloudAgent[]
  selectedAgentId: string | null
  filter: FilterType
  searchQuery: string
  accountFilter: string
  /** Why the last remove / clear-completed did not land. */
  error: string | null

  hydrate: (agents: CloudAgent[]) => void
  dispatch: (params: CloudAgentDispatchParams) => Promise<void>
  cancel: (id: string) => Promise<void>
  remove: (id: string) => Promise<CloudAgentMutationResult>
  retry: (id: string) => Promise<void>
  clearCompleted: () => Promise<CloudAgentMutationResult>
  clearError: () => void
  selectAgent: (id: string | null) => void
  setFilter: (filter: FilterType) => void
  setSearchQuery: (query: string) => void
  setAccountFilter: (email: string) => void

  handleStatusChanged: (agent: CloudAgent) => void
  handleOutputChunk: (data: { id: string; chunk: string }) => void

  getFilteredAgents: () => CloudAgent[]
  getCounts: () => { all: number; running: number; completed: number; failed: number }
}

// Cap the renderer's in-memory copy of an agent's streamed output. We keep the
// TAIL (the most recent bytes — the tail of a `claude -p` stream carries the
// result + cost summary that matters) with a leading marker. Mirrors the main
// process's 500KB cap (cloud-agent-manager.ts MAX_OUTPUT_BYTES) so neither side
// grows unbounded.
//
// The renderer persists NOTHING for cloudAgents. Main owns cloud-agents.json
// outright: it persist()s on every mutation (dispatch/completion/error/cancel/
// remove/clearCompleted) with its capped output, and every renderer mutation
// goes through main IPC first. The old renderer save (output stripped to '')
// raced main's write on the SAME file and, when it landed last, erased the
// persisted output of every completed agent (review finding on 8389ed9).
const MAX_OUTPUT_BYTES = 512 * 1024 // 500KB
const OUTPUT_TRUNCATED_MARKER = '[earlier output truncated — exceeded 500KB]\n\n'

function capOutputTail(output: string): string {
  if (output.length <= MAX_OUTPUT_BYTES) return output
  let start = output.length - MAX_OUTPUT_BYTES
  // Don't start mid-surrogate-pair: rendering a lone low surrogate draws U+FFFD.
  const c = output.charCodeAt(start)
  if (c >= 0xdc00 && c <= 0xdfff) start++
  return OUTPUT_TRUNCATED_MARKER + output.slice(start)
}

export const useCloudAgentStore = create<CloudAgentState>((set, get) => ({
  agents: [],
  selectedAgentId: null,
  filter: 'all',
  searchQuery: '',
  accountFilter: 'all',
  error: null,

  hydrate: (agents: CloudAgent[]) => {
    set({ agents: agents || [] })
  },

  dispatch: async (params) => {
    // The backstop behind every way in: a cloud agent is a headless run of
    // its provider (Claude Code unless it says otherwise), and none starts
    // while that provider is switched off. The page's banner (this store's
    // `error`) says why.
    const blocked = agentLaunchBlockedReason(agentProviderOf(params))
    if (blocked) { set({ error: blocked }); return }
    try {
      const agent = await window.electronAPI.cloudAgent.dispatch(params)
      // Main refuses on its own while the provider is off (a switch flipped
      // since this page last read the setting): the banner says why.
      const refusal = launchRefusalOf(agent)
      if (refusal) { set({ error: refusal.message }); return }
      if (agent && typeof agent === 'object' && 'rejected' in agent) { set({ error: agent.rejected }); return }
      if (!agent || !('id' in agent)) return
      // Don't add agent here — handleStatusChanged listener already added it
      // from the broadcastStatus() call in the main process. Just select it.
      set({ selectedAgentId: agent.id })
    } catch (err: any) {
      console.error('[cloudAgentStore] dispatch failed:', err)
    }
  },

  cancel: async (id: string) => {
    await window.electronAPI.cloudAgent.cancel(id)
  },

  // #371 BLOCKER-1. This still writes NOTHING itself (see the note above) — it
  // only reads main's answer. `ok:false` means main rolled its own list back and
  // the agent is still in cloud-agents.json, so filtering it out here would show
  // a removal that did not happen and un-remove itself on the next restart.
  remove: async (id: string) => {
    set({ error: null })
    const result = await window.electronAPI.cloudAgent.remove(id)
    if (!result.ok) {
      const error = result.error || 'This agent could not be removed from disk.'
      set({ error })
      return { ok: false, error }
    }
    set(state => {
      const agents = state.agents.filter(a => a.id !== id)
      const selectedAgentId = state.selectedAgentId === id ? null : state.selectedAgentId
      return { agents, selectedAgentId }
    })
    return { ok: true }
  },

  retry: async (id: string) => {
    // A retry is a new run on the agent's own provider: the same backstop as
    // dispatch.
    const agent = get().agents.find((a) => a.id === id)
    const provider = agentProviderOf(agent)
    const blocked = agentLaunchBlockedReason(provider)
    if (blocked) { set({ error: blocked }); return }
    let ack = false
    if (provider !== 'claude' && agent) {
      const answer = await confirmRetrySignIn(agent, provider)
      if (answer === 'cancel') return
      ack = answer === 'ack'
    }
    const newAgent = ack
      ? await window.electronAPI.cloudAgent.retry(id, { acknowledgeRealmOnly: true })
      : await window.electronAPI.cloudAgent.retry(id)
    const refusal = launchRefusalOf(newAgent)
    if (refusal) { set({ error: refusal.message }); return }
    if (newAgent && typeof newAgent === 'object' && 'rejected' in newAgent) { set({ error: newAgent.rejected }); return }
    if (newAgent && 'id' in newAgent) {
      // Don't add — handleStatusChanged listener already added it from broadcast
      set({ selectedAgentId: newAgent.id })
    }
  },

  clearCompleted: async () => {
    set({ error: null })
    const result = await window.electronAPI.cloudAgent.clearCompleted()
    if (!result.ok) {
      const error = result.error || 'The finished agents could not be cleared from disk.'
      set({ error })
      return { ok: false, error }
    }
    set(state => {
      const agents = state.agents.filter(a => a.status === 'running' || a.status === 'pending')
      const selectedAgentId = agents.find(a => a.id === state.selectedAgentId)
        ? state.selectedAgentId
        : null
      return { agents, selectedAgentId }
    })
    return { ok: true }
  },

  clearError: () => set({ error: null }),

  selectAgent: (id: string | null) => set({ selectedAgentId: id }),
  setFilter: (filter: FilterType) => set({ filter }),
  setSearchQuery: (query: string) => set({ searchQuery: query }),
  setAccountFilter: (email: string) => set({ accountFilter: email }),

  handleStatusChanged: (agent: CloudAgent) => {
    set(state => {
      const agents = [...state.agents]
      const idx = agents.findIndex(a => a.id === agent.id)
      if (idx >= 0) {
        agents[idx] = { ...agents[idx], ...agent }
      } else {
        agents.unshift(agent)
      }
      return { agents }
    })
  },

  handleOutputChunk: (data: { id: string; chunk: string }) => {
    set(state => {
      const agents = [...state.agents]
      const idx = agents.findIndex(a => a.id === data.id)
      if (idx >= 0) {
        agents[idx] = { ...agents[idx], output: capOutputTail(agents[idx].output + data.chunk) }
        return { agents }
      }
      return state
    })
  },

  getFilteredAgents: () => {
    const { agents, filter, searchQuery, accountFilter } = get()
    let filtered = agents

    if (filter === 'running') {
      filtered = filtered.filter(a => a.status === 'running' || a.status === 'pending')
    } else if (filter === 'completed') {
      filtered = filtered.filter(a => a.status === 'completed')
    } else if (filter === 'failed') {
      filtered = filtered.filter(a => a.status === 'failed' || a.status === 'cancelled')
    }

    if (accountFilter !== 'all') {
      filtered = filtered.filter(a => a.accountEmail === accountFilter)
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      filtered = filtered.filter(a =>
        a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)
      )
    }

    // Sort: running first, then by newest
    return filtered.sort((a, b) => {
      const aRunning = a.status === 'running' || a.status === 'pending' ? 1 : 0
      const bRunning = b.status === 'running' || b.status === 'pending' ? 1 : 0
      if (aRunning !== bRunning) return bRunning - aRunning
      return b.createdAt - a.createdAt
    })
  },

  getCounts: () => {
    const { agents } = get()
    return {
      all: agents.length,
      running: agents.filter(a => a.status === 'running' || a.status === 'pending').length,
      completed: agents.filter(a => a.status === 'completed').length,
      failed: agents.filter(a => a.status === 'failed' || a.status === 'cancelled').length,
    }
  },
}))

// Set up IPC listeners once globally — never tear down.
// Previously tied to CloudAgentsPage mount/unmount, which meant status updates
// were missed while the user was on a different page.
let listenerSetup = false
export function setupCloudAgentListener(): void {
  if (listenerSetup) return
  listenerSetup = true

  window.electronAPI.cloudAgent.onStatusChanged((agent) => {
    useCloudAgentStore.getState().handleStatusChanged(agent)
  })

  window.electronAPI.cloudAgent.onOutputChunk((data) => {
    useCloudAgentStore.getState().handleOutputChunk(data)
  })
}
