// src/renderer/components/channels/PermissionToast.tsx
import React from 'react'
import { resolveIdentityColor } from '../../../shared/identity-colors'
import { getResolvedTheme } from '../../utils/resolvedTheme'
import type { PendingPermission } from '../../../shared/channel-types'

interface Props {
  p: PendingPermission
  onGoToSession: () => void
  onIgnore: () => void
}
export function PermissionToast({ p, onGoToSession, onIgnore }: Props) {
  const theme = getResolvedTheme()
  const rail = p.identityColorKey ? resolveIdentityColor(p.identityColorKey as any, theme) : 'var(--text-muted)'
  const hasDetail = p.tool !== 'Permission'
  return (
    <div role="alertdialog" aria-label={`Permission needed in ${p.sessionLabel}`}
      className="w-[360px] rounded-md bg-surface0 border border-surface1 shadow-2xl overflow-hidden channels-toast"
      style={{ boxShadow: `inset 4px 0 0 ${rail}` }}>
      {p.highRisk && (
        <div className="bg-red/20 text-red text-[10px] font-semibold px-3 py-1">! destructive -- {p.highRisk.matched}</div>
      )}
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold text-text truncate">{p.sessionLabel}</span>
          {p.provider && <span className="text-[10px] text-overlay0">{p.provider}</span>}
          <span className="ml-auto text-[10px] text-overlay0">needs your permission</span>
        </div>
        {hasDetail
          ? (<>
              <div className="mt-1.5 text-[11px] text-subtext0">{p.tool}:</div>
              <pre className="text-[11px] font-mono text-text whitespace-pre-wrap break-all max-h-16 overflow-hidden">{p.payloadPreview}</pre>
            </>)
          : (<div className="mt-1.5 text-[11px] text-subtext0">{p.payloadPreview}</div>)}
        {/* MOUSE ONLY. No autoFocus (a card must never steal focus from the
            terminal and interrupt typing) and tabIndex=-1 (so a stray Enter /
            Space while typing can never activate an action). Click only. */}
        <div className="mt-2 flex items-center gap-2">
          <button onClick={onGoToSession} tabIndex={-1}
            className="px-2 py-1 rounded text-[11px] bg-surface1 hover:bg-surface2 text-text">Go to session</button>
          <button onClick={onIgnore} tabIndex={-1}
            className="ml-auto px-2 py-1 rounded text-[11px] text-subtext0 hover:bg-surface1"
            title="Dismiss this card -- Claude's own prompt stays in the session">Ignore</button>
        </div>
      </div>
    </div>
  )
}
