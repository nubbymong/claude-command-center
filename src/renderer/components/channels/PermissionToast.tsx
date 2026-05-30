// src/renderer/components/channels/PermissionToast.tsx
import React from 'react'
import { resolveIdentityColor } from '../../../shared/identity-colors'
import { getResolvedTheme } from '../../utils/resolvedTheme'
import { useSessionStore } from '../../stores/sessionStore'
import type { PendingPermission } from '../../../shared/channel-types'

interface Props {
  p: PendingPermission; focused: boolean
  onAllow: () => void; onDeny: () => void
}
export function PermissionToast({ p, focused, onAllow, onDeny }: Props) {
  const theme = getResolvedTheme()
  const rail = p.identityColorKey ? resolveIdentityColor(p.identityColorKey as any, theme) : 'var(--text-muted)'
  const tierBadge = p.tierLabel === 'channel-relay' ? 'via channel-relay' : p.tierLabel === 'hooks' ? 'via hooks' : null
  return (
    <div role="alertdialog" aria-label={`Permission request from ${p.sessionLabel}`}
      className="w-[360px] rounded-md bg-surface0 border border-surface1 shadow-2xl overflow-hidden channels-toast"
      style={{ boxShadow: `inset 4px 0 0 ${rail}` }}>
      {p.highRisk && (
        <div className="bg-red/20 text-red text-[10px] font-semibold px-3 py-1">! destructive -- {p.highRisk.matched} (Deny is selected)</div>
      )}
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold text-text truncate">{p.sessionLabel}</span>
          {p.provider && <span className="text-[10px] text-overlay0">{p.provider}</span>}
          {tierBadge && <span className="ml-auto text-[10px] text-overlay0">{tierBadge}</span>}
        </div>
        <div className="mt-1.5 text-[11px] text-subtext0">{p.tool}:</div>
        <pre className="text-[11px] font-mono text-text whitespace-pre-wrap break-all max-h-16 overflow-hidden">{p.payloadPreview}</pre>
        {p.reason && <div className="mt-1 text-[11px] italic text-subtext0">{p.reason}</div>}
        <div className="mt-2 flex items-center gap-2">
          <button onClick={onAllow} autoFocus={focused && !p.highRisk}
            className="px-2 py-1 rounded text-[11px] bg-surface1 hover:bg-surface2 text-text">Allow {String.fromCodePoint(0x21B5)}</button>
          <button onClick={onDeny} autoFocus={focused && !!p.highRisk}
            className="px-2 py-1 rounded text-[11px] bg-surface1 hover:bg-surface2 text-text">Deny esc</button>
          <button onClick={() => useSessionStore.getState().setActiveSession(p.sessionId)}
            className="px-2 py-1 rounded text-[11px] text-subtext0 hover:bg-surface1">Open</button>
          <button onClick={() => window.electronAPI.channels.standingApprovalCRUD({ op: 'add', tool: p.tool, ttl: '1h' })}
            className="ml-auto px-2 py-1 rounded text-[11px] text-subtext0 hover:bg-surface1"
            title={`Stop asking about ${p.tool} for 1 hour`}>Mute 1h</button>
        </div>
      </div>
    </div>
  )
}
