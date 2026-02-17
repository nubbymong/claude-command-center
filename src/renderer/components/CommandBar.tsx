import React, { useState } from 'react'
import { useCommandStore, CustomCommand } from '../stores/commandStore'
import CommandDialog from './CommandDialog'
import ScreenshotButton from './ScreenshotButton'
import CompactionInterruptButton from './CompactionInterruptButton'

interface Props {
  sessionId: string
  configId?: string
  sessionType?: 'local' | 'ssh'
  partnerEnabled?: boolean
  isPartnerActive?: boolean
  onTogglePartner?: () => void
  partnerSessionId?: string
  visionEnabled?: boolean
  visionConnected?: boolean
  visionBrowser?: 'chrome' | 'edge'
  visionDebugPort?: number
  visionUrl?: string
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export default function CommandBar({ sessionId, configId, sessionType = 'local', partnerEnabled, isPartnerActive, onTogglePartner, partnerSessionId, visionEnabled, visionConnected, visionBrowser, visionDebugPort, visionUrl }: Props) {
  const { commands, addCommand, updateCommand, removeCommand, reorderCommands } = useCommandStore()
  const [showDialog, setShowDialog] = useState(false)
  const [editingCommand, setEditingCommand] = useState<CustomCommand | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; commandId?: string } | null>(null)
  const [visionContextMenu, setVisionContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  const visibleCommands = commands
    .filter((c) => c.scope === 'global' || (c.scope === 'config' && c.configId === configId))

  // Debug: log when commands don't match configId filter
  if (commands.length !== visibleCommands.length) {
    const hidden = commands.filter((c) => c.scope === 'config' && c.configId !== configId)
    if (hidden.length > 0) {
      console.log('[CommandBar] Hidden commands:', hidden.map(c => `${c.label} (configId=${c.configId})`), 'session configId:', configId)
    }
  }

  // Split commands by target
  const claudeCommands = visibleCommands.filter((c) => !c.target || c.target === 'any' || c.target === 'claude')
  const partnerCommands = visibleCommands.filter((c) => c.target === 'partner')

  const handleClick = (cmd: CustomCommand) => {
    const target = cmd.target || 'any'
    if (target === 'partner' && !isPartnerActive && onTogglePartner && partnerSessionId) {
      onTogglePartner()
      setTimeout(() => window.electronAPI.pty.write(partnerSessionId, cmd.prompt + '\r'), 100)
      return
    }
    if (target === 'claude' && isPartnerActive && onTogglePartner) {
      onTogglePartner()
      setTimeout(() => window.electronAPI.pty.write(sessionId, cmd.prompt + '\r'), 100)
      return
    }
    // 'any' or already on the right terminal
    const targetId = target === 'partner' && partnerSessionId ? partnerSessionId
      : target === 'claude' ? sessionId
      : (isPartnerActive && partnerSessionId ? partnerSessionId : sessionId)
    window.electronAPI.pty.write(targetId, cmd.prompt + '\r')
  }

  const handleContextMenu = (e: React.MouseEvent, commandId?: string) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, commandId })
  }

  const handleAdd = (data: Omit<CustomCommand, 'id'>) => {
    addCommand({ ...data, id: generateId() })
    setShowDialog(false)
  }

  const handleEdit = (data: Omit<CustomCommand, 'id'>) => {
    if (editingCommand) {
      updateCommand(editingCommand.id, data)
      setEditingCommand(null)
    }
  }

  const handleDragStart = (e: React.DragEvent, cmd: CustomCommand) => {
    setDragId(cmd.id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', cmd.id)
  }

  const handleDragOver = (e: React.DragEvent, cmd: CustomCommand) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragId && cmd.id !== dragId) {
      setDragOverId(cmd.id)
    }
  }

  const handleDrop = (e: React.DragEvent, targetCmd: CustomCommand) => {
    e.preventDefault()
    if (!dragId || dragId === targetCmd.id) return
    const newCommands = [...commands]
    const fromIdx = newCommands.findIndex((c) => c.id === dragId)
    const toIdx = newCommands.findIndex((c) => c.id === targetCmd.id)
    if (fromIdx === -1 || toIdx === -1) return
    const [moved] = newCommands.splice(fromIdx, 1)
    newCommands.splice(toIdx, 0, moved)
    reorderCommands(newCommands)
    setDragId(null)
    setDragOverId(null)
  }

  const handleDragEnd = () => {
    setDragId(null)
    setDragOverId(null)
  }

  // Render a single command button with full-color styling
  const renderCommandButton = (cmd: CustomCommand) => {
    const color = cmd.color || '#89B4FA'
    const isDragging = dragId === cmd.id
    const isDragOver = dragOverId === cmd.id
    return (
      <button
        key={cmd.id}
        draggable
        onDragStart={(e) => handleDragStart(e, cmd)}
        onDragOver={(e) => handleDragOver(e, cmd)}
        onDrop={(e) => handleDrop(e, cmd)}
        onDragEnd={handleDragEnd}
        onClick={() => handleClick(cmd)}
        onContextMenu={(e) => { e.stopPropagation(); handleContextMenu(e, cmd.id) }}
        className="flex items-center gap-1 px-2.5 py-0.5 text-xs rounded border text-subtext0 hover:text-text transition-colors whitespace-nowrap shrink-0"
        style={{
          backgroundColor: color + '20',
          borderColor: isDragOver ? '#89B4FA' : color + '40',
          opacity: isDragging ? 0.4 : 1,
          cursor: isDragging ? 'grabbing' : 'grab',
          borderLeftWidth: isDragOver ? '2px' : undefined,
          borderLeftColor: isDragOver ? '#89B4FA' : undefined,
        }}
        onMouseEnter={(e) => {
          if (!isDragging) {
            (e.currentTarget as HTMLElement).style.backgroundColor = color + '35'
            if (!isDragOver) (e.currentTarget as HTMLElement).style.borderColor = color + '60'
          }
        }}
        onMouseLeave={(e) => {
          if (!isDragging) {
            (e.currentTarget as HTMLElement).style.backgroundColor = color + '20'
            if (!isDragOver) (e.currentTarget as HTMLElement).style.borderColor = color + '40'
          }
        }}
        title={cmd.prompt}
      >
        {cmd.scope === 'global' && (
          <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-overlay0 shrink-0 opacity-60">
            <circle cx="8" cy="8" r="6.5" />
            <ellipse cx="8" cy="8" rx="3" ry="6.5" />
            <path d="M1.5 8h13" />
          </svg>
        )}
        {cmd.label}
      </button>
    )
  }

  return (
    <div className="flex flex-col shrink-0" onContextMenu={(e) => handleContextMenu(e)}>
      {/* Row 1: Magic buttons */}
      <div className="flex items-center gap-1 px-2 py-0.5 bg-crust border-t border-surface0">
        {/* Section icon: sparkle/wand */}
        <div className="shrink-0 text-overlay0" title="Tools">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
            <path d="M3.5 3.5l2 2M10.5 10.5l2 2M12.5 3.5l-2 2M5.5 10.5l-2 2" />
          </svg>
        </div>
        <div className="w-px h-4 bg-surface1 mx-0.5" />
        <ScreenshotButton sessionId={sessionId} sessionType={sessionType} />
        <CompactionInterruptButton sessionId={sessionId} />
        {visionEnabled && (
          visionConnected ? (
            <div className="relative shrink-0">
              <button
                onClick={(e) => e.preventDefault()}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setVisionContextMenu({ x: e.clientX, y: e.clientY })
                }}
                className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-green/40 bg-green/10 text-green cursor-default shrink-0"
                title={`Vision connected to ${visionBrowser || 'browser'} (port ${visionDebugPort || 9222}) \u2014 right-click to disconnect`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-green inline-block" />
                Vision
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                if (visionBrowser && visionDebugPort) {
                  window.electronAPI.vision.launch(visionBrowser, visionDebugPort, visionUrl)
                }
              }}
              className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-peach/40 bg-peach/10 text-peach hover:bg-peach/20 transition-colors shrink-0"
              title={`Launch ${visionBrowser || 'browser'} with remote debugging on port ${visionDebugPort || 9222}`}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
              </svg>
              Launch Vision
            </button>
          )
        )}
        {visionContextMenu && (
          <VisionContextMenu
            x={visionContextMenu.x}
            y={visionContextMenu.y}
            onClose={() => setVisionContextMenu(null)}
            onDisconnect={() => {
              window.electronAPI.vision.stop(sessionId)
              setVisionContextMenu(null)
            }}
            onLaunch={visionBrowser && visionDebugPort ? () => {
              window.electronAPI.vision.launch(visionBrowser, visionDebugPort, visionUrl)
              setVisionContextMenu(null)
            } : undefined}
          />
        )}
        {/* Back to Claude / Partner toggle - on magic row */}
        {partnerEnabled && onTogglePartner && (
          <>
            <div className="w-px h-4 bg-surface1 mx-0.5" />
            {isPartnerActive ? (
              <button
                onClick={onTogglePartner}
                className="flex items-center gap-1.5 px-2.5 py-0.5 text-xs rounded bg-blue/20 border border-blue/40 text-blue hover:bg-blue/30 transition-colors shrink-0 font-medium"
                title="Switch back to Claude terminal"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M12 2v8.5M12 13.5V22M2 12h8.5M13.5 12H22M4.93 4.93l6.01 6.01M13.06 13.06l6.01 6.01M19.07 4.93l-6.01 6.01M10.94 13.06l-6.01 6.01" />
                </svg>
                Back to Claude
              </button>
            ) : (
              <button
                onClick={onTogglePartner}
                className="flex items-center gap-1.5 px-2.5 py-0.5 text-xs rounded border border-surface1 text-overlay0 hover:text-text hover:bg-surface0/50 hover:border-surface2 transition-colors shrink-0"
                title="Switch to partner terminal"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="7 8 3 12 7 16" />
                  <polyline points="17 8 21 12 17 16" />
                  <line x1="14" y1="4" x2="10" y2="20" />
                </svg>
                Partner
              </button>
            )}
          </>
        )}
        {/* Spacer to push + to the right */}
        <div className="flex-1" />
        <button
          onClick={() => setShowDialog(true)}
          className="px-1.5 py-0.5 text-xs text-overlay0 hover:text-text rounded hover:bg-surface0 shrink-0"
          title="Add command"
        >
          +
        </button>
      </div>

      {/* Row 2: Claude commands */}
      {claudeCommands.length > 0 && (
        <div className="flex items-center gap-1 px-2 py-0.5 bg-crust border-t border-surface0/50 overflow-x-auto">
          {/* Section icon: Claude asterisk */}
          <div className="shrink-0 text-peach/60" title="Claude Commands">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 2v8.5M12 13.5V22M2 12h8.5M13.5 12H22M4.93 4.93l6.01 6.01M13.06 13.06l6.01 6.01M19.07 4.93l-6.01 6.01M10.94 13.06l-6.01 6.01" />
            </svg>
          </div>
          <div className="w-px h-4 bg-surface1 mx-0.5" />
          {claudeCommands.map(renderCommandButton)}
        </div>
      )}

      {/* Row 3: Partner commands */}
      {partnerEnabled && partnerCommands.length > 0 && (
        <div className="flex items-center gap-1 px-2 py-0.5 bg-crust border-t border-surface0/50 overflow-x-auto">
          {/* Section icon: </> code */}
          <div className="shrink-0 text-green/60" title="Partner Terminal Commands">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="7 8 3 12 7 16" />
              <polyline points="17 8 21 12 17 16" />
              <line x1="14" y1="4" x2="10" y2="20" />
            </svg>
          </div>
          <div className="w-px h-4 bg-surface1 mx-0.5" />
          {partnerCommands.map(renderCommandButton)}
        </div>
      )}

      {/* Dialogs & context menu */}
      {showDialog && (
        <CommandDialog
          onConfirm={handleAdd}
          onCancel={() => setShowDialog(false)}
          configId={configId}
        />
      )}
      {editingCommand && (
        <CommandDialog
          onConfirm={handleEdit}
          onCancel={() => setEditingCommand(null)}
          initial={editingCommand}
          configId={configId}
        />
      )}
      {contextMenu && (
        <ContextMenuOverlay
          {...contextMenu}
          onClose={() => setContextMenu(null)}
          onAdd={() => { setContextMenu(null); setShowDialog(true) }}
          onEdit={contextMenu.commandId ? () => {
            const cmd = commands.find(c => c.id === contextMenu.commandId)
            if (cmd) { setEditingCommand(cmd); setContextMenu(null) }
          } : undefined}
          onDelete={contextMenu.commandId ? () => {
            removeCommand(contextMenu.commandId!)
            setContextMenu(null)
          } : undefined}
        />
      )}
    </div>
  )
}

