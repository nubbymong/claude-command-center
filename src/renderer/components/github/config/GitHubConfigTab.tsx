import { useEffect } from 'react'
import { useGitHubStore } from '../../../stores/githubStore'
import AuthProfilesList from './AuthProfilesList'
import FeatureTogglesList from './FeatureTogglesList'
import PermissionsSummary from './PermissionsSummary'
import PrivacySettings from './PrivacySettings'
import SyncSettings from './SyncSettings'
import HooksGatewaySection from './HooksGatewaySection'

export default function GitHubConfigTab() {
  const config = useGitHubStore((s) => s.config)
  const loadConfig = useGitHubStore((s) => s.loadConfig)
  const updateConfig = useGitHubStore((s) => s.updateConfig)

  useEffect(() => {
    loadConfig()
  }, [loadConfig])

  if (!config) {
    return <div className="p-6 text-overlay1">Loading GitHub config…</div>
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-lg text-text">GitHub integration</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.enabledByDefault}
            onChange={(e) => updateConfig({ enabledByDefault: e.target.checked })}
          />
          <span>Enable by default for new sessions</span>
        </label>
      </div>
      <AuthProfilesList />
      <FeatureTogglesList />
      <PermissionsSummary />
      <PrivacySettings />
      <SyncSettings />
      <HooksGatewaySection />
      <div className="text-xs text-overlay0 pt-4 border-t border-surface0">
        <strong>No telemetry.</strong> This feature sends no usage data to Anthropic
        or third parties. All requests go to github.com using your configured auth.
      </div>
    </div>
  )
}
