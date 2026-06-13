// src/renderer/components/github/config/github-feature-meta.tsx
// Shared presentation meta for the GitHub auth features: the Chip pill and the
// AUTH_FEATURE_META label/description map. Extracted from MasterFeaturesSection
// so AccountPanel and MasterFeaturesSection render the same chips and labels
// from one source rather than duplicating the strings.
import React from 'react'
import type { GitHubAuthFeatureKey } from '../../../../shared/github-types'

// Reused by AccountPanel for its scope/status chips.
export function Chip({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'custom' | 'muted'
  children: React.ReactNode
}) {
  const tones = {
    ok: 'text-green border-green/40',
    warn: 'text-yellow border-yellow/40',
    custom: 'text-mauve border-mauve/40',
    muted: 'text-subtext0 border-surface1',
  }
  return (
    <span
      className={`text-[10px] rounded-full px-2 py-px border whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

// Label/description copied verbatim from FeatureTogglesList's FEATURES array.
// aiCredits is new in the per-account model (no row in the legacy list).
// Exported so AccountPanel and MasterFeaturesSection reuse the same labels for
// their chips and pending-re-auth text rather than duplicating the strings.
export const AUTH_FEATURE_META: Record<
  GitHubAuthFeatureKey,
  { label: string; description: string }
> = {
  activePR: {
    label: 'Active PR card',
    description: 'PR for your branch with CI, reviews, merge state.',
  },
  ci: {
    label: 'CI / Actions',
    description: 'Workflow runs, logs, re-run failed jobs.',
  },
  reviews: {
    label: 'Reviews & comments',
    description: 'Threaded review comments with reply.',
  },
  linkedIssues: {
    label: 'Linked issues',
    description: 'Issues linked by PR body, branch, or transcript.',
  },
  notifications: {
    label: 'Notifications inbox',
    description: 'Review requests, mentions, assignments.',
  },
  aiCredits: {
    label: 'AI credits usage',
    description: 'Copilot billed-usage meter and cap.',
  },
}
