import { useState } from 'react'
import { useGitHubStore } from '../../../stores/githubStore'

const OPTS_FAST = [30, 60, 120, 300]
const OPTS_SLOW = [120, 300, 600, 900]
const OPTS_NOTIF = [60, 180, 300, 600]

function fmt(s: number): string {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

export default function SyncSettings() {
  const config = useGitHubStore((s) => s.config)
  const updateConfig = useGitHubStore((s) => s.updateConfig)
  const [lastClick, setLastClick] = useState(0)
  if (!config) return null

  const setInt = (k: keyof typeof config.syncIntervals, v: number) =>
    void updateConfig({ syncIntervals: { ...config.syncIntervals, [k]: v } })

  const syncActiveNow = async () => {
    // Render debounce: the user can't know server state; 5s dedupe prevents
    // button-mash from queueing redundant full-fetches behind the rate-limit
    // shield. Server also coalesces, but failing fast here is kinder UX.
    if (Date.now() - lastClick < 5000) return
    setLastClick(Date.now())
    // Active-session id is not known to this component; main resolves it from
    // the focused terminal via syncFocusedNow, avoiding an ambiguous empty-
    // string sentinel on the per-session syncNow channel.
    await window.electronAPI.github.syncFocusedNow()
  }

  return (
    <section>
      <h3 className="text-sm uppercase text-subtext0 mb-3">Sync</h3>
      <div className="bg-mantle p-3 rounded space-y-3 text-sm">
        <label className="flex items-center justify-between">
          <span>Active session</span>
          <select
            className="bg-surface0 p-1 rounded"
            value={config.syncIntervals.activeSessionSec}
            onChange={(e) => setInt('activeSessionSec', Number(e.target.value))}
          >
            {OPTS_FAST.map((s) => (
              <option key={s} value={s}>
                {fmt(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between">
          <span>Background sessions</span>
          <select
            className="bg-surface0 p-1 rounded"
            value={config.syncIntervals.backgroundSec}
            onChange={(e) => setInt('backgroundSec', Number(e.target.value))}
          >
            {OPTS_SLOW.map((s) => (
              <option key={s} value={s}>
                {fmt(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between">
          <span>Notifications</span>
          <select
            className="bg-surface0 p-1 rounded"
            value={config.syncIntervals.notificationsSec}
            onChange={(e) => setInt('notificationsSec', Number(e.target.value))}
          >
            {OPTS_NOTIF.map((s) => (
              <option key={s} value={s}>
                {fmt(s)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2 pt-2 border-t border-surface0">
          <button
            onClick={() => window.electronAPI.github.syncPause()}
            className="bg-surface0 px-3 py-1 rounded text-xs"
          >
            Pause syncs
          </button>
          <button
            onClick={() => window.electronAPI.github.syncResume()}
            className="bg-surface0 px-3 py-1 rounded text-xs"
          >
            Resume
          </button>
          <button
            onClick={syncActiveNow}
            className="bg-blue text-base px-3 py-1 rounded text-xs"
          >
            Sync active now
          </button>
        </div>
      </div>
    </section>
  )
}
