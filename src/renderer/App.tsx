import React, { useCallback, useEffect, useState, useRef } from 'react'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import TabBar from './components/TabBar'
import SessionHeader from './components/SessionHeader'
import TerminalView, { killSessionPty } from './components/TerminalView'
import WebviewPane from './components/WebviewPane'
import { useWebviewStore } from './stores/webviewStore'
import StatusBar from './components/StatusBar'
import UsageDashboard from './components/UsageDashboard'
import ProjectBrowser from './components/ProjectBrowser'
import SettingsPage from './components/SettingsPage'
import LogViewer from './components/LogViewer'
import InsightsPage from './components/InsightsPage'
import CloudAgentsPage from './components/CloudAgentsPage'
import TokenomicsPage from './components/TokenomicsPage'
import VisionPage from './components/VisionPage'
import MemoryPage from './components/MemoryPage'
import SetupDialog from './components/SetupDialog'
import WhatsNewModal, { shouldShowWhatsNew, markWhatsNewSeen } from './components/WhatsNewModal'
import TrainingWalkthrough, { shouldShowTraining, isFirstInstall } from './components/TrainingWalkthrough'
import GuidedConfigView from './components/GuidedConfigView'
import TipModal from './components/TipModal'
import { useTipsStore, trackUsage } from './stores/tipsStore'
import ErrorBoundary from './components/ErrorBoundary'
import CloseDialog from './components/CloseDialog'
import { useSessionStore, Session } from './stores/sessionStore'
import { useConfigStore } from './stores/configStore'
import { useCommandStore } from './stores/commandStore'
import { useMagicButtonStore } from './stores/magicButtonStore'
import { useAppMetaStore } from './stores/appMetaStore'
import { useSettingsStore } from './stores/settingsStore'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useThemeController } from './hooks/useThemeController'
import { markSessionForResumePicker } from './utils/resumePicker'
import { gatherLocalStorageData, hydrateStores } from './utils/configHydration'
import { setupCloudAgentListener } from './stores/cloudAgentStore'
import { setupTokenomicsListener } from './stores/tokenomicsStore'
import { setupVisionListener, useVisionStore } from './stores/visionStore'
import { setupGitHubListener, useGitHubStore } from './stores/githubStore'
import GitHubPanel from './components/github/GitHubPanel'
import OnboardingModal from './components/github/onboarding/OnboardingModal'
import AutoDetectBanner from './components/github/AutoDetectBanner'
import type { SessionState, SavedSession } from './types/electron'
import { buildSessionState } from './session-persistence'

// Re-export ViewType from its canonical location for backwards compatibility
export type { ViewType } from './types/views'
import type { ViewType } from './types/views'

// Re-export resume picker for backwards compatibility
export { markSessionForResumePicker, shouldUseResumePicker } from './utils/resumePicker'

