import React from 'react'
import SubToolCard from './SubToolCard'

const codexIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18l-6-6 6-6" />
    <path d="M15 6l6 6-6 6" />
  </svg>
)

export default function CodexReviewSubTool() {
  // P7.4: Codex review status is "available" whenever the MCP server is
  // running -- per-session opt-in is handled by SessionDialog. The card
  // here is informational. Future enhancement (post-v1.5): wire up
  // useCodexReviewUsage to show aggregate counts across all opted-in
  // sessions.
  return (
    <SubToolCard
      title="Codex review (Claude-driven)"
      icon={codexIcon}
      statusLabel="Available"
      statusColor="green"
      description='Available to every local Claude Code session while Codex is enabled (Settings -> Codex). Calls aggregate into Tokenomics > Codex review row.'
      toolList={['codex_review']}
    />
  )
}
