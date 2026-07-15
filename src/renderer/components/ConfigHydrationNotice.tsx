import { useSettingsStore } from '../stores/settingsStore'

/**
 * One-shot, dismissible WARNING notice for P2.4 config-hydration drops. Shows
 * when a saved config section failed structural validation on load and was reset
 * to its default, so the user knows data was dropped rather than silently losing
 * it. Warning tone (amber) — unlike the informational colour-migration notice.
 * Per-field Zustand selectors to avoid re-render cascades (codebase convention).
 */
export default function ConfigHydrationNotice() {
  const pending = useSettingsStore((s) => s.settings.configHydrationNoticePending)
  const dismissed = useSettingsStore((s) => s.settings.configHydrationNoticeDismissed)
  const dropped = useSettingsStore((s) => s.settings.configHydrationDropped)

  if (pending !== true || dismissed === true) return null

  const dismiss = () => {
    // getState() (not the hook value) so this never depends on a fresh render.
    void useSettingsStore.getState().updateSettings({ configHydrationNoticeDismissed: true })
  }

  const items = Array.isArray(dropped) ? dropped : []

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-2 mb-2 rounded-lg border border-yellow/40 bg-mantle p-3"
    >
      <div className="flex items-start gap-2 mb-2">
        <div className="text-yellow mt-0.5 shrink-0">
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
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-text">Some saved settings couldn&apos;t be loaded</div>
          <div className="text-[11px] text-subtext0 leading-snug mt-0.5">
            Part of your config was corrupt and was reset to its default so the app could start. The
            rest of your setup is intact.
          </div>
          {items.length > 0 && (
            <ul className="mt-1 text-[10px] text-overlay1 font-mono list-disc pl-4 space-y-0.5">
              {items.map((it, i) => (
                <li key={i}>{it}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={dismiss}
          className="px-2 py-1 bg-surface0 hover:bg-surface1 text-text rounded text-xs transition-colors"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
