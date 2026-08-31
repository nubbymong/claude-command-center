import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useSessionStore, Session } from '../stores/sessionStore'
import { useConfigStore, TerminalConfig, ConfigGroup, ConfigSection } from '../stores/configStore'
import { useCommandStore } from '../stores/commandStore'
import { commandSecretKey } from '../../shared/command-secret'
import { reorderLoose } from '../utils/reorderLoose'
import { useInsightsStore } from '../stores/insightsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useCloudAgentStore } from '../stores/cloudAgentStore'
import { useConductorMcpStore } from '../stores/conductorMcpStore'
import { useAccountAuthStore } from '../stores/accountAuthStore'
import SessionDialog from './SessionDialog'
import { killSessionPty } from '../ptyTracker'
import { requestCloseSession, forgetSessionBrowserProfile } from '../stores/sshCloseStore'
import { ViewType } from '../types/views'
import { trackUsage } from '../stores/tipsStore'
import { generateId } from '../utils/id'
import { matchesShortcut, DEFAULT_SHORTCUTS } from '../utils/shortcuts'
import { canSwitchAccountForSession, sshMappedProfileId } from '../utils/sessionLaunch'
import { useLaunchConfig } from '../hooks/useLaunchConfig'
import { useClickOutside } from '../hooks/useClickOutside'
import { useRegionTypography } from '../hooks/useTypography'
import SidebarNav from './sidebar/SidebarNav'
import ConfigRow from './sidebar/ConfigRow'
import SessionRow from './sidebar/SessionRow'
import ConfigContextMenu from './sidebar/ConfigContextMenu'
import SessionContextMenu from './sidebar/SessionContextMenu'
import { openArtifactsPerSetting } from '../lib/claude-web-targets'
import GroupContextMenu from './sidebar/GroupContextMenu'
import SectionHeader from './sidebar/SectionHeader'
import GroupHeader from './sidebar/GroupHeader'
import SessionSectionHeader from './sidebar/SessionSectionHeader'
import SessionGroupHeader from './sidebar/SessionGroupHeader'
import UngroupedSessionsHeader from './sidebar/UngroupedSessionsHeader'
import { runningConfigCounts, sessionInstanceOrdinals } from './sidebar/savedConfigsView'
import AskConductorDock from './sidebar/AskConductorDock'
import QuickStartPanel from './sidebar/QuickStartPanel'
import { resolveDefaultPanelTab, resolveSidebarWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, launchableInGroup, launchableInSection, type PanelTab } from './sidebar/sessionsPanelState'
import FirstRunCard from './FirstRunCard'
import ColourMigrationNotice from './ColourMigrationNotice'
import ConfigHydrationNotice from './ConfigHydrationNotice'
import ConfigLoadFailedNotice from './ConfigLoadFailedNotice'
import ConfigLoadFailedRailIndicator from './sidebar/ConfigLoadFailedRailIndicator'
import { useAppMetaStore } from '../stores/appMetaStore'
import { deriveOnboarding } from '../onboarding/gate'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useSwitchAccount } from '../hooks/useSwitchAccount'
import { useTokenomicsStore } from '../stores/tokenomicsStore'

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
  collapsed?: boolean
  onShowAccountUsage?: () => void
  onShowFirstRun?: () => void
  /** Raise the tip modal. The trigger lives in the dock, under Ask Conductor. */
  onShowTip?: () => void
  // Suppresses the FirstRunCard while the training/walkthrough is
  // open — clicking "Create Config" otherwise opens the first-config dialog
  // behind the tour, which the user can't see and which doesn't
  // dismiss the tour. macOS and Windows both affected.
  tourActive?: boolean
}

