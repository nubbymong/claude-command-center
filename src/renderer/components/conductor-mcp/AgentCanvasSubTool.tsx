import React from 'react'
import SubToolCard from './SubToolCard'

const canvasIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M7 8h6" />
    <path d="M7 11.5h9" />
    <path d="M9 21l3-4 3 4" />
  </svg>
)

export default function AgentCanvasSubTool() {
  // Informational, like the Codex card: the canvas tools register for every
  // CCC-spawned Claude session (transport-bound, one canvas per session) and
  // are not offered to Codex sessions, which connect without a bound session
  // id. The surface itself lives behind each session's Agent Canvas button.
  return (
    <SubToolCard
      title="Agent Canvas"
      icon={canvasIcon}
      statusLabel="Available"
      statusColor="green"
      description="Per-session visual review: the agent renders a mockup or the built app onto the session's canvas (render), reads back the real layout with measurements (snapshot), and pulls the notes you submit from the canvas pane (review). One canvas per session, bound to that session's connection; open it with the Agent Canvas button."
      toolList={['canvas_render', 'canvas_snapshot', 'canvas_review']}
    />
  )
}
