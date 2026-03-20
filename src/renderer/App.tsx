import React, { useEffect, useState, useRef } from 'react'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import TabBar from './components/TabBar'
import SessionHeader from './components/SessionHeader'
import TerminalView, { killSessionPty } from './components/TerminalView'
import StatusBar from './components/StatusBar'
import UsageDashboard from './components/UsageDashboard'
import ProjectBrowser from './components/ProjectBrowser'
import SettingsPage from './components/SettingsPage'
import LogViewer from './components/LogViewer'
import InsightsPage from './components/InsightsPage'
import CloudAgentsPage from './components/CloudAgentsPage'
import TokenomicsPage from './components/TokenomicsPage'
import SetupDialog from './components/SetupDialog'
import WhatsNewModal, { shouldShowWhatsNew, markWhatsNewSeen } from './components/WhatsNewModal'
import TrainingWalkthrough, { shouldShowTraining, isFirstInstall } from './components/TrainingWalkthrough'
import ErrorBoundary from './components/ErrorBoundary'
import CloseDialog from './components/CloseDialog'
import { useSessionStore, Session } from './stores/sessionStore'
import { useConfigStore } from './stores/configStore'
import { useCommandStore } from './stores/commandStore'
import { useMagicButtonStore } from './stores/magicButtonStore'
import { useAppMetaStore } from './stores/appMetaStore'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { markSessionForResumePicker } from './utils/resumePicker'
import { gatherLocalStorageData, hydrateStores } from './utils/configHydration'
import { setupCloudAgentListener } from './stores/cloudAgentStore'
import { setupTokenomicsListener } from './stores/tokenomicsStore'
import type { SessionState, SavedSession } from './types/electron'

// Re-export ViewType from its canonical location for backwards compatibility
export type { ViewType } from './types/views'
import type { ViewType } from './types/views'

// Re-export resume picker for backwards compatibility
export { markSessionForResumePicker, shouldUseResumePicker } from './utils/resumePicker'

