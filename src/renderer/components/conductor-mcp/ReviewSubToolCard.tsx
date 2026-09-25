// The Conductor MCP page's two review cards (WP2 final fixes). Each says
// whether main offers its tool right now, by the conditions main asks for
// every connection (conductor-mcp-server createServer, offeredReviewTool):
// the built-in tools on, the tool's own switch on, and a review that could
// be prepared now -- the reviewing provider on and an account that can run
// the review, which the Accounts snapshot carries as providers[].review.ready.
// Settings, General, Built-in Tools asks the same through reviewToolView, so
// the card and the switch never disagree about why a review cannot run.
import React from 'react'
import SubToolCard from './SubToolCard'
import type { AccountsSnapshot } from '../../../shared/providers'
import { useSettingsStore, DEFAULT_CONDUCTOR_TOOLS } from '../../stores/settingsStore'
import { useProviderAccountsStore, providerView, savedOff } from '../../stores/providerAccountsStore'
import { reviewToolView, type ReviewToolKey } from '../settings/CodeReviewTools'

export interface ReviewSubToolState {
  label: 'Available' | 'Off' | 'Unavailable' | 'Checking'
  color: 'green' | 'yellow' | 'overlay1'
  /** Why the tool is not offered now, and where to change that. */
  reason: string | null
  /** A fact beside an offered tool (Claude review while Codex is off). */
  note: string | null
}

export interface ReviewSubToolContext {
  /** The built-in tools master (conductorToolsEnabled). */
  masterOn: boolean
  /** This tool's own switch (conductorTools.codexReview / claudeReview). */
  toolOn: boolean
  platform: string
  /** The first Accounts snapshot request has answered. */
  loaded: boolean
  settings: { claudeEnabled?: boolean; codexEnabled?: boolean }
}

const REVIEWER = { codexReview: 'codex', claudeReview: 'claude' } as const
const TOOL_NAME: Record<ReviewToolKey, string> = { codexReview: 'Codex review', claudeReview: 'Claude review' }

/** Whether main offers the review tool now, and why not. Pure. */
export function reviewSubToolState(snapshot: AccountsSnapshot | null, tool: ReviewToolKey, ctx: ReviewSubToolContext): ReviewSubToolState {
  if (!ctx.masterOn) return { label: 'Off', color: 'overlay1', reason: 'The built-in tools are off. Turn them on in Settings, General, Built-in Tools.', note: null }
  if (!ctx.toolOn) return { label: 'Off', color: 'overlay1', reason: `${TOOL_NAME[tool]} is off. Turn it on in Settings, General, Built-in Tools.`, note: null }
  const id = REVIEWER[tool]
  const view = reviewToolView(snapshot, tool, { masterOn: true, platform: ctx.platform, loaded: ctx.loaded, settings: ctx.settings })
  const provider = providerView(snapshot, id)
  if (savedOff(ctx.settings, id) || provider?.enabled === false) return { label: 'Off', color: 'overlay1', reason: view.message, note: null }
  if (!snapshot && !ctx.loaded) return { label: 'Checking', color: 'overlay1', reason: view.message, note: null }
  if (view.disabled || provider?.review?.ready !== true) {
    return { label: 'Unavailable', color: 'yellow', reason: view.message ?? 'No review can run right now. Check Settings, Accounts.', note: view.note ?? null }
  }
  return { label: 'Available', color: 'green', reason: null, note: view.note ?? null }
}

const reviewIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18l-6-6 6-6" />
    <path d="M15 6l6 6-6 6" />
  </svg>
)

/** One review card, live: re-renders when a switch, a provider or the
 *  reviewer account changes. */
export function ReviewSubToolCard({ tool, title, description, toolName }: {
  tool: ReviewToolKey
  title: string
  description: string
  toolName: 'codex_review' | 'claude_review'
}) {
  const settings = useSettingsStore((s) => s.settings)
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const loaded = useProviderAccountsStore((s) => s.loaded)
  const tools = { ...DEFAULT_CONDUCTOR_TOOLS, ...(settings.conductorTools || {}) }
  const state = reviewSubToolState(snapshot, tool, {
    masterOn: settings.conductorToolsEnabled !== false,
    toolOn: tools[tool] !== false,
    platform: typeof window !== 'undefined' ? window.electronPlatform : '',
    loaded,
    settings,
  })
  return (
    <SubToolCard title={title} icon={reviewIcon} statusLabel={state.label} statusColor={state.color} description={description} toolList={[toolName]}>
      {state.reason && (
        <div className="text-xs leading-snug" style={{ color: 'var(--text-secondary)' }} data-testid={`review-sub-tool-${tool}-reason`}>
          {state.reason}
        </div>
      )}
      {state.note && (
        <div className="text-xs leading-snug" style={{ color: 'var(--text-muted)' }} data-testid={`review-sub-tool-${tool}-note`}>
          {state.note}
        </div>
      )}
    </SubToolCard>
  )
}
