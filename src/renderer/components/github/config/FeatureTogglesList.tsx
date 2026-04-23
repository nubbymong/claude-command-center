import type { Capability, GitHubFeatureKey } from '../../../../shared/github-types'
import { useGitHubStore } from '../../../stores/githubStore'

interface FeatureDef {
  key: GitHubFeatureKey
  label: string
  description: string
  requiredCapabilities: Capability[]
}

const FEATURES: FeatureDef[] = [
  {
    key: 'activePR',
    label: 'Active PR card',
    description: 'PR for your branch with CI, reviews, merge state.',
    requiredCapabilities: ['pulls'],
  },
  {
    key: 'ci',
    label: 'CI / Actions',
    description: 'Workflow runs, logs, re-run failed jobs.',
    requiredCapabilities: ['actions'],
  },
  {
    key: 'reviews',
    label: 'Reviews & comments',
    description: 'Threaded review comments with reply.',
    requiredCapabilities: ['pulls'],
  },
  {
    key: 'linkedIssues',
    label: 'Linked issues',
    description: 'Issues linked by PR body, branch, or transcript.',
    requiredCapabilities: ['issues'],
  },
  {
    key: 'notifications',
    label: 'Notifications inbox',
    description: 'Review requests, mentions, assignments.',
    requiredCapabilities: ['notifications'],
  },
  {
    key: 'localGit',
    label: 'Local git state',
    description: 'Dirty files, ahead/behind, recent commits (no auth needed).',
    requiredCapabilities: [],
  },
  {
    key: 'sessionContext',
    label: 'Session context',
    description: "What this session is working on right now.",
    requiredCapabilities: [],
  },
]

export default function FeatureTogglesList() {
  const config = useGitHubStore((s) => s.config)
  const profiles = useGitHubStore((s) => s.profiles)
  const updateConfig = useGitHubStore((s) => s.updateConfig)

  const availableCaps = new Set<Capability>()
  if (config) {
    for (const p of profiles) for (const c of p.capabilities) availableCaps.add(c)
  }

  // Capability availability is a RENDER-TIME MASK — never persisted. An earlier
  // iteration reconciled into config on every render whose caps were missing,
  // but that ran during first-launch (before the user signs in) and silently
  // flipped every default-on feature to false. After sign-in the config kept
  // them false even though the auth now supplied the required capabilities, so
  // the user saw nothing tick back on. The config always stores user intent;
  // the UI just dims the checkbox when the required scope isn't connected.

  if (!config) return null

  return (
    <section>
      <h3 className="text-sm uppercase text-subtext0 mb-3">Features</h3>
      <div className="space-y-2">
        {FEATURES.map((f) => {
          const unavailable = f.requiredCapabilities.some((c) => !availableCaps.has(c))
          const checked = !!config.featureToggles[f.key]
          return (
            <div
              key={f.key}
              className={`bg-mantle p-3 rounded flex items-start gap-3 ${
                unavailable ? 'opacity-60' : ''
              }`}
            >
              <input
                type="checkbox"
                disabled={unavailable}
                checked={checked}
                onChange={(e) => {
                  if (unavailable) return
                  void updateConfig({
                    featureToggles: {
                      ...config.featureToggles,
                      [f.key]: e.target.checked,
                    },
                  })
                }}
                className="mt-1"
                aria-label={f.label}
              />
              <div className="flex-1">
                <div className="text-text text-sm">{f.label}</div>
                <div className="text-xs text-subtext0">{f.description}</div>
                <div className="text-xs text-overlay1 mt-1">
                  {f.requiredCapabilities.length === 0
                    ? 'No auth needed'
                    : `Needs: ${f.requiredCapabilities.join(', ')}`}
                </div>
                {unavailable && (
                  <div className="text-xs text-yellow mt-1" role="note">
                    Add an auth profile with {f.requiredCapabilities.join(' + ')} capability to
                    enable.
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
