import React, { useState, useEffect, useRef } from 'react'
import { useSessionStore, Session } from '../stores/sessionStore'
import { useConfigStore, TerminalConfig, ConfigGroup, ConfigSection } from '../stores/configStore'
import { useInsightsStore } from '../stores/insightsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useCloudAgentStore } from '../stores/cloudAgentStore'
import { useVisionStore } from '../stores/visionStore'
import SessionDialog from './SessionDialog'
import { killSessionPty } from '../ptyTracker'
import { ViewType } from '../types/views'
import { trackUsage } from '../stores/tipsStore'
import { generateId } from '../utils/id'
import { matchesShortcut, DEFAULT_SHORTCUTS } from '../utils/shortcuts'
import { markSessionForResumePicker } from '../utils/resumePicker'
import SidebarNav from './sidebar/SidebarNav'
import ConfigRow from './sidebar/ConfigRow'
import SessionRow from './sidebar/SessionRow'
import ConfigContextMenu from './sidebar/ConfigContextMenu'
import SessionContextMenu from './sidebar/SessionContextMenu'
import GroupContextMenu from './sidebar/GroupContextMenu'
import SectionHeader from './sidebar/SectionHeader'
import GroupHeader from './sidebar/GroupHeader'
import SessionSectionHeader from './sidebar/SessionSectionHeader'
import SessionGroupHeader from './sidebar/SessionGroupHeader'
import UpdatePanel from './sidebar/UpdatePanel'
import PinnedConfigsPanel from './sidebar/PinnedConfigsPanel'
import FirstRunCard from './FirstRunCard'
import { useAppMetaStore } from '../stores/appMetaStore'

// Inject keyframes for attention pulse animation (shared with TabBar)
const ATTENTION_STYLES_ID = 'attention-pulse-styles'
function injectAttentionStyles() {
  if (document.getElementById(ATTENTION_STYLES_ID)) return
  const style = document.createElement('style')
  style.id = ATTENTION_STYLES_ID
  style.textContent = `
    @keyframes attention-pulse {
      0%, 100% { opacity: 0; }
      50% { opacity: 0.35; }
    }
    .attention-pulse-bg {
      animation: attention-pulse 2s ease-in-out infinite;
    }
    @keyframes insights-pulse {
      0%, 100% { opacity: 0.5; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.2); }
    }
    .insights-pulse-dot {
      animation: insights-pulse 1.5s ease-in-out infinite;
    }
  `
  document.head.appendChild(style)
}

interface Props {
  currentView: ViewType
  onViewChange: (view: ViewType) => void
  onUpdateRequested?: () => void
  collapsed?: boolean
  onShowHelp?: () => void
  onShowFirstRun?: () => void
  // Suppresses the FirstRunCard while the training/walkthrough is
  // open — clicking "Create Config" otherwise opens GuidedConfigView
  // behind the tour, which the user can't see and which doesn't
  // dismiss the tour. macOS and Windows both affected.
  tourActive?: boolean
}

