import React from 'react'
import { Session } from '../stores/sessionStore'
import NotesBar from './NotesBar'
import TipPill from './TipPill'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../shared/identity-colors'
import { useResolvedTheme } from '../hooks/useThemeController'
import { useRegionTypography } from '../hooks/useTypography'

interface Props {
  session: Session
  onShowTip?: () => void
}

export default function SessionHeader({ session, onShowTip }: Props) {
  const theme = useResolvedTheme()
  const headerType = useRegionTypography('header')
  // Resolve identity per-theme (like every other migrated surface) so the accent
  // theme-shifts and a pre-migration reserved hue never leaks through.
  const identity = resolveIdentityColor(session.identityColorKey ?? bucketLegacyColorToKey(session.color), theme)
  return (
    <div
      className="flex items-center gap-3 px-4 py-2 border-b shrink-0 relative"
      style={{ background: 'var(--surface-panel)', borderColor: 'var(--border-subtle)', ...headerType }}
    >
      {/* Session-color accent line that fades out toward the right --
          the gradient stops before fully transparent at ~70% so the
          colour reads strong on the left and dissolves toward the right. */}
      <div
        className="absolute top-0 left-0 right-0 h-[2px] pointer-events-none"
        style={{ background: `linear-gradient(to right, ${identity} 0%, ${identity}80 15%, transparent 55%)` }}
        aria-hidden
      />
      {/* Color dot: at-a-glance session identifier (name lives in the tab strip above) */}
      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: identity }} />

      {session.sessionType === 'ssh' && session.sshConfig && (
        <span className="text-xs text-mauve">SSH: {session.sshConfig.username}@{session.sshConfig.host}</span>
      )}
      {/* Separator before notes */}
      <div className="w-px h-4 bg-surface1" />

      {/* Secret notes */}
      <NotesBar configId={session.configId} />

      <div className="flex-1" />

      {onShowTip && <TipPill onClick={onShowTip} />}
    </div>
  )
}
