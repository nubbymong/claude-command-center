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
import { Chip, AUTH_FEATURE_META } from './github-feature-meta'

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
