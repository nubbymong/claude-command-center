import React from 'react'
import { ReviewSubToolCard } from './ReviewSubToolCard'

/** codex_review: Codex reviews for Claude Code sessions. Its status is the
 *  one main offers the tool on (see ReviewSubToolCard). */
export default function CodexReviewSubTool() {
  return (
    <ReviewSubToolCard
      tool="codexReview"
      title="Codex review (Claude-driven)"
      toolName="codex_review"
      description="Offered to local Claude Code sessions with a real project folder while Codex is on (Settings, Accounts), a Codex account there can run reviews, and Codex review is on (Settings, General, Built-in Tools)."
    />
  )
}