function ContextMenuOverlay({ x, y, onClose, onAdd, onEdit, onDelete }: {
  x: number; y: number
  onClose: () => void
  onAdd: () => void
  onEdit?: () => void
  onDelete?: () => void
}) {
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top?: number; bottom?: number }>({ left: x })

  React.useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const viewH = window.innerHeight
    const viewW = window.innerWidth
    const left = Math.min(x, viewW - rect.width - 8)
    // If menu would overflow bottom, open upward from click point
    if (y + rect.height > viewH - 8) {
      setPos({ left, bottom: viewH - y })
    } else {
      setPos({ left, top: y })
    }
  }, [x, y])

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        ref={menuRef}
        className="fixed bg-surface0 border border-surface1 rounded-lg shadow-xl py-1 min-w-[160px]"
        style={pos}
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={onAdd} className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>
          Add Command
        </button>
        {onEdit && (
          <button onClick={onEdit} className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8.5 1.5l2 2-7 7H1.5v-2z"/></svg>
            Edit
          </button>
        )}
        {onDelete && (
          <button onClick={onDelete} className="w-full text-left px-3 py-1.5 text-xs text-red hover:bg-surface1 transition-colors flex items-center gap-2">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
            Delete
          </button>
        )}
      </div>
    </div>
  )
}

function VisionContextMenu({ x, y, onClose, onDisconnect, onLaunch }: {
  x: number; y: number
  onClose: () => void
  onDisconnect: () => void
  onLaunch?: () => void
}) {
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top?: number; bottom?: number }>({ left: x })

  React.useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const viewH = window.innerHeight
    const viewW = window.innerWidth
    const left = Math.min(x, viewW - rect.width - 8)
    if (y + rect.height > viewH - 8) {
      setPos({ left, bottom: viewH - y })
    } else {
      setPos({ left, top: y })
    }
  }, [x, y])

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        ref={menuRef}
        className="fixed bg-surface0 border border-surface1 rounded-lg shadow-xl py-1 min-w-[180px]"
        style={pos}
        onClick={(e) => e.stopPropagation()}
      >
        {onLaunch && (
          <button onClick={onLaunch} className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
            </svg>
            Relaunch Browser
          </button>
        )}
        <button onClick={onDisconnect} className="w-full text-left px-3 py-1.5 text-xs text-red hover:bg-surface1 transition-colors flex items-center gap-2">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
          Disconnect Vision
        </button>
      </div>
    </div>
  )
}
