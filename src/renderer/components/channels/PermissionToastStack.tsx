// src/renderer/components/channels/PermissionToastStack.tsx
import React, { useEffect } from 'react'
import { useChannelStore } from '../../stores/channelStore'
import { PermissionToast } from './PermissionToast'

const MAX_VISIBLE = 4
export default function PermissionToastStack() {
  const pending = useChannelStore((s) => s.pending)
  const respond = (requestId: string, decision: 'allow' | 'deny') =>
    window.electronAPI.channels.respondPermission({ requestId, decision })

  // getPending() returns insertion order (oldest first); the tray shows the
  // newest on top. Reverse once and use the same order for rendering, focus,
  // and the keyboard shortcuts so they all agree on which card is "primary".
  const ordered = [...pending].reverse()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ordered.length === 0) return
      const isMac = (window as any).electronPlatform === 'darwin'
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (e.key === 'Enter' && !mod) { respond(ordered[0].requestId, 'allow'); e.preventDefault() }
      else if (e.key === 'Escape') { respond(ordered[0].requestId, 'deny'); e.preventDefault() }
      else if (mod && /^[1-9]$/.test(e.key)) {
        const idx = +e.key - 1; if (ordered[idx]) { respond(ordered[idx].requestId, 'allow'); e.preventDefault() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pending])

  if (ordered.length === 0) return null
  const visible = ordered.slice(0, MAX_VISIBLE)  // newest first
  const overflow = ordered.length - visible.length
  // Normal column: the box is pinned at bottom-left, so it grows UPWARD and the
  // first child (newest) sits on top while the "+N waiting" pill sits at the
  // bottom just above the bottom bar.
  return (
    <div className="fixed left-3 bottom-12 z-50 flex flex-col gap-2 items-start channels-tray">
      {visible.map((p, i) => (
        <PermissionToast key={p.requestId} p={p} focused={i === 0}
          onAllow={() => respond(p.requestId, 'allow')}
          onDeny={() => respond(p.requestId, 'deny')} />
      ))}
      {overflow > 0 && <div className="text-[11px] text-overlay0 bg-surface0 border border-surface1 rounded px-2 py-1">+{overflow} waiting</div>}
    </div>
  )
}