declare const __APP_VERSION__: string

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [viewRaw, setViewRaw] = useState<ViewType>('sessions')
  const view = viewRaw
  const setView = (v: ViewType) => {
    setViewRaw(v)
    // Track view usage for the tips system
    const map: Record<string, string> = {
      'memory': 'memory.memory-page',
      'tokenomics': 'tokenomics.dashboard',
      'vision': 'vision.toggle-vision',
      'insights': 'advanced.insights',
      'logs': 'advanced.log-viewer',
      'cloud-agents': 'agents.cloud-agent-dispatch',
    }
    const featureId = map[v]
    if (featureId) trackUsage(featureId)
  }
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [needsCliSetup, setNeedsCliSetup] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [closeDialog, setCloseDialog] = useState<'close' | 'update' | null>(null)
  const [showWhatsNew, setShowWhatsNew] = useState(false)
  const [showTraining, setShowTraining] = useState(false)
  const [showTrainingAll, setShowTrainingAll] = useState(false)
  const [showGitHubOnboarding, setShowGitHubOnboarding] = useState(false)
  // Deep-link the Settings page to a specific tab the next time it opens.
  // Set by the onboarding "Set up now" button and the auto-detect banner
  // Accept/Edit actions; consumed once by SettingsPage's initialTab prop.
  const [pendingSettingsTab, setPendingSettingsTab] = useState<
    'general' | 'statusline' | 'shortcuts' | 'github' | 'about' | null
  >(null)

  // Clear the pending tab once SettingsPage has consumed it (i.e. we've
  // navigated away from the settings view). A return visit then defaults to
  // General as expected, rather than sticking on whatever tab the deep link
  // originally requested.
  useEffect(() => {
    if (view !== 'settings' && pendingSettingsTab) {
      setPendingSettingsTab(null)
    }
  }, [view, pendingSettingsTab])
  const [showGuidedConfig, setShowGuidedConfig] = useState(false)
  const [showTipModal, setShowTipModal] = useState(false)
  const [partnerActive, setPartnerActive] = useState<Set<string>>(new Set())
  const [showMachineNamePrompt, setShowMachineNamePrompt] = useState(false)
  const [machineNameInput, setMachineNameInput] = useState('')
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const webviewBySession = useWebviewStore((s) => s.bySessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const hasRestoredRef = useRef(false)

  // Push focus changes to main so the sync orchestrator can shift the
  // active session to the fast interval and the background ones to the
  // slow interval. ipcRenderer.send, not invoke — fire-and-forget.
  useEffect(() => {
    window.electronAPI.github.notifyFocusChanged(activeSessionId ?? null)
  }, [activeSessionId])

  // Global keyboard shortcuts
  useKeyboardShortcuts(activeSessionId, setSidebarOpen, setView)
  // Stamp data-theme on <html> from the persisted setting + listen for
  // OS prefers-color-scheme changes when in 'system' mode.
  useThemeController()

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
      setupVisionListener()
      setupGitHubListener()
      useGitHubStore.getState().loadConfig()
      useVisionStore.getState().loadConfig()
      useVisionStore.getState().fetchStatus()

      const magicSettings = useMagicButtonStore.getState().settings
      if (magicSettings.autoDeleteDays != null && magicSettings.autoDeleteDays > 0) {
        window.electronAPI.screenshot.cleanup(magicSettings.autoDeleteDays)
      }

      // Prompt for local machine name if not set (first run after update)
      const currentSettings = useSettingsStore.getState().settings
      if (!currentSettings.localMachineName) {
        setTimeout(() => setShowMachineNamePrompt(true), 800)
      }

      setTimeout(() => {
        if (isFirstInstall()) {
          setShowTraining(true)
        } else {
          if (shouldShowWhatsNew()) setShowWhatsNew(true)
          else if (shouldShowTraining()) setShowTraining(true)
        }
      }, 500)

      // Pick a tip for this session (one per app launch)
      setTimeout(() => {
        useTipsStore.getState().pickNextTip()
      }, 2000)
    }

    postConfigInit()
  }, [configLoaded])

  // Show GitHub sidebar onboarding once per version bump after config
  // hydrates. `seenOnboardingVersion === 'permanent'` opts out forever —
  // MUST be checked before the version compare so dismissed users don't
  // see the modal on every app update.
  const githubConfig = useGitHubStore((s) => s.config)
  // Session-scoped dismissal guard. Needed because dismissGitHubOnboarding's
  // updateConfig IPC can fail (swallowed in its catch). Without this ref,
  // a later unrelated githubConfig mutation would re-fire the effect,
  // find seenOnboardingVersion still unpersisted, and re-open the modal —
  // trapping the user in a loop. The ref survives re-renders but resets
  // on reload, which is the intended behavior: persist failure shouldn't
  // silently suppress the modal across restarts.
  const onboardingDismissedThisSessionRef = useRef(false)

  // Decides whether github onboarding is due right now. Reads persistent
  // config state plus the session dismissal ref and component `needsCliSetup`
  // — NOT a pure persistent-state read, but stable across React render
  // timing in a way that `showWhatsNew` / `showTraining` are not (those flip
  // after a 500ms postConfigInit timer).
  const isGitHubOnboardingDue = (): boolean => {
    if (!githubConfig) return false
    if (onboardingDismissedThisSessionRef.current) return false
    if (githubConfig.seenOnboardingVersion === 'permanent') return false
    if (githubConfig.seenOnboardingVersion === __APP_VERSION__) return false
    if (needsCliSetup) return false
    return true
  }

  // Single source of truth for when the GitHub onboarding modal opens. The
  // previous design also had handleWhatsNewClose / handleTrainingClose
  // scheduling setShowGitHubOnboarding(true) via setTimeout — but this effect
  // already re-runs when showWhatsNew/showTraining flip to false, which meant
  // the effect opened onboarding immediately and the handler's delay was
  // bypassed (a double setState with the first one winning). Keep the 120ms
  // gap here in the effect so it applies uniformly regardless of which
  // earlier modal just closed, and clean up the timer if the conditions
  // change before it fires.
  useEffect(() => {
    if (!isGitHubOnboardingDue()) return
    if (showWhatsNew || showTraining || showTrainingAll) return
    if (isFirstInstall() || shouldShowWhatsNew() || shouldShowTraining()) return
    const t = setTimeout(() => setShowGitHubOnboarding(true), 120)
    return () => clearTimeout(t)
  }, [githubConfig, showWhatsNew, showTraining, showTrainingAll, needsCliSetup])

  // useCallback: passed to OnboardingModal as `onClose`, which forwards it
  // to useFocusTrap. Without stable identity, the focus-trap effect re-runs
  // every App render — which resets previouslyFocused to the currently-
  // focused node (a button inside the modal) and yanks focus back to the
  // first focusable on every parent re-render. Stable identity fixes both.
  const dismissGitHubOnboarding = useCallback(async () => {
    // Flip the ref BEFORE the setState so any render-pass that reads
    // the effect deps sees the guard already in place, not just the
    // showGitHubOnboarding flip.
    onboardingDismissedThisSessionRef.current = true
    setShowGitHubOnboarding(false)
    try {
      await useGitHubStore
        .getState()
        .updateConfig({ seenOnboardingVersion: __APP_VERSION__ })
    } catch {
      // Persist failure falls back to the in-session ref guard above.
      // A restart will show the modal again, which is fine — the user
      // never actually opted out of future reminders from the server side.
    }
  }, [])

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
    if (view === 'settings') return <SettingsPage initialTab={pendingSettingsTab ?? undefined} />
    if (view === 'insights') return <InsightsPage />
    if (view === 'cloud-agents') return <CloudAgentsPage />
    if (view === 'tokenomics') return <TokenomicsPage />
    if (view === 'vision') return <VisionPage />
    if (view === 'memory') return <MemoryPage />
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
        <SessionHeader session={activeSession} isShowingPartner={partnerActive.has(activeSession.id)} sidebarCollapsed={!sidebarOpen} onShowTip={() => setShowTipModal(true)} />
        {(() => {
          const gi = activeSession.githubIntegration
          const shouldShow =
            !gi?.enabled &&
            !gi?.repoUrl &&
            !gi?.dismissedAutoDetect &&
            !!activeSession.workingDirectory
          if (!shouldShow) return null
          return (
            <AutoDetectBanner
              cwd={activeSession.workingDirectory!}
              onAccept={async (slug) => {
                // Persist the detected repo onto the session BEFORE
                // navigating so the GitHub config tab reflects the
                // auto-filled value. Without this write the slug was
                // silently discarded and the user had to re-enter it.
                try {
                  const patch = {
                    repoUrl: `https://github.com/${slug}`,
                    repoSlug: slug,
                    autoDetected: true,
                  }
                  await window.electronAPI.github.updateSessionConfig(
                    activeSession.id,
                    patch,
                  )
                  useSessionStore.getState().updateSession(activeSession.id, {
                    githubIntegration: {
                      ...(gi ?? { enabled: false, autoDetected: false }),
                      ...patch,
                    },
                  })
                } catch {
                  // Fall through: we still send the user to the GitHub
                  // tab so they can configure manually. Losing the write
                  // is fine; losing the navigation would be worse.
                }
                setPendingSettingsTab('github')
                setView('settings')
              }}
              onEdit={() => {
                setPendingSettingsTab('github')
                setView('settings')
              }}
              onDismiss={async () => {
                try {
                  await window.electronAPI.github.updateSessionConfig(activeSession.id, {
                    dismissedAutoDetect: true,
                  })
                  useSessionStore.getState().updateSession(activeSession.id, {
                    githubIntegration: {
                      ...(gi ?? { enabled: false, autoDetected: false }),
                      dismissedAutoDetect: true,
                    },
                  })
                } catch {
                  // IPC failure leaves the banner visible for the user to
                  // retry; better than silently swallowing the dismissal.
                }
              }}
            />
          )
        })()}
        <div className="flex-1 flex flex-row" style={{ minHeight: 0 }}>
          <div className="flex-1 flex flex-col" style={{ minWidth: 0, minHeight: 0 }}>
            {sessions.map((session) => {
              const isShowingPartner = partnerActive.has(session.id)
              const hasPartner = !!session.partnerTerminalPath
              const partnerPtyId = session.id + '-partner'
              const isShowingWebview = !!webviewBySession[session.id]?.isOpen
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
                      display: isShowingPartner || isShowingWebview ? 'none' : 'flex',
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
                      isActive={session.id === activeSessionId && view === 'sessions' && !isShowingPartner && !isShowingWebview}
                      partnerEnabled={hasPartner}
                      isPartnerActive={isShowingPartner}
                      onTogglePartner={() => togglePartner(session.id)}
                      partnerSessionId={hasPartner ? partnerPtyId : undefined}
                      legacyVersion={session.legacyVersion}
                      agentIds={session.agentIds}
                      flickerFree={session.flickerFree}
                      powershellTool={session.powershellTool}
                      effortLevel={session.effortLevel}
                      disableAutoMemory={session.disableAutoMemory}
                    />
                  </div>
                  {hasPartner && (
                    <div
                      className="flex-1 flex flex-col"
                      style={{
                        display: isShowingPartner && !isShowingWebview ? 'flex' : 'none',
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
                        isActive={session.id === activeSessionId && view === 'sessions' && isShowingPartner && !isShowingWebview}
                        partnerEnabled={true}
                        isPartnerActive={isShowingPartner}
                        onTogglePartner={() => togglePartner(session.id)}
                        partnerSessionId={partnerPtyId}
                      />
                    </div>
                  )}
                  {isShowingWebview && <WebviewPane sessionId={session.id} />}
                </div>
              )
            })}
          </div>
          {activeSession && <GitHubPanel sessionId={activeSession.id} />}
        </div>
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
    // Training is opened directly here because it's not managed by the
    // onboarding effect. Onboarding is handled by the useEffect above,
    // which re-runs when showWhatsNew flips to false and applies its own
    // 120ms delay so the cross-fade stays smooth.
    if (shouldShowTraining()) {
      setTimeout(() => setShowTraining(true), 120)
    }
  }

  const handleTrainingClose = () => {
    setShowTraining(false)
    setShowTrainingAll(false)
    // Onboarding is handled by the useEffect above; no need to schedule it
    // here.
  }

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-screen bg-base text-text">
        {showWhatsNew && <WhatsNewModal onClose={handleWhatsNewClose} />}
        {showTipModal && <TipModal onClose={() => setShowTipModal(false)} onNavigate={(v) => setView(v)} />}
        {showGitHubOnboarding && (
          <OnboardingModal
            onClose={dismissGitHubOnboarding}
            onSetup={() => {
              // Dismiss-and-navigate: persist seenOnboardingVersion and
              // open the GitHub settings tab so users immediately land where
              // they can sign in. The pendingSettingsTab handoff is required
              // because SettingsPage's activeTab is local state that
              // otherwise defaults to 'general' on mount.
              void dismissGitHubOnboarding()
              setPendingSettingsTab('github')
              setView('settings')
            }}
          />
        )}

        {showMachineNamePrompt && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-surface0 rounded-lg p-5 w-[360px] shadow-2xl border border-surface1">
              <h3 className="text-sm font-semibold text-text mb-2">Name this machine</h3>
              <p className="text-xs text-overlay1 mb-3">Give your local machine a name so sessions and memories can be identified by machine.</p>
              <input
                autoFocus
                value={machineNameInput}
                onChange={e => setMachineNameInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && machineNameInput.trim()) {
                    useSettingsStore.getState().updateSettings({ localMachineName: machineNameInput.trim() })
                    setShowMachineNamePrompt(false)
                  }
                }}
                placeholder="e.g. Desktop, Dev Workstation, Laptop"
                className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue mb-3"
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowMachineNamePrompt(false)}
                  className="px-3 py-1.5 rounded text-xs text-subtext0 hover:text-text hover:bg-surface1 transition-colors"
                >
                  Skip
                </button>
                <button
                  onClick={() => {
                    if (machineNameInput.trim()) {
                      useSettingsStore.getState().updateSettings({ localMachineName: machineNameInput.trim() })
                    }
                    setShowMachineNamePrompt(false)
                  }}
                  className="px-3 py-1.5 rounded text-xs bg-blue text-crust font-medium hover:bg-blue/90 transition-colors"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

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
          <Sidebar currentView={view} onViewChange={setView} collapsed={!sidebarOpen} tourActive={showTraining || showTrainingAll} onShowFirstRun={() => setShowGuidedConfig(true)} onShowHelp={() => { setShowTrainingAll(true); setShowTraining(true) }} onUpdateRequested={() => {
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
            {showTraining ? (
              <TrainingWalkthrough onClose={handleTrainingClose} showAll={showTrainingAll} />
            ) : showGuidedConfig ? (
              <GuidedConfigView
                onSkip={() => setShowGuidedConfig(false)}
                onConfirm={async (configDraft, sshPassword) => {
                  const { generateId } = await import('./utils/id')
                  const configId = generateId()
                  if (sshPassword) {
                    await window.electronAPI.credentials.save(configId, sshPassword)
                  }
                  const newConfig = { ...configDraft, id: configId }
                  useConfigStore.getState().addConfig(newConfig)
                  useAppMetaStore.getState().update({ hasCreatedFirstConfig: true })

                  // Track feature usage based on config fields set
                  trackUsage('sessions.create-config')
                  if (newConfig.sessionType === 'ssh') trackUsage('sessions.session-type')
                  if (newConfig.flickerFree) trackUsage('sessions.flicker-free')
                  if (newConfig.effortLevel) trackUsage('sessions.effort-level')
                  if (newConfig.disableAutoMemory) trackUsage('sessions.disable-auto-memory')
                  if (newConfig.powershellTool) trackUsage('sessions.powershell-tool')
                  if (newConfig.partnerTerminalPath) trackUsage('sessions.partner-terminal')

                  const session: Session = {
                    id: generateId(),
                    configId: newConfig.id,
                    label: newConfig.label,
                    workingDirectory: newConfig.workingDirectory,
                    model: newConfig.model,
                    color: newConfig.color,
                    status: 'idle',
                    createdAt: Date.now(),
                    sessionType: newConfig.sessionType,
                    shellOnly: newConfig.shellOnly,
                    sshConfig: newConfig.sshConfig,
                    flickerFree: newConfig.flickerFree,
                    powershellTool: newConfig.powershellTool,
                    effortLevel: newConfig.effortLevel,
                    disableAutoMemory: newConfig.disableAutoMemory,
                  }
                  if (!session.shellOnly && session.sessionType === 'local') {
                    markSessionForResumePicker(session.id)
                  }
                  useSessionStore.getState().addSession(session)
                  setShowGuidedConfig(false)
                  setView('sessions')
                }}
              />
            ) : (
              <>
                {renderSessions()}
                {renderOverlayView()}
              </>
            )}
          </main>
        </div>
        <StatusBar />
      </div>
    </ErrorBoundary>
  )
}
