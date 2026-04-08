import React, { useState } from 'react'
import { useCommandStore, CustomCommand } from '../stores/commandStore'
import CommandDialog from './CommandDialog'
import ScreenshotButton from './ScreenshotButton'
import StoryboardButton from './StoryboardButton'
import { generateId } from '../utils/id'

interface Props {
  sessionId: string
  configId?: string
  sessionType?: 'local' | 'ssh'
  partnerEnabled?: boolean
  isPartnerActive?: boolean
  onTogglePartner?: () => void
  partnerSessionId?: string
}

export default function CommandBar({ sessionId, configId, sessionType = 'local', partnerEnabled, isPartnerActive, onTogglePartner, partnerSessionId }: Props) {
  const { commands, sections, addCommand, updateCommand, removeCommand, reorderCommands } = useCommandStore()
  const [showDialog, setShowDialog] = useState(false)
  const [editingCommand, setEditingCommand] = useState<CustomCommand | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; commandId?: string } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [argsPopover, setArgsPopover] = useState<{ cmd: CustomCommand; rect: DOMRect } | null>(null)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [sectionInput, setSectionInput] = useState<{ x: number; y: number } | null>(null)

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

  /** Build the full command string (prompt + default args) */
  const buildFullCommand = (cmd: CustomCommand, args?: string[]): string => {
    const useArgs = args || cmd.defaultArgs
    if (useArgs && useArgs.length > 0) {
      return cmd.prompt + ' ' + useArgs.join(' ')
    }
    return cmd.prompt
  }

  /** Send a command to the appropriate PTY */
  const sendCommand = (cmd: CustomCommand, fullCommand: string) => {
    const target = cmd.target || 'any'
    if (target === 'partner' && !isPartnerActive && onTogglePartner && partnerSessionId) {
      onTogglePartner()
      setTimeout(() => window.electronAPI.pty.write(partnerSessionId, fullCommand + '\r'), 100)
      return
    }
    if (target === 'claude' && isPartnerActive && onTogglePartner) {
      onTogglePartner()
      setTimeout(() => window.electronAPI.pty.write(sessionId, fullCommand + '\r'), 100)
      return
    }
    // 'any' or already on the right terminal
    const targetId = target === 'partner' && partnerSessionId ? partnerSessionId
      : target === 'claude' ? sessionId
      : (isPartnerActive && partnerSessionId ? partnerSessionId : sessionId)
    window.electronAPI.pty.write(targetId, fullCommand + '\r')
  }

  const handleClick = (cmd: CustomCommand, e: React.MouseEvent) => {
    // Ctrl+click: show args popover if command has args
    if (e.ctrlKey && (cmd.defaultArgs?.length || cmd.lastCustomArgs?.length)) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setArgsPopover({ cmd, rect })
      return
    }
    sendCommand(cmd, buildFullCommand(cmd))
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

  /** Toggle section collapse */
  const toggleSection = (sectionId: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }

  // Render a single command button with full-color styling
  const renderCommandButton = (cmd: CustomCommand) => {
    const color = cmd.color || '#89B4FA'
    const isDragging = dragId === cmd.id
    const isDragOver = dragOverId === cmd.id
    const hasArgs = (cmd.defaultArgs && cmd.defaultArgs.length > 0) || (cmd.lastCustomArgs && cmd.lastCustomArgs.length > 0)
    const argsTitle = cmd.defaultArgs?.length
      ? `${cmd.prompt}\nArgs: ${cmd.defaultArgs.join(' ')}\nCtrl+click to customize args`
      : cmd.prompt
    return (
      <button
        key={cmd.id}
        draggable
        onDragStart={(e) => handleDragStart(e, cmd)}
        onDragOver={(e) => handleDragOver(e, cmd)}
        onDrop={(e) => handleDrop(e, cmd)}
        onDragEnd={handleDragEnd}
        onClick={(e) => handleClick(cmd, e)}
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
        title={argsTitle}
      >
        {cmd.scope === 'global' && (
          <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-overlay0 shrink-0 opacity-60">
            <circle cx="8" cy="8" r="6.5" />
            <ellipse cx="8" cy="8" rx="3" ry="6.5" />
            <path d="M1.5 8h13" />
          </svg>
        )}
        {cmd.label}
        {hasArgs && (
          <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" className="text-overlay0 shrink-0 opacity-50">
            <path d="M2 3.5l3 3 3-3" />
          </svg>
        )}
      </button>
    )
  }

  /** Render commands grouped by section */
  const renderGroupedCommands = (cmds: CustomCommand[]) => {
    const visibleSections = sections.filter(
      (s) => s.scope === 'global' || (s.scope === 'config' && s.configId === configId)
    )

    // Group by sectionId
    const unsectioned = cmds.filter((c) => !c.sectionId)
    const bySectionId = new Map<string, CustomCommand[]>()
    for (const cmd of cmds) {
      if (cmd.sectionId) {
        const list = bySectionId.get(cmd.sectionId) || []
        list.push(cmd)
        bySectionId.set(cmd.sectionId, list)
      }
    }

    // Only show sections that have commands
    const activeSections = visibleSections.filter((s) => bySectionId.has(s.id))

    return (
      <>
        {unsectioned.map(renderCommandButton)}
        {activeSections.map((section, idx) => {
          const sectionCmds = bySectionId.get(section.id) || []
          const isCollapsed = collapsedSections.has(section.id)
          const showDivider = unsectioned.length > 0 || idx > 0
          return (
            <React.Fragment key={section.id}>
              {showDivider && <div className="w-px h-4 bg-surface1/60 mx-0.5 shrink-0" />}
              <button
                onClick={() => toggleSection(section.id)}
                className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] text-overlay0 hover:text-subtext0 transition-colors shrink-0 rounded hover:bg-surface0/50"
                title={`${section.name} (${sectionCmds.length} commands)`}
              >
                <svg
                  width="6" height="6" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5"
                  className="shrink-0 transition-transform"
                  style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
                >
                  <path d="M1.5 2.5l2.5 3 2.5-3" />
                </svg>
                {section.name}
              </button>
              {!isCollapsed && sectionCmds.map(renderCommandButton)}
            </React.Fragment>
          )
        })}
      </>
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
        <StoryboardButton sessionId={sessionId} sessionType={sessionType} />
        {/* Back to Claude / Partner toggle - on magic row */}
        {partnerEnabled && onTogglePartner && (
          <>
            <div className="w-px h-4 bg-surface1 mx-0.5" />
            {isPartnerActive ? (
              <button
                onClick={onTogglePartner}
                className="w-[118px] flex items-center justify-center gap-1.5 py-0.5 text-xs rounded font-medium transition-colors shrink-0"
                style={{ backgroundColor: 'rgba(227, 148, 85, 0.18)', borderColor: 'rgba(227, 148, 85, 0.4)', color: '#E39455', border: '1px solid rgba(227, 148, 85, 0.4)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'rgba(227, 148, 85, 0.28)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'rgba(227, 148, 85, 0.18)' }}
                title="Switch back to Claude terminal"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M12 2v8.5M12 13.5V22M2 12h8.5M13.5 12H22M4.93 4.93l6.01 6.01M13.06 13.06l6.01 6.01M19.07 4.93l-6.01 6.01M10.94 13.06l-6.01 6.01" />
                </svg>
                Claude
              </button>
            ) : (
              <button
                onClick={onTogglePartner}
                className="w-[118px] flex items-center justify-center gap-1.5 py-0.5 text-xs rounded font-medium transition-colors shrink-0"
                style={{ backgroundColor: 'rgba(100, 160, 240, 0.14)', borderColor: 'rgba(100, 160, 240, 0.35)', color: '#64A0F0', border: '1px solid rgba(100, 160, 240, 0.35)' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'rgba(100, 160, 240, 0.24)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'rgba(100, 160, 240, 0.14)' }}
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
          {renderGroupedCommands(claudeCommands)}
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
          {renderGroupedCommands(partnerCommands)}
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
          onAddSection={() => {
            setSectionInput({ x: contextMenu.x, y: contextMenu.y })
            setContextMenu(null)
          }}
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
      {sectionInput && (
        <SectionNameInput
          x={sectionInput.x}
          y={sectionInput.y}
          onConfirm={(name) => {
            const { addSection } = useCommandStore.getState()
            addSection({
              id: generateId(),
              name,
              scope: configId ? 'config' : 'global',
              configId,
            })
            setSectionInput(null)
          }}
          onCancel={() => setSectionInput(null)}
        />
      )}
      {argsPopover && (
        <ArgsPopover
          cmd={argsPopover.cmd}
          rect={argsPopover.rect}
          onRun={(args) => {
            const cmd = argsPopover.cmd
            updateCommand(cmd.id, { lastCustomArgs: args })
            sendCommand(cmd, buildFullCommand(cmd, args))
            setArgsPopover(null)
          }}
          onSetDefault={(args) => {
            updateCommand(argsPopover.cmd.id, { defaultArgs: args })
            setArgsPopover(null)
          }}
          onClose={() => setArgsPopover(null)}
        />
      )}
    </div>
  )
}

function ContextMenuOverlay({ x, y, onClose, onAdd, onAddSection, onEdit, onDelete }: {
  x: number; y: number
  onClose: () => void
  onAdd: () => void
  onAddSection: () => void
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
        <button onClick={onAddSection} className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M2 6h8"/><path d="M2 3h8"/><path d="M2 9h8"/></svg>
          Add Section
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

/** Popover for customizing command arguments (shown on Ctrl+click) */
function ArgsPopover({ cmd, rect, onRun, onSetDefault, onClose }: {
  cmd: CustomCommand
  rect: DOMRect
  onRun: (args: string[]) => void
  onSetDefault: (args: string[]) => void
  onClose: () => void
}) {
  // Build union of all known args
  const allKnownArgs = React.useMemo(() => {
    const set = new Set<string>()
    cmd.defaultArgs?.forEach((a) => set.add(a))
    cmd.lastCustomArgs?.forEach((a) => set.add(a))
    return Array.from(set)
  }, [cmd.defaultArgs, cmd.lastCustomArgs])

  // Initialize checked state from lastCustomArgs or defaultArgs
  const initialChecked = React.useMemo(() => {
    const checked = new Set<string>()
    const source = cmd.lastCustomArgs || cmd.defaultArgs || []
    source.forEach((a) => checked.add(a))
    return checked
  }, [cmd.lastCustomArgs, cmd.defaultArgs])

  const [checked, setChecked] = React.useState<Set<string>>(initialChecked)
  const [customArgs, setCustomArgs] = React.useState<string[]>([])
  const [inputVal, setInputVal] = React.useState('')
  const popoverRef = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top?: number; bottom?: number }>({ left: 0 })

  // Position the popover above the button
  React.useEffect(() => {
    const el = popoverRef.current
    if (!el) return
    const popRect = el.getBoundingClientRect()
    const viewW = window.innerWidth
    const viewH = window.innerHeight

    let left = rect.left
    if (left + popRect.width > viewW - 8) {
      left = viewW - popRect.width - 8
    }
    if (left < 8) left = 8

    // Position above the button by default; below if no room above
    if (rect.top - popRect.height - 4 > 0) {
      setPos({ left, bottom: viewH - rect.top + 4 })
    } else {
      setPos({ left, top: rect.bottom + 4 })
    }
  }, [rect])

  const toggleArg = (arg: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(arg)) next.delete(arg)
      else next.add(arg)
      return next
    })
  }

  const handleAddCustom = () => {
    const val = inputVal.trim()
    if (val && !allKnownArgs.includes(val) && !customArgs.includes(val)) {
      setCustomArgs((prev) => [...prev, val])
      setChecked((prev) => new Set(prev).add(val))
      setInputVal('')
    }
  }

  const getSelectedArgs = (): string[] => {
    const result: string[] = []
    // Maintain order: allKnownArgs first, then custom args
    for (const a of allKnownArgs) {
      if (checked.has(a)) result.push(a)
    }
    for (const a of customArgs) {
      if (checked.has(a)) result.push(a)
    }
    return result
  }

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        ref={popoverRef}
        className="fixed bg-surface0 border border-surface1 rounded-lg shadow-xl p-3 min-w-[240px] max-w-[340px]"
        style={pos}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs text-subtext0 mb-2 font-medium truncate" title={cmd.prompt}>
          {cmd.label} — Arguments
        </div>

        {/* Argument checkboxes */}
        <div className="space-y-1 mb-2 max-h-[200px] overflow-y-auto">
          {allKnownArgs.map((arg) => (
            <label key={arg} className="flex items-center gap-2 text-xs text-text cursor-pointer hover:bg-surface1/50 rounded px-1 py-0.5">
              <input
                type="checkbox"
                checked={checked.has(arg)}
                onChange={() => toggleArg(arg)}
                className="rounded border-surface1 text-blue accent-blue"
              />
              <span className="font-mono truncate">{arg}</span>
              {cmd.defaultArgs?.includes(arg) && (
                <span className="text-[9px] text-overlay0 ml-auto shrink-0">default</span>
              )}
            </label>
          ))}
          {customArgs.map((arg) => (
            <label key={arg} className="flex items-center gap-2 text-xs text-text cursor-pointer hover:bg-surface1/50 rounded px-1 py-0.5">
              <input
                type="checkbox"
                checked={checked.has(arg)}
                onChange={() => toggleArg(arg)}
                className="rounded border-surface1 text-blue accent-blue"
              />
              <span className="font-mono truncate">{arg}</span>
              <span className="text-[9px] text-green ml-auto shrink-0">custom</span>
            </label>
          ))}
        </div>

        {/* Add custom arg input */}
        <div className="flex gap-1 mb-2">
          <input
            type="text"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddCustom() } }}
            className="flex-1 px-2 py-1 bg-crust text-text text-xs rounded border border-surface1 outline-none focus:border-blue font-mono"
            placeholder="Add argument..."
          />
          <button
            onClick={handleAddCustom}
            disabled={!inputVal.trim()}
            className="px-2 py-1 text-xs bg-surface1 text-text rounded hover:bg-surface1/80 disabled:opacity-40"
          >
            +
          </button>
        </div>

        {/* Action buttons */}
        <div className="flex gap-1.5">
          <button
            onClick={() => onRun(getSelectedArgs())}
            className="flex-1 px-3 py-1.5 text-xs bg-blue text-crust rounded hover:bg-blue/80 font-medium"
          >
            Run
          </button>
          <button
            onClick={() => onSetDefault(getSelectedArgs())}
            className="px-3 py-1.5 text-xs bg-surface1 text-text rounded hover:bg-surface1/80"
            title="Save selected args as the new default"
          >
            Set as Default
          </button>
        </div>
      </div>
    </div>
  )
}

/** Floating input for creating a new section from the context menu */
function SectionNameInput({ x, y, onConfirm, onCancel }: {
  x: number; y: number
  onConfirm: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = React.useState('')
  const ref = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top?: number; bottom?: number }>({ left: x })

  React.useEffect(() => {
    const el = ref.current
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
    <div className="fixed inset-0 z-50" onClick={onCancel}>
      <div
        ref={ref}
        className="fixed bg-surface0 border border-surface1 rounded-lg shadow-xl p-3 min-w-[220px]"
        style={pos}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs text-subtext0 mb-2 font-medium">New Section</div>
        <div className="flex gap-1">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) { e.preventDefault(); onConfirm(name.trim()) }
              if (e.key === 'Escape') onCancel()
            }}
            className="flex-1 px-2 py-1 bg-crust text-text text-xs rounded border border-surface1 outline-none focus:border-blue"
            placeholder="Section name"
            autoFocus
          />
          <button
            onClick={() => name.trim() && onConfirm(name.trim())}
            disabled={!name.trim()}
            className="px-2 py-1 text-xs bg-blue text-crust rounded hover:bg-blue/80 disabled:opacity-40"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  )
}