export default function Sidebar({ currentView, onViewChange, onUpdateRequested, collapsed, onShowHelp, onShowFirstRun, tourActive }: Props) {
  const { sessions, activeSessionId, setActiveSession, removeSession, addSession, updateSession } = useSessionStore()
  const { configs, groups, sections, addConfig, updateConfig, removeConfig, addGroup, renameGroup, removeGroup, toggleGroupCollapsed, moveConfigToGroup, addSection, renameSection, removeSection, toggleSectionCollapsed, moveGroupToSection, moveConfigToSection, togglePinned, duplicateConfig, reorderConfigs } = useConfigStore()
  const appMeta = useAppMetaStore((s) => s.meta)
  const updateAppMeta = useAppMetaStore((s) => s.update)
  const showFirstRunCard = configs.length === 0 && !appMeta.hasCreatedFirstConfig && !appMeta.firstRunCardDismissed && !tourActive
  const insightsStatus = useInsightsStore((s) => s.status)
  const insightsMessage = useInsightsStore((s) => s.statusMessage)
  const cloudAgentRunning = useCloudAgentStore((s) => s.agents.filter(a => a.status === 'running' || a.status === 'pending').length)
  const visionRunning = useVisionStore((s) => s.running)
  const visionConnected = useVisionStore((s) => s.connected)
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [editingConfig, setEditingConfig] = useState<TerminalConfig | null>(null)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  const [checking, setChecking] = useState(false)
  const [contextMenuConfig, setContextMenuConfig] = useState<{ configId: string; x: number; y: number } | null>(null)
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [sessionGroupCollapsed, setSessionGroupCollapsed] = useState<Record<string, boolean>>({})
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [sessionRenameValue, setSessionRenameValue] = useState('')
  const [sessionContextMenu, setSessionContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null)
  const [renamingSectionId, setRenamingSectionId] = useState<string | null>(null)
  const [sectionRenameValue, setSectionRenameValue] = useState('')
  const [sessionSectionCollapsed, setSessionSectionCollapsed] = useState<Record<string, boolean>>({})
  const [groupContextMenu, setGroupContextMenu] = useState<{ groupId: string; x: number; y: number } | null>(null)
  const [showNewSectionInput, setShowNewSectionInput] = useState(false)
  const [newSectionName, setNewSectionName] = useState('')
  const [configPanelOpen, setConfigPanelOpen] = useState(false)
  const configPanelPinned = useSettingsStore((s) => s.settings.configPanelPinned)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const setConfigPanelPinned = (val: boolean | ((prev: boolean) => boolean)) => {
    const newVal = typeof val === 'function' ? val(configPanelPinned) : val
    updateSettings({ configPanelPinned: newVal })
  }
  const [configSearchQuery, setConfigSearchQuery] = useState('')
  const [dragConfigId, setDragConfigId] = useState<string | null>(null)
  const [dragOverConfigId, setDragOverConfigId] = useState<string | null>(null)
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set())
  const [focusedSessionIndex, setFocusedSessionIndex] = useState(-1)
  const configPanelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const sessionRenameRef = useRef<HTMLInputElement>(null)
  const sectionRenameRef = useRef<HTMLInputElement>(null)
  const newSectionInputRef = useRef<HTMLInputElement>(null)

  // Inject attention styles on mount
  useEffect(() => {
    injectAttentionStyles()
  }, [])

  // Check for updates on startup and subscribe to push notifications
  useEffect(() => {
    setChecking(true)
    window.electronAPI.update.check().then((available) => {
      setUpdateAvailable(available)
      setChecking(false)
    }).catch(() => setChecking(false))
    const unsubAvailable = window.electronAPI.update.onAvailable((available, version) => {
      setUpdateAvailable(available)
      if (version) setUpdateVersion(version)
      setChecking(false)
    })
    return () => { unsubAvailable() }
  }, [])

  const handleCheckForUpdates = () => {
    if (checking) return
    setChecking(true)
    window.electronAPI.update.check().then(async (available) => {
      setUpdateAvailable(available)
      if (available) {
        try {
          const ver = await window.electronAPI.update.getVersion()
          if (ver) setUpdateVersion(ver)
        } catch { /* ignore */ }
      }
      setChecking(false)
    }).catch(() => setChecking(false))
  }

  const handleInstallUpdate = () => {
    if (updating) return
    if (onUpdateRequested) {
      onUpdateRequested()
    } else {
      setUpdating(true)
      window.electronAPI.update.installAndRestart().catch(() => setUpdating(false))
    }
  }

  // New config shortcut (configurable)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const sc = useSettingsStore.getState().settings.keyboardShortcuts || DEFAULT_SHORTCUTS
      if (matchesShortcut(e, sc.newConfig)) {
        e.preventDefault()
        setShowNewDialog(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleCreateConfig = async (data: Omit<TerminalConfig, 'id'>, password?: string, sudoPassword?: string) => {
    const config: TerminalConfig = { ...data, id: generateId() }
    addConfig(config)
    // Save credentials to the encrypted store (main process handles decryption at spawn time)
    if (password) {
      await window.electronAPI.credentials.save(config.id, password)
    }
    if (sudoPassword) {
      await window.electronAPI.credentials.save(config.id + '_sudo', sudoPassword)
    }
    setShowNewDialog(false)
    launchFromConfig(config)
  }

  const handleEditConfig = async (data: Omit<TerminalConfig, 'id'>, password?: string, sudoPassword?: string) => {
    if (!editingConfig) return
    updateConfig(editingConfig.id, data)
    sessions.forEach((s) => {
      if (s.configId === editingConfig.id) {
        updateSession(s.id, { color: data.color, label: data.label })
      }
    })
    // Save credentials to the encrypted store (main process handles decryption at spawn time)
    if (password) {
      await window.electronAPI.credentials.save(editingConfig.id, password)
    }
    if (sudoPassword) {
      await window.electronAPI.credentials.save(editingConfig.id + '_sudo', sudoPassword)
    }
    setEditingConfig(null)
  }

  const handleDeleteConfig = async (configId: string) => {
    removeConfig(configId)
    await window.electronAPI.credentials.delete(configId)
  }

  const launchFromConfig = async (config: TerminalConfig) => {
    // Credentials are resolved in the main process at PTY spawn time — never loaded in the renderer
    const session: Session = {
      id: generateId(),
      configId: config.id,
      label: config.label,
      workingDirectory: config.workingDirectory,
      model: config.claudeOptions?.model ?? '',
      color: config.color,
      status: 'idle',
      createdAt: Date.now(),
      sessionType: config.sessionType,
      shellOnly: config.shellOnly,
      partnerTerminalPath: config.partnerTerminalPath,
      partnerElevated: config.partnerElevated,
      sshConfig: config.sshConfig ? {
        host: config.sshConfig.host,
        port: config.sshConfig.port,
        username: config.sshConfig.username,
        remotePath: config.sshConfig.remotePath,
        hasPassword: config.sshConfig.hasPassword,
        postCommand: config.sshConfig.postCommand,
        hasSudoPassword: config.sshConfig.hasSudoPassword,
      } : undefined,
      legacyVersion: config.claudeOptions?.legacyVersion,
      agentIds: config.claudeOptions?.agentIds,
      machineName: config.machineName,
      effortLevel: config.claudeOptions?.effortLevel,
      disableAutoMemory: config.claudeOptions?.disableAutoMemory,
    }
    if (!session.shellOnly && session.sessionType === 'local') {
      markSessionForResumePicker(session.id)
    }
    addSession(session)
    onViewChange('sessions')
  }

  const launchGroup = async (groupId: string) => {
    const groupConfigs = configs.filter((c) => c.groupId === groupId)
    for (const config of groupConfigs) {
      await launchFromConfig(config)
    }
  }

  const handleConfigContextMenu = (e: React.MouseEvent, configId: string) => {
    e.preventDefault()
    setContextMenuConfig({ configId, x: e.clientX, y: e.clientY })
  }

  const handleMoveToGroup = (configId: string, groupId: string | undefined) => {
    moveConfigToGroup(configId, groupId)
    setContextMenuConfig(null)
  }

  const handleCreateGroupAndMove = (configId: string, name: string) => {
    if (!name.trim()) return
    const id = generateId()
    addGroup({ id, name: name.trim() })
    moveConfigToGroup(configId, id)
    setContextMenuConfig(null)
  }

  const handleStartRename = (groupId: string, currentName: string) => {
    setRenamingGroupId(groupId)
    setRenameValue(currentName)
    setTimeout(() => renameInputRef.current?.focus(), 0)
  }

  const handleFinishRename = () => {
    if (renamingGroupId && renameValue.trim()) {
      renameGroup(renamingGroupId, renameValue.trim())
    }
    setRenamingGroupId(null)
    setRenameValue('')
  }

  const handleStartSessionRename = (sessionId: string, currentLabel: string) => {
    setRenamingSessionId(sessionId)
    setSessionRenameValue(currentLabel)
    setSessionContextMenu(null)
    setTimeout(() => sessionRenameRef.current?.focus(), 0)
  }

  const handleFinishSessionRename = () => {
    if (renamingSessionId && sessionRenameValue.trim()) {
      const newLabel = sessionRenameValue.trim()
      updateSession(renamingSessionId, { label: newLabel })
      const session = sessions.find((s) => s.id === renamingSessionId)
      if (session?.configId) {
        updateConfig(session.configId, { label: newLabel })
      }
    }
    setRenamingSessionId(null)
    setSessionRenameValue('')
  }

  const handleStartSectionRename = (sectionId: string, currentName: string) => {
    setRenamingSectionId(sectionId)
    setSectionRenameValue(currentName)
    setTimeout(() => sectionRenameRef.current?.focus(), 0)
  }

  const handleFinishSectionRename = () => {
    if (renamingSectionId && sectionRenameValue.trim()) {
      renameSection(renamingSectionId, sectionRenameValue.trim())
    }
    setRenamingSectionId(null)
    setSectionRenameValue('')
  }

  const handleGroupContextMenu = (e: React.MouseEvent, groupId: string) => {
    e.preventDefault()
    setGroupContextMenu({ groupId, x: e.clientX, y: e.clientY })
  }

  const handleMoveGroupToSection = (groupId: string, sectionId: string | undefined) => {
    moveGroupToSection(groupId, sectionId)
    setGroupContextMenu(null)
  }

  const handleCreateSectionAndMoveGroup = (groupId: string, name: string) => {
    if (!name.trim()) return
    const id = generateId()
    addSection({ id, name: name.trim() })
    moveGroupToSection(groupId, id)
    setGroupContextMenu(null)
  }

  const handleMoveConfigToSection = (configId: string, sectionId: string | undefined) => {
    moveConfigToSection(configId, sectionId)
    setContextMenuConfig(null)
  }

  const handleCreateSectionAndMoveConfig = (configId: string, name: string) => {
    if (!name.trim()) return
    const id = generateId()
    addSection({ id, name: name.trim() })
    moveConfigToSection(configId, id)
    setContextMenuConfig(null)
  }

  const launchSection = async (sectionId: string) => {
    const sectionGroups = groups.filter((g) => g.sectionId === sectionId)
    const sectionGroupIds = new Set(sectionGroups.map((g) => g.id))
    const sectionConfigs = configs.filter((c) => {
      if (c.groupId && sectionGroupIds.has(c.groupId)) return true
      if (!c.groupId && c.sectionId === sectionId) return true
      return false
    })
    for (const config of sectionConfigs) {
      await launchFromConfig(config)
    }
  }

  const handleCreateSection = () => {
    if (!newSectionName.trim()) return
    const id = generateId()
    addSection({ id, name: newSectionName.trim() })
    setNewSectionName('')
    setShowNewSectionInput(false)
  }

  // DnD handlers for config reordering
  const handleConfigDragStart = (e: React.DragEvent, configId: string) => {
    setDragConfigId(configId)
    e.dataTransfer.effectAllowed = 'move'
  }
  const handleConfigDragOver = (e: React.DragEvent, configId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverConfigId(configId)
  }
  const handleConfigDrop = (e: React.DragEvent, targetConfigId: string) => {
    e.preventDefault()
    if (!dragConfigId || dragConfigId === targetConfigId) return
    const fromIdx = configs.findIndex(c => c.id === dragConfigId)
    const toIdx = configs.findIndex(c => c.id === targetConfigId)
    if (fromIdx === -1 || toIdx === -1) return
    const reordered = [...configs]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    reorderConfigs(reordered)
    setDragConfigId(null)
    setDragOverConfigId(null)
  }
  const handleConfigDragEnd = () => {
    setDragConfigId(null)
    setDragOverConfigId(null)
  }

  // Multi-select session handlers
  const handleSessionClick = (sessionId: string, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedSessionIds(prev => {
        const next = new Set(prev)
        if (next.has(sessionId)) next.delete(sessionId)
        else next.add(sessionId)
        return next
      })
    } else {
      setSelectedSessionIds(new Set())
      setActiveSession(sessionId)
      onViewChange('sessions')
    }
  }
  const handleBulkClose = () => {
    selectedSessionIds.forEach(id => { killSessionPty(id); removeSession(id) })
    setSelectedSessionIds(new Set())
  }

  // Config search filter
  const matchesSearch = (config: TerminalConfig): boolean => {
    if (!configSearchQuery) return true
    const q = configSearchQuery.toLowerCase()
    if (config.label.toLowerCase().includes(q)) return true
    const group = config.groupId ? groups.find(g => g.id === config.groupId) : undefined
    if (group?.name.toLowerCase().includes(q)) return true
    const section = config.sectionId ? sections.find(s => s.id === config.sectionId) : undefined
    if (section?.name.toLowerCase().includes(q)) return true
    return false
  }

  // Filter configs by search (used only in the overlay)
  const filteredConfigs = configSearchQuery ? configs.filter(matchesSearch) : configs

  // Organize configs by section -> group hierarchy
  const getConfigEffectiveSection = (config: TerminalConfig): string | undefined => {
    if (config.groupId) {
      const group = groups.find((g) => g.id === config.groupId)
      return group?.sectionId
    }
    return config.sectionId
  }

  const sectionData = sections.map((section) => {
    const sectionGroups = groups
      .filter((g) => g.sectionId === section.id)
      .map((group) => ({
        group,
        configs: filteredConfigs.filter((c) => c.groupId === group.id)
      }))
      .filter((g) => g.configs.length > 0)
    const looseConfigs = filteredConfigs.filter(
      (c) => !c.groupId && c.sectionId === section.id
    )
    return { section, groups: sectionGroups, looseConfigs }
  }).filter((s) => s.groups.length > 0 || s.looseConfigs.length > 0)

  const unsectionedGroups = groups
    .filter((g) => !g.sectionId || !sections.some((s) => s.id === g.sectionId))
    .map((group) => ({
      group,
      configs: filteredConfigs.filter((c) => c.groupId === group.id)
    }))
    .filter((g) => g.configs.length > 0)

  const unsectionedUngroupedConfigs = filteredConfigs.filter(
    (c) => (!c.groupId || !groups.some((g) => g.id === c.groupId)) &&
           (!c.sectionId || !sections.some((s) => s.id === c.sectionId))
  )

  // Session organization mirrors config hierarchy
  const getSessionGroup = (session: Session): string | undefined => {
    if (!session.configId) return undefined
    const config = configs.find((c) => c.id === session.configId)
    return config?.groupId
  }

  const getSessionEffectiveSection = (session: Session): string | undefined => {
    if (!session.configId) return undefined
    const config = configs.find((c) => c.id === session.configId)
    if (!config) return undefined
    return getConfigEffectiveSection(config)
  }

  const sessionSectionData = sections.map((section) => {
    const sectionGroups = groups
      .filter((g) => g.sectionId === section.id)
      .map((group) => ({
        group,
        sessions: sessions.filter((s) => getSessionGroup(s) === group.id)
      }))
      .filter((g) => g.sessions.length > 0)
    const looseSessions = sessions.filter((s) => {
      const gid = getSessionGroup(s)
      if (gid) return false
      return getSessionEffectiveSection(s) === section.id
    })
    return { section, groups: sectionGroups, looseSessions }
  }).filter((s) => s.groups.length > 0 || s.looseSessions.length > 0)

  const unsectionedSessionGroups = groups
    .filter((g) => !g.sectionId || !sections.some((s) => s.id === g.sectionId))
    .map((group) => ({
      group,
      sessions: sessions.filter((s) => getSessionGroup(s) === group.id)
    }))
    .filter((g) => g.sessions.length > 0)

  const unsectionedUngroupedSessions = sessions.filter((s) => {
    const gid = getSessionGroup(s)
    const sid = getSessionEffectiveSection(s)
    return (!gid || !groups.some((g) => g.id === gid)) &&
           (!sid || !sections.some((sec) => sec.id === sid))
  })

  // Collapsed mode: just show the icon rail
  if (collapsed) {
    return (
      <aside className="w-12 bg-mantle flex flex-col border-r border-surface0 shrink-0 select-none titlebar-no-drag transition-[width] duration-200">
        <SidebarNav
          currentView={currentView}
          onViewChange={onViewChange}
          insightsStatus={insightsStatus}
          insightsMessage={insightsMessage}
          cloudAgentRunning={cloudAgentRunning}
          visionRunning={visionRunning}
          visionConnected={visionConnected}
          collapsed
          onShowHelp={onShowHelp}
        />
      </aside>
    )
  }

  // Helper to render a config row with DnD props
  const renderConfigRow = (config: TerminalConfig) => (
    <ConfigRow
      key={config.id}
      config={config}
      onLaunch={() => launchFromConfig(config)}
      onEdit={() => setEditingConfig(config)}
      onDelete={() => handleDeleteConfig(config.id)}
      onPin={() => togglePinned(config.id)}
      onContextMenu={(e) => handleConfigContextMenu(e, config.id)}
      draggable
      onDragStart={(e) => handleConfigDragStart(e, config.id)}
      onDragOver={(e) => handleConfigDragOver(e, config.id)}
      onDrop={(e) => handleConfigDrop(e, config.id)}
      onDragEnd={handleConfigDragEnd}
      isDragOver={dragOverConfigId === config.id}
    />
  )

  // Helper to render a session row with multi-select and keyboard nav
  const renderSessionRow = (session: Session) => {
    const flatIndex = sessions.indexOf(session)
    return (
      <SessionRow
        key={session.id}
        session={session}
        isActive={activeSessionId === session.id && currentView === 'sessions'}
        needsAttention={!!session.needsAttention && activeSessionId !== session.id}
        isRenaming={renamingSessionId === session.id}
        renameValue={sessionRenameValue}
        renameRef={sessionRenameRef}
        onRenameChange={setSessionRenameValue}
        onRenameFinish={handleFinishSessionRename}
        onRenameCancel={() => { setRenamingSessionId(null); setSessionRenameValue('') }}
        onClick={(e) => handleSessionClick(session.id, e)}
        onContextMenu={(e) => { e.preventDefault(); setSessionContextMenu({ sessionId: session.id, x: e.clientX, y: e.clientY }) }}
        isSelected={selectedSessionIds.has(session.id)}
        isFocused={focusedSessionIndex === flatIndex}
      />
    )
  }

  return (
    <aside className="w-64 bg-mantle flex flex-col border-r border-surface0 shrink-0 select-none titlebar-no-drag relative transition-[width] duration-200">
      {/* Navigation */}
      <SidebarNav
        currentView={currentView}
        onViewChange={onViewChange}
        insightsStatus={insightsStatus}
        insightsMessage={insightsMessage}
        cloudAgentRunning={cloudAgentRunning}
        visionRunning={visionRunning}
        visionConnected={visionConnected}
        onShowHelp={onShowHelp}
      />

      {/* Saved Configs — hover trigger or pinned inline */}
      <div
        className="relative"
        onMouseEnter={() => {
          if (!configPanelPinned) {
            if (configPanelTimeoutRef.current) clearTimeout(configPanelTimeoutRef.current)
            setConfigPanelOpen(true)
          }
        }}
        onMouseLeave={() => {
          if (!configPanelPinned) {
            configPanelTimeoutRef.current = setTimeout(() => setConfigPanelOpen(false), 150)
          }
        }}
      >
        <div className="p-3 flex items-center justify-between cursor-pointer hover:bg-surface0/30 transition-colors">
          <div className="flex items-center gap-1.5">
            <svg
              width="10" height="10" viewBox="0 0 10 10" fill="currentColor"
              className="text-overlay0 transition-transform"
              style={{ transform: (configPanelOpen || configPanelPinned) ? 'rotate(0deg)' : 'rotate(-90deg)' }}
            >
              <polygon points="2,2 8,5 2,8" />
            </svg>
            <span className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Saved Configs</span>
            <span className="text-[10px] text-overlay0">{configs.length}</span>
          </div>
          <div className="flex gap-0.5">
            <button
              onClick={(e) => {
                e.stopPropagation()
                setConfigPanelPinned(prev => {
                  if (!prev) setConfigPanelOpen(true)
                  return !prev
                })
              }}
              className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${configPanelPinned ? 'bg-blue/20 text-blue' : 'hover:bg-surface0 text-overlay1 hover:text-text'}`}
              title={configPanelPinned ? 'Unpin config panel' : 'Pin config panel open'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
              </svg>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setShowNewSectionInput(true); setConfigPanelOpen(true); setTimeout(() => newSectionInputRef.current?.focus(), 0) }}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface0 text-overlay1 hover:text-text transition-colors"
              title="New section"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="1" y="2" width="12" height="10" rx="1.5" />
                <line x1="1" y1="5" x2="13" y2="5" />
                <line x1="7" y1="7" x2="7" y2="11" />
                <line x1="5" y1="9" x2="9" y2="9" />
              </svg>
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setShowNewDialog(true) }}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface0 text-overlay1 hover:text-text transition-colors"
              title="New config (Ctrl+T)"
            >
              <svg width="14" height="14" viewBox="0 0 14 14"><line x1="7" y1="2" x2="7" y2="12" stroke="currentColor" strokeWidth="1.5"/><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.5"/></svg>
            </button>
          </div>
        </div>

      {/* Config panel — overlay when not pinned, inline when pinned */}
      <div
        className={configPanelPinned
          ? 'border-b border-surface0 overflow-hidden transition-all duration-200'
          : 'absolute left-0 right-0 z-50 border border-surface1/50 rounded-b-lg overflow-hidden transition-all duration-200'
        }
        style={configPanelPinned
          ? { maxHeight: '60vh', backgroundColor: 'var(--color-mantle)' }
          : {
              maxHeight: configPanelOpen ? '60vh' : '0',
              opacity: configPanelOpen ? 1 : 0,
              top: '100%',
              backgroundColor: 'var(--color-base)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            }
        }
      >
        {/* Search input */}
        <div className="px-2 pt-2 pb-1">
          <input
            value={configSearchQuery}
            onChange={(e) => setConfigSearchQuery(e.target.value)}
            placeholder="Search configs..."
            className="w-full bg-base border border-surface1 rounded px-2 py-1 text-xs text-text placeholder:text-overlay0 outline-none focus:border-blue"
          />
        </div>

        <div className="px-2 space-y-0.5 overflow-y-auto pb-2" style={{ maxHeight: 'calc(60vh - 40px)' }}>
        {configs.length === 0 && !showNewSectionInput && (
          <div className="text-xs text-overlay0 text-center py-4">
            No saved configs.<br />Click + to create one.
          </div>
        )}

        {/* New section inline input */}
        {showNewSectionInput && (
          <div className="flex gap-1 px-1 py-1">
            <input
              ref={newSectionInputRef}
              value={newSectionName}
              onChange={(e) => setNewSectionName(e.target.value)}
              onBlur={() => { if (!newSectionName.trim()) { setShowNewSectionInput(false); setNewSectionName('') } }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateSection()
                if (e.key === 'Escape') { setShowNewSectionInput(false); setNewSectionName('') }
              }}
              placeholder="Section name"
              className="flex-1 bg-base border border-blue rounded px-1.5 py-0.5 text-xs text-text placeholder:text-overlay0 outline-none min-w-0"
            />
            <button
              onClick={handleCreateSection}
              className="px-2 py-0.5 rounded text-xs bg-blue text-crust font-medium hover:bg-blue/90 shrink-0"
            >
              OK
            </button>
          </div>
        )}

        {/* Sectioned configs */}
        {sectionData.map(({ section, groups: sectionGroups, looseConfigs }) => (
          <div key={section.id} className="mb-1">
            <SectionHeader
              section={section}
              isRenaming={renamingSectionId === section.id}
              renameValue={sectionRenameValue}
              renameRef={sectionRenameRef}
              onRenameChange={setSectionRenameValue}
              onRenameFinish={handleFinishSectionRename}
              onRenameCancel={() => { setRenamingSectionId(null); setSectionRenameValue('') }}
              onToggleCollapse={() => toggleSectionCollapsed(section.id)}
              onStartRename={() => handleStartSectionRename(section.id, section.name)}
              onLaunchAll={() => launchSection(section.id)}
              onDelete={() => removeSection(section.id)}
            />
            {!section.collapsed && (
              <div className="ml-2 space-y-0.5">
                {sectionGroups.map(({ group, configs: groupConfigs }) => (
                  <div key={group.id} className="mb-1">
                    <GroupHeader
                      group={group}
                      isRenaming={renamingGroupId === group.id}
                      renameValue={renameValue}
                      renameRef={renameInputRef}
                      onRenameChange={setRenameValue}
                      onRenameFinish={handleFinishRename}
                      onRenameCancel={() => { setRenamingGroupId(null); setRenameValue('') }}
                      onToggleCollapse={() => toggleGroupCollapsed(group.id)}
                      onStartRename={() => handleStartRename(group.id, group.name)}
                      onLaunchAll={() => launchGroup(group.id)}
                      onDelete={() => removeGroup(group.id)}
                      onContextMenu={(e) => handleGroupContextMenu(e, group.id)}
                    />
                    {!group.collapsed && (
                      <div className="ml-3 space-y-0.5">
                        {groupConfigs.map(renderConfigRow)}
                      </div>
                    )}
                  </div>
                ))}
                {looseConfigs.map(renderConfigRow)}
              </div>
            )}
          </div>
        ))}

        {/* Unsectioned groups */}
        {unsectionedGroups.map(({ group, configs: groupConfigs }) => (
          <div key={group.id} className="mb-1">
            <GroupHeader
              group={group}
              isRenaming={renamingGroupId === group.id}
              renameValue={renameValue}
              renameRef={renameInputRef}
              onRenameChange={setRenameValue}
              onRenameFinish={handleFinishRename}
              onRenameCancel={() => { setRenamingGroupId(null); setRenameValue('') }}
              onToggleCollapse={() => toggleGroupCollapsed(group.id)}
              onStartRename={() => handleStartRename(group.id, group.name)}
              onLaunchAll={() => launchGroup(group.id)}
              onDelete={() => removeGroup(group.id)}
              onContextMenu={(e) => handleGroupContextMenu(e, group.id)}
            />
            {!group.collapsed && (
              <div className="ml-3 space-y-0.5">
                {groupConfigs.map(renderConfigRow)}
              </div>
            )}
          </div>
        ))}

        {/* Unsectioned ungrouped configs */}
        {unsectionedUngroupedConfigs.map(renderConfigRow)}
      </div>
      </div>{/* end overlay */}
      </div>{/* end relative hover wrapper */}

      {/* Config context menu */}
      {contextMenuConfig && (
        <ConfigContextMenu
          x={contextMenuConfig.x}
          y={contextMenuConfig.y}
          groups={groups}
          sections={sections}
          currentGroupId={configs.find((c) => c.id === contextMenuConfig.configId)?.groupId}
          currentSectionId={configs.find((c) => c.id === contextMenuConfig.configId)?.sectionId}
          isPinned={configs.find((c) => c.id === contextMenuConfig.configId)?.pinned}
          onMoveToGroup={(gid) => handleMoveToGroup(contextMenuConfig.configId, gid)}
          onCreateGroup={(name) => handleCreateGroupAndMove(contextMenuConfig.configId, name)}
          onMoveToSection={(sid) => handleMoveConfigToSection(contextMenuConfig.configId, sid)}
          onCreateSection={(name) => handleCreateSectionAndMoveConfig(contextMenuConfig.configId, name)}
          onEdit={() => {
            const cfg = configs.find((c) => c.id === contextMenuConfig.configId)
            if (cfg) setEditingConfig(cfg)
            setContextMenuConfig(null)
          }}
          onDelete={() => {
            handleDeleteConfig(contextMenuConfig.configId)
            setContextMenuConfig(null)
          }}
          onPin={() => {
            togglePinned(contextMenuConfig.configId)
            trackUsage('sessions.pin-config')
            setContextMenuConfig(null)
          }}
          onDuplicate={() => {
            duplicateConfig(contextMenuConfig.configId)
            trackUsage('sessions.duplicate-config')
            setContextMenuConfig(null)
          }}
          onClose={() => setContextMenuConfig(null)}
        />
      )}

      {/* Group context menu */}
      {groupContextMenu && (
        <GroupContextMenu
          x={groupContextMenu.x}
          y={groupContextMenu.y}
          sections={sections}
          currentSectionId={groups.find((g) => g.id === groupContextMenu.groupId)?.sectionId}
          onMoveToSection={(sid) => handleMoveGroupToSection(groupContextMenu.groupId, sid)}
          onCreateSection={(name) => handleCreateSectionAndMoveGroup(groupContextMenu.groupId, name)}
          onClose={() => setGroupContextMenu(null)}
        />
      )}

      {/* Pinned Configs — below config panel */}
      <PinnedConfigsPanel
        configs={configs.filter(c => c.pinned)}
        onLaunch={(config) => launchFromConfig(config)}
      />

      {/* Active Sessions */}
      <div className="p-3 flex items-center justify-between border-t border-surface0 mt-2">
        <span className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Active Sessions</span>
        {selectedSessionIds.size > 1 && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-overlay0">{selectedSessionIds.size} selected</span>
            <button
              onClick={handleBulkClose}
              className="px-1.5 py-0.5 rounded text-[10px] bg-red/20 text-red hover:bg-red/30 transition-colors"
            >
              Close All
            </button>
            <button
              onClick={() => setSelectedSessionIds(new Set())}
              className="px-1.5 py-0.5 rounded text-[10px] bg-surface1 text-overlay1 hover:bg-surface1/80 transition-colors"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      <div
        className="flex-1 overflow-y-auto px-2 space-y-0.5 pb-28"
        tabIndex={0}
        onKeyDown={(e) => {
          if (sessions.length === 0) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setFocusedSessionIndex(prev => Math.min(prev + 1, sessions.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setFocusedSessionIndex(prev => Math.max(prev - 1, 0))
          } else if (e.key === 'Enter' && focusedSessionIndex >= 0 && focusedSessionIndex < sessions.length) {
            e.preventDefault()
            const s = sessions[focusedSessionIndex]
            setActiveSession(s.id)
            onViewChange('sessions')
          } else if (e.key === 'Delete' && focusedSessionIndex >= 0 && focusedSessionIndex < sessions.length) {
            e.preventDefault()
            const s = sessions[focusedSessionIndex]
            killSessionPty(s.id)
            removeSession(s.id)
            setFocusedSessionIndex(prev => Math.min(prev, sessions.length - 2))
          } else if (e.key === 'Escape') {
            setSelectedSessionIds(new Set())
            setFocusedSessionIndex(-1)
          }
        }}
      >
        {showFirstRunCard && onShowFirstRun && (
          <FirstRunCard
            onGetStarted={onShowFirstRun}
            onDismiss={() => updateAppMeta({ firstRunCardDismissed: true })}
          />
        )}

        {sessions.length === 0 && !showFirstRunCard && (
          <div className="text-xs text-overlay0 text-center py-4">
            No active sessions.
          </div>
        )}

        {/* Sectioned sessions */}
        {sessionSectionData.map(({ section, groups: sectionGroups, looseSessions }) => (
          <div key={section.id} className="mb-1">
            <SessionSectionHeader
              section={section}
              collapsed={sessionSectionCollapsed[section.id]}
              onToggleCollapse={() => setSessionSectionCollapsed((prev) => ({ ...prev, [section.id]: !prev[section.id] }))}
              onCloseAll={() => {
                const allSessions = [
                  ...sectionGroups.flatMap((g) => g.sessions),
                  ...looseSessions
                ]
                allSessions.forEach((s) => { killSessionPty(s.id); removeSession(s.id) })
              }}
            />
            {!sessionSectionCollapsed[section.id] && (
              <div className="ml-2 space-y-0.5">
                {sectionGroups.map(({ group, sessions: groupSessions }) => (
                  <div key={group.id} className="mb-1">
                    <SessionGroupHeader
                      group={group}
                      collapsed={sessionGroupCollapsed[group.id]}
                      onToggleCollapse={() => setSessionGroupCollapsed((prev) => ({ ...prev, [group.id]: !prev[group.id] }))}
                      onCloseAll={() => { groupSessions.forEach((s) => { killSessionPty(s.id); removeSession(s.id) }) }}
                    />
                    {!sessionGroupCollapsed[group.id] && (
                      <div className="ml-3 space-y-0.5">
                        {groupSessions.map(renderSessionRow)}
                      </div>
                    )}
                  </div>
                ))}
                {looseSessions.map(renderSessionRow)}
              </div>
            )}
          </div>
        ))}

        {/* Unsectioned grouped sessions */}
        {unsectionedSessionGroups.map(({ group, sessions: groupSessions }) => (
          <div key={group.id} className="mb-1">
            <SessionGroupHeader
              group={group}
              collapsed={sessionGroupCollapsed[group.id]}
              onToggleCollapse={() => setSessionGroupCollapsed((prev) => ({ ...prev, [group.id]: !prev[group.id] }))}
              onCloseAll={() => { groupSessions.forEach((s) => { killSessionPty(s.id); removeSession(s.id) }) }}
            />
            {!sessionGroupCollapsed[group.id] && (
              <div className="ml-3 space-y-0.5">
                {groupSessions.map(renderSessionRow)}
              </div>
            )}
          </div>
        ))}

        {/* Unsectioned ungrouped sessions */}
        {unsectionedUngroupedSessions.map(renderSessionRow)}
      </div>

      {/* Session context menu */}
      {sessionContextMenu && (() => {
        const s = sessions.find((s) => s.id === sessionContextMenu.sessionId)
        const cfg = s?.configId ? configs.find((c) => c.id === s.configId) : undefined
        return s ? (
          <SessionContextMenu
            x={sessionContextMenu.x}
            y={sessionContextMenu.y}
            session={s}
            hasGroup={!!cfg?.groupId}
            onRename={() => handleStartSessionRename(s.id, s.label)}
            onRemoveFromGroup={() => {
              if (cfg) moveConfigToGroup(cfg.id, undefined)
              setSessionContextMenu(null)
            }}
            onClose={() => {
              killSessionPty(sessionContextMenu.sessionId)
              removeSession(sessionContextMenu.sessionId)
              setSessionContextMenu(null)
            }}
            onDismiss={() => setSessionContextMenu(null)}
          />
        ) : null
      })()}

      {showNewDialog && (
        <SessionDialog
          onConfirm={handleCreateConfig}
          onCancel={() => setShowNewDialog(false)}
        />
      )}

      {editingConfig && (
        <SessionDialog
          onConfirm={handleEditConfig}
          onCancel={() => setEditingConfig(null)}
          initial={editingConfig}
        />
      )}

      {/* Update panel */}
      <UpdatePanel
        updateAvailable={updateAvailable}
        updateVersion={updateVersion}
        updating={updating}
        checking={checking}
        onCheckForUpdates={handleCheckForUpdates}
        onInstallUpdate={handleInstallUpdate}
      />
    </aside>
  )
}
