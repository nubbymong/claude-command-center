import { useEffect, useMemo, useState } from 'react'
import SectionFrame from '../SectionFrame'
import type { NotificationSummary } from '../../../../shared/github-types'
import { useGitHubStore } from '../../../stores/githubStore'

interface Props {
  sessionId: string
}

export default function NotificationsSection({ sessionId }: Props) {
  const profiles = useGitHubStore((s) => s.profiles)
  const notificationsByProfile = useGitHubStore((s) => s.notificationsByProfile)
  const [markError, setMarkError] = useState<string | null>(null)

  const markRead = async (profileId: string, notifId: string) => {
    try {
      const r = await window.electronAPI.github.markNotifRead(profileId, notifId)
      if (!r.ok) {
        setMarkError(r.error ?? 'Failed to mark read')
        setTimeout(() => setMarkError(null), 3000)
      }
    } catch (err) {
      // IPC rejection — without this catch the onClick's promise rejects
      // unhandled. The next poll tick (up to 5 min away) would eventually
      // reflect the server truth, but the user sees no feedback why their
      // click did nothing.
      setMarkError(err instanceof Error ? err.message : 'Failed to mark read')
      setTimeout(() => setMarkError(null), 3000)
    }
  }
  // Memoize so the filtered list has stable identity between renders.
  // Without this, the hydration effect below depends on a new array
  // every render and runs on every render tick.
  const notifCapable = useMemo(
    () => profiles.filter((p) => p.capabilities.includes('notifications')),
    [profiles],
  )
  const [selectedId, setSelectedId] = useState(notifCapable[0]?.id ?? '')
  // Re-sync the selection when profiles hydrate after mount (or when the
  // previously-selected profile is removed). useState's initializer only
  // fires once — without this, selectedId can stay '' and markNotifRead
  // would fire with an empty profile id.
  useEffect(() => {
    if (notifCapable.length === 0) {
      if (selectedId !== '') setSelectedId('')
      return
    }
    if (!notifCapable.some((p) => p.id === selectedId)) {
      setSelectedId(notifCapable[0].id)
    }
  }, [notifCapable, selectedId])
  // Pushed from the NotificationsPoller in main via onNotificationsUpdate;
  // keyed by profileId. An unknown profile id yields [] (first-render,
  // pre-poll state) which renders the empty-state message below.
  const items: NotificationSummary[] = notificationsByProfile[selectedId] ?? []

  if (notifCapable.length === 0) {
    return (
      <SectionFrame
        sessionId={sessionId}
        id="notifications"
        title="Notifications"
        emptyIndicator
      >
        <div className="text-xs text-overlay0">
          Add an auth profile with the notifications scope to enable this.
        </div>
      </SectionFrame>
    )
  }

  const unread = items.filter((i) => i.unread).length
  return (
    <SectionFrame
      sessionId={sessionId}
      id="notifications"
      title="Notifications"
      summary={unread > 0 ? `${unread} unread` : undefined}
      emptyIndicator={items.length === 0}
    >
      {notifCapable.length > 1 && (
        <label className="mb-2 flex items-center gap-2 text-xs text-text">
          <span className="text-subtext0">Profile</span>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="bg-surface0 p-1 rounded text-xs"
          >
            {notifCapable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ({p.username})
              </option>
            ))}
          </select>
        </label>
      )}
      {markError && (
        <div className="text-red text-[10px] mb-1" role="alert" aria-live="polite">
          {markError}
        </div>
      )}
      <ul className="space-y-1 text-xs">
        {items.map((i) => (
          <li key={i.id} className="flex gap-2">
            {i.unread && (
              <span className="text-peach w-2" aria-label="unread">
                {String.fromCodePoint(0x25cf)}
              </span>
            )}
            <button
              onClick={() => void window.electronAPI.shell.openExternal(i.url)}
              className="text-blue hover:underline"
            >
              {i.repo}
            </button>
            <span className="text-text truncate flex-1" title={i.title}>
              {i.title}
            </span>
            {i.unread && (
              <button
                onClick={() => void markRead(selectedId, i.id)}
                className="text-overlay1 text-[10px]"
              >
                mark read
              </button>
            )}
          </li>
        ))}
        {items.length === 0 && (
          <li className="text-overlay0">No notifications right now</li>
        )}
      </ul>
    </SectionFrame>
  )
}
