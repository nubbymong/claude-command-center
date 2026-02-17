import React, { useState, useEffect, useRef } from 'react'
import { useSessionStore, Session } from '../stores/sessionStore'
import { useConfigStore, TerminalConfig, ConfigGroup, ConfigSection } from '../stores/configStore'
import { useInsightsStore } from '../stores/insightsStore'
import SessionDialog from './SessionDialog'
import { killSessionPty } from '../ptyTracker'
import { ViewType, markSessionForResumePicker } from '../App'

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

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

interface Props {
  currentView: ViewType
  onViewChange: (view: ViewType) => void
  onUpdateRequested?: () => void
}

export default function Sidebar({ currentView, onViewChange, onUpdateRequested }: Props) {
  const { sessions, activeSessionId, setActiveSession, removeSession, addSession, updateSession } = useSessionStore()
  const { configs, groups, sections, addConfig, updateConfig, removeConfig, addGroup, renameGroup, removeGroup, toggleGroupCollapsed, moveConfigToGroup, addSection, renameSection, removeSection, toggleSectionCollapsed, moveGroupToSection, moveConfigToSection } = useConfigStore()
  const insightsStatus = useInsightsStore((s) => s.status)
  const insightsMessage = useInsightsStore((s) => s.statusMessage)
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [editingConfig, setEditingConfig] = useState<TerminalConfig | null>(null)
  const [debugRecording, setDebugRecording] = useState(false)
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
  const renameInputRef = useRef<HTMLInputElement>(null)
  const sessionRenameRef = useRef<HTMLInputElement>(null)
  const sectionRenameRef = useRef<HTMLInputElement>(null)
  const newSectionInputRef = useRef<HTMLInputElement>(null)

  // Inject attention styles and check debug mode status on mount
  useEffect(() => {
    injectAttentionStyles()
    window.electronAPI.debug.isEnabled().then(setDebugRecording)
  }, [])

  // Check for updates on startup and subscribe to push notifications
  useEffect(() => {
    // Startup check
    setChecking(true)
    window.electronAPI.update.check().then((available) => {
      setUpdateAvailable(available)
      setChecking(false)
    }).catch(() => setChecking(false))
    // Listen for push notifications (from dev server WebSocket if connected)
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
    window.electronAPI.update.check().then((available) => {
      setUpdateAvailable(available)
      setChecking(false)
    }).catch(() => setChecking(false))
  }

  const handleInstallUpdate = () => {
    if (updating) return
    if (onUpdateRequested) {
      onUpdateRequested()
    } else {
      // Fallback: direct install
      setUpdating(true)
      window.electronAPI.update.installAndRestart().catch(() => setUpdating(false))
    }
  }

  // Ctrl+T shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 't') {
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
    if (password) {
      await window.electronAPI.credentials.save(config.id, password)
    }
    if (sudoPassword) {
      await window.electronAPI.credentials.save(config.id + '_sudo', sudoPassword)
    }
    setShowNewDialog(false)
    // Immediately launch a session from this config
    launchFromConfig(config, password, sudoPassword)
  }

  const handleEditConfig = async (data: Omit<TerminalConfig, 'id'>, password?: string, sudoPassword?: string) => {
    if (!editingConfig) return
    updateConfig(editingConfig.id, data)
    // Propagate visual changes (color, label) to active sessions using this config
    sessions.forEach((s) => {
      if (s.configId === editingConfig.id) {
        updateSession(s.id, { color: data.color, label: data.label })
      }
    })
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

  const launchFromConfig = async (config: TerminalConfig, passwordOverride?: string, sudoPasswordOverride?: string) => {
    let password = passwordOverride
    if (!password && config.sshConfig?.hasPassword) {
      password = (await window.electronAPI.credentials.load(config.id)) ?? undefined
    }

    let sudoPassword = sudoPasswordOverride
    if (!sudoPassword && config.sshConfig?.hasSudoPassword) {
      sudoPassword = (await window.electronAPI.credentials.load(config.id + '_sudo')) ?? undefined
    }

    const session: Session = {
      id: generateId(),
      configId: config.id,
      label: config.label,
      workingDirectory: config.workingDirectory,
      model: config.model,
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
        password,
        postCommand: config.sshConfig.postCommand,
        sudoPassword,
        startClaudeAfter: config.sshConfig.startClaudeAfter,
        dockerContainer: config.sshConfig.dockerContainer
      } : undefined,
      visionConfig: config.visionConfig
    }
    // Mark local Claude sessions for the resume picker
    if (!session.shellOnly && session.sessionType === 'local') {
      markSessionForResumePicker(session.id)
    }
    addSession(session)
    onViewChange('sessions')
  }

  // Launch all configs in a group simultaneously
  const launchGroup = async (groupId: string) => {
    const groupConfigs = configs.filter((c) => c.groupId === groupId)
    for (const config of groupConfigs) {
      await launchFromConfig(config)
    }
  }

  // Context menu handlers for moving configs to groups
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
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
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

  // Session rename: updates both session label and underlying config label
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
      // Also rename the underlying config
      const session = sessions.find((s) => s.id === renamingSessionId)
      if (session?.configId) {
        updateConfig(session.configId, { label: newLabel })
      }
    }
    setRenamingSessionId(null)
    setSessionRenameValue('')
  }

  // Section rename handlers
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

  // Group context menu handlers (for section assignment)
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
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
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
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    addSection({ id, name: name.trim() })
    moveConfigToSection(configId, id)
    setContextMenuConfig(null)
  }

  // Launch all configs in a section
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
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    addSection({ id, name: newSectionName.trim() })
    setNewSectionName('')
    setShowNewSectionInput(false)
  }

  // Organize configs by section -> group hierarchy
  // Get effective section for a config (group's section takes priority)
  const getConfigEffectiveSection = (config: TerminalConfig): string | undefined => {
    if (config.groupId) {
      const group = groups.find((g) => g.id === config.groupId)
      return group?.sectionId
    }
    return config.sectionId
  }

  // Build section data: each section contains its groups and loose configs
  const sectionData = sections.map((section) => {
    const sectionGroups = groups
      .filter((g) => g.sectionId === section.id)
      .map((group) => ({
        group,
        configs: configs.filter((c) => c.groupId === group.id)
      }))
      .filter((g) => g.configs.length > 0)
    const looseConfigs = configs.filter(
      (c) => !c.groupId && c.sectionId === section.id
    )
    return { section, groups: sectionGroups, looseConfigs }
  }).filter((s) => s.groups.length > 0 || s.looseConfigs.length > 0)

  // Groups not in any section
  const unsectionedGroups = groups
    .filter((g) => !g.sectionId || !sections.some((s) => s.id === g.sectionId))
    .map((group) => ({
      group,
      configs: configs.filter((c) => c.groupId === group.id)
    }))
    .filter((g) => g.configs.length > 0)

  // Configs not in any group or section
  const unsectionedUngroupedConfigs = configs.filter(
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

  // Sessions organized by sections
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
      if (gid) return false // has a group, handled above
      return getSessionEffectiveSection(s) === section.id
    })
    return { section, groups: sectionGroups, looseSessions }
  }).filter((s) => s.groups.length > 0 || s.looseSessions.length > 0)

  // Unsectioned grouped sessions
  const unsectionedSessionGroups = groups
    .filter((g) => !g.sectionId || !sections.some((s) => s.id === g.sectionId))
    .map((group) => ({
      group,
      sessions: sessions.filter((s) => getSessionGroup(s) === group.id)
    }))
    .filter((g) => g.sessions.length > 0)

  // Unsectioned ungrouped sessions
  const unsectionedUngroupedSessions = sessions.filter((s) => {
    const gid = getSessionGroup(s)
    const sid = getSessionEffectiveSection(s)
    return (!gid || !groups.some((g) => g.id === gid)) &&
           (!sid || !sections.some((sec) => sec.id === sid))
  })

  const navItems: { view: ViewType; icon: React.ReactNode; label: string }[] = [
    {
      view: 'sessions',
      label: 'Sessions',
      icon: (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <line x1="2" y1="6" x2="14" y2="6" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )
    },
    {
      view: 'browser',
      label: 'Browse',
      icon: (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2 4 L2 13 L7 13 L7 6 L9 4 Z" stroke="currentColor" strokeWidth="1.2" fill="none" />
          <path d="M7 6 L14 6 L14 13 L7 13" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </svg>
      )
    },
    {
      view: 'usage',
      label: 'Usage',
      icon: (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="9" width="3" height="5" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
          <rect x="6.5" y="5" width="3" height="9" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
          <rect x="11" y="2" width="3" height="12" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )
    },
    {
      view: 'insights',
      label: 'Insights',
      icon: (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="3" r="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M4 8h8M6 6v4M10 6v4M3 12h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )
    },
    {
      view: 'logs',
      label: 'Logs',
      icon: (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="3" y="2" width="10" height="12" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <line x1="5.5" y1="5" x2="10.5" y2="5" stroke="currentColor" strokeWidth="1.2" />
          <line x1="5.5" y1="7.5" x2="10.5" y2="7.5" stroke="currentColor" strokeWidth="1.2" />
          <line x1="5.5" y1="10" x2="8.5" y2="10" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )
    },
    {
      view: 'settings',
      label: 'Settings',
      icon: (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M8 2 V4 M8 12 V14 M2 8 H4 M12 8 H14 M3.8 3.8 L5.2 5.2 M10.8 10.8 L12.2 12.2 M12.2 3.8 L10.8 5.2 M5.2 10.8 L3.8 12.2" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )
    },
  ]

  const toggleDebugRecording = async () => {
    if (debugRecording) {
      await window.electronAPI.debug.disable()
      setDebugRecording(false)
    } else {
      await window.electronAPI.debug.enable()
      setDebugRecording(true)
    }
  }

  return (
    <aside className="w-64 bg-mantle flex flex-col border-r border-surface0 shrink-0 select-none titlebar-no-drag relative">
      {/* Navigation */}
      <div className="px-2 pt-2 flex gap-1 border-b border-surface0 pb-2">
        {navItems.map(item => {
          const isInsightsActive = item.view === 'insights' && !!insightsStatus
          const insightsDotColor = insightsStatus === 'running' ? '#89B4FA'
            : insightsStatus === 'extracting_kpis' ? '#F9E2AF'
            : insightsStatus === 'complete' ? '#A6E3A1'
            : insightsStatus === 'failed' ? '#F38BA8'
            : null
          const isInsightsAnimating = insightsStatus === 'running' || insightsStatus === 'extracting_kpis'
          return (
          <button
            key={item.view}
            onClick={() => onViewChange(item.view)}
            title={isInsightsAnimating ? (insightsMessage || 'Insights running...') : item.label}
            className={`flex-1 flex items-center justify-center py-1.5 rounded transition-colors relative ${
              currentView === item.view
                ? 'bg-surface0 text-text'
                : isInsightsAnimating
                ? 'text-blue'
                : 'text-overlay0 hover:text-text hover:bg-surface0/50'
            }`}
          >
            {item.icon}
            {isInsightsActive && insightsDotColor && (
              <span
                className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${isInsightsAnimating ? 'insights-pulse-dot' : ''}`}
                style={{
                  backgroundColor: insightsDotColor,
                  boxShadow: `0 0 6px 2px ${insightsDotColor}60`,
                }}
              />
            )}
          </button>
          )
        })}
        {/* Debug recording toggle button */}
        <button
          onClick={toggleDebugRecording}
          title={debugRecording ? 'Debug Recording ON - Click to stop' : 'Start Debug Recording'}
          className={`flex-1 flex items-center justify-center py-1.5 rounded transition-colors relative ${
            debugRecording
              ? 'bg-red/20 text-red'
              : 'text-overlay0 hover:text-text hover:bg-surface0/50'
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 2 C5.8 2 4 3.8 4 6 V10 C4 12.2 5.8 14 8 14 C10.2 14 12 12.2 12 10 V6 C12 3.8 10.2 2 8 2" stroke="currentColor" strokeWidth="1.2" />
            <line x1="4" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.2" />
            <line x1="4" y1="10" x2="12" y2="10" stroke="currentColor" strokeWidth="1.2" />
            <line x1="2" y1="5" x2="4" y2="6" stroke="currentColor" strokeWidth="1.2" />
            <line x1="14" y1="5" x2="12" y2="6" stroke="currentColor" strokeWidth="1.2" />
          </svg>
          {debugRecording && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red animate-pulse" />
          )}
        </button>
      </div>

      {/* Debug recording notification banner */}
      {debugRecording && (
        <div className="mx-2 mb-2 px-2 py-1.5 bg-red/10 border border-red/30 rounded text-xs text-red flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-red animate-pulse shrink-0" />
          <span className="flex-1">Debug recording active</span>
          <button
            onClick={() => window.electronAPI.debug.openFolder()}
            className="text-red/70 hover:text-red underline"
          >
            Open folder
          </button>
        </div>
      )}

      {/* Saved Configs */}
      <div className="p-3 flex items-center justify-between">
        <span className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Saved Configs</span>
        <div className="flex gap-0.5">
          <button
            onClick={() => { setShowNewSectionInput(true); setTimeout(() => newSectionInputRef.current?.focus(), 0) }}
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
            onClick={() => setShowNewDialog(true)}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-surface0 text-overlay1 hover:text-text transition-colors"
            title="New config (Ctrl+T)"
          >
            <svg width="14" height="14" viewBox="0 0 14 14"><line x1="7" y1="2" x2="7" y2="12" stroke="currentColor" strokeWidth="1.5"/><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.5"/></svg>
          </button>
        </div>
      </div>

      <div className="px-2 space-y-0.5 overflow-y-auto" style={{ maxHeight: '40%' }}>
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
                        {groupConfigs.map((config) => (
                          <ConfigRow
                            key={config.id}
                            config={config}
                            onLaunch={() => launchFromConfig(config)}
                            onEdit={() => setEditingConfig(config)}
                            onDelete={() => handleDeleteConfig(config.id)}
                            onContextMenu={(e) => handleConfigContextMenu(e, config.id)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {looseConfigs.map((config) => (
                  <ConfigRow
                    key={config.id}
                    config={config}
                    onLaunch={() => launchFromConfig(config)}
                    onEdit={() => setEditingConfig(config)}
                    onDelete={() => handleDeleteConfig(config.id)}
                    onContextMenu={(e) => handleConfigContextMenu(e, config.id)}
                  />
                ))}
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
                {groupConfigs.map((config) => (
                  <ConfigRow
                    key={config.id}
                    config={config}
                    onLaunch={() => launchFromConfig(config)}
                    onEdit={() => setEditingConfig(config)}
                    onDelete={() => handleDeleteConfig(config.id)}
                    onContextMenu={(e) => handleConfigContextMenu(e, config.id)}
                  />
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Unsectioned ungrouped configs */}
        {unsectionedUngroupedConfigs.map((config) => (
          <ConfigRow
            key={config.id}
            config={config}
            onLaunch={() => launchFromConfig(config)}
            onEdit={() => setEditingConfig(config)}
            onDelete={() => handleDeleteConfig(config.id)}
            onContextMenu={(e) => handleConfigContextMenu(e, config.id)}
          />
        ))}
      </div>

      {/* Config context menu for group/section assignment */}
      {contextMenuConfig && (
        <ConfigContextMenu
          x={contextMenuConfig.x}
          y={contextMenuConfig.y}
          groups={groups}
          sections={sections}
          currentGroupId={configs.find((c) => c.id === contextMenuConfig.configId)?.groupId}
          currentSectionId={configs.find((c) => c.id === contextMenuConfig.configId)?.sectionId}
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
          onClose={() => setContextMenuConfig(null)}
        />
      )}

      {/* Group context menu for section assignment */}
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

      {/* Active Sessions */}
      <div className="p-3 flex items-center justify-between border-t border-surface0 mt-2">
        <span className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Active Sessions</span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 space-y-0.5 pb-28">
        {sessions.length === 0 && (
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
                        {groupSessions.map((session) => (
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
                            onClick={() => { setActiveSession(session.id); onViewChange('sessions') }}
                            onContextMenu={(e) => { e.preventDefault(); setSessionContextMenu({ sessionId: session.id, x: e.clientX, y: e.clientY }) }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {looseSessions.map((session) => (
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
                    onClick={() => { setActiveSession(session.id); onViewChange('sessions') }}
                    onContextMenu={(e) => { e.preventDefault(); setSessionContextMenu({ sessionId: session.id, x: e.clientX, y: e.clientY }) }}
                  />
                ))}
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
                {groupSessions.map((session) => (
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
                    onClick={() => { setActiveSession(session.id); onViewChange('sessions') }}
                    onContextMenu={(e) => { e.preventDefault(); setSessionContextMenu({ sessionId: session.id, x: e.clientX, y: e.clientY }) }}
                  />
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Unsectioned ungrouped sessions */}
        {unsectionedUngroupedSessions.map((session) => (
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
            onClick={() => { setActiveSession(session.id); onViewChange('sessions') }}
            onContextMenu={(e) => { e.preventDefault(); setSessionContextMenu({ sessionId: session.id, x: e.clientX, y: e.clientY }) }}
          />
        ))}
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
            onUpdateClaude={!s.shellOnly ? () => {
              const isSSH = s.sessionType === 'ssh'
              // Send Escape first to clear any pending input, then /exit
              window.electronAPI.pty.write(s.id, '\x1b')
              setTimeout(() => {
                window.electronAPI.pty.write(s.id, '/exit\n')
              }, 300)
              setTimeout(() => {
                const cmd = isSSH ? 'sudo claude update' : 'claude update'
                window.electronAPI.pty.write(s.id, cmd + '\n')
              }, 3000)
              setTimeout(() => {
                window.electronAPI.pty.write(s.id, 'claude\n')
              }, 30000)
              setSessionContextMenu(null)
            } : undefined}
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

      {/* Bottom buttons: Update check / Update available */}
      <div className="absolute bottom-2 left-2 right-2 flex flex-col gap-2">
        {updateAvailable ? (
          <button
            onClick={handleInstallUpdate}
            disabled={updating}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
              updating
                ? 'bg-surface0 border-surface1 text-overlay0 cursor-wait'
                : 'bg-green/10 border-green/30 text-green hover:bg-green/20'
            }`}
          >
            {updating ? (
              <>
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
                </svg>
                <span className="text-xs font-medium">Installing...</span>
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M8 3v7M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M3 12v1a1 1 0 001 1h8a1 1 0 001-1v-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                <div className="flex-1 text-left">
                  <div className="text-xs font-medium">
                    Update Available{updateVersion ? ` — v${updateVersion}` : ''}
                  </div>
                  <div className="text-[10px] text-green/70">Click to install & restart</div>
                </div>
                <div className="w-2 h-2 rounded-full bg-green animate-pulse" />
              </>
            )}
          </button>
        ) : (
          <button
            onClick={handleCheckForUpdates}
            disabled={checking}
            className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg border border-surface1 text-overlay0 hover:text-subtext0 hover:bg-surface0/50 hover:border-surface2 transition-colors"
          >
            {checking ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
                </svg>
                <span className="text-xs">Checking...</span>
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M8 2v4M8 14v-4M8 6a2 2 0 110 4 2 2 0 010-4z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  <path d="M2 8h4M14 8h-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                <span className="text-xs">Check for Updates</span>
              </>
            )}
          </button>
        )}
      </div>
    </aside>
  )
}

function ConfigRow({ config, onLaunch, onEdit, onDelete, onContextMenu }: {
  config: TerminalConfig
  onLaunch: () => void
  onEdit: () => void
  onDelete: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-md py-1.5 px-2 group transition-colors"
      style={{ borderLeft: `3px solid ${config.color}` }}
      onContextMenu={onContextMenu}
      onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.backgroundColor = config.color + '12'}
      onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.backgroundColor = ''}
    >
      <span className="text-sm text-text truncate flex-1">{config.label}</span>
      {config.sessionType === 'ssh' && <SshBadge />}
      {config.shellOnly ? <ShellBadge /> : <ClaudeBadge needsAttention={false} />}
      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onLaunch}
          className="p-1 rounded hover:bg-surface1 text-green"
          title="Launch"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><polygon points="3,1 10,6 3,11" /></svg>
        </button>
        <button
          onClick={onEdit}
          className="p-1 rounded hover:bg-surface1 text-overlay1 hover:text-text"
          title="Edit"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8.5 1.5l2 2-7 7H1.5v-2z"/></svg>
        </button>
        <button
          onClick={onDelete}
          className="p-1 rounded hover:bg-surface1 text-overlay1 hover:text-red"
          title="Delete"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        </button>
      </div>
    </div>
  )
}

function SessionRow({ session, isActive, needsAttention, isRenaming, renameValue, renameRef, onRenameChange, onRenameFinish, onRenameCancel, onClick, onContextMenu }: {
  session: Session
  isActive: boolean
  needsAttention: boolean
  isRenaming: boolean
  renameValue: string
  renameRef: React.RefObject<HTMLInputElement | null>
  onRenameChange: (val: string) => void
  onRenameFinish: () => void
  onRenameCancel: () => void
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const tintColor = session.color
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`w-full text-left rounded-md py-2 px-3 transition-all duration-150 group flex relative overflow-hidden ${
        isActive
          ? 'text-text'
          : 'text-subtext0 hover:text-text'
      }`}
      style={{
        backgroundColor: isActive ? tintColor + '20' : undefined,
      }}
      onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.backgroundColor = tintColor + '12' }}
      onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
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

function SessionContextMenu({ x, y, session, hasGroup, onRename, onUpdateClaude, onRemoveFromGroup, onClose, onDismiss }: {
  x: number
  y: number
  session: Session
  hasGroup: boolean
  onRename: () => void
  onUpdateClaude?: () => void
  onRemoveFromGroup: () => void
  onClose: () => void
  onDismiss: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onDismiss()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onDismiss])

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-surface0 border border-surface1 rounded-lg shadow-xl py-1 min-w-[140px]"
      style={{ left: x, top: y }}
    >
      <button
        onClick={onRename}
        className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8.5 1.5l2 2-7 7H1.5v-2z"/></svg>
        Rename
      </button>
      {onUpdateClaude && (
        <button
          onClick={onUpdateClaude}
          className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M6 2v5M4 5l2 2 2-2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M2 8v2h8V8" strokeLinecap="round"/>
          </svg>
          Update Claude
        </button>
      )}
      {hasGroup && (
        <button
          onClick={onRemoveFromGroup}
          className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M4 6h4" strokeLinecap="round"/>
            <rect x="1" y="1" width="10" height="10" rx="1.5"/>
          </svg>
          Remove from Group
        </button>
      )}
      <button
        onClick={onClose}
        className="w-full text-left px-3 py-1.5 text-xs text-red hover:bg-surface1 transition-colors flex items-center gap-2"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        Close Session
      </button>
    </div>
  )
}

function ConfigContextMenu({ x, y, groups, sections, currentGroupId, currentSectionId, onMoveToGroup, onCreateGroup, onMoveToSection, onCreateSection, onEdit, onDelete, onClose }: {
  x: number
  y: number
  groups: ConfigGroup[]
  sections: ConfigSection[]
  currentGroupId?: string
  currentSectionId?: string
  onMoveToGroup: (groupId: string | undefined) => void
  onCreateGroup: (name: string) => void
  onMoveToSection: (sectionId: string | undefined) => void
  onCreateSection: (name: string) => void
  onEdit: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [showNewGroupInput, setShowNewGroupInput] = useState(false)
  const [showNewSectionInput, setShowNewSectionInput] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newSectionName, setNewSectionName] = useState('')
  const groupInputRef = useRef<HTMLInputElement>(null)
  const sectionInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showNewGroupInput) setShowNewGroupInput(false)
        else if (showNewSectionInput) setShowNewSectionInput(false)
        else onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose, showNewGroupInput, showNewSectionInput])

  useEffect(() => {
    if (showNewGroupInput) setTimeout(() => groupInputRef.current?.focus(), 0)
  }, [showNewGroupInput])

  useEffect(() => {
    if (showNewSectionInput) setTimeout(() => sectionInputRef.current?.focus(), 0)
  }, [showNewSectionInput])

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-surface0 border border-surface1 rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ left: x, top: y }}
    >
      <button
        onClick={onEdit}
        className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8.5 1.5l2 2-7 7H1.5v-2z"/></svg>
        Edit
      </button>
      <button
        onClick={onDelete}
        className="w-full text-left px-3 py-1.5 text-xs text-red hover:bg-surface1 transition-colors flex items-center gap-2"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        Delete
      </button>
      <div className="border-t border-surface1 my-1" />
      <div className="px-3 py-1.5 text-[10px] text-overlay0 uppercase tracking-wider">Move to Group</div>
      {currentGroupId && (
        <button
          onClick={() => onMoveToGroup(undefined)}
          className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors"
        >
          Remove from group
        </button>
      )}
      {groups.filter((g) => g.id !== currentGroupId).map((g) => (
        <button
          key={g.id}
          onClick={() => onMoveToGroup(g.id)}
          className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors"
        >
          {g.name}
        </button>
      ))}
      <div className="border-t border-surface1 mt-1 pt-1">
        {showNewGroupInput ? (
          <div className="px-2 py-1 flex gap-1">
            <input
              ref={groupInputRef}
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newGroupName.trim()) onCreateGroup(newGroupName.trim())
                e.stopPropagation()
              }}
              placeholder="Group name"
              className="flex-1 bg-base border border-surface1 rounded px-2 py-1 text-xs text-text placeholder:text-overlay0 outline-none focus:border-blue min-w-0"
            />
            <button
              onClick={() => { if (newGroupName.trim()) onCreateGroup(newGroupName.trim()) }}
              className="px-2 py-1 rounded text-xs bg-blue text-crust font-medium hover:bg-blue/90 shrink-0"
            >
              OK
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowNewGroupInput(true)}
            className="w-full text-left px-3 py-1.5 text-xs text-blue hover:bg-surface1 transition-colors"
          >
            + New Group...
          </button>
        )}
      </div>
      {/* Move to Section */}
      {!currentGroupId && (
        <>
          <div className="border-t border-surface1 my-1" />
          <div className="px-3 py-1.5 text-[10px] text-overlay0 uppercase tracking-wider">Move to Section</div>
          {currentSectionId && (
            <button
              onClick={() => onMoveToSection(undefined)}
              className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors"
            >
              Remove from section
            </button>
          )}
          {sections.filter((s) => s.id !== currentSectionId).map((s) => (
            <button
              key={s.id}
              onClick={() => onMoveToSection(s.id)}
              className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors"
            >
              {s.name}
            </button>
          ))}
          <div className="border-t border-surface1 mt-1 pt-1">
            {showNewSectionInput ? (
              <div className="px-2 py-1 flex gap-1">
                <input
                  ref={sectionInputRef}
                  value={newSectionName}
                  onChange={(e) => setNewSectionName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newSectionName.trim()) onCreateSection(newSectionName.trim())
                    e.stopPropagation()
                  }}
                  placeholder="Section name"
                  className="flex-1 bg-base border border-surface1 rounded px-2 py-1 text-xs text-text placeholder:text-overlay0 outline-none focus:border-blue min-w-0"
                />
                <button
                  onClick={() => { if (newSectionName.trim()) onCreateSection(newSectionName.trim()) }}
                  className="px-2 py-1 rounded text-xs bg-blue text-crust font-medium hover:bg-blue/90 shrink-0"
                >
                  OK
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowNewSectionInput(true)}
                className="w-full text-left px-3 py-1.5 text-xs text-blue hover:bg-surface1 transition-colors"
              >
                + New Section...
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function SectionHeader({ section, isRenaming, renameValue, renameRef, onRenameChange, onRenameFinish, onRenameCancel, onToggleCollapse, onStartRename, onLaunchAll, onDelete }: {
  section: ConfigSection
  isRenaming: boolean
  renameValue: string
  renameRef: React.RefObject<HTMLInputElement | null>
  onRenameChange: (val: string) => void
  onRenameFinish: () => void
  onRenameCancel: () => void
  onToggleCollapse: () => void
  onStartRename: () => void
  onLaunchAll: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex items-center gap-1 py-1.5 px-1 rounded hover:bg-surface0/20 transition-colors group/section">
      <button
        onClick={onToggleCollapse}
        className="p-0.5 text-overlay0 hover:text-text transition-colors"
        title={section.collapsed ? 'Expand' : 'Collapse'}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"
          style={{ transform: section.collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}>
          <polygon points="2,2 8,5 2,8" />
        </svg>
      </button>
      {isRenaming ? (
        <input
          ref={renameRef}
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameFinish}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameFinish()
            if (e.key === 'Escape') onRenameCancel()
          }}
          className="flex-1 bg-base border border-blue rounded px-1.5 py-0.5 text-[10px] text-text outline-none min-w-0 uppercase tracking-widest font-bold"
        />
      ) : (
        <span
          className="text-[10px] font-bold uppercase tracking-widest text-overlay1 truncate flex-1 cursor-pointer"
          onDoubleClick={onStartRename}
          onContextMenu={(e) => { e.preventDefault(); onStartRename() }}
          title="Double-click or right-click to rename"
        >
          {section.name}
        </span>
      )}
      <div className="flex gap-0.5 opacity-0 group-hover/section:opacity-100 transition-opacity">
        <button
          onClick={onLaunchAll}
          className="p-0.5 rounded hover:bg-surface1 text-green"
          title="Launch all in section"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 8,5 2,9" /></svg>
        </button>
        <button
          onClick={onDelete}
          className="p-0.5 rounded hover:bg-surface1 text-overlay1 hover:text-red"
          title="Delete section (items move to root)"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>
        </button>
      </div>
    </div>
  )
}

function GroupHeader({ group, isRenaming, renameValue, renameRef, onRenameChange, onRenameFinish, onRenameCancel, onToggleCollapse, onStartRename, onLaunchAll, onDelete, onContextMenu }: {
  group: ConfigGroup
  isRenaming: boolean
  renameValue: string
  renameRef: React.RefObject<HTMLInputElement | null>
  onRenameChange: (val: string) => void
  onRenameFinish: () => void
  onRenameCancel: () => void
  onToggleCollapse: () => void
  onStartRename: () => void
  onLaunchAll: () => void
  onDelete: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  return (
    <div
      className="flex items-center gap-1 py-1 px-1 rounded hover:bg-surface0/30 transition-colors group/header"
      onContextMenu={onContextMenu}
    >
      <button
        onClick={onToggleCollapse}
        className="p-0.5 text-overlay0 hover:text-text transition-colors"
        title={group.collapsed ? 'Expand' : 'Collapse'}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"
          style={{ transform: group.collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}>
          <polygon points="2,2 8,5 2,8" />
        </svg>
      </button>
      {isRenaming ? (
        <input
          ref={renameRef}
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameFinish}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameFinish()
            if (e.key === 'Escape') onRenameCancel()
          }}
          className="flex-1 bg-base border border-blue rounded px-1.5 py-0.5 text-xs text-text outline-none min-w-0"
        />
      ) : (
        <span
          className="text-xs font-medium text-subtext1 truncate flex-1 cursor-pointer"
          onDoubleClick={onStartRename}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onStartRename() }}
          title="Double-click or right-click to rename"
        >
          {group.name}
        </span>
      )}
      <div className="flex gap-0.5 opacity-0 group-hover/header:opacity-100 transition-opacity">
        <button
          onClick={onLaunchAll}
          className="p-0.5 rounded hover:bg-surface1 text-green"
          title="Launch all"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 8,5 2,9" /></svg>
        </button>
        <button
          onClick={onDelete}
          className="p-0.5 rounded hover:bg-surface1 text-overlay1 hover:text-red"
          title="Delete group (configs kept)"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>
        </button>
      </div>
    </div>
  )
}

function SessionSectionHeader({ section, collapsed, onToggleCollapse, onCloseAll }: {
  section: ConfigSection
  collapsed?: boolean
  onToggleCollapse: () => void
  onCloseAll: () => void
}) {
  return (
    <div className="flex items-center gap-1 py-1.5 px-1 rounded hover:bg-surface0/20 transition-colors group/ssection">
      <button
        onClick={onToggleCollapse}
        className="p-0.5 text-overlay0 hover:text-text transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}>
          <polygon points="2,2 8,5 2,8" />
        </svg>
      </button>
      <span className="text-[10px] font-bold uppercase tracking-widest text-overlay1 truncate flex-1">
        {section.name}
      </span>
      <button
        onClick={onCloseAll}
        className="p-0.5 rounded hover:bg-surface1 text-overlay1 hover:text-red opacity-0 group-hover/ssection:opacity-100 transition-opacity"
        title="Close all sessions in section"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>
      </button>
    </div>
  )
}

function SessionGroupHeader({ group, collapsed, onToggleCollapse, onCloseAll }: {
  group: ConfigGroup
  collapsed?: boolean
  onToggleCollapse: () => void
  onCloseAll: () => void
}) {
  return (
    <div className="flex items-center gap-1 py-1 px-1 rounded hover:bg-surface0/30 transition-colors group/sheader">
      <button
        onClick={onToggleCollapse}
        className="p-0.5 text-overlay0 hover:text-text transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}>
          <polygon points="2,2 8,5 2,8" />
        </svg>
      </button>
      <span className="text-xs font-medium text-subtext1 truncate flex-1">{group.name}</span>
      <button
        onClick={onCloseAll}
        className="p-0.5 rounded hover:bg-surface1 text-overlay1 hover:text-red opacity-0 group-hover/sheader:opacity-100 transition-opacity"
        title="Close all sessions in group"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>
      </button>
    </div>
  )
}

function GroupContextMenu({ x, y, sections, currentSectionId, onMoveToSection, onCreateSection, onClose }: {
  x: number
  y: number
  sections: ConfigSection[]
  currentSectionId?: string
  onMoveToSection: (sectionId: string | undefined) => void
  onCreateSection: (name: string) => void
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [showNewInput, setShowNewInput] = useState(false)
  const [newName, setNewName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showNewInput) setShowNewInput(false)
        else onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose, showNewInput])

  useEffect(() => {
    if (showNewInput) setTimeout(() => inputRef.current?.focus(), 0)
  }, [showNewInput])

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-surface0 border border-surface1 rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ left: x, top: y }}
    >
      <div className="px-3 py-1.5 text-[10px] text-overlay0 uppercase tracking-wider">Move to Section</div>
      {currentSectionId && (
        <button
          onClick={() => onMoveToSection(undefined)}
          className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors"
        >
          Remove from section
        </button>
      )}
      {sections.filter((s) => s.id !== currentSectionId).map((s) => (
        <button
          key={s.id}
          onClick={() => onMoveToSection(s.id)}
          className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors"
        >
          {s.name}
        </button>
      ))}
      <div className="border-t border-surface1 mt-1 pt-1">
        {showNewInput ? (
          <div className="px-2 py-1 flex gap-1">
            <input
              ref={inputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim()) onCreateSection(newName.trim())
                e.stopPropagation()
              }}
              placeholder="Section name"
              className="flex-1 bg-base border border-surface1 rounded px-2 py-1 text-xs text-text placeholder:text-overlay0 outline-none focus:border-blue min-w-0"
            />
            <button
              onClick={() => { if (newName.trim()) onCreateSection(newName.trim()) }}
              className="px-2 py-1 rounded text-xs bg-blue text-crust font-medium hover:bg-blue/90 shrink-0"
            >
              OK
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowNewInput(true)}
            className="w-full text-left px-3 py-1.5 text-xs text-blue hover:bg-surface1 transition-colors"
          >
            + New Section...
          </button>
        )}
      </div>
    </div>
  )
}

function ClaudeBadge({ needsAttention }: { needsAttention: boolean }) {
  const isWorking = !needsAttention
  return (
    <div
      className={`flex items-center justify-center w-4 h-4 rounded shrink-0 transition-colors ${
        isWorking ? 'bg-peach/20 text-peach' : 'bg-blue/20 text-blue'
      }`}
      title={isWorking ? 'Claude is working' : 'Waiting for input'}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2v8.5M12 13.5V22M2 12h8.5M13.5 12H22M4.93 4.93l6.01 6.01M13.06 13.06l6.01 6.01M19.07 4.93l-6.01 6.01M10.94 13.06l-6.01 6.01" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none"/>
      </svg>
    </div>
  )
}

function ShellBadge() {
  return (
    <div
      className="flex items-center justify-center w-4 h-4 rounded shrink-0 bg-surface1 text-overlay1"
      title="Shell terminal"
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="7 8 3 12 7 16" />
        <polyline points="17 8 21 12 17 16" />
        <line x1="14" y1="4" x2="10" y2="20" />
      </svg>
    </div>
  )
}

function SshBadge() {
  return (
    <div
      className="flex items-center justify-center h-4 px-1 rounded shrink-0 bg-blue/15 text-blue"
      title="SSH session"
      style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '0.5px' }}
    >
      SSH
    </div>
  )
}
