import { useEffect, useState } from 'react'
import SectionFrame from '../SectionFrame'
import type { NotificationSummary } from '../../../../shared/github-types'
import { useGitHubStore } from '../../../stores/githubStore'

interface Props {
  sessionId: string
}

export default function NotificationsSection({ sessionId }: Props) {
  const profiles = useGitHubStore((s) => s.profiles)
  const notifCapable = profiles.filter((p) => p.capabilities.includes('notifications'))
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
  // Local-only for now — main's notifications fetch pushes through the
  // data channel in a follow-up. The empty state below is the correct
  // UX until that lands: "no notifications right now" with no fake data.
  const items: NotificationSummary[] = []

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
                onClick={() =>
                  void window.electronAPI.github.markNotifRead(selectedId, i.id)
                }
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
