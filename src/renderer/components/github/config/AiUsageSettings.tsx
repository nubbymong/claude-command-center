import { useSettingsStore } from '../../../stores/settingsStore'
import { useGitHubStore } from '../../../stores/githubStore'

/**
 * Settings for the GitHub AI-credits (Copilot) usage meter. Reads/writes the
 * app settings store (githubAiUsageEnabled + copilotIncludedCredits). Toggling
 * the meter on kicks an immediate fetch via loadAiUsage so the (later) meter UI
 * has data to render. No meter visualization lives here — this is the opt-in +
 * cap entry only.
 */
export default function AiUsageSettings() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const loadAiUsage = useGitHubStore((s) => s.loadAiUsage)

  const enabled = settings.githubAiUsageEnabled === true
  const cap = settings.copilotIncludedCredits

  const toggle = async (next: boolean): Promise<void> => {
    await updateSettings({ githubAiUsageEnabled: next })
    // Drive an immediate refresh on enable so the meter populates without
    // waiting for the 60-minute poll. On disable, loadAiUsage returns null
    // (main clears the cache) and the store reflects the cleared state.
    await loadAiUsage().catch(() => {})
  }

  const onCapChange = (raw: string): void => {
    const trimmed = raw.trim()
    // Empty input = "unknown" (null). Otherwise parse a non-negative number;
    // ignore garbage so a stray keystroke can't persist NaN.
    if (trimmed === '') {
      void updateSettings({ copilotIncludedCredits: null })
      return
    }
    const n = Number(trimmed)
    if (Number.isFinite(n) && n >= 0) {
      void updateSettings({ copilotIncludedCredits: n })
    }
  }

  return (
    <section>
      <h3 className="text-sm uppercase text-subtext0 mb-3">AI credits usage</h3>
      <div className="bg-mantle p-3 rounded space-y-3">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => void toggle(e.target.checked)}
            className="mt-1"
          />
          <div>
            <div className="text-text">Show Copilot AI-credits usage</div>
            <div className="text-xs text-subtext0 mt-1">
              Polls your billed AI-credit usage from GitHub every 60 minutes and shows how
              much you are spending beyond your plan&apos;s included credits. This needs an
              extra token permission: classic tokens require the <code>user</code> scope;
              fine-grained tokens require Account permissions{' '}
              <strong>Plan: read</strong>. Without it GitHub returns no data and the meter
              stays empty. Default: off.
            </div>
          </div>
        </label>
        <label className="flex items-center justify-between text-sm pt-2 border-t border-surface0">
          <div className="pr-3">
            <div className="text-text">Included credits (USD)</div>
            <div className="text-xs text-subtext0 mt-1">
              GitHub does not expose your plan&apos;s included-credit cap through the API for
              personal accounts. Enter it from your plan / billing page so the meter can show
              progress toward the cap. Leave blank if unknown.
            </div>
          </div>
          <input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            className="bg-surface0 p-1 rounded w-24 text-right"
            value={cap ?? ''}
            placeholder="—"
            onChange={(e) => onCapChange(e.target.value)}
          />
        </label>
      </div>
    </section>
  )
}
