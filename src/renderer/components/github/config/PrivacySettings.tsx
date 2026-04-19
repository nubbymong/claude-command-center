import { useGitHubStore } from '../../../stores/githubStore'

export default function PrivacySettings() {
  const config = useGitHubStore((s) => s.config)
  const updateConfig = useGitHubStore((s) => s.updateConfig)
  if (!config) return null

  return (
    <section>
      <h3 className="text-sm uppercase text-subtext0 mb-3">Privacy</h3>
      <div className="bg-mantle p-3 rounded">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.transcriptScanningOptIn}
            onChange={(e) =>
              void updateConfig({ transcriptScanningOptIn: e.target.checked })
            }
            className="mt-1"
          />
          <div>
            <div className="text-text">
              Scan this session&apos;s Claude conversation for issue/PR references
            </div>
            <div className="text-xs text-subtext0 mt-1">
              When on, we read the last 50 user/assistant messages for patterns like{' '}
              <code>#247</code>, <code>GH-247</code>, and github.com URLs.{' '}
              <strong>Matches are rendered as plain reference text only</strong> — message bodies
              are never shown in the panel. Scanning is local; nothing is sent to GitHub. Default:
              off.
            </div>
          </div>
        </label>
      </div>
    </section>
  )
}
