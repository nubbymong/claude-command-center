// src/renderer/components/channels/PermissionToastStack.tsx
import React, { useEffect } from 'react'
import { useChannelStore } from '../../stores/channelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSessionStore } from '../../stores/sessionStore'
import { PermissionToast } from './PermissionToast'

const MAX_VISIBLE = 4
export default function PermissionToastStack() {
  const enabled = useSettingsStore((s) => s.settings.permissionTrayEnabled !== false)
  const pending = useChannelStore((s) => s.pending)

  const ignore = (requestId: string) => window.electronAPI.channels.dismissPermission({ requestId })
  const goTo = (sessionId: string) => useSessionStore.getState().setActiveSession(sessionId)

  // Newest on top (the box is pinned bottom-left and grows upward).
  const ordered = [...pending].reverse()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ordered.length === 0) return
      if (e.key === 'Escape') { ignore(ordered[0].requestId); e.preventDefault() }   // Esc dismisses the top card
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pending])

  if (!enabled || ordered.length === 0) return null
  const visible = ordered.slice(0, MAX_VISIBLE)
  const overflow = ordered.length - visible.length
  return (
    <div className="fixed left-3 bottom-12 z-50 flex flex-col gap-2 items-start channels-tray">
      {visible.map((p) => (
        <PermissionToast key={p.requestId} p={p}
          onGoToSession={() => goTo(p.sessionId)}
          onIgnore={() => ignore(p.requestId)} />
      ))}
      {overflow > 0 && <div className="text-[11px] text-overlay0 bg-surface0 border border-surface1 rounded px-2 py-1">+{overflow} waiting</div>}
    </div>
  )
}
