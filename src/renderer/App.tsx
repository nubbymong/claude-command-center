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
import SetupDialog from './components/SetupDialog'
import WhatsNewModal, { shouldShowWhatsNew, markWhatsNewSeen } from './components/WhatsNewModal'
import { useSessionStore, Session } from './stores/sessionStore'
import { useCommandStore, DEFAULT_COMMANDS } from './stores/commandStore'
import { useConfigStore } from './stores/configStore'
import { useMagicButtonStore } from './stores/magicButtonStore'
import { useSettingsStore } from './stores/settingsStore'
import { useAppMetaStore } from './stores/appMetaStore'
import type { SessionState, SavedSession } from './types/electron'

export type ViewType = 'sessions' | 'usage' | 'browser' | 'logs' | 'settings' | 'insights'

// Error boundary to catch renderer crashes and show error instead of blank screen
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Renderer crash:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col h-screen bg-base text-text p-8">
          <h1 className="text-2xl font-bold text-red mb-4">Something went wrong</h1>
          <p className="text-subtext1 mb-4">The app encountered an error. Your sessions are still running in the background.</p>
          <pre className="bg-surface0 p-4 rounded text-sm text-red overflow-auto flex-1 mb-4">
            {this.state.error?.message}
            {'\n\n'}
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-2 bg-blue text-crust rounded hover:bg-blue/80 w-fit"
          >
            Try to recover
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// Track sessions that should use the resume picker (restored local sessions)
const resumePickerSessionIds = new Set<string>()

export function markSessionForResumePicker(sessionId: string) {
  resumePickerSessionIds.add(sessionId)
}

export function shouldUseResumePicker(sessionId: string): boolean {
  if (resumePickerSessionIds.has(sessionId)) {
    resumePickerSessionIds.delete(sessionId)
    return true
  }
  return false
}

declare const __APP_VERSION__: string

/**
 * Gather all relevant localStorage keys for migration to CONFIG/.
 */
function gatherLocalStorageData(): Record<string, string> {
  const keys = [
    'claude-multi-commands',
    'claude-multi-commands-seeded-v2',
    'claude-multi-configs',
    'claude-multi-config-groups',
    'claude-multi-config-sections',
    'claude-multi-settings',
    'claude-multi-magic-buttons',
    'claude-multi-color-migration-v2',
    'claude-conductor-setup-version',
    'claude-conductor-last-seen-version',
  ]
  const data: Record<string, string> = {}
  for (const key of keys) {
    const value = localStorage.getItem(key)
    if (value != null) {
      data[key] = value
    }
  }
  return data
}

/**
 * Hydrate all stores from loaded config data.
 */
