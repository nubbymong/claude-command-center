// src/renderer/components/github/config/MasterFeaturesSection.tsx
// "Features for all accounts" master section: one tri-state ToggleSwitch per
// auth feature (master across every account, persists featureDefaults) plus the
// two app-wide no-auth rows. Replaces the legacy FeatureTogglesList's role.
import React from 'react'
import { useGitHubStore } from '../../../stores/githubStore'
import ToggleSwitch from './ToggleSwitch'
import {
  AUTH_FEATURE_KEYS,
  masterState,
  effectiveToggle,
} from '../../../../shared/github-features'
import { DEFAULT_AUTH_FEATURE_TOGGLES } from '../../../../shared/github-constants'
import type {
  GitHubAuthFeatureKey,
  GitHubAppWideFeatureKey,
} from '../../../../shared/github-types'

// Reused by AccountPanel (Task 3) for its scope/status chips.
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
// Exported so AccountPanel (Task 3) reuses the same labels for its chips and
// pending-re-auth text rather than duplicating the strings.
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

const APP_WIDE_META: Record<GitHubAppWideFeatureKey, { label: string; description: string }> = {
  localGit: {
    label: 'Local git state',
    description: 'Dirty files, ahead/behind, recent commits (no auth needed).',
  },
  sessionContext: {
    label: 'Session context',
    description: 'What this session is working on right now.',
  },
}
const APP_WIDE_KEYS: GitHubAppWideFeatureKey[] = ['localGit', 'sessionContext']

export default function MasterFeaturesSection() {
  const config = useGitHubStore((s) => s.config)
  const profiles = useGitHubStore((s) => s.profiles)
  const setMasterFeature = useGitHubStore((s) => s.setMasterFeature)
  const setAppWideToggle = useGitHubStore((s) => s.setAppWideToggle)

  if (!config) return null

  // masterState requires a COMPLETE defaults map; the renderer's first hydrate
  // can race the boot migration and see featureDefaults undefined for one frame.
  const layeredDefaults = {
    ...DEFAULT_AUTH_FEATURE_TOGGLES,
    ...(config.featureDefaults ?? {}),
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm uppercase text-subtext0">Features for all accounts</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="text-xs text-subtext0 hover:text-text px-2 py-1 rounded transition-colors"
            onClick={() => {
              for (const k of AUTH_FEATURE_KEYS) void setMasterFeature(k, true)
            }}
          >
            All on
          </button>
          <button
            type="button"
            className="text-xs text-subtext0 hover:text-text px-2 py-1 rounded transition-colors"
            onClick={() => {
              for (const k of AUTH_FEATURE_KEYS) void setMasterFeature(k, false)
            }}
          >
            All off
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {AUTH_FEATURE_KEYS.map((key) => {
          const meta = AUTH_FEATURE_META[key]
          const state = masterState(profiles, layeredDefaults, key)
          const onCount = profiles.filter((p) => effectiveToggle(p, key, layeredDefaults)).length
          let chip: React.ReactNode
          if (profiles.length === 0) {
            chip = layeredDefaults[key] ? (
              <Chip tone="muted">on · needs an account</Chip>
            ) : (
              <Chip tone="muted">needs an account</Chip>
            )
          } else if (state === 'on') {
            chip = <Chip tone="ok">all accounts</Chip>
          } else if (state === 'mixed') {
            chip = (
              <Chip tone="custom">
                on for {onCount} of {profiles.length} accounts
              </Chip>
            )
          } else {
            chip = <Chip tone="muted">off</Chip>
          }
          return (
            <div key={key} className="bg-mantle p-3 rounded flex items-start gap-3">
              <div className="flex-1">
                <div className="text-text text-sm">{meta.label}</div>
                <div className="text-xs text-subtext0">{meta.description}</div>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                {chip}
                <ToggleSwitch
                  state={state}
                  label={meta.label}
                  onToggle={() => void setMasterFeature(key, state !== 'on')}
                />
              </div>
            </div>
          )
        })}

        {APP_WIDE_KEYS.map((key) => {
          const meta = APP_WIDE_META[key]
          // Legacy fallback for the one-frame race before appWideToggles hydrates.
          const on = config.appWideToggles?.[key] ?? config.featureToggles[key]
          return (
            <div key={key} className="bg-mantle p-3 rounded flex items-start gap-3">
              <div className="flex-1">
                <div className="text-text text-sm">{meta.label}</div>
                <div className="text-xs text-subtext0">{meta.description}</div>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <Chip tone="muted">app-wide · no auth</Chip>
                <ToggleSwitch
                  state={on ? 'on' : 'off'}
                  label={meta.label}
                  onToggle={() => void setAppWideToggle(key, !on)}
                />
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
