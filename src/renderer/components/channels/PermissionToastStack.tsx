// src/renderer/components/channels/PermissionToastStack.tsx
import React, { useEffect } from 'react'
import { useChannelStore } from '../../stores/channelStore'
import { PermissionToast } from './PermissionToast'

const MAX_VISIBLE = 5
export default function PermissionToastStack() {
  const pending = useChannelStore((s) => s.pending)
  const respond = (requestId: string, decision: 'allow' | 'deny' | 'allow-once') =>
    window.electronAPI.channels.respondPermission({ requestId, decision })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (pending.length === 0) return
      const isMac = (window as any).electronPlatform === 'darwin'
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (e.key === 'Enter' && !mod) { respond(pending[0].requestId, 'allow'); e.preventDefault() }
      else if (e.key === 'Escape') { respond(pending[0].requestId, 'deny'); e.preventDefault() }
      else if (mod && /^[1-9]$/.test(e.key)) {
        const idx = +e.key - 1; if (pending[idx]) { respond(pending[idx].requestId, 'allow'); e.preventDefault() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pending])

  if (pending.length === 0) return null
  const visible = pending.slice(0, MAX_VISIBLE)
  const overflow = pending.length - visible.length
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 items-end">
      {visible.map((p, i) => (
        <PermissionToast key={p.requestId} p={p} focused={i === 0}
          onAllow={() => respond(p.requestId, 'allow')}
          onDeny={() => respond(p.requestId, 'deny')}
          onAllowOnce={() => respond(p.requestId, 'allow-once')} />
      ))}
      {overflow > 0 && <div className="text-[11px] text-overlay0 bg-surface0 border border-surface1 rounded px-2 py-1">+{overflow} more</div>}
    </div>
  )
}