function hydrateStores(configData: Record<string, unknown>): void {
  // Commands — seed defaults if empty
  const commands = (configData.commands as any[]) || [...DEFAULT_COMMANDS]
  useCommandStore.getState().hydrate(commands)

  // Terminal configs
  const configs = (configData.configs as any[]) || []
  const groups = (configData.configGroups as any[]) || []
  const sections = (configData.configSections as any[]) || []
  useConfigStore.getState().hydrate(configs, groups, sections)

  // Magic buttons
  const magicButtons = configData.magicButtons || {}
  useMagicButtonStore.getState().hydrate(magicButtons as any)

  // Settings
  const settings = configData.settings || {}
  useSettingsStore.getState().hydrate(settings as any)

  // App meta
  const appMeta = configData.appMeta || {}
  useAppMetaStore.getState().hydrate(appMeta as any)

  console.log('[App] All stores hydrated from CONFIG/')
}

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
  const [partnerActive, setPartnerActive] = useState<Set<string>>(new Set())
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const hasRestoredRef = useRef(false)

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
          // Reload after migration
          const reloaded = await window.electronAPI.config.loadAll()
          hydrateStores(reloaded.data)
        } else {
          // Fresh install — hydrate with defaults
          hydrateStores(result.data)
        }
      } else {
        hydrateStores(result.data)
      }

      setConfigLoaded(true)
    } catch (err) {
      console.error('[App] Failed to load config:', err)
      // Fall through — hydrate with empty defaults so the app still works
      hydrateStores({})
      setConfigLoaded(true)
    }
  }

  // Post-config-load initialization
  useEffect(() => {
    if (!configLoaded || hasRestoredRef.current) return
    hasRestoredRef.current = true

    async function postConfigInit() {
      // On version change: check if CLI is trusted
      const appMeta = useAppMetaStore.getState().meta
      if (appMeta.setupVersion !== __APP_VERSION__) {
        // If we already have config data, this is an upgrade — just stamp and skip
        const hasExistingConfig = useConfigStore.getState().configs.length > 0 ||
          useCommandStore.getState().commands.length > 0
        if (hasExistingConfig) {
          // Existing user — auto-stamp, no CLI setup needed
          useAppMetaStore.getState().update({ setupVersion: __APP_VERSION__ })
        } else {
          // Fresh install — check if CLI is trusted
          const cliReady = await window.electronAPI.setup.isCliReady()
          if (cliReady) {
            useAppMetaStore.getState().update({ setupVersion: __APP_VERSION__ })
          } else {
            setNeedsCliSetup(true)
          }
        }
      }

      await restoreSavedSessions()

      // Auto-cleanup old screenshots
      const magicSettings = useMagicButtonStore.getState().settings
      if (magicSettings.autoDeleteDays != null && magicSettings.autoDeleteDays > 0) {
        window.electronAPI.screenshot.cleanup(magicSettings.autoDeleteDays)
      }

      // Check if we should show What's New modal (after a short delay for restore to complete)
      setTimeout(() => {
        if (shouldShowWhatsNew()) {
          setShowWhatsNew(true)
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

      // Convert saved sessions to full Session objects
      const restoredSessions: Session[] = savedState.sessions.map((saved: SavedSession) => ({
        ...saved,
        status: 'idle' as const,
        createdAt: Date.now(),
        // Mark non-shellOnly sessions for /resume
      }))

      // Mark local Claude sessions for resume picker (shows conversation list before Claude)
      for (const session of restoredSessions) {
        if (!session.shellOnly && session.sessionType === 'local') {
          markSessionForResumePicker(session.id)
        }
      }

      // Restore to store
      useSessionStore.getState().restoreSessions(restoredSessions, savedState.activeSessionId)

      // Clear the saved state after successful restore
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
      })),
      activeSessionId: state.activeSessionId,
      savedAt: Date.now(),
    }
  }

  // Close with saving sessions (for restore on next launch)
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

  // Close without saving sessions (sessions die)
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
      // If no sessions, allow close immediately
      if (state.sessions.length === 0) {
        window.electronAPI.window.allowClose()
        return
      }
      // Show close dialog
      setCloseDialog('close')
    }

    const unsub = window.electronAPI.window.onCloseRequested(handleCloseRequested)
    return () => unsub()
  }, [isClosing])


  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      // Ctrl+W: close current session
      if (e.ctrlKey && e.key === 'w') {
        e.preventDefault()
        if (activeSessionId) {
          killSessionPty(activeSessionId)
          killSessionPty(activeSessionId + '-partner')
          useSessionStore.getState().removeSession(activeSessionId)
        }
      }
      // Ctrl+Tab: next session
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        const state = useSessionStore.getState()
        if (state.sessions.length > 1 && state.activeSessionId) {
          const idx = state.sessions.findIndex(s => s.id === state.activeSessionId)
          const nextIdx = e.shiftKey
            ? (idx - 1 + state.sessions.length) % state.sessions.length
            : (idx + 1) % state.sessions.length
          state.setActiveSession(state.sessions[nextIdx].id)
        }
      }
      // Ctrl+1-9: jump to session
      if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const idx = parseInt(e.key) - 1
        const state = useSessionStore.getState()
        if (idx < state.sessions.length) {
          state.setActiveSession(state.sessions[idx].id)
          setView('sessions')
        }
      }
      // Ctrl+B: toggle sidebar
      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault()
        setSidebarOpen(prev => !prev)
      }
      // Ctrl+Shift+D: toggle debug recording
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault()
        window.electronAPI.debug.isEnabled().then(enabled => {
          if (enabled) {
            window.electronAPI.debug.disable()
          } else {
            window.electronAPI.debug.enable()
          }
        })
      }
      // Alt+V: paste clipboard image into active terminal
      if (e.altKey && e.key === 'v') {
        e.preventDefault()
        const state = useSessionStore.getState()
        if (state.activeSessionId) {
          const base64 = await window.electronAPI.clipboard.readImage()
          if (base64) {
            window.electronAPI.pty.write(state.activeSessionId, base64)
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeSessionId])

  // Render non-session views (shown on top of sessions)
  const renderOverlayView = () => {
    if (view === 'usage') return <UsageDashboard />
    if (view === 'browser') return <ProjectBrowser />
    if (view === 'logs') return <LogViewer />
    if (view === 'settings') return <SettingsPage />
    if (view === 'insights') return <InsightsPage />
    return null
  }

  // Sessions are ALWAYS rendered (kept alive) but hidden when another view is active.
  // This preserves terminal state, input text, and PTY connections across view switches.
  const renderSessions = () => {
    if (!activeSessionId || sessions.length === 0 || !activeSession) {
      return (
        <div className="flex-1 flex flex-col" style={{ display: view === 'sessions' ? 'flex' : 'none' }}>
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-overlay1">
              <div className="text-5xl mb-4 font-mono">&gt;_</div>
              <h2 className="text-xl font-semibold mb-2">Claude Conductor <span className="text-yellow/70">Beta</span></h2>
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
        <SessionHeader session={activeSession} isShowingPartner={partnerActive.has(activeSession.id)} />
        {/* Render ALL sessions but only show the active one - keeps PTYs alive */}
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
              {/* Main terminal */}
              <div
                className="flex-1 flex flex-col"
                style={{
                  display: isShowingPartner ? 'none' : 'flex',
                  minHeight: 0,
                }}
              >
                <TerminalView
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
                />
              </div>
              {/* Partner terminal */}
              {hasPartner && (
                <div
                  className="flex-1 flex flex-col"
                  style={{
                    display: isShowingPartner ? 'flex' : 'none',
                    minHeight: 0,
                  }}
                >
                  <TerminalView
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

  // Show setup dialog on version change — CLI not trusted, skip to step 2 (dirs already saved)
  if (needsCliSetup) {
    return <SetupDialog initialStep={2} onComplete={() => { useAppMetaStore.getState().update({ setupVersion: __APP_VERSION__ }); setNeedsCliSetup(false) }} />
  }

  const handleWhatsNewClose = () => {
    markWhatsNewSeen()
    setShowWhatsNew(false)
  }

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-screen bg-base text-text">
        {/* What's New modal */}
        {showWhatsNew && <WhatsNewModal onClose={handleWhatsNewClose} />}

        {/* Close/Update dialog */}
        {closeDialog && (
          <div className="absolute inset-0 bg-base/80 z-50 flex items-center justify-center">
            <div className="bg-surface0 border border-surface1 rounded-lg shadow-2xl p-6 max-w-sm w-full mx-4">
              <h2 className="text-lg font-semibold text-text mb-2">
                {closeDialog === 'update' ? 'Update & Restart' : 'Close App'}
              </h2>
              <p className="text-sm text-overlay1 mb-5">
                You have {sessions.length} active session{sessions.length !== 1 ? 's' : ''}.
                Would you like to save them for next launch?
              </p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleSaveAndClose}
                  className="w-full py-2 px-4 text-sm font-medium rounded bg-blue hover:bg-blue/80 text-crust transition-colors"
                >
                  Save Sessions
                </button>
                <button
                  onClick={handleCloseWithoutSaving}
                  className="w-full py-2 px-4 text-sm font-medium rounded bg-surface1 hover:bg-surface2 text-text transition-colors"
                >
                  Close Sessions
                </button>
                <button
                  onClick={() => { setCloseDialog(null); window.electronAPI.window.cancelClose() }}
                  className="w-full py-1.5 px-4 text-xs text-overlay0 hover:text-overlay1 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Closing/Updating overlay */}
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
          {sidebarOpen && <Sidebar currentView={view} onViewChange={setView} onUpdateRequested={() => {
            const state = useSessionStore.getState()
            if (state.sessions.length === 0) {
              // No sessions — show updating overlay then update
              setIsClosing(true)
              setIsUpdating(true)
              window.electronAPI.update.installAndRestart().catch(() => { setIsClosing(false); setIsUpdating(false) })
            } else {
              setCloseDialog('update')
            }
          }} />}
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
