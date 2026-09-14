// src/renderer/components/github/config/AppWideFeatures.tsx
// App-wide (no-auth) feature group: the two toggles that need no GitHub auth
// (local git state, session context). Lifted verbatim from the deleted
// MasterFeaturesSection so the rows, labels, and the appWideToggles fallback
// behave identically. These write the root-level appWideToggles map via
// setAppWideToggle (never a per-profile patch).
import { useGitHubStore } from '../../../stores/githubStore'
import ToggleSwitch from './ToggleSwitch'
import { Chip } from './github-feature-meta'
import type { GitHubAppWideFeatureKey } from '../../../../shared/github-types'

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

export default function AppWideFeatures() {
  const config = useGitHubStore((s) => s.config)
  const setAppWideToggle = useGitHubStore((s) => s.setAppWideToggle)

  if (!config) return null

  return (
    <section>
      <h3 className="text-sm uppercase text-subtext0 mb-3">App-wide (no auth)</h3>
      <div className="space-y-2">
        {APP_WIDE_KEYS.map((key) => {
          const meta = APP_WIDE_META[key]
          // Legacy fallback for the one-frame race before appWideToggles hydrates.
          const on = config.appWideToggles?.[key] ?? config.featureToggles[key]
          return (
            <div key={key} className="settings-card p-3 flex items-start gap-3">
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
