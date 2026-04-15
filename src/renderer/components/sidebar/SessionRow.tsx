import React from 'react'
import { Session } from '../../stores/sessionStore'
import { ClaudeBadge, ShellBadge, SshBadge } from './Badges'

interface SessionRowProps {
  session: Session
  isActive: boolean
  needsAttention: boolean
  isRenaming: boolean
  renameValue: string
  renameRef: React.RefObject<HTMLInputElement | null>
  onRenameChange: (val: string) => void
  onRenameFinish: () => void
  onRenameCancel: () => void
  onClick: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  isSelected?: boolean
  isFocused?: boolean
}

export default function SessionRow({ session, isActive, needsAttention, isRenaming, renameValue, renameRef, onRenameChange, onRenameFinish, onRenameCancel, onClick, onContextMenu, isSelected, isFocused }: SessionRowProps) {
  const tintColor = session.color
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`w-full text-left rounded-md py-2 px-3 transition-all duration-150 group flex relative overflow-hidden ${
        isActive
          ? 'text-text'
          : 'text-subtext0 hover:text-text'
      } ${isSelected ? 'ring-1 ring-blue/50' : ''} ${isFocused ? 'ring-1 ring-blue/30' : ''}`}
      style={{
        backgroundColor: isActive ? tintColor + '20' : isSelected ? tintColor + '15' : undefined,
      }}
      onMouseEnter={(e) => { if (!isActive && !isSelected) (e.currentTarget as HTMLElement).style.backgroundColor = tintColor + '12' }}
      onMouseLeave={(e) => { if (!isActive && !isSelected) (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
    >
      {needsAttention && (
        <div
          className="absolute inset-0 rounded-md attention-pulse-bg"
          style={{ backgroundColor: tintColor }}
        />
      )}
      <div className="flex-1 min-w-0 relative z-10">
        <div className="flex items-center gap-2">
          {isRenaming ? (
            <input
              ref={renameRef}
              value={renameValue}
              onChange={(e) => onRenameChange(e.target.value)}
              onBlur={onRenameFinish}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') onRenameFinish()
                if (e.key === 'Escape') onRenameCancel()
              }}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 bg-base border border-blue rounded px-1.5 py-0.5 text-xs text-text outline-none min-w-0"
            />
          ) : (
            <span className="text-sm font-medium truncate flex-1">{session.label}</span>
          )}
          {session.sessionType === 'ssh' && <SshBadge />}
          {session.shellOnly ? <ShellBadge /> : <ClaudeBadge needsAttention={needsAttention} />}
        </div>
        <div className="mt-1 pl-4 pr-1">
          <div className="flex items-center gap-1.5">
            <div className="flex-1 h-1.5 bg-surface1 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${session.contextPercent ?? 0}%`,
                  backgroundColor: (session.contextPercent ?? 0) > 80
                    ? tintColor
                    : (session.contextPercent ?? 0) > 50
                    ? tintColor + 'CC'
                    : tintColor + '99'
                }}
              />
            </div>
            <span className="text-[10px] text-overlay0 w-7 text-right">
              {session.contextPercent != null ? `${Math.round(session.contextPercent)}%` : ''}
            </span>
          </div>
        </div>
      </div>
    </button>
  )
}
