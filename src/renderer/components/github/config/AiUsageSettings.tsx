import { useSettingsStore } from '../../../stores/settingsStore'

/**
 * The included-credit cap input for the Copilot AI-credits meter.
 *
 * After the 2026-06-13 redesign this is the ONLY thing this section owns: the
 * one value GitHub does not expose through its API for personal accounts. The
 * meter's ENABLE moved to the per-account `aiCredits` feature toggle (which
 * writes through to settings.githubAiUsageEnabled), and the scope re-auth moved
 * into the account card's kind-aware "Re-authorize this account" action. The
 * meter itself now lives in the per-session status strip.
 */
export default function AiUsageSettings() {
  const cap = useSettingsStore((s) => s.settings.copilotIncludedCredits)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

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
      <div className="bg-mantle p-3 rounded">
        <label className="flex items-center justify-between text-sm">
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
            placeholder=""
            onChange={(e) => onCapChange(e.target.value)}
          />
        </label>
      </div>
    </section>
  )
}
