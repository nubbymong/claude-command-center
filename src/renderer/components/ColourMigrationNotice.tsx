import { useSettingsStore } from '../stores/settingsStore'
import { useConfigStore } from '../stores/configStore'
import { useSessionStore } from '../stores/sessionStore'
import { pickColourReviewTarget } from '../utils/migrateIdentityColors'

interface Props {
  /**
   * Opens the app's existing config-edit dialog for the given config id. Wired
   * by the parent to the SAME handler ConfigRow's onEdit ultimately calls
   * (Sidebar's setEditingConfig). Optional: when absent, Review colours still
   * dismisses and warns rather than dead-ending.
   */
  onOpenConfigEditor?: (configId: string) => void
}

/**
 * One-time, dismissible info notice for the V2 identity-colour migration. Shows
 * once when a migration changed saved records (pending && !dismissed) and gives
 * a safe "Review colours" shortcut that resolves to a still-existing config (or
 * warns + dismisses if there is nothing safe to open). Quiet info tone -- this
 * is informational, not a warning. Uses per-field Zustand selectors to avoid
 * re-render cascades (codebase convention).
 */
export default function ColourMigrationNotice({ onOpenConfigEditor }: Props) {
  const pending = useSettingsStore((s) => s.settings.colourMigrationNoticePending)
  const dismissed = useSettingsStore((s) => s.settings.colourMigrationNoticeDismissed)

  if (pending !== true || dismissed === true) return null

  const dismiss = () => {
    // getState() (not the hook value) so this never depends on a fresh render.
    void useSettingsStore.getState().updateSettings({ colourMigrationNoticeDismissed: true })
  }

  const handleReview = () => {
    try {
      const target = pickColourReviewTarget(
        useConfigStore.getState().configs,
        useSessionStore.getState().sessions,
      )
      if (target.kind === 'config') {
        onOpenConfigEditor?.(target.configId)
      } else {
        console.warn('[colourMigration] Review colours: no editable target found')
      }
    } catch (err) {
      // Never let the shortcut throw -- it is a convenience, not load-bearing.
      console.warn('[colourMigration] Review colours failed', err)
    } finally {
      // Always dismiss after a Review action, regardless of outcome.
      dismiss()
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-2 mb-2 rounded-lg border border-blue/30 bg-mantle p-3"
    >
      <div className="flex items-start gap-2 mb-2">
        <div className="text-blue mt-0.5 shrink-0">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-text">Session colours refreshed</div>
          <div className="text-[11px] text-subtext0 leading-snug mt-0.5">
            Some saved config and session colours were moved out of reserved status colours so
            running, warning, error and focus states stay readable.
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={handleReview}
          className="px-2 py-1 bg-surface0 hover:bg-surface1 text-text rounded text-xs transition-colors"
        >
          Review colours
        </button>
        <button
          onClick={dismiss}
          className="px-2 py-1 text-overlay1 hover:text-text rounded text-xs transition-colors"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
