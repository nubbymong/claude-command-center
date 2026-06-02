import React, { useState, useEffect } from 'react'
import { useCommandStore, CustomCommand, CommandSection } from '../stores/commandStore'
import { useSessionStore } from '../stores/sessionStore'
import { useCommandBarStore } from '../stores/commandBarStore'
import CommandDialog from './CommandDialog'
import ScreenshotButton from './ScreenshotButton'
import ExcalidrawButton from './ExcalidrawButton'
import WebviewButton from './WebviewButton'
import { useWebviewStore, pollUrlForContent, probeWebviewUrls } from '../stores/webviewStore'
import { generateId } from '../utils/id'
import { trackUsage } from '../stores/tipsStore'
import { CODEX_MODELS } from '../codex-models'

// -- Codex toolbar sub-components --

const CODEX_PRESETS = ['read-only', 'standard', 'auto', 'unrestricted'] as const
type CodexPreset = typeof CODEX_PRESETS[number]

function CodexModelDropdown({ value, onChange }: {
  value: string
  onChange: (next: string) => void
}) {
  const [dirty, setDirty] = React.useState(false)
  return (
    <div className="flex items-center gap-1">
      <select
        value={value}
        onChange={(e) => { setDirty(true); onChange(e.target.value) }}
        className="bg-base border border-surface1 rounded px-1.5 py-0.5 text-xs text-text"
      >
        {CODEX_MODELS.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      {dirty && <span className="text-[10px] text-overlay1">Restart session to apply</span>}
    </div>
  )
}

function PermissionsPresetDropdown({ value, onChange }: {
  value: CodexPreset
  onChange: (next: CodexPreset) => void
}) {
  const [dirty, setDirty] = React.useState(false)
  return (
    <div className="flex items-center gap-1">
      <select
        value={value}
        onChange={(e) => { setDirty(true); onChange(e.target.value as CodexPreset) }}
        className="bg-base border border-surface1 rounded px-1.5 py-0.5 text-xs text-text"
      >
        {CODEX_PRESETS.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>
      {dirty && <span className="text-[10px] text-overlay1">Restart session to apply</span>}
    </div>
  )
}

interface Props {
  sessionId: string
  configId?: string
  sessionType?: 'local' | 'ssh'
  partnerEnabled?: boolean
  isPartnerActive?: boolean
  onTogglePartner?: () => void
  partnerSessionId?: string
  /**
   * The owning *session*'s id (not the PTY id). Used to key webview
   * store state so the Claude and Partner CommandBars within the same
   * session share one set of pulse/open state — without it, clicking
   * Web from the partner pane would write `bySessionId[partnerPtyId]`
   * while App.tsx renders `WebviewPane` keyed by `session.id`,
   * resulting in the banner triggering but the pane never appearing.
   * Defaults to `sessionId` so single-pane TerminalViews keep working.
   */
  parentSessionId?: string
}

export default function CommandBar({ sessionId, configId, sessionType = 'local', partnerEnabled, isPartnerActive, onTogglePartner, partnerSessionId, parentSessionId }: Props) {
  const webviewKey = parentSessionId ?? sessionId
  const { commands, sections, addCommand, updateCommand, removeCommand, reorderCommands, updateSection, removeSection, reorderSections } = useCommandStore()
  const [showDialog, setShowDialog] = useState(false)
  const [editingCommand, setEditingCommand] = useState<CustomCommand | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; commandId?: string; sectionId?: string; rowTarget?: 'claude' | 'partner' } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragOverSectionId, setDragOverSectionId] = useState<string | null>(null)
  const [dragSectionId, setDragSectionId] = useState<string | null>(null)
  const [dragOverSectionTargetId, setDragOverSectionTargetId] = useState<string | null>(null)
  const [argsPopover, setArgsPopover] = useState<{ cmd: CustomCommand; rect: DOMRect } | null>(null)
  // Section collapse state lives in a shared store so the Claude and Partner
  // CommandBar instances within the same config see the same set. Local
  // useState would diverge across the two terminal views and only "feel"
  // persistent when bouncing back to the original side.
  const collapsedSectionIds = useCommandBarStore((s) => s.state.collapsedSectionIds)
  const toggleSectionCollapse = useCommandBarStore((s) => s.toggleSection)
  // Whole-bar collapse -- shared + persisted, same store as section collapse.
  // Defaults to expanded so existing users are not surprised on upgrade.
  const barCollapsed = useCommandBarStore((s) => s.state.barCollapsed)
  const toggleBar = useCommandBarStore((s) => s.toggleBar)
  const [sectionInput, setSectionInput] = useState<{ x: number; y: number; editSection?: CommandSection; rowTarget?: 'claude' | 'partner' } | null>(null)

  // Claude Mode/Model/Effort pickers used to live here. They were removed in
  // P4b -- the app-level BottomBar now owns those controls (Claude only).
  // Codex sessions keep their inline option dropdowns below.
  const activeSession = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  const updateSession = useSessionStore((s) => s.updateSession)

  const visibleCommands = commands
    .filter((c) => c.scope === 'global' || (c.scope === 'config' && c.configId === configId))

  // Debug: log when commands don't match configId filter
  if (commands.length !== visibleCommands.length) {
    const hidden = commands.filter((c) => c.scope === 'config' && c.configId !== configId)
    if (hidden.length > 0) {
      console.log('[CommandBar] Hidden commands:', hidden.map(c => `${c.label} (configId=${c.configId})`), 'session configId:', configId)
    }
  }

  // Split commands by target — no 'any' concept, default is 'claude'
  const claudeCommands = visibleCommands.filter((c) => !c.target || c.target === 'claude' || c.target === 'any')
  const partnerCommands = visibleCommands.filter((c) => c.target === 'partner')

  // Count of command chips actually shown in the strip -- drives the collapse
  // toggle's badge. Partner commands only count when the partner row renders.
  const showPartnerRow = !!partnerEnabled && partnerCommands.length > 0
  const visibleCommandCount = claudeCommands.length + (showPartnerRow ? partnerCommands.length : 0)

  /** Build the full command string (prompt + default args) */
  const buildFullCommand = (cmd: CustomCommand, args?: string[]): string => {
    const useArgs = args || cmd.defaultArgs
    if (useArgs && useArgs.length > 0) {
      return cmd.prompt + ' ' + useArgs.join(' ')
    }
    return cmd.prompt
  }

  const startActivation = useWebviewStore((s) => s.startActivation)
  const markAvailable = useWebviewStore((s) => s.markAvailable)
  const markFailed = useWebviewStore((s) => s.markFailed)

  /**
   * Kick off polling for a webview-enabled command. Called after the
   * pty write completes (or after a partner-toggle delay) so the button
   * starts pulsing in lock-step with the command actually being sent.
   * Always keyed by the parent session id (not PTY id) so Claude and
   * Partner CommandBars share the same status.
   *
   * `startActivation` returns a monotonic token. We pass it to mark*()
   * so a slow earlier poll can't clobber a newer activation's result —
   * matters when the user double-taps the command, or runs two
   * different webview-enabled commands with different URLs back-to-back.
   */
  const startWebviewPolling = (url: string) => {
    const token = startActivation(webviewKey, url)
    pollUrlForContent(url).then((reachable) => {
      if (reachable) markAvailable(webviewKey, url, token)
      else markFailed(webviewKey, token)
    })
  }

  /** Send a command to the appropriate PTY */
  const sendCommand = (cmd: CustomCommand, fullCommand: string) => {
    const target = cmd.target || 'any'
    const webViewUrl = cmd.webView?.enabled ? cmd.webView.url : null

    const writeTo = (ptyId: string) => {
      window.electronAPI.pty.write(ptyId, fullCommand + '\r')
      if (webViewUrl) {
        // Webview-enabled command — full 30s pending → available/failed
        // poll, owned by startWebviewPolling.
        startWebviewPolling(webViewUrl)
      } else if (webviewUrls.length > 0) {
        // Any other command-button press is a natural moment to re-verify
        // the webview URLs for this session — catches "user stopped the
        // dev server" without burning a background interval. Skipped
        // when a startWebviewPolling cycle is in flight (pending).
        void probeWebviewUrls(webviewKey, webviewUrls)
      }
    }

    if (target === 'partner' && !isPartnerActive && onTogglePartner && partnerSessionId) {
      onTogglePartner()
      setTimeout(() => writeTo(partnerSessionId), 100)
      return
    }
    if (target === 'claude' && isPartnerActive && onTogglePartner) {
      onTogglePartner()
      setTimeout(() => writeTo(sessionId), 100)
      return
    }
    // 'any' or already on the right terminal
    const targetId = target === 'partner' && partnerSessionId ? partnerSessionId
      : target === 'claude' ? sessionId
      : (isPartnerActive && partnerSessionId ? partnerSessionId : sessionId)
    writeTo(targetId)
  }

  // One-shot auto-detect on mount — catches a dev server that was
  // already running before the app launched. No background interval:
  // re-verification happens when the user clicks any command button
  // for this session (see writeTo above). Constant polling was the
  // previous approach; user vetoed it as wasteful.
  const webviewUrls = visibleCommands
    .filter((c) => c.webView?.enabled && c.webView.url)
    .map((c) => c.webView!.url)
  const webviewUrlsKey = webviewUrls.join('|')
  useEffect(() => {
    if (webviewUrls.length === 0) return
    void probeWebviewUrls(webviewKey, webviewUrls)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webviewKey, webviewUrlsKey])

  const hasWebviewCommand = webviewUrls.length > 0

  const handleClick = (cmd: CustomCommand, e: React.MouseEvent) => {
    // Ctrl+click: show args popover if command has args
    if (e.ctrlKey && (cmd.defaultArgs?.length || cmd.lastCustomArgs?.length)) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setArgsPopover({ cmd, rect })
      return
    }
    sendCommand(cmd, buildFullCommand(cmd))
  }

  const handleContextMenu = (e: React.MouseEvent, commandId?: string, rowTarget?: 'claude' | 'partner') => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, commandId, rowTarget })
  }

  const handleAdd = (data: Omit<CustomCommand, 'id'>) => {
    addCommand({ ...data, id: generateId() })
    trackUsage('commands.create-command')
    setShowDialog(false)
  }

  const handleEdit = (data: Omit<CustomCommand, 'id'>) => {
    if (editingCommand) {
      updateCommand(editingCommand.id, data)
      setEditingCommand(null)
    }
  }

  // --- Command drag-and-drop ---
  const handleDragStart = (e: React.DragEvent, cmd: CustomCommand) => {
    setDragId(cmd.id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', cmd.id)
    e.dataTransfer.setData('application/x-command', cmd.id)
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
    // Assign to same section as target
    moved.sectionId = targetCmd.sectionId
    newCommands.splice(toIdx, 0, moved)
    reorderCommands(newCommands)
    setDragId(null)
    setDragOverId(null)
    setDragOverSectionId(null)
  }

  const handleDragEnd = () => {
    setDragId(null)
    setDragOverId(null)
    setDragOverSectionId(null)
    setDragSectionId(null)
    setDragOverSectionTargetId(null)
  }

  // --- Drop command onto section header to assign it ---
  const handleSectionDragOver = (e: React.DragEvent, sectionId: string) => {
    e.preventDefault()
    e.stopPropagation()
    // Only accept command drags (not section drags)
    if (dragId && !dragSectionId) {
      e.dataTransfer.dropEffect = 'move'
      setDragOverSectionId(sectionId)
    }
    // Accept section drags for reordering
    if (dragSectionId && dragSectionId !== sectionId) {
      e.dataTransfer.dropEffect = 'move'
      setDragOverSectionTargetId(sectionId)
    }
  }

  const handleSectionDrop = (e: React.DragEvent, sectionId: string) => {
    e.preventDefault()
    e.stopPropagation()
    // Command dropped on section header — assign it
    if (dragId && !dragSectionId) {
      updateCommand(dragId, { sectionId })
      setDragId(null)
      setDragOverSectionId(null)
      return
    }
    // Section dropped on section — reorder
    if (dragSectionId && dragSectionId !== sectionId) {
      const newSections = [...sections]
      const fromIdx = newSections.findIndex((s) => s.id === dragSectionId)
      const toIdx = newSections.findIndex((s) => s.id === sectionId)
      if (fromIdx !== -1 && toIdx !== -1) {
        const [moved] = newSections.splice(fromIdx, 1)
        newSections.splice(toIdx, 0, moved)
        reorderSections(newSections)
      }
      setDragSectionId(null)
      setDragOverSectionTargetId(null)
    }
  }

  // --- Drop command on unsectioned area to unassign from section ---
  const handleUnsectionedDragOver = (e: React.DragEvent) => {
    if (dragId && !dragSectionId) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDragOverSectionId('__unsectioned__')
    }
  }

  const handleUnsectionedDrop = (e: React.DragEvent) => {
    e.preventDefault()
    if (dragId && !dragSectionId) {
      updateCommand(dragId, { sectionId: undefined })
      setDragId(null)
      setDragOverSectionId(null)
    }
  }

  // --- Section header drag-and-drop ---
  const handleSectionDragStart = (e: React.DragEvent, section: CommandSection) => {
    setDragSectionId(section.id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-section', section.id)
  }

  /** Toggle section collapse via shared store (synced across Claude/Partner). */
  const toggleSection = (sectionId: string) => {
    toggleSectionCollapse(sectionId)
  }

  // Render a single command button as a NEUTRAL chip.
  // The command's colour reads as a small dot in front of the label rather
  // than tinting the whole button (P4b + the 2026-04-25 pass). A saturated
  // chip-per-button row dominated the strip and clashed with the active-tab
  // marker; the neutral surface chip mirrors the tool-button style and the
  // dot carries identity. Drag-over still uses the blue ring -- a transient
  // affordance, not the command colour.
  const renderCommandButton = (cmd: CustomCommand) => {
    const color = cmd.color || 'var(--accent)'
    const isDragging = dragId === cmd.id
    const isDragOver = dragOverId === cmd.id
    const hasArgs = (cmd.defaultArgs && cmd.defaultArgs.length > 0) || (cmd.lastCustomArgs && cmd.lastCustomArgs.length > 0)
    const argsTitle = cmd.defaultArgs?.length
      ? `${cmd.prompt}\nArgs: ${cmd.defaultArgs.join(' ')}\nCtrl+click to customize args`
      : (cmd.label || cmd.prompt)
    // Token-driven neutral pill (UAT R2 Task 4). The command's colour reads
    // as a small leading dot; the surface stays neutral so the strip is calm
    // and consistent with the SessionStatusStrip control cluster. Drag-over
    // keeps a transient accent ring -- an affordance, not the command colour.
    // Hover is applied via inline style so it tracks semantic tokens (and
    // both themes) rather than legacy Catppuccin utility classes.
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
        className="flex items-center gap-1.5 px-2 py-0.5 text-xs rounded-md border whitespace-nowrap shrink-0 transition-colors duration-150 focus-ring"
        style={{
          opacity: isDragging ? 0.4 : 1,
          cursor: isDragging ? 'grabbing' : 'grab',
          background: isDragOver ? 'var(--surface-overlay)' : 'var(--surface-raised)',
          color: isDragOver ? 'var(--text-primary)' : 'var(--text-secondary)',
          borderColor: isDragOver ? 'var(--brand)' : 'var(--border-subtle)',
          borderLeftWidth: isDragOver ? '2px' : undefined,
        }}
        onMouseEnter={(e) => { if (!isDragging) { e.currentTarget.style.background = 'var(--surface-overlay)'; e.currentTarget.style.color = 'var(--text-primary)' } }}
        onMouseLeave={(e) => { if (!isDragOver) { e.currentTarget.style.background = 'var(--surface-raised)'; e.currentTarget.style.color = 'var(--text-secondary)' } }}
        title={argsTitle}
      >
        <span
          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
          style={{ backgroundColor: color }}
          aria-hidden
        />
        <span className="truncate">{cmd.label}</span>
        {hasArgs && (
          <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0 opacity-50" style={{ color: 'var(--text-muted)' }}>
            <path d="M2 3.5l3 3 3-3" />
          </svg>
        )}
      </button>
    )
  }

  /** Render commands grouped by section */
  const renderGroupedCommands = (cmds: CustomCommand[], rowTarget: 'claude' | 'partner') => {
    const visibleSections = sections.filter(
      (s) => (s.scope === 'global' || (s.scope === 'config' && s.configId === configId))
        && (!s.target || s.target === rowTarget)
    )

    // Orphan commands — those whose sectionId points to a section not visible
    // on the current config — fall through to the unsectioned row. Without
    // this, a global command parked inside a config-scoped section would
    // render only on that config, breaking the "global applies to all" promise.
    const visibleSectionIds = new Set(visibleSections.map((s) => s.id))
    const unsectioned = cmds.filter(
      (c) => !c.sectionId || !visibleSectionIds.has(c.sectionId),
    )
    const bySectionId = new Map<string, CustomCommand[]>()
    for (const cmd of cmds) {
      if (cmd.sectionId && visibleSectionIds.has(cmd.sectionId)) {
        const list = bySectionId.get(cmd.sectionId) || []
        list.push(cmd)
        bySectionId.set(cmd.sectionId, list)
      }
    }

    const isUnsectionedDropTarget = dragOverSectionId === '__unsectioned__'

    return (
      <>
        {/* Unsectioned commands — also a drop target to unassign from sections */}
        <div
          className={`flex items-center gap-1 shrink-0 rounded px-0.5 transition-colors ${isUnsectionedDropTarget ? 'bg-blue/10 ring-1 ring-blue/30' : ''}`}
          onDragOver={handleUnsectionedDragOver}
          onDrop={handleUnsectionedDrop}
          onDragLeave={() => { if (dragOverSectionId === '__unsectioned__') setDragOverSectionId(null) }}
        >
          {unsectioned.map(renderCommandButton)}
        </div>
        {/* All sections — always shown, even when empty */}
        {visibleSections.map((section, idx) => {
          const sectionCmds = bySectionId.get(section.id) || []
          const isCollapsed = collapsedSectionIds.includes(section.id)
          const isDropTarget = dragOverSectionId === section.id
          const isSectionDragging = dragSectionId === section.id
          const isSectionDropTarget = dragOverSectionTargetId === section.id
          const showDivider = unsectioned.length > 0 || idx > 0
          return (
            <React.Fragment key={section.id}>
              {showDivider && <div className="w-px h-5 bg-surface1 mx-1 shrink-0" />}
              {/* Section header — drop target for commands + draggable for reorder */}
              <div
                className={`flex items-center gap-1 shrink-0 rounded transition-all ${isDropTarget ? 'bg-blue/15 ring-1 ring-blue/40' : ''} ${isSectionDropTarget ? 'ring-1 ring-mauve/40' : ''}`}
                onDragOver={(e) => handleSectionDragOver(e, section.id)}
                onDrop={(e) => handleSectionDrop(e, section.id)}
                onDragLeave={() => {
                  if (dragOverSectionId === section.id) setDragOverSectionId(null)
                  if (dragOverSectionTargetId === section.id) setDragOverSectionTargetId(null)
                }}
              >
                <button
                  draggable
                  onDragStart={(e) => handleSectionDragStart(e, section)}
                  onDragEnd={handleDragEnd}
                  onClick={() => toggleSection(section.id)}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, sectionId: section.id }) }}
                  className={`flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium transition-colors duration-150 shrink-0 rounded-md border cursor-grab focus-ring ${isSectionDragging ? 'opacity-40' : ''}`}
                  style={{
                    background: isDropTarget ? 'var(--surface-overlay)' : 'var(--surface-raised)',
                    color: isDropTarget ? 'var(--text-primary)' : 'var(--text-secondary)',
                    borderColor: isDropTarget ? 'var(--brand)' : 'var(--border-subtle)',
                  }}
                  onMouseEnter={(e) => { if (!isDropTarget) { e.currentTarget.style.background = 'var(--surface-overlay)'; e.currentTarget.style.color = 'var(--text-primary)' } }}
                  onMouseLeave={(e) => { if (!isDropTarget) { e.currentTarget.style.background = 'var(--surface-raised)'; e.currentTarget.style.color = 'var(--text-secondary)' } }}
                  title={`${section.name} (${sectionCmds.length}) -- click to ${isCollapsed ? 'expand' : 'collapse'}, drag to reorder, right-click for options`}
                >
                  <svg
                    width="7" height="7" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5"
                    className="shrink-0 transition-transform"
                    style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', color: section.color || undefined }}
                  >
                    <path d="M1.5 2.5l2.5 3 2.5-3" />
                  </svg>
                  <span style={{ color: section.color || undefined }}>{section.name}</span>
                  {isCollapsed && sectionCmds.length > 0 && <span className="text-[9px] text-overlay0 font-normal">{sectionCmds.length}</span>}
                </button>
                {!isCollapsed && sectionCmds.map(renderCommandButton)}
              </div>
            </React.Fragment>
          )
        })}
      </>
    )
  }

  return (
    <div className="flex flex-col shrink-0" onContextMenu={(e) => handleContextMenu(e, undefined, 'claude')}>
      {/* Row 1: Magic buttons */}
      <div className="flex items-center gap-1 px-2 py-0.5 border-t" style={{ background: 'var(--surface-chrome)', borderColor: 'var(--border-subtle)' }}>
        {/* Collapse toggle -- chevron + "Commands" + visible-command count.
            Collapsing hides the command rows (2/3) so the strip becomes a
            single slim row. Replaces the old static Tools sparkle icon. */}
        <button
          onClick={toggleBar}
          aria-expanded={!barCollapsed}
          title={barCollapsed ? 'Show commands' : 'Hide commands'}
          className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-overlay0 hover:text-text rounded hover:bg-surface0/60 transition-colors shrink-0 focus-ring cursor-pointer"
        >
          <svg
            width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4"
            className="shrink-0 transition-transform duration-200"
            style={{ transform: barCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
            aria-hidden
          >
            <path d="M2.5 4l2.5 2.5L7.5 4" />
          </svg>
          <span className="font-medium">Commands</span>
          {visibleCommandCount > 0 && (
            <span className="text-[9px] text-overlay0 font-normal tabular-nums">{visibleCommandCount}</span>
          )}
        </button>
        <div className="w-px h-4 bg-surface1 mx-0.5" />
        <ScreenshotButton sessionId={sessionId} sessionType={sessionType} />
        <ExcalidrawButton sessionId={sessionId} />
        <WebviewButton sessionId={webviewKey} hasWebviewCommand={hasWebviewCommand} />
        {/* Back to Claude / Partner toggle - same monochrome tool-button shape as Snap */}
        {partnerEnabled && onTogglePartner && (
          <>
            <div className="w-px h-4 bg-surface1 mx-0.5" />
            <button
              onClick={onTogglePartner}
              className="flex items-center gap-1.5 px-2 py-0.5 text-xs rounded bg-surface0/60 border border-surface1/80 hover:bg-surface1 text-overlay1 hover:text-text transition-colors whitespace-nowrap shrink-0 focus-ring"
              title={isPartnerActive ? 'Switch back to Claude terminal' : 'Switch to partner terminal'}
            >
              {isPartnerActive ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 2v8.5M12 13.5V22M2 12h8.5M13.5 12H22M4.93 4.93l6.01 6.01M13.06 13.06l6.01 6.01M19.07 4.93l-6.01 6.01M10.94 13.06l-6.01 6.01" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="7 8 3 12 7 16" />
                  <polyline points="17 8 21 12 17 16" />
                  <line x1="14" y1="4" x2="10" y2="20" />
                </svg>
              )}
              {isPartnerActive ? 'Claude' : 'Partner'}
            </button>
          </>
        )}
        {/* Spacer */}
        <div className="flex-1" />

        {/* Codex inline option dropdowns -- BottomBar owns the Claude Mode/Model
            controls now, so the Claude pickers that used to live here were
            removed (P4b). Codex sessions keep these because BottomBar's
            Mode/Model cockpit is Claude-only. */}
        {(activeSession?.provider ?? 'claude') === 'codex' && activeSession?.codexOptions && (
          <>
            <PermissionsPresetDropdown
              value={activeSession.codexOptions.permissionsPreset ?? 'standard'}
              onChange={(next) =>
                updateSession(activeSession.id, {
                  codexOptions: { ...activeSession.codexOptions!, permissionsPreset: next },
                })
              }
            />
            <CodexModelDropdown
              value={activeSession.codexOptions.model ?? 'gpt-5.5'}
              onChange={(next) =>
                updateSession(activeSession.id, {
                  codexOptions: { ...activeSession.codexOptions!, model: next },
                })
              }
            />
            <div className="w-px h-4 bg-surface1 mx-0.5" />
          </>
        )}

        <button
          onClick={() => setShowDialog(true)}
          className="px-1.5 py-0.5 text-xs text-overlay0 hover:text-text rounded hover:bg-surface0 shrink-0 focus-ring"
          title="Add command"
        >
          +
        </button>
      </div>

      {/* Command rows (2/3) -- hidden when the bar is collapsed. The wrapper
          animates open via a max-height + opacity transition (220ms); when
          collapsed the rows are removed from the DOM entirely so collapsed
          chips are not focusable/clickable behind a clipped container. */}
      {!barCollapsed && (
        <div className="flex flex-col overflow-hidden animate-[commandbar-expand_0.22s_ease-out]">
          {/* Row 2: Claude commands */}
          {claudeCommands.length > 0 && (
            <div className="flex items-center gap-1 px-2 py-0.5 border-t overflow-x-auto" style={{ background: 'var(--surface-chrome)', borderColor: 'var(--border-subtle)' }} onContextMenu={(e) => { e.stopPropagation(); handleContextMenu(e, undefined, 'claude') }}>
              {/* Section icon: Claude asterisk -- quiet leading label */}
              <div className="shrink-0" title="Claude Commands" style={{ color: 'var(--text-muted)' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M12 2v8.5M12 13.5V22M2 12h8.5M13.5 12H22M4.93 4.93l6.01 6.01M13.06 13.06l6.01 6.01M19.07 4.93l-6.01 6.01M10.94 13.06l-6.01 6.01" />
                </svg>
              </div>
              <div className="w-px h-4 mx-0.5" style={{ background: 'var(--border-subtle)' }} />
              {renderGroupedCommands(claudeCommands, 'claude')}
            </div>
          )}

          {/* Row 3: Partner commands */}
          {showPartnerRow && (
            <div className="flex items-center gap-1 px-2 py-0.5 border-t overflow-x-auto" style={{ background: 'var(--surface-chrome)', borderColor: 'var(--border-subtle)' }} onContextMenu={(e) => { e.stopPropagation(); handleContextMenu(e, undefined, 'partner') }}>
              {/* Section icon: </> code -- quiet leading label */}
              <div className="shrink-0" title="Partner Terminal Commands" style={{ color: 'var(--text-muted)' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="7 8 3 12 7 16" />
                  <polyline points="17 8 21 12 17 16" />
                  <line x1="14" y1="4" x2="10" y2="20" />
                </svg>
              </div>
              <div className="w-px h-4 mx-0.5" style={{ background: 'var(--border-subtle)' }} />
              {renderGroupedCommands(partnerCommands, 'partner')}
            </div>
          )}
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
          sections={sections.filter((s) => (s.scope === 'global' || (s.scope === 'config' && s.configId === configId)) && (!s.target || s.target === (contextMenu.rowTarget || 'claude')))}
          commandSectionId={contextMenu.commandId ? commands.find(c => c.id === contextMenu.commandId)?.sectionId : undefined}
          onClose={() => setContextMenu(null)}
          onAdd={() => { setContextMenu(null); setShowDialog(true) }}
          onAddSection={() => {
            setSectionInput({ x: contextMenu.x, y: contextMenu.y, rowTarget: contextMenu.rowTarget })
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
          onMoveToSection={contextMenu.commandId ? (sectionId: string | undefined) => {
            updateCommand(contextMenu.commandId!, { sectionId })
            setContextMenu(null)
          } : undefined}
          onRenameSection={contextMenu.sectionId ? () => {
            const section = sections.find(s => s.id === contextMenu.sectionId)
            if (section) {
              setSectionInput({ x: contextMenu.x, y: contextMenu.y, editSection: section })
              setContextMenu(null)
            }
          } : undefined}
          onDeleteSection={contextMenu.sectionId ? () => {
            removeSection(contextMenu.sectionId!)
            setContextMenu(null)
          } : undefined}
        />
      )}
      {sectionInput && (
        <SectionNameInput
          x={sectionInput.x}
          y={sectionInput.y}
          initialName={sectionInput.editSection?.name}
          initialColor={sectionInput.editSection?.color}
          onConfirm={(name, color) => {
            if (sectionInput.editSection) {
              updateSection(sectionInput.editSection.id, { name, color })
            } else {
              const { addSection } = useCommandStore.getState()
              addSection({
                id: generateId(),
                name,
                color,
                target: sectionInput.rowTarget,
                scope: configId ? 'config' : 'global',
                configId,
              })
              trackUsage('commands.command-sections')
            }
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

function ContextMenuOverlay({ x, y, onClose, onAdd, onAddSection, onEdit, onDelete, onMoveToSection, onRenameSection, onDeleteSection, sections, commandSectionId }: {
  x: number; y: number
  sections: CommandSection[]
  commandSectionId?: string
  onClose: () => void
  onAdd: () => void
  onAddSection: () => void
  onEdit?: () => void
  onDelete?: () => void
  onMoveToSection?: (sectionId: string | undefined) => void
  onRenameSection?: () => void
  onDeleteSection?: () => void
}) {
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top?: number; bottom?: number }>({ left: x })
  const [showSectionSubmenu, setShowSectionSubmenu] = React.useState(false)

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

  // Section-specific context menu
  if (onRenameSection || onDeleteSection) {
    return (
      <div className="fixed inset-0 z-50" onClick={onClose}>
        <div
          ref={menuRef}
          className="fixed bg-surface0 border border-surface1 rounded-lg shadow-xl py-1 min-w-[160px]"
          style={pos}
          onClick={(e) => e.stopPropagation()}
        >
          {onRenameSection && (
            <button onClick={onRenameSection} className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8.5 1.5l2 2-7 7H1.5v-2z"/></svg>
              Rename Section
            </button>
          )}
          {onDeleteSection && (
            <button onClick={onDeleteSection} className="w-full text-left px-3 py-1.5 text-xs text-red hover:bg-surface1 transition-colors flex items-center gap-2">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
              Delete Section
            </button>
          )}
        </div>
      </div>
    )
  }

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
        {onMoveToSection && sections.length > 0 && (
          <>
            <div className="h-px bg-surface1 my-1" />
            <div
              className="relative"
              onMouseEnter={() => setShowSectionSubmenu(true)}
              onMouseLeave={() => setShowSectionSubmenu(false)}
            >
              <button className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M2 6h8"/><path d="M2 3h8"/><path d="M2 9h8"/></svg>
                Move to Section
                <svg width="8" height="8" viewBox="0 0 8 8" className="ml-auto opacity-60"><path d="M3 1.5l3 2.5-3 2.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              {showSectionSubmenu && (
                <div className="absolute left-full top-0 ml-0.5 bg-surface0 border border-surface1 rounded-lg shadow-xl py-1 min-w-[140px]">
                  {commandSectionId && (
                    <button
                      onClick={() => onMoveToSection(undefined)}
                      className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors"
                    >
                      <span className="text-overlay0">No section</span>
                    </button>
                  )}
                  {sections.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => onMoveToSection(s.id)}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface1 transition-colors ${commandSectionId === s.id ? 'text-blue font-medium' : 'text-text'}`}
                    >
                      {s.name}
                      {commandSectionId === s.id && <span className="ml-2 text-[9px] text-overlay0">current</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        {onEdit && (
          <>
            <div className="h-px bg-surface1 my-1" />
            <button onClick={onEdit} className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8.5 1.5l2 2-7 7H1.5v-2z"/></svg>
              Edit
            </button>
          </>
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

const SECTION_TEXT_COLORS = [
  null,     // default (inherit)
  '#89B4FA', '#A6E3A1', '#F9E2AF', '#F38BA8',
  '#CBA6F7', '#94E2D5', '#FAB387', '#74C7EC',
  '#F5C2E7', '#B4BEFE', '#A6ADC8',
]

/** Floating input for creating/renaming a section */
function SectionNameInput({ x, y, initialName, initialColor, onConfirm, onCancel }: {
  x: number; y: number
  initialName?: string
  initialColor?: string
  onConfirm: (name: string, color?: string) => void
  onCancel: () => void
}) {
  const [name, setName] = React.useState(initialName || '')
  const [color, setColor] = React.useState<string | undefined>(initialColor)
  const ref = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top?: number; bottom?: number }>({ left: x })

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const viewH = window.innerHeight
    const viewW = window.innerWidth
    const left = Math.max(8, Math.min(x, viewW - rect.width - 8))
    if (y + rect.height > viewH - 8) {
      setPos({ left, bottom: viewH - y })
    } else {
      setPos({ left, top: y })
    }
  }, [x, y])

  const submit = () => { if (name.trim()) onConfirm(name.trim(), color) }

  return (
    <div className="fixed inset-0 z-50" onClick={onCancel}>
      <div
        ref={ref}
        className="fixed bg-surface0 border border-surface1 rounded-lg shadow-xl p-3 min-w-[220px]"
        style={pos}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs text-subtext0 mb-2 font-medium">{initialName ? 'Rename Section' : 'New Section'}</div>
        <div className="flex gap-1 mb-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) { e.preventDefault(); submit() }
              if (e.key === 'Escape') onCancel()
            }}
            className="flex-1 px-2 py-1 bg-crust text-xs rounded border border-surface1 outline-none focus:border-blue"
            style={{ color: color || undefined }}
            placeholder="Section name"
            autoFocus
          />
          <button
            onClick={submit}
            disabled={!name.trim()}
            className="px-2 py-1 text-xs bg-blue text-crust rounded hover:bg-blue/80 disabled:opacity-40"
          >
            {initialName ? 'Save' : 'Add'}
          </button>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[10px] text-overlay0 mr-0.5">Color:</span>
          {SECTION_TEXT_COLORS.map((c, i) => (
            <button
              key={i}
              onClick={() => setColor(c || undefined)}
              className={`w-4 h-4 rounded-full border transition-all shrink-0 ${
                (c || undefined) === color ? 'ring-1 ring-offset-1 ring-offset-surface0 ring-blue scale-110' : 'hover:scale-110'
              }`}
              style={{ backgroundColor: c || 'var(--text-muted)', borderColor: c ? c + '60' : 'var(--border-subtle)' }}
              title={c || 'Default'}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

