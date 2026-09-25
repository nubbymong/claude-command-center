import React from 'react'
import { ReviewSubToolCard } from './ReviewSubToolCard'

/** claude_review: Claude reviews for Codex sessions. Its status is the one
 *  main offers the tool on (see ReviewSubToolCard). */
export default function ClaudeReviewSubTool() {
  return (
    <ReviewSubToolCard
      tool="claudeReview"
      title="Claude review (Codex-driven)"
      toolName="claude_review"
      description="Offered to local Codex sessions with a real project folder while Claude Code is on (Settings, Accounts), a Claude account there can run reviews, and Claude review is on (Settings, General, Built-in Tools)."
    />
  )
}
