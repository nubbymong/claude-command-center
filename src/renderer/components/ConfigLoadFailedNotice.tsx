import { useConfigWriteLockStore } from '../stores/configWriteLockStore'

/**
 * Shown when the app could not READ your configuration and started on defaults.
 *
 * This is not the same event as ConfigHydrationNotice, which reports a section
 * that loaded but failed validation. Here nothing loaded at all, so the screen
 * you are looking at is empty defaults rather than your setup — and the danger
 * is not what you have lost, it is what you are about to overwrite. Saving is
 * latched off while this is up, so the notice's job is to say that plainly and
 * offer the two ways out: quit and fix the file, or accept the defaults.
 *
 * Deliberately not dismissible. A dismiss would leave writes latched with
 * nothing on screen explaining why nothing sticks, which is a worse state than
 * the notice itself.
 */
export default function ConfigLoadFailedNotice() {
  const reason = useConfigWriteLockStore((s) => s.lockedReason)
  if (!reason) return null

  return (
    <div
      role="alert"
      data-ux-id="config-load-failed-notice"
      className="mx-2 mb-2 rounded-lg border border-red/50 bg-mantle p-3"
    >
      <div className="flex items-start gap-2">
        <div className="text-red mt-0.5 shrink-0" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-text">Your configuration could not be loaded</div>
          <div className="text-[11px] text-subtext0 leading-snug mt-0.5">
            The app has started with defaults, so what you see is not your setup.
            <span className="text-text"> Nothing has been written over your saved config</span> — saving is
            paused so it stays that way. Close the app and your configs, commands and settings are still
            on disk exactly as they were.
          </div>
          {/* The WHY, in the words the lock was set with: which files failed,
              so the fix (a locked file, a permissions change, a junction) is
              nameable without opening the log. */}
          <div className="mt-1 text-[10px] font-mono text-overlay1 break-words" data-ux-id="config-load-failed-reason">{reason}</div>
          <button
            type="button"
            onClick={() => useConfigWriteLockStore.getState().unlock()}
            data-ux-id="config-load-failed-start-fresh"
            className="mt-2 px-2 py-1 rounded text-[11px] bg-surface1 hover:bg-surface2 text-text transition-colors focus-ring"
          >
            Start fresh anyway — allow saving over it
          </button>
        </div>
      </div>
    </div>
  )
}