declare const __APP_VERSION__: string

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [view, setView] = useState<ViewType>('sessions')
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [needsCliSetup, setNeedsCliSetup] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [closeDialog, setCloseDialog] = useState<'close' | 'update' | null>(null)
  const [showWhatsNew, setShowWhatsNew] = useState(false)
  const [showTraining, setShowTraining] = useState(false)
  const [partnerActive, setPartnerActive] = useState<Set<string>>(new Set())
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const hasRestoredRef = useRef(false)

  // Global keyboard shortcuts
  useKeyboardShortcuts(activeSessionId, setSidebarOpen, setView)

  const togglePartner = (sessionId: string) => {
    setPartnerActive(prev => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  // Load config and hydrate stores after setup is complete
  useEffect(() => {
    window.electronAPI.setup.isComplete().then(async (complete) => {
      setSetupComplete(complete)
      if (complete) {
        await loadAndHydrateConfig()
      }
    })
  }, [])

  async function loadAndHydrateConfig() {
    try {
      console.log('[App] Loading config from CONFIG/...')
      const result = await window.electronAPI.config.loadAll()

      if (result.needsMigration) {
        console.log('[App] CONFIG/ is empty, migrating from localStorage...')
        const lsData = gatherLocalStorageData()
        if (Object.keys(lsData).length > 0) {
          await window.electronAPI.config.migrateFromLocalStorage(lsData)
          console.log('[App] Migration complete, reloading...')
          const reloaded = await window.electronAPI.config.loadAll()
          hydrateStores(reloaded.data)
        } else {
          hydrateStores(result.data)
        }
      } else {
        hydrateStores(result.data)
      }

      setConfigLoaded(true)
    } catch (err) {
      console.error('[App] Failed to load config:', err)
      hydrateStores({})
      setConfigLoaded(true)
    }
  }

  // Post-config-load initialization
  useEffect(() => {
    if (!configLoaded || hasRestoredRef.current) return
    hasRestoredRef.current = true

    async function postConfigInit() {
      const appMeta = useAppMetaStore.getState().meta
      if (appMeta.setupVersion !== __APP_VERSION__) {
        const hasExistingConfig = useConfigStore.getState().configs.length > 0 ||
          useCommandStore.getState().commands.length > 0
        if (hasExistingConfig) {
          useAppMetaStore.getState().update({ setupVersion: __APP_VERSION__ })
        } else {
          const cliReady = await window.electronAPI.setup.isCliReady()
          if (cliReady) {
            useAppMetaStore.getState().update({ setupVersion: __APP_VERSION__ })
          } else {
            setNeedsCliSetup(true)
          }
        }
      }

      await restoreSavedSessions()

      // Start cloud agent IPC listener early so status updates are
      // never missed (previously only started when CloudAgentsPage mounted)
      setupCloudAgentListener()
      setupTokenomicsListener()

      const magicSettings = useMagicButtonStore.getState().settings
      if (magicSettings.autoDeleteDays != null && magicSettings.autoDeleteDays > 0) {
        window.electronAPI.screenshot.cleanup(magicSettings.autoDeleteDays)
      }

      setTimeout(() => {
        if (isFirstInstall()) {
          setShowTraining(true)
        } else {
          if (shouldShowWhatsNew()) setShowWhatsNew(true)
          else if (shouldShowTraining()) setShowTraining(true)
        }
      }, 500)
    }

    postConfigInit()
  }, [configLoaded])

  // Restore saved sessions on startup
  async function restoreSavedSessions() {
    try {
      const savedState = await window.electronAPI.session.load() as SessionState | null
      if (!savedState || savedState.sessions.length === 0) return

      console.log(`[App] Restoring ${savedState.sessions.length} sessions...`)

      const restoredSessions: Session[] = savedState.sessions.map((saved: SavedSession) => ({
        ...saved,
        status: 'idle' as const,
        createdAt: Date.now(),
      }))

      for (const session of restoredSessions) {
        if (!session.shellOnly && session.sessionType === 'local') {
          markSessionForResumePicker(session.id)
        }
      }

      useSessionStore.getState().restoreSessions(restoredSessions, savedState.activeSessionId)
      await window.electronAPI.session.clear()

      console.log('[App] Sessions restored')
    } catch (err) {
      console.error('[App] Failed to restore sessions:', err)
    }
  }

  // Build session state object for saving
  const buildSessionState = (): SessionState => {
    const state = useSessionStore.getState()
    return {
      sessions: state.sessions.map(s => ({
        id: s.id,
        configId: s.configId,
        label: s.label,
        workingDirectory: s.workingDirectory,
        model: s.model,
        color: s.color,
        sessionType: s.sessionType,
        shellOnly: s.shellOnly,
        partnerTerminalPath: s.partnerTerminalPath,
        partnerElevated: s.partnerElevated,
        sshConfig: s.sshConfig ? {
          host: s.sshConfig.host,
          port: s.sshConfig.port,
          username: s.sshConfig.username,
          remotePath: s.sshConfig.remotePath,
          hasPassword: s.sshConfig.hasPassword,
          postCommand: s.sshConfig.postCommand,
          hasSudoPassword: !!s.sshConfig.sudoPassword,
          startClaudeAfter: s.sshConfig.startClaudeAfter,
          dockerContainer: s.sshConfig.dockerContainer,
        } : undefined,
        visionConfig: s.visionConfig,
        legacyVersion: s.legacyVersion,
        agentIds: s.agentIds,
      })),
      activeSessionId: state.activeSessionId,
      savedAt: Date.now(),
    }
  }

  const handleSaveAndClose = async () => {
    const isUpdate = closeDialog === 'update'
    setCloseDialog(null)
    setIsClosing(true)
    if (isUpdate) setIsUpdating(true)
    try {
      await window.electronAPI.session.save(buildSessionState())
      console.log('[App] Session state saved')
      if (isUpdate) {
        await window.electronAPI.update.installAndRestart()
      } else {
        await window.electronAPI.session.gracefulExit()
        console.log('[App] Sessions gracefully exited')
        window.electronAPI.window.allowClose()
      }
    } catch (err) {
      console.error('[App] Error during graceful shutdown:', err)
      if (!isUpdate) window.electronAPI.window.allowClose()
      setIsClosing(false)
    }
  }

  const handleCloseWithoutSaving = async () => {
    const isUpdate = closeDialog === 'update'
    setCloseDialog(null)
    setIsClosing(true)
    if (isUpdate) setIsUpdating(true)
    try {
      await window.electronAPI.session.clear()
      console.log('[App] Session state cleared')
      if (isUpdate) {
        await window.electronAPI.update.installAndRestart()
      } else {
        window.electronAPI.window.allowClose()
      }
    } catch (err) {
      console.error('[App] Error during close:', err)
      if (!isUpdate) window.electronAPI.window.allowClose()
      setIsClosing(false)
    }
  }

  // Main process sends 'closeRequested' when window close is attempted
  useEffect(() => {
    const handleCloseRequested = () => {
      if (isClosing) return
      const state = useSessionStore.getState()
      if (state.sessions.length === 0) {
        window.electronAPI.window.allowClose()
        return
      }
      setCloseDialog('close')
    }

    const unsub = window.electronAPI.window.onCloseRequested(handleCloseRequested)
    return () => unsub()
  }, [isClosing])

  // Render non-session views (shown on top of sessions)
  const renderOverlayView = () => {
    if (view === 'logs') return <LogViewer />
    if (view === 'settings') return <SettingsPage />
    if (view === 'insights') return <InsightsPage />
    if (view === 'cloud-agents') return <CloudAgentsPage />
    if (view === 'tokenomics') return <TokenomicsPage />
    return null
  }

  // Sessions are ALWAYS rendered (kept alive) but hidden when another view is active.
  const renderSessions = () => {
    if (!activeSessionId || sessions.length === 0 || !activeSession) {
      return (
        <div className="flex-1 flex flex-col" style={{ display: view === 'sessions' ? 'flex' : 'none' }}>
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-overlay1">
              <div className="text-5xl mb-4 font-mono">&gt;_</div>
              <h2 className="text-xl font-semibold mb-2">Claude Command Center <span className="text-yellow/70">Beta</span></h2>
              <p className="text-sm">Create a terminal config to get started</p>
              <p className="text-xs text-overlay0 mt-2">Ctrl+T to create, Ctrl+Tab to switch</p>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="flex-1 flex flex-col" style={{ display: view === 'sessions' ? 'flex' : 'none', minHeight: 0 }}>
        <TabBar />
        <SessionHeader session={activeSession} isShowingPartner={partnerActive.has(activeSession.id)} sidebarCollapsed={!sidebarOpen} />
        {sessions.map((session) => {
          const isShowingPartner = partnerActive.has(session.id)
          const hasPartner = !!session.partnerTerminalPath
          const partnerPtyId = session.id + '-partner'
          return (
            <div
              key={session.id + '-' + session.createdAt}
              className="flex-1 flex flex-col"
              style={{
                display: session.id === activeSessionId ? 'flex' : 'none',
                minHeight: 0,
              }}
            >
              <div
                className="flex-1 flex flex-col"
                style={{
                  display: isShowingPartner ? 'none' : 'flex',
                  minHeight: 0,
                }}
              >
                <TerminalView
                  key={session.id + '-main-' + session.createdAt}
                  sessionId={session.id}
                  configId={session.configId}
                  cwd={session.sessionType === 'local' ? session.workingDirectory : undefined}
                  shellOnly={session.shellOnly}
                  ssh={session.sshConfig}
                  isActive={session.id === activeSessionId && view === 'sessions' && !isShowingPartner}
                  partnerEnabled={hasPartner}
                  isPartnerActive={isShowingPartner}
                  onTogglePartner={() => togglePartner(session.id)}
                  partnerSessionId={hasPartner ? partnerPtyId : undefined}
                  visionConfig={session.visionConfig}
                  legacyVersion={session.legacyVersion}
                  agentIds={session.agentIds}
                />
              </div>
              {hasPartner && (
                <div
                  className="flex-1 flex flex-col"
                  style={{
                    display: isShowingPartner ? 'flex' : 'none',
                    minHeight: 0,
                  }}
                >
                  <TerminalView
                    key={partnerPtyId + '-' + session.createdAt}
                    sessionId={partnerPtyId}
                    configId={session.configId}
                    cwd={session.partnerTerminalPath}
                    shellOnly={true}
                    elevated={session.partnerElevated}
                    isActive={session.id === activeSessionId && view === 'sessions' && isShowingPartner}
                    partnerEnabled={true}
                    isPartnerActive={isShowingPartner}
                    onTogglePartner={() => togglePartner(session.id)}
                    partnerSessionId={partnerPtyId}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  // Show loading while checking setup status or loading config
  if (setupComplete === null || (setupComplete && !configLoaded)) {
    return (
      <div className="flex flex-col h-screen bg-base text-text items-center justify-center">
        <div className="text-overlay1">Loading...</div>
      </div>
    )
  }

  // Show setup dialog on first run
  if (!setupComplete) {
    return <SetupDialog onComplete={async () => {
      await loadAndHydrateConfig()
      useAppMetaStore.getState().update({ setupVersion: __APP_VERSION__ })
      setSetupComplete(true)
      setNeedsCliSetup(false)
    }} />
  }

  // Show setup dialog on version change — CLI not trusted
  if (needsCliSetup) {
    return <SetupDialog initialStep={2} onComplete={() => { useAppMetaStore.getState().update({ setupVersion: __APP_VERSION__ }); setNeedsCliSetup(false) }} />
  }

  const handleWhatsNewClose = () => {
    markWhatsNewSeen()
    setShowWhatsNew(false)
    if (shouldShowTraining()) {
      setTimeout(() => setShowTraining(true), 300)
    }
  }

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-screen bg-base text-text">
        {showWhatsNew && <WhatsNewModal onClose={handleWhatsNewClose} />}
        {showTraining && <TrainingWalkthrough onClose={() => setShowTraining(false)} />}

        {closeDialog && (
          <CloseDialog
            mode={closeDialog}
            sessionCount={sessions.length}
            onSaveAndClose={handleSaveAndClose}
            onCloseWithoutSaving={handleCloseWithoutSaving}
            onCancel={() => { setCloseDialog(null); window.electronAPI.window.cancelClose() }}
          />
        )}

        {isClosing && (
          <div className="absolute inset-0 bg-base/90 z-50 flex items-center justify-center">
            <div className="text-center">
              <div className="text-2xl font-mono mb-4 text-blue animate-pulse">
                {isUpdating ? 'Updating...' : 'Closing...'}
              </div>
              <p className="text-overlay1 text-sm">
                {isUpdating ? 'Installing update and restarting' : 'Please wait'}
              </p>
            </div>
          </div>
        )}
        <TitleBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar currentView={view} onViewChange={setView} collapsed={!sidebarOpen} onUpdateRequested={() => {
            const state = useSessionStore.getState()
            if (state.sessions.length === 0) {
              setIsClosing(true)
              setIsUpdating(true)
              window.electronAPI.update.installAndRestart().catch(() => { setIsClosing(false); setIsUpdating(false) })
            } else {
              setCloseDialog('update')
            }
          }} />
          <main className="flex-1 flex flex-col overflow-hidden titlebar-no-drag">
            {renderSessions()}
            {renderOverlayView()}
          </main>
        </div>
        <StatusBar />
      </div>
    </ErrorBoundary>
  )
}
