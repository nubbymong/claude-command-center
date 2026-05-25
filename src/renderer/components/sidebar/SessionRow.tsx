import React from 'react'
import { Session } from '../../stores/sessionStore'
import { ClaudeBadge, CodexBadge, ShellBadge, SshBadge } from './Badges'
import { StatusDot, type SessionState } from '../ui/StatusDot'

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

/** Map the store's SessionStatus (5 values) to the UI SessionState (7 values).
 *  Source field: session.status (type SessionStatus = 'idle'|'working'|'complete'|'error'|'disconnected')
 *  needsAttention boolean overrides to 'awaiting' when true (no 'awaiting'/'blocked' in store).
 *
 *  Mapping:
 *    needsAttention=true                -> 'awaiting'
 *    status 'working'                   -> 'running'
 *    status 'idle'                      -> 'idle'
 *    status 'complete'                  -> 'idle'   (done/ready = idle)
 *    status 'error'                     -> 'error'
 *    status 'disconnected'              -> 'background'
 */
function toSessionState(status: Session['status'], needsAttention: boolean): SessionState {
  // error wins over needsAttention (spec §10 priority: error > awaiting)
  if (status === 'error') return 'error'
  if (needsAttention) return 'awaiting'
  switch (status) {
    case 'working':      return 'running'
    case 'idle':         return 'idle'
    case 'complete':     return 'idle'
    case 'disconnected': return 'background'
    default:             return 'idle'
  }
}

export default function SessionRow({ session, isActive, needsAttention, isRenaming, renameValue, renameRef, onRenameChange, onRenameFinish, onRenameCancel, onClick, onContextMenu, isSelected, isFocused }: SessionRowProps) {
  const tintColor = session.color
  const st = toSessionState(session.status, needsAttention)

  // Priority: error > awaiting > active (spec §10). toSessionState never
  // emits 'blocked' (no store signal yet); wire it here + there together if added.
  const rowStateClass =
    st === 'error' ? 'row-error'
    : st === 'awaiting' ? 'row-awaiting'
    : isActive ? 'row-active' : ''

  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`session-row w-full text-left transition-all duration-150 group relative overflow-hidden ${rowStateClass} ${
        isActive
          ? 'text-text'
          : 'text-subtext0 hover:text-text'
      } ${isSelected ? 'ring-1 ring-blue/50' : ''} ${isFocused ? 'ring-1 ring-blue/30' : ''}`}
      style={{
        backgroundColor: isActive && !rowStateClass ? tintColor + '20' : isSelected && !rowStateClass ? tintColor + '15' : undefined,
      }}
      onMouseEnter={(e) => { if (!isActive && !isSelected && !rowStateClass) (e.currentTarget as HTMLElement).style.backgroundColor = tintColor + '12' }}
      onMouseLeave={(e) => { if (!isActive && !isSelected && !rowStateClass) (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
    >
      {st === 'awaiting' && (
        <div
          className="absolute inset-0 rounded-md attention-pulse-bg"
          style={{ backgroundColor: tintColor }}
        />
      )}

      {/* Col 1: status dot (hidden during rename to keep input flush) */}
      <span className="relative z-10" style={{ display: isRenaming ? 'none' : undefined }}>
        <StatusDot state={st} />
      </span>

      {/* Col 2: name / rename input + badges */}
      <span className="nm relative z-10 flex items-center gap-1.5" style={isRenaming ? { gridColumn: '1 / -1' } : undefined}>
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
          <>
            <span className="text-xs font-medium truncate">{session.label}</span>
            {session.sessionType === 'ssh' && <SshBadge />}
            {session.shellOnly ? (
              <ShellBadge />
            ) : (session.provider ?? 'claude') === 'codex' ? (
              <CodexBadge needsAttention={needsAttention} />
            ) : (
              <ClaudeBadge needsAttention={needsAttention} />
            )}
          </>
        )}
      </span>

      {/* Col 3: model meta (right-aligned) -- hidden during rename */}
      {!isRenaming && (
        <span className="meta relative z-10">
          {session.modelName ?? session.model ?? ''}
        </span>
      )}

      {/* Context bar: spans all 3 columns */}
      <div className="relative z-10" style={{ gridColumn: '1 / -1', marginTop: 2 }}>
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
    </button>
  )
}