export default function Sidebar({ currentView, onViewChange, collapsed, onShowAccountUsage, onShowFirstRun, onShowTip, tourActive }: Props) {
  const launchConfig = useLaunchConfig()
  const sideType = useRegionTypography('sidebar')
  const { sessions: allSessions, activeSessionId, setActiveSession, removeSession, updateSession } = useSessionStore()
  // Ask Conductor is docked at the BOTTOM of the sidebar, apart from your
  // project sessions — that separation is the whole point of the design. It is
  // split out here, once, rather than at each of the four bucketing expressions
  // below (sectioned groups, section-loose, unsectioned groups, unsectioned
  // loose): missing any one of them would show it twice or lose it. Everything
  // downstream — the "Active Sessions" count, the arrow-key list, the
  // empty-state — reads `sessions` and so agrees with what is rendered.
  const askSession = allSessions.find((s) => s.kind === 'ask')
  const sessions = allSessions.filter((s) => s.kind !== 'ask')
  const { configs, groups, sections, addConfig, updateConfig, removeConfig, addGroup, renameGroup, removeGroup, toggleGroupCollapsed, moveConfigToGroup, addSection, renameSection, removeSection, toggleSectionCollapsed, moveGroupToSection, moveConfigToSection, togglePinned, duplicateConfig, reorderConfigs } = useConfigStore()
  const appMeta = useAppMetaStore((s) => s.meta)
  const updateAppMeta = useAppMetaStore((s) => s.update)
  const showFirstRunCard = configs.length === 0 && !appMeta.hasCreatedFirstConfig && !appMeta.firstRunCardDismissed && !tourActive
  const insightsStatus = useInsightsStore((s) => s.status)
  const insightsMessage = useInsightsStore((s) => s.statusMessage)
  const tokenomicsIndexComplete = useTokenomicsStore((s) => s.indexJustCompleted)
  const cloudAgentRunning = useCloudAgentStore((s) => s.agents.filter(a => a.status === 'running' || a.status === 'pending').length)
  const visionRunning = useConductorMcpStore((s) => s.browserRunning)
  // P7.7: sidebar dot now reflects MCP server health (the per-task reviewer
  // missed that visionConnected gated the dot on browser CDP attach instead
  // of server liveness, leaving the dot red until Chrome handshake completed
  // even though the MCP HTTP listener was up).
  const serverRunning = useConductorMcpStore((s) => s.serverRunning)
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [editingConfig, setEditingConfig] = useState<TerminalConfig | null>(null)
  const [contextMenuConfig, setContextMenuConfig] = useState<{ configId: string; x: number; y: number } | null>(null)
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [sessionGroupCollapsed, setSessionGroupCollapsed] = useState<Record<string, boolean>>({})
  // #363: collapse state of the "Ungrouped" pseudo-group, keyed by section id
  // ('' = the unsectioned tail). Lives alongside the group/section state above
  // and persists the same way (for the life of the window).
  const [ungroupedSessionsCollapsed, setUngroupedSessionsCollapsed] = useState<Record<string, boolean>>({})
  const toggleUngroupedSessionsCollapsed = (key: string) =>
    setUngroupedSessionsCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [sessionRenameValue, setSessionRenameValue] = useState('')
  const [sessionContextMenu, setSessionContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null)

  // #216: per-account auth status (Claude Code CLI + claude.ai web) via the SHARED
  // store, so the session-header pills and this menu read one source and a sign-in
  // refreshes both. Fetched when a session context menu opens — not polled, since
  // the Claude Code check is a heavy subprocess.
  const authByProfile = useAccountAuthStore((s) => s.byProfile)
  const refreshWebSessions = React.useCallback(async (profileId?: string, force = false) => {
    if (!profileId) return
    await useAccountAuthStore.getState().refresh(profileId, { force })
  }, [])
  /**
   * Web-session status for the menu about to open.
   *
   * The full `refresh` cannot answer this without first awaiting the
   * `claude auth status` subprocess, so on an account whose status was not
   * already cached "Open artifacts" rendered disabled and a click did nothing at
   * all — no window, no error, no log line. This is a local read, so the answer
   * lands before the menu is even painted. The heavy refresh still runs
   * alongside for the CLI half.
   */
  const refreshWebOnly = React.useCallback((profileId?: string) => {
    if (!profileId) return
    void useAccountAuthStore.getState().refreshWeb(profileId)
  }, [])

  /** Acquire this account's claude.ai web session, then refresh the menu state. */
  const authenticateWebForSession = React.useCallback(async (profileId: string) => {
    await window.electronAPI.accountWeb.signIn(profileId)
    await refreshWebSessions(profileId, true)
  }, [refreshWebSessions])
  const [renamingSectionId, setRenamingSectionId] = useState<string | null>(null)
  const [sectionRenameValue, setSectionRenameValue] = useState('')
  const [sessionSectionCollapsed, setSessionSectionCollapsed] = useState<Record<string, boolean>>({})
  const [groupContextMenu, setGroupContextMenu] = useState<{ groupId: string; x: number; y: number } | null>(null)
  const [showNewSectionInput, setShowNewSectionInput] = useState(false)
  // One central + New button (#483); the menu offers Config / Section.
  const [showNewMenu, setShowNewMenu] = useState(false)
  const [newSectionName, setNewSectionName] = useState('')
  // Two-mode left panel (design pass 2026-08-24): 'saved' is the launcher,
  // 'running' the live sessions. Replaces the #217 hover fly-out + pin
  // machinery — the panel is a MODE now, not an overlay over the sessions.
  // Starts on 'running' (the stored default's own default, plan Q1); once
  // settings hydrate the stored choice is adopted, but never over a tab the
  // user has already clicked this session.
  const [panelTab, setPanelTab] = useState<PanelTab>('running')
  const panelTabTouchedRef = useRef(false)
  const settingsLoaded = useSettingsStore((s) => s.isLoaded)
  const storedDefaultTab = useSettingsStore((s) => s.settings.sessionsPanelDefaultTab)
  useEffect(() => {
    if (settingsLoaded && !panelTabTouchedRef.current) setPanelTab(resolveDefaultPanelTab(storedDefaultTab))
  }, [settingsLoaded, storedDefaultTab])
  const selectPanelTab = (tab: PanelTab) => {
    panelTabTouchedRef.current = true
    setPanelTab(tab)
  }
  // #461: draggable width. Live width is component state (per-frame updates);
  // the settings write happens ONCE, on pointerup. The stored value is adopted
  // when settings hydrate — but never over a width the user is/was dragging
  // this session (same rule as the panel tab above).
  const storedSidebarWidth = useSettingsStore((s) => s.settings.sidebarWidth)
  const [sidebarWidth, setSidebarWidth] = useState(() => resolveSidebarWidth(storedSidebarWidth))
  const sidebarWidthTouchedRef = useRef(false)
  const [resizing, setResizing] = useState(false)
  useEffect(() => {
    if (settingsLoaded && !sidebarWidthTouchedRef.current) setSidebarWidth(resolveSidebarWidth(storedSidebarWidth))
  }, [settingsLoaded, storedSidebarWidth])
  // The width transition stays OFF until a frame after the stored width is
  // adopted — otherwise every launch with a non-default width visibly slides
  // 256px → stored. (Collapse keeps its animation from the next frame on.)
  const [widthAnimated, setWidthAnimated] = useState(false)
  useEffect(() => {
    if (!settingsLoaded) return
    const id = requestAnimationFrame(() => setWidthAnimated(true))
    return () => cancelAnimationFrame(id)
  }, [settingsLoaded])
  // Detach mid-drag listeners if the sidebar unmounts mid-drag
  // (the GitHubPanel resize pattern).
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => resizeCleanupRef.current?.(), [])
  const startSidebarResize = (e: React.PointerEvent) => {
    e.preventDefault()
    resizeCleanupRef.current?.()
    setResizing(true)
    const startX = e.clientX
    const startW = sidebarWidth
    // The typography setting can put CSS `zoom` on this aside; clientX is
    // unzoomed viewport px while the width is zoomed units — divide, or the
    // edge outruns the cursor.
    const zoom = Number((sideType as Record<string, unknown>).zoom) || 1
    let latest = startW
    const onMove = (ev: PointerEvent) => {
      // Handle is on the sidebar's RIGHT edge: dragging right widens it.
      sidebarWidthTouchedRef.current = true
      latest = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(startW + (ev.clientX - startX) / zoom)))
      setSidebarWidth(latest)
    }
    const prevCursor = document.body.style.cursor
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
      document.body.style.cursor = prevCursor
      resizeCleanupRef.current = null
      setResizing(false)
    }
    const onUp = () => {
      cleanup()
      // One settings write per drag, on release — and none for a bare click.
      if (latest !== startW) void useSettingsStore.getState().updateSettings({ sidebarWidth: latest })
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', onUp)
    resizeCleanupRef.current = cleanup
  }
  // Roving tabIndex needs focus to FOLLOW arrow-key selection (APG tabs
  // pattern) — selection alone would leave focus on a tabIndex={-1} button.
  const savedTabRef = useRef<HTMLButtonElement | null>(null)
  const runningTabRef = useRef<HTMLButtonElement | null>(null)
  const selectPanelTabWithFocus = (tab: PanelTab) => {
    selectPanelTab(tab)
    ;(tab === 'saved' ? savedTabRef : runningTabRef).current?.focus()
  }
  const [configSearchQuery, setConfigSearchQuery] = useState('')
  // Live-session counts per config: the row/Quick Start pills and the
  // delete guard read these; launch-all skips anything counted (bring-up).
  // `sessions` already excludes the Ask session.
  const runningCounts = useMemo(() => runningConfigCounts(sessions), [sessions])
  // Per-session instance ordinal (#454), same input array as the counts so the
  // two always agree. Only same-config 2+ instances get a number.
  const sessionOrdinals = useMemo(() => sessionInstanceOrdinals(sessions), [sessions])
  const [dragConfigId, setDragConfigId] = useState<string | null>(null)
  const [dragOverConfigId, setDragOverConfigId] = useState<string | null>(null)
  // The LOOSE configs: in no group and no section (a stale id pointing at a
  // group or section that no longer exists counts as loose, which is also how
  // they render). Over ALL configs, not the search-filtered view, so a drag
  // means the same thing whatever the search box holds. These are the only
  // rows drag-to-reorder applies to; see reorderLoose.
  const looseConfigIds = useMemo(() => {
    const ids = new Set<string>()
    for (const c of configs) {
      const grouped = !!c.groupId && groups.some((g) => g.id === c.groupId)
      const sectioned = !!c.sectionId && sections.some((s) => s.id === c.sectionId)
      if (!grouped && !sectioned) ids.add(c.id)
    }
    return ids
  }, [configs, groups, sections])
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set())
  const [focusedSessionIndex, setFocusedSessionIndex] = useState(-1)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const sessionRenameRef = useRef<HTMLInputElement>(null)
  const sectionRenameRef = useRef<HTMLInputElement>(null)
  const newSectionInputRef = useRef<HTMLInputElement>(null)
  const newMenuRef = useRef<HTMLDivElement>(null)
  useClickOutside(newMenuRef, () => setShowNewMenu(false))
  // The menu's DOM unmounts with the Saved body (tab switch, rail collapse) —
  // both reachable keyboard-only, where no outside mousedown fires. Without
  // this the state latches and the menu reappears unrequested (#483 review).
  useEffect(() => {
    if (panelTab !== 'saved' || collapsed) setShowNewMenu(false)
  }, [panelTab, collapsed])
  // Read current collapse state inside the stable ([]) keydown effect below.
  const collapsedRef = useRef(collapsed)
  collapsedRef.current = collapsed

  // Mid-session account switch (respawn + resume) for the session context menu.
  // Gated on having 2+ profiles. The hook is bound to whichever
  // session currently has its context menu open; it reads the live session and
  // no-ops when the chosen account equals the current one.
  const accountProfiles = useAccountProfilesStore((s) => s.profiles)
  // A session with no EXPLICIT account profile runs on the default/global home,
  // which is the primary account — so its web session and artifacts belong to the
  // primary. Without this fallback the account context-menu items vanished on a
  // fresh install (the common case: default account, no profile assigned), which
  // is exactly when a user first needs them. #269.
  const primaryProfileId = accountProfiles.find((p) => p.isPrimary)?.id
  const accountAliases = useSettingsStore((s) => s.settings.accountAliases)
  const menuSession = sessionContextMenu ? sessions.find((s) => s.id === sessionContextMenu.sessionId) ?? null : null
  const canSwitchAccount = canSwitchAccountForSession({ provider: menuSession?.provider, isSsh: !!menuSession?.sshConfig, shellOnly: !!menuSession?.shellOnly, profileCount: accountProfiles.length })
  const switchMenuAccount = useSwitchAccount(menuSession)

  // Inject attention styles on mount
  useEffect(() => {
    injectAttentionStyles()
  }, [])

  // Update availability + install moved to the global runtime footer
  // (BottomBar) in UAT R2. The big green sidebar toast was removed; the
  // footer Update pill is now the single update affordance.

  // New config shortcut (configurable)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Suppressed while onboarding overlays the shell — Ctrl+T here would
      // open the New Config dialog invisibly underneath it.
      if (deriveOnboarding(useAppMetaStore.getState().meta, {}).due) return
      const sc = useSettingsStore.getState().settings.keyboardShortcuts || DEFAULT_SHORTCUTS
      if (matchesShortcut(e, sc.newConfig)) {
        e.preventDefault()
        setShowNewDialog(true)
      }
      // Rename (F2) edits the ACTIVE session here in the Active Sessions list —
      // only while the sidebar is visible ("if it's in focus"). Preferred over
      // the tab editor. Falls back to the default binding for pre-existing
      // shortcut maps. Reads live state (stable [] effect).
      if (matchesShortcut(e, sc.renameSession || DEFAULT_SHORTCUTS.renameSession)) {
        if (collapsedRef.current) return
        const st = useSessionStore.getState()
        const id = st.activeSessionId
        if (!id) return
        e.preventDefault()
        const s = st.sessions.find((x) => x.id === id)
        setRenamingSessionId(id)
        setSessionRenameValue(s?.customName?.trim() || s?.label || '')
        setSessionContextMenu(null)
        setTimeout(() => sessionRenameRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleCreateConfig = async (data: Omit<TerminalConfig, 'id'>, password?: string, sudoPassword?: string, argSecret?: string) => {
    const config: TerminalConfig = { ...data, id: generateId() }
    addConfig(config)
    // Same stamps as the guided first-config path (App.tsx): without them the
    // FirstRunCard re-appears if the user later deletes all configs, and the
    // tips system never learns the feature was used.
    useAppMetaStore.getState().update({ hasCreatedFirstConfig: true })
    trackUsage('sessions.create-config')
    // Save credentials to the encrypted store (main process handles decryption at spawn time)
    if (password) {
      await window.electronAPI.credentials.save(config.id, password)
    }
    if (sudoPassword) {
      await window.electronAPI.credentials.save(config.id + '_sudo', sudoPassword)
    }
    if (argSecret) {
      await window.electronAPI.credentials.save(config.id + '_argsecret', argSecret)
    }
    setShowNewDialog(false)
    launchFromConfig(config)
  }

  const handleEditConfig = async (data: Omit<TerminalConfig, 'id'>, password?: string, sudoPassword?: string, argSecret?: string) => {
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
    if (argSecret) {
      await window.electronAPI.credentials.save(editingConfig.id + '_argsecret', argSecret)
    }
    setEditingConfig(null)
  }

  const handleDeleteConfig = async (configId: string) => {
    removeConfig(configId)
    await window.electronAPI.credentials.delete(configId)
    // The sudo password and the Terminal-only secret argument live under their
    // own keys; without these they stay orphaned in the OS keychain forever
    // (pre-2.1.0-beta.5 bug).
    await window.electronAPI.credentials.delete(configId + '_sudo')
    await window.electronAPI.credentials.delete(configId + '_argsecret')
    // The config's own command buttons go with it, and so do their secrets
    // (ADR-018: "config delete sweeps its buttons' secrets") -- otherwise they
    // linger as rows "a deleted config" with ciphertext nothing can ever use.
    const store = useCommandStore.getState()
    for (const cmd of store.commands.filter((c) => c.scope === 'config' && c.configId === configId)) {
      if (cmd.hasSecretArg) await window.electronAPI.credentials.delete(commandSecretKey(cmd.id))
      store.removeCommand(cmd.id)
    }
  }

  const launchFromConfig = async (config: TerminalConfig) => {
    launchConfig(config)
    onViewChange('sessions')
  }

  const launchGroup = async (groupId: string) => {
    // Running configs are skipped (launchableInGroup): launch-all is bring-up
    // — it fills in what is missing and never silently doubles what runs.
    for (const config of launchableInGroup(configs, groupId, runningCounts)) {
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
    if (renamingSessionId) {
      // Decoupled per-session "work name": renameSession writes customName ONLY
      // (never the Saved Config's label — that coupling was the confusion) AND
      // persists the name into the logs/history DB. Blank clears the override
      // -> tab reverts to `label`.
      useSessionStore.getState().renameSession(renamingSessionId, sessionRenameValue)
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
    // Running configs skipped for the same reason as launchGroup: bring-up
    // fills in what is missing, never silently doubles what runs.
    for (const config of launchableInSection(configs, groups, sectionId, runningCounts)) {
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
    // Only among the loose configs — see reorderLoose for why a drag between
    // grouped rows changed nothing visible, or the wrong thing.
    const reordered = dragConfigId ? reorderLoose(configs, looseConfigIds, dragConfigId, targetConfigId) : null
    if (reordered) reorderConfigs(reordered)
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
    selectedSessionIds.forEach(id => { killSessionPty(id); forgetSessionBrowserProfile(id); removeSession(id) })
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
      <aside
        className="w-12 flex flex-col border-r border-surface0 shrink-0 select-none titlebar-no-drag transition-[width] duration-200"
        style={{ background: 'var(--surface-panel)', boxShadow: 'var(--shadow-panel), var(--highlight-inset)', ...sideType }}
      >
        <SidebarNav
          currentView={currentView}
          onViewChange={onViewChange}
          insightsStatus={insightsStatus}
          insightsMessage={insightsMessage}
          cloudAgentRunning={cloudAgentRunning}
          visionRunning={visionRunning}
          serverRunning={serverRunning}
          tokenomicsIndexComplete={tokenomicsIndexComplete}
          collapsed
          onShowAccountUsage={onShowAccountUsage}
        />
        {/* #370: the config-load-failed notice below is in the EXPANDED list
            only, so the rail carries a danger glyph (tooltip + click opens the
            same notice in a popover) while writes are latched. Renders nothing
            otherwise. */}
        <ConfigLoadFailedRailIndicator />
        {/* `mt-auto` because the collapsed rail has no flex-1 child to push
            against — the nav is content-height. */}
        <AskConductorDock
          collapsed
          onOpened={() => onViewChange('sessions')}
          isActive={currentView === 'sessions' && !!askSession && activeSessionId === askSession.id}
          onShowTip={onShowTip}
        />
      </aside>
    )
  }

  // Helper to render a config row with DnD props
  const renderConfigRow = (config: TerminalConfig) => {
    // Drag-to-reorder is for the loose list only — the one place the flat
    // array order is the visible order. Rows inside a group or section are
    // neither drag sources nor drop targets, so a stray drag over them shows
    // no drop affordance and does nothing.
    const loose = looseConfigIds.has(config.id)
    const runningCount = runningCounts.get(config.id) ?? 0
    return (
      <ConfigRow
        key={config.id}
        config={config}
        onLaunch={() => launchFromConfig(config)}
        onEdit={() => setEditingConfig(config)}
        onDelete={() => handleDeleteConfig(config.id)}
        onPin={() => togglePinned(config.id)}
        onContextMenu={(e) => handleConfigContextMenu(e, config.id)}
        runningCount={runningCount}
        onOpenSession={runningCount > 0 ? () => {
          // The count pill's affordance: jump to the LATEST live session of
          // this config — on the Running tab, in the sessions view.
          const live = [...sessions].reverse().find((s) => s.configId === config.id)
          if (live) {
            setActiveSession(live.id)
            selectPanelTab('running')
            onViewChange('sessions')
          }
        } : undefined}
        draggable={loose}
        onDragStart={loose ? (e) => handleConfigDragStart(e, config.id) : undefined}
        onDragOver={loose ? (e) => handleConfigDragOver(e, config.id) : undefined}
        onDrop={loose ? (e) => handleConfigDrop(e, config.id) : undefined}
        onDragEnd={handleConfigDragEnd}
        isDragOver={loose && dragOverConfigId === config.id}
      />
    )
  }

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
        onContextMenu={(e) => { e.preventDefault(); const prefetchId = sshMappedProfileId(session, accountProfiles) ?? (session.profileId ?? primaryProfileId); refreshWebOnly(prefetchId); void refreshWebSessions(prefetchId); setSessionContextMenu({ sessionId: session.id, x: e.clientX, y: e.clientY }) }}
        isSelected={selectedSessionIds.has(session.id)}
        isFocused={focusedSessionIndex === flatIndex}
        ordinal={sessionOrdinals.get(session.id)}
      />
    )
  }

  return (
    <aside
      className={`flex flex-col border-r border-surface0 shrink-0 select-none titlebar-no-drag relative ${resizing || !widthAnimated ? '' : 'transition-[width] duration-200'}`}
      style={{ width: sidebarWidth, background: 'var(--surface-panel)', boxShadow: 'var(--shadow-panel), var(--highlight-inset)', ...sideType }}
    >
      {/* #461: drag the right edge to resize; width persists on release.
          Sits astride the aside's edge (right: -4px) fully CLEAR of the
          session list's 6px scrollbar — grabbing the scrollbar must scroll. */}
      <div
        onPointerDown={startSidebarResize}
        onDoubleClick={() => {
          sidebarWidthTouchedRef.current = true
          setSidebarWidth(resolveSidebarWidth(undefined))
          void useSettingsStore.getState().updateSettings({ sidebarWidth: undefined })
        }}
        className="absolute top-0 bottom-0 w-1 z-20 cursor-col-resize hover:bg-surface1"
        style={{ right: -4 }}
        title="Drag to resize — double-click to reset"
        data-testid="sidebar-resize-handle"
        aria-hidden="true"
      />
      {/* Navigation */}
      <SidebarNav
        currentView={currentView}
        onViewChange={onViewChange}
        insightsStatus={insightsStatus}
        insightsMessage={insightsMessage}
        cloudAgentRunning={cloudAgentRunning}
        visionRunning={visionRunning}
        serverRunning={serverRunning}
        tokenomicsIndexComplete={tokenomicsIndexComplete}
        onShowAccountUsage={onShowAccountUsage}
      />

      {/* Saved ⇄ Running — the two-mode head (design pass 2026-08-24). The
          whole left panel switches modes; the old hover fly-out, its notch and
          the pin-open machinery are gone — a mode needs no overlay. */}
      <div
        className="px-2 pt-2 pb-1.5 flex gap-1.5 shrink-0"
        role="tablist"
        aria-label="Sessions panel"
        onKeyDown={(e) => {
          // Roving tabs: Left/Right moves selection AND focus.
          if (e.key === 'ArrowLeft') { e.preventDefault(); selectPanelTabWithFocus('saved') }
          if (e.key === 'ArrowRight') { e.preventDefault(); selectPanelTabWithFocus('running') }
        }}
      >
        <button
          ref={savedTabRef}
          id="panel-tab-saved"
          role="tab"
          aria-selected={panelTab === 'saved'}
          aria-controls="saved-tabpanel"
          tabIndex={panelTab === 'saved' ? 0 : -1}
          onClick={() => selectPanelTab('saved')}
          className={`flex-1 h-8 rounded-lg flex items-center justify-center gap-1.5 text-xs font-semibold transition-colors focus-ring ${
            panelTab === 'saved' ? 'bg-surface0 border border-surface1 text-text' : 'border border-transparent text-overlay1 hover:text-text'
          }`}
          data-testid="panel-tab-saved"
          /* The tour's "Saved configs live here" anchor: on the always-mounted
             tab, NOT the "+ New" button inside the Saved body — the
             panel defaults to Running, and an unresolvable selector makes
             GuidedTour.available() silently skip the step. */
          data-tour="new-config"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={panelTab === 'saved' ? 'text-blue' : ''}>
            <line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" />
            <circle cx="9" cy="7" r="1.6" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="8" cy="17" r="1.6" fill="currentColor" stroke="none" />
          </svg>
          Saved
          <span className={`text-[10px] rounded-full px-1.5 py-0.5 ${panelTab === 'saved' ? 'bg-blue/20 text-blue' : 'bg-surface0 text-overlay1'}`}>{configs.length}</span>
        </button>
        <button
          ref={runningTabRef}
          id="panel-tab-running"
          role="tab"
          aria-selected={panelTab === 'running'}
          aria-controls="running-tabpanel"
          tabIndex={panelTab === 'running' ? 0 : -1}
          onClick={() => selectPanelTab('running')}
          className={`flex-1 h-8 rounded-lg flex items-center justify-center gap-1.5 text-xs font-semibold transition-colors focus-ring ${
            panelTab === 'running' ? 'bg-surface0 border border-surface1 text-text' : 'border border-transparent text-overlay1 hover:text-text'
          }`}
          data-testid="panel-tab-running"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={panelTab === 'running' ? 'text-blue' : ''}>
            <path d="M3 12h4l2 6 4-14 2 8h6" />
          </svg>
          Running
          <span className={`text-[10px] rounded-full px-1.5 py-0.5 ${panelTab === 'running' ? 'bg-blue/20 text-blue' : 'bg-surface0 text-overlay1'}`}>{sessions.length}</span>
        </button>
      </div>
      <div className="mx-2 border-t border-surface1 shrink-0" aria-hidden />

      {/* ── Saved tab: the launcher ── */}
      {panelTab === 'saved' && (
      <div id="saved-tabpanel" role="tabpanel" aria-labelledby="panel-tab-saved" className="flex flex-col flex-1 min-h-0" data-testid="saved-tab">
        <div className="px-2 pt-2 pb-1 shrink-0">
          <input
            value={configSearchQuery}
            onChange={(e) => setConfigSearchQuery(e.target.value)}
            placeholder="Search configs..."
            className="w-full bg-base border border-surface1 rounded px-2 py-1 text-xs text-text placeholder:text-overlay0 outline-none focus:border-blue"
          />
        </div>
        {/* The header icon buttons became labelled toolbar buttons here; the
            pin-panel button retired with the fly-out. The tour anchor lives on
            the Saved TAB (always mounted), not here. */}
        {/* One central + New button (#483) — what to create is the second
            click's question, so the two answers live in a menu, not the row. */}
        <div ref={newMenuRef} className="px-2 pb-1.5 flex justify-center shrink-0 relative">
          <button
            data-testid="new-button"
            onClick={() => setShowNewMenu((v) => !v)}
            aria-expanded={showNewMenu}
            aria-haspopup="menu"
            className="h-7 px-4 rounded-md bg-blue/20 border border-blue/45 text-blue text-[11px] font-semibold flex items-center gap-1 hover:bg-blue/30 transition-colors focus-ring"
            title="New config (Ctrl+T) or section"
          >
            <span className="font-extrabold">+</span> New
          </button>
          {showNewMenu && (
            <div
              role="menu"
              data-testid="new-menu"
              className="absolute top-full left-1/2 -translate-x-1/2 z-50 rounded-lg shadow-xl py-1 min-w-[150px]"
              style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
            >
              <button
                role="menuitem"
                data-testid="new-menu-config"
                onClick={() => { setShowNewMenu(false); setShowNewDialog(true) }}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors flex items-center justify-between gap-3"
                style={{ color: 'var(--text-primary)' }}
              >
                Config
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Ctrl+T</span>
              </button>
              <button
                role="menuitem"
                data-testid="new-menu-section"
                onClick={() => { setShowNewMenu(false); setShowNewSectionInput(true); setTimeout(() => newSectionInputRef.current?.focus(), 0) }}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors"
                style={{ color: 'var(--text-primary)' }}
              >
                Section
              </button>
            </div>
          )}
        </div>

        {/* The scrolling launcher list — sections, groups, loose configs. */}
        <div className="px-2 space-y-0.5 overflow-y-auto pb-2 flex-1 min-h-0">
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

        {/* Unsectioned ungrouped configs — the loose list. Divided from the
            organised part above so the eye stops reading it as the tail of
            the last group; the rule only appears when there IS something above
            it, so a sidebar of nothing but loose configs stays clean. */}
        {unsectionedUngroupedConfigs.length > 0 && (sectionData.length > 0 || unsectionedGroups.length > 0) && (
          <div
            className="mx-2 mt-2 mb-1.5 border-t border-surface1"
            role="separator"
            aria-label="Configs not in a section or group"
            data-testid="loose-configs-divider"
          />
        )}
        {unsectionedUngroupedConfigs.map(renderConfigRow)}
      </div>
      </div>
      )}{/* end Saved tab */}

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
          running={(runningCounts.get(contextMenuConfig.configId) ?? 0) > 0}
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

      {/* ── Running tab: the live sessions (rows untouched by design). Quick
          Start — launch-only, collapsible — leads the tab; the old
          always-below PinnedConfigsPanel is what it replaces. ── */}
      {panelTab === 'running' && (
      <div id="running-tabpanel" role="tabpanel" aria-labelledby="panel-tab-running" className="flex flex-col flex-1 min-h-0" data-testid="running-tab">
      <QuickStartPanel
        configs={configs}
        running={runningCounts}
        onLaunch={launchFromConfig}
        onContextMenu={handleConfigContextMenu}
      />
      <div className="p-3 flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <span className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Active Sessions</span>
          <span className="text-[10px] text-overlay0">{sessions.length}</span>
        </span>
        {selectedSessionIds.size > 1 && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-overlay0">{selectedSessionIds.size} selected</span>
            <button
              onClick={handleBulkClose}
              className="px-1.5 py-0.5 rounded text-[10px] bg-red/20 text-red hover:bg-red/30 transition-colors focus-ring"
            >
              Close All
            </button>
            <button
              onClick={() => setSelectedSessionIds(new Set())}
              className="px-1.5 py-0.5 rounded text-[10px] bg-surface1 text-overlay1 hover:bg-surface1/80 transition-colors focus-ring"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      <div
        className="flex-1 overflow-y-auto px-2 space-y-0.5 pb-2"
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
            requestCloseSession(s.id)
            setFocusedSessionIndex(prev => Math.min(prev, sessions.length - 2))
          } else if (e.key === 'Escape') {
            setSelectedSessionIds(new Set())
            setFocusedSessionIndex(-1)
          }
        }}
      >
        {/* One-time colour-migration notice. Wires Review colours to the SAME
            edit dialog ConfigRow.onEdit uses (setEditingConfig below). */}
        <ColourMigrationNotice
          onOpenConfigEditor={(configId) => {
            const cfg = configs.find((c) => c.id === configId)
            if (cfg) setEditingConfig(cfg)
          }}
        />

        {/* P2.4: warns when a corrupt config section was reset on hydrate. */}
        <ConfigLoadFailedNotice />
        <ConfigHydrationNotice />

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
                allSessions.forEach((s) => { killSessionPty(s.id); forgetSessionBrowserProfile(s.id); removeSession(s.id) })
              }}
            />
            {!sessionSectionCollapsed[section.id] && (
              <div className="space-y-0.5">
                {sectionGroups.map(({ group, sessions: groupSessions }) => (
                  <div key={group.id} className="mb-1">
                    <SessionGroupHeader
                      name={group.name}
                      collapsed={sessionGroupCollapsed[group.id]}
                      onToggleCollapse={() => setSessionGroupCollapsed((prev) => ({ ...prev, [group.id]: !prev[group.id] }))}
                      onCloseAll={() => { groupSessions.forEach((s) => { killSessionPty(s.id); forgetSessionBrowserProfile(s.id); removeSession(s.id) }) }}
                    />
                    {!sessionGroupCollapsed[group.id] && (
                      <div className="space-y-0.5">
                        {groupSessions.map(renderSessionRow)}
                      </div>
                    )}
                  </div>
                ))}
                {/* #363: loose sessions in this section get an "Ungrouped"
                    heading only when a group sits above them; a section of
                    nothing but loose sessions stays bare. */}
                {sectionGroups.length > 0 && looseSessions.length > 0 ? (
                  <div className="mb-1">
                    <UngroupedSessionsHeader
                      collapsed={ungroupedSessionsCollapsed[section.id]}
                      onToggleCollapse={() => toggleUngroupedSessionsCollapsed(section.id)}
                      onCloseAll={() => { looseSessions.forEach((s) => { killSessionPty(s.id); forgetSessionBrowserProfile(s.id); removeSession(s.id) }) }}
                    />
                    {!ungroupedSessionsCollapsed[section.id] && (
                      <div className="space-y-0.5">
                        {looseSessions.map(renderSessionRow)}
                      </div>
                    )}
                  </div>
                ) : (
                  looseSessions.map(renderSessionRow)
                )}
              </div>
            )}
          </div>
        ))}

        {/* Unsectioned grouped sessions */}
        {unsectionedSessionGroups.map(({ group, sessions: groupSessions }) => (
          <div key={group.id} className="mb-1">
            <SessionGroupHeader
              name={group.name}
              collapsed={sessionGroupCollapsed[group.id]}
              onToggleCollapse={() => setSessionGroupCollapsed((prev) => ({ ...prev, [group.id]: !prev[group.id] }))}
              onCloseAll={() => { groupSessions.forEach((s) => { killSessionPty(s.id); forgetSessionBrowserProfile(s.id); removeSession(s.id) }) }}
            />
            {!sessionGroupCollapsed[group.id] && (
              <div className="space-y-0.5">
                {groupSessions.map(renderSessionRow)}
              </div>
            )}
          </div>
        ))}

        {/* Unsectioned ungrouped sessions — the loose tail. #363: headed
            "Ungrouped" (collapsible, close-all, same look as a group heading)
            only when something organised sits above it — a section or a group
            — so it stops reading as the tail of the last group, while a
            sidebar of nothing but loose sessions stays clean. Mirrors the
            loose-configs divider rule above. */}
        {unsectionedUngroupedSessions.length > 0 && (sessionSectionData.length > 0 || unsectionedSessionGroups.length > 0) ? (
          <div className="mb-1">
            <UngroupedSessionsHeader
              collapsed={ungroupedSessionsCollapsed['']}
              onToggleCollapse={() => toggleUngroupedSessionsCollapsed('')}
              onCloseAll={() => { unsectionedUngroupedSessions.forEach((s) => { killSessionPty(s.id); forgetSessionBrowserProfile(s.id); removeSession(s.id) }) }}
            />
            {!ungroupedSessionsCollapsed[''] && (
              <div className="space-y-0.5">
                {unsectionedUngroupedSessions.map(renderSessionRow)}
              </div>
            )}
          </div>
        ) : (
          unsectionedUngroupedSessions.map(renderSessionRow)
        )}
      </div>
      </div>
      )}{/* end Running tab */}

      {/* Ask Conductor, docked below the session list. Sibling of the scrollers
          (each tab's scroller is that tab's only flex-1 child), so it stays
          pinned to the bottom whichever tab is active. */}
      <AskConductorDock
        onOpened={() => onViewChange('sessions')}
        isActive={currentView === 'sessions' && !!askSession && activeSessionId === askSession.id}
        onShowTip={onShowTip}
      />

      {/* Session context menu */}
      {sessionContextMenu && (() => {
        const s = sessions.find((s) => s.id === sessionContextMenu.sessionId)
        if (!s) return null
        const cfg = s.configId ? configs.find((c) => c.id === s.configId) : undefined
        // SSH → local-profile mapping (harmonise-remote): a mapped SSH session
        // gets the local-machine account affordances (claude.ai / Claude Code /
        // artifacts / sign-in). Undefined for a local/shell/non-Claude session,
        // and for an SSH session with no matching local profile.
        const sshProfileId = sshMappedProfileId(s, accountProfiles)
        // The LOCAL profile the account actions operate on: the session's own
        // profile for a local session (primary as the #269 fallback), the email-
        // mapped profile for a mapped SSH session. Undefined for a shell-only
        // session, and for an SSH session with no matching local profile — which
        // keeps the profile-scoped items hidden/off there, exactly as before.
        const actionProfileId = !s.shellOnly && s.sessionType === 'local'
          ? (s.profileId ?? primaryProfileId)
          : sshProfileId
        return (
          <SessionContextMenu
            x={sessionContextMenu.x}
            y={sessionContextMenu.y}
            session={s}
            hasGroup={!!cfg?.groupId}
            onRename={() => handleStartSessionRename(s.id, s.customName?.trim() || s.label)}
            configPinned={cfg?.pinned}
            onPinConfig={cfg ? () => {
              togglePinned(cfg.id)
              trackUsage('sessions.pin-config')
              setSessionContextMenu(null)
            } : undefined}
            onRemoveFromGroup={() => {
              if (cfg) moveConfigToGroup(cfg.id, undefined)
              setSessionContextMenu(null)
            }}
            onClose={() => {
              // item 4: persistent SSH sessions get the End-vs-Leave choice.
              requestCloseSession(sessionContextMenu.sessionId)
              setSessionContextMenu(null)
            }}
            onDismiss={() => setSessionContextMenu(null)}
            canSwitchAccount={canSwitchAccount}
            profiles={accountProfiles}
            accountAliases={accountAliases}
            onSwitchAccount={(profileId) => {
              // Gates the multi-account tip's "you already do this" variant.
              trackUsage('accounts.switch-session-account')
              switchMenuAccount(s.id, profileId)
            }}
            // #216: account actions on the session itself. Gated to a local
            // session with a resolved account — an SSH session's browser and
            // credentials live on another machine, and a shell-only session has
            // no /login to run.
            hasWebSession={
              // Drives the "Open artifacts" enabled state (+ the authenticate
              // wording): does the acting profile hold a claude.ai web session.
              // The acting profile is the SSH-mapped local profile for a mapped
              // remote session, else the session's own (#269 primary fallback).
              !!actionProfileId && authByProfile[actionProfileId]?.web === 'active'
            }
            codeSignedIn={!!actionProfileId && (s.provider ?? 'claude') === 'claude' && authByProfile[actionProfileId]?.cliAuthed === true}
            onOpenArtifacts={
              actionProfileId
                ? () => {
                    // Owner call 2026-08-26: this menu item has no chooser of
                    // its own — it silently follows the global open-target
                    // setting (window by default; the pane when chosen). The
                    // helper keeps the window path's error surfacing (#216's
                    // fix: a refusal must never be silent).
                    openArtifactsPerSetting(actionProfileId, s.id)
                  }
                : undefined
            }
            onAuthenticateWeb={
              actionProfileId
                ? () => { void authenticateWebForSession(actionProfileId) }
                : undefined
            }
            onSignInCode={
              // Local Claude keeps its exact gate (available even with no profile
              // yet — that is when you first need to sign in); a mapped SSH
              // session runs /login in its own (remote) terminal.
              (!s.shellOnly && s.sessionType === 'local' && (s.provider ?? 'claude') === 'claude') || sshProfileId
                ? () => {
                    // Restores what the old add-account flow actually DID: put the
                    // login in front of the user instead of telling them a command.
                    // /login is the in-session form, so it reuses this terminal and
                    // this account's config dir rather than starting anything new.
                    window.electronAPI.pty.write(s.id, '/login\r')
                    onViewChange('sessions')
                  }
                : undefined
            }
          />
        )
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
          liveSessionCount={runningCounts.get(editingConfig.id) ?? 0}
        />
      )}

    </aside>
  )
}
