import React, { useCallback, useEffect, useState, useRef } from 'react'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import TabBar from './components/TabBar'
import SessionHeader from './components/SessionHeader'
import TerminalView, { killSessionPty } from './components/TerminalView'
import CommandBar from './components/CommandBar'
import SessionStatusStrip from './components/SessionStatusStrip'
import WebviewPane from './components/WebviewPane'
import ExcalidrawPane from './components/ExcalidrawPane'
import LogsPane from './components/LogsPane'
import { useWebviewStore } from './stores/webviewStore'
import { useExcalidrawStore } from './stores/excalidrawStore'
import { useLogsStore } from './stores/useLogsStore'
import BottomBar from './components/BottomBar'
import UsageDashboard from './components/UsageDashboard'
import ProjectBrowser from './components/ProjectBrowser'
import SettingsPage, { SETTINGS_TAB_IDS, type SettingsTab } from './components/SettingsPage'
import GlobalLogsView from './components/GlobalLogsView'
import InsightsPage from './components/InsightsPage'
import CloudAgentsPage from './components/CloudAgentsPage'
import TokenomicsPage from './components/TokenomicsPage'
import ConductorMcpPage from './components/ConductorMcpPage'
import MemoryPage from './components/MemoryPage'
import SetupDialog from './components/SetupDialog'
import WhatsNewModal, { shouldShowWhatsNew, markWhatsNewSeen } from './components/WhatsNewModal'
import AccountLaunchGate from './components/AccountLaunchGate'
import NewAccountPrompt from './components/NewAccountPrompt'
import { useAddAccount } from './hooks/useAddAccount'
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
import { useAccountProfilesStore } from './stores/accountProfilesStore'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useThemeController } from './hooks/useThemeController'
import { useLaunchConfig } from './hooks/useLaunchConfig'
import StageEmptyState from './components/StageEmptyState'
import { markSessionForResumePicker } from './utils/resumePicker'
import { migrateColorRecords } from './utils/migrateIdentityColors'
import { gatherLocalStorageData, hydrateStores, applyConfigColourMigration } from './utils/configHydration'
import { isGitHubOnboardingDue as isGitHubOnboardingDuePredicate } from './utils/githubOnboarding'
import { setupCloudAgentListener } from './stores/cloudAgentStore'
import { setupTokenomicsListener } from './stores/tokenomicsStore'
import { setupConductorMcpListener, useConductorMcpStore } from './stores/conductorMcpStore'
import { setupGitHubListener, useGitHubStore } from './stores/githubStore'
import { setupChannelListeners } from './stores/channelStore'
import PermissionToastStack from './components/channels/PermissionToastStack'
import LoggingConsentPrompt from './components/LoggingConsentPrompt'
import LogMigrationPrompt from './components/LogMigrationPrompt'
// Side-effect import: registers window.__captureHarness for the
// capture-training script. Renderer-local store mutations only, no
// IPC surface widening (see capture-harness.ts header).
import './utils/capture-harness'
import { useCodexAccountStore } from './stores/codexAccountStore'
import GitHubPanel from './components/github/GitHubPanel'
import OnboardingModal from './components/github/onboarding/OnboardingModal'
import AutoDetectBanner from './components/github/AutoDetectBanner'
import { handleAutoDetectAccept } from './utils/githubAutoDetectAccept'
import RepoBreadcrumb from './components/RepoBreadcrumb'
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
  const [newAccountDetected, setNewAccountDetected] = useState<{ sessionId: string; profileId: string; email: string } | null>(null)
  const addAccount = useAddAccount()
  // Deep-link the Settings page to a specific tab the next time it opens.
  // Set by the onboarding "Set up now" button and the auto-detect banner
  // Accept/Edit actions; consumed once by SettingsPage's initialTab prop.
  const [pendingSettingsTab, setPendingSettingsTab] = useState<SettingsTab | null>(null)

  // Clear the pending tab once SettingsPage has consumed it (i.e. we've
  // navigated away from the settings view). A return visit then defaults to
  // General as expected, rather than sticking on whatever tab the deep link
  // originally requested.
  useEffect(() => {
    if (view !== 'settings' && pendingSettingsTab) {
      setPendingSettingsTab(null)
    }
  }, [view, pendingSettingsTab])

  // Listen for app:openSettings dispatched by CodexFormFields "Open Settings" links.
  // Switches the active view to Settings and deep-links to the requested tab.
  // Validates the tab against the allow-list -- a malformed CustomEvent
  // detail otherwise leaves SettingsPage with no matching tab content.
  useEffect(() => {
    const onOpenSettings = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tab?: string } | undefined
      const tab = detail?.tab
      if (tab && (SETTINGS_TAB_IDS as readonly string[]).includes(tab)) {
        setPendingSettingsTab(tab as SettingsTab)
      }
      setView('settings')
    }
    window.addEventListener('app:openSettings', onOpenSettings)
    return () => window.removeEventListener('app:openSettings', onOpenSettings)
  }, [])

  const [showGuidedConfig, setShowGuidedConfig] = useState(false)
  const [showTipModal, setShowTipModal] = useState(false)
  const [partnerActive, setPartnerActive] = useState<Set<string>>(new Set())
  const [showMachineNamePrompt, setShowMachineNamePrompt] = useState(false)
  const [machineNameInput, setMachineNameInput] = useState('')
  const configs = useConfigStore((s) => s.configs)
  const launchConfig = useLaunchConfig()
  // onCreateConfigFromStage: App owns the GuidedConfigView toggle via showGuidedConfig.
  // Sidebar receives onShowFirstRun={() => setShowGuidedConfig(true)}, so we use the
  // same setter here to open the real create dialog from the stage empty state.
  const onCreateConfigFromStage = () => setShowGuidedConfig(true)
  const loggingConsentSeen = useSettingsStore((s) => s.settings.loggingConsentSeen)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const webviewBySession = useWebviewStore((s) => s.bySessionId)
  const excalidrawBySession = useExcalidrawStore((s) => s.bySessionId)
  const logsBySession = useLogsStore((s) => s.bySessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const hasRestoredRef = useRef(false)

  // Push focus changes to main so the sync orchestrator can shift the
  // active session to the fast interval and the background ones to the
  // slow interval. ipcRenderer.send, not invoke — fire-and-forget.
  useEffect(() => {
    window.electronAPI.github.notifyFocusChanged(activeSessionId ?? null)
  }, [activeSessionId])

  // Sweep orphan Excalidraw entries when the live session list changes
  // (session removed, app restart with fewer restored sessions, etc).
  // Without this, drawings persist forever under session IDs that no
  // longer exist — the JSON grows unbounded and any future global
  // drawings library would surface zombie sessions.
  useEffect(() => {
    if (sessions.length === 0) return
    useExcalidrawStore.getState().reconcile(sessions.map((s) => s.id))
    useLogsStore.getState().reconcile(sessions.map((s) => s.id))
  }, [sessions])

  // Global keyboard shortcuts
  useKeyboardShortcuts(activeSessionId, setSidebarOpen, setView)
  // Stamp data-theme on <html> from the persisted setting + listen for
  // OS prefers-color-scheme changes when in 'system' mode.
  useThemeController()

  // Emergency escape hatch for the WebContentsView pane — Esc closes
  // the *active* session's webview. Native Electron views render above
  // all HTML, so a stuck/oversized view can bury the toolbar Close
  // button and leave the user with no in-pane way out. This handler
  // runs at document level so it fires regardless of where focus is in
  // the renderer (the inner page only consumes Esc when *it* has focus).
  const activeSessionHasWebview = !!activeSessionId && !!webviewBySession[activeSessionId]?.isOpen
  const closeActiveWebview = useCallback(() => {
    if (!activeSessionId) return
    useWebviewStore.getState().setOpen(activeSessionId, false)
  }, [activeSessionId])
  useEffect(() => {
    if (!activeSessionHasWebview) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Defer to any open modal — pressing Esc inside the Excalidraw
      // freeze-annotate overlay should dismiss the modal first, not
      // close the underlying webview pane out from under it. Without
      // this check the global handler (capture phase) fired first and
      // collapsed both at once. Switched to bubble phase so the
      // detection runs after focus settles.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      e.preventDefault()
      closeActiveWebview()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [activeSessionHasWebview, closeActiveWebview])

  // Forward Esc presses that happen INSIDE a WebContentsView (where
  // keyboard focus belongs to the embedded page, not this renderer
  // document). The main process's `before-input-event` hook on each
  // view emits sessionId here; we close that specific session's pane.
  useEffect(() => {
    return window.electronAPI.webview.onEscapePressed((sessionId) => {
      // Skip when an in-renderer modal is showing — the modal's own
      // focus-trap will own the Esc instead.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      useWebviewStore.getState().setOpen(sessionId, false)
    })
  }, [])

  // Subscribe to main-process notification that a /login produced a previously
  // unseen account. The prompt lets the user name + save it as a profile.
  useEffect(() => {
    const off = window.electronAPI.accountProfiles.onAccountNewDetected?.((d) => setNewAccountDetected(d))
    return () => off?.()
  }, [])

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
          hydrateStores(await applyConfigColourMigration(reloaded.data))
        } else {
          hydrateStores(await applyConfigColourMigration(result.data))
        }
      } else {
        hydrateStores(await applyConfigColourMigration(result.data))
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
      setupConductorMcpListener()
      setupGitHubListener()
      setupChannelListeners()
      useGitHubStore.getState().loadConfig()
      useConductorMcpStore.getState().loadConfig()
      useConductorMcpStore.getState().fetchStatus()
      useCodexAccountStore.getState().refresh()
      useAccountProfilesStore.getState().hydrate()

      const magicSettings = useMagicButtonStore.getState().settings
      if (magicSettings.autoDeleteDays != null && magicSettings.autoDeleteDays > 0) {
        window.electronAPI.screenshot.cleanup(magicSettings.autoDeleteDays)
      }

      // Prompt for local machine name if not set (first run after update)
      const currentSettings = useSettingsStore.getState().settings
      if (!currentSettings.localMachineName) {
        setTimeout(() => setShowMachineNamePrompt(true), 800)
      }

      const gateShown = false

      setTimeout(() => {
        if (gateShown) return
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
  const isGitHubOnboardingDue = (): boolean =>
    isGitHubOnboardingDuePredicate({
      githubConfig,
      dismissedThisSession: onboardingDismissedThisSessionRef.current,
      appVersion: __APP_VERSION__,
      needsCliSetup,
    })

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

      // Idempotent session colour migration (no guard). session.clear() below wipes
      // the on-disk copy right after restore, and migrated keys only reach disk on a
      // graceful close (buildSessionState). So this recomputes each launch until then
      // -- harmless: it is a no-op once keyed, raw `color` is always preserved, and the
      // notice guard below prevents re-notifying.
      const { records: migratedSaved, summary: sessionSummary } = migrateColorRecords(savedState.sessions || [])
      console.log('[colourMigration] sessions', sessionSummary)

      const restoredSessions: Session[] = migratedSaved.map((saved: SavedSession) => {
        // v1.5 provider-shape: read Claude fields from claudeOptions, fall back to
        // legacy top-level fields for un-migrated files (belt-and-braces).
        const claude = saved.claudeOptions
        return {
          id: saved.id,
          configId: saved.configId,
          label: saved.label,
          workingDirectory: saved.workingDirectory,
          model: claude?.model ?? saved.model ?? '',
          color: saved.color,
          identityColorKey: saved.identityColorKey,
          legacyColor: saved.legacyColor,
          sessionType: saved.sessionType,
          shellOnly: saved.shellOnly,
          partnerTerminalPath: saved.partnerTerminalPath,
          partnerElevated: saved.partnerElevated,
          sshConfig: saved.sshConfig,
          legacyVersion: claude?.legacyVersion ?? saved.legacyVersion,
          agentIds: claude?.agentIds ?? saved.agentIds,
          effortLevel: claude?.effortLevel ?? saved.effortLevel,
          disableAutoMemory: claude?.disableAutoMemory ?? saved.disableAutoMemory,
          enableCodexReview: claude?.enableCodexReview,
          machineName: saved.machineName,
          githubIntegration: saved.githubIntegration,
          status: 'idle' as const,
          createdAt: Date.now(),
          provider: saved.provider,
          profileId: saved.profileId,
          codexOptions: saved.codexOptions,
        }
      })

      for (const session of restoredSessions) {
        // Both providers support a resume picker. For Codex, the picker script
        // may not be deployed yet on first boot -- buildCodexSpawn falls back
        // to direct codex spawn in that case (see src/main/providers/codex/spawn.ts).
        if (!session.shellOnly && session.sessionType === 'local') {
          markSessionForResumePicker(session.id)
        }
      }

      useSessionStore.getState().restoreSessions(restoredSessions, savedState.activeSessionId)
      await window.electronAPI.session.clear()

      if (sessionSummary.changed > 0) {
        const s = useSettingsStore.getState()
        if (!s.settings.colourMigrationNoticeDismissed && !s.settings.colourMigrationNoticePending) {
          s.updateSettings({ colourMigrationNoticePending: true })
        }
      }

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
      const stateToSave = buildSessionState()
      await window.electronAPI.session.save(stateToSave)
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
    if (view === 'logs') return <GlobalLogsView />
    if (view === 'settings') return <SettingsPage initialTab={pendingSettingsTab ?? undefined} onNavigateToSessions={() => setView('sessions')} />
    if (view === 'insights') return <InsightsPage />
    if (view === 'cloud-agents') return <CloudAgentsPage />
    if (view === 'tokenomics') return <TokenomicsPage />
    if (view === 'vision') return <ConductorMcpPage />
    if (view === 'memory') return <MemoryPage />
    return null
  }

  // Sessions are ALWAYS rendered (kept alive) but hidden when another view is active.
  const renderSessions = () => {
    if (!activeSessionId || sessions.length === 0 || !activeSession) {
      return (
        <div className="flex-1 flex flex-col" style={{ display: view === 'sessions' ? 'flex' : 'none' }}>
          <StageEmptyState
            configs={configs}
            onLaunch={(c) => { launchConfig(c); setView('sessions') }}
            onShowAllConfigs={() => setView('sessions')}
            onCreateConfig={onCreateConfigFromStage}
          />
        </div>
      )
    }

    return (
      <div className="flex-1 flex flex-col" style={{ display: view === 'sessions' ? 'flex' : 'none', minHeight: 0 }}>
        <TabBar />
        <RepoBreadcrumb session={activeSession} />
        <SessionHeader session={activeSession} onShowTip={() => setShowTipModal(true)} />
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
                // Logic lives in utils/githubAutoDetectAccept so it is unit-
                // testable (App.tsx is enormous). It fixes two bugs the
                // inline version had:
                //   #436 -- now writes the patch to the parent CONFIG too,
                //   so the GH repo selection persists across app restarts.
                //   #437 -- if the user already has at least one auth
                //   profile, the click auto-enables the integration, picks
                //   a profile by slug owner, and stays on the session
                //   view. The legacy "send to Settings" path only fires
                //   for unauthed users.
                await handleAutoDetectAccept(
                  slug,
                  {
                    id: activeSession.id,
                    configId: activeSession.configId,
                    githubIntegration: gi,
                  },
                  {
                    electronAPI: window.electronAPI,
                    updateSession: (id, patch) =>
                      useSessionStore.getState().updateSession(id, patch),
                    updateConfig: (id, patch) =>
                      useConfigStore.getState().updateConfig(id, patch),
                    profiles: useGitHubStore.getState().profiles,
                    navigateToGitHubSettings: () => {
                      setPendingSettingsTab('github')
                      setView('settings')
                    },
                    // #441: flush the session store to disk first so the
                    // main-side updateSessionConfig handler can find the row
                    // in sessions[] -- freshly-spawned sessions aren't on
                    // disk until graceful close otherwise.
                    flushSessionState: async () => {
                      try {
                        const state = buildSessionState()
                        return await window.electronAPI.session.save(state)
                      } catch {
                        return false
                      }
                    },
                  },
                )
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
        <div className="relative flex-1 flex flex-row" style={{ minHeight: 0 }}>
          <div className="flex-1 flex flex-col" style={{ minWidth: 0, minHeight: 0 }}>
            {sessions.map((session) => {
              const isShowingPartner = partnerActive.has(session.id)
              const hasPartner = !!session.partnerTerminalPath
              const partnerPtyId = session.id + '-partner'
              const isShowingWebview = !!webviewBySession[session.id]?.isOpen
              const isShowingExcalidraw = !!excalidrawBySession[session.id]?.isOpen
              const isShowingLogs = !!logsBySession[session.id]?.isOpen
              // Priority: logs > webview > excalidraw > partner > claude. Logs
              // sits TOP so an open log view isn't suppressed by Draw/Web/Partner.
              const altPaneShowing = isShowingLogs || isShowingWebview || isShowingExcalidraw
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
                      display: isShowingPartner || altPaneShowing ? 'none' : 'flex',
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
                      isActive={session.id === activeSessionId && view === 'sessions' && !isShowingPartner && !altPaneShowing}
                      legacyVersion={session.legacyVersion}
                      agentIds={session.agentIds}
                      effortLevel={session.effortLevel}
                      disableAutoMemory={session.disableAutoMemory}
                      enableCodexReview={session.enableCodexReview}
                      model={session.model}
                      provider={session.provider}
                      codexOptions={session.codexOptions}
                    />
                  </div>
                  {hasPartner && (
                    <div
                      className="flex-1 flex flex-col"
                      style={{
                        display: isShowingPartner && !altPaneShowing ? 'flex' : 'none',
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
                        isActive={session.id === activeSessionId && view === 'sessions' && isShowingPartner && !altPaneShowing}
                      />
                    </div>
                  )}
                  {/* Alt-pane priority: Logs > Webview > Excalidraw. Each
                      alternative pane replaces the underlying terminal panes.
                      Toggle buttons are independent so multiple flags can be
                      true; render only the highest-priority one. */}
                  {isShowingLogs ? (
                    <LogsPane sessionId={session.id} />
                  ) : isShowingWebview ? (
                    <WebviewPane sessionId={session.id} isActive={session.id === activeSessionId} />
                  ) : isShowingExcalidraw ? (
                    <ExcalidrawPane sessionId={session.id} />
                  ) : null}
                </div>
              )
            })}
          </div>
          {activeSession && <GitHubPanel sessionId={activeSession.id} />}
        </div>
        {/* Per-session telemetry strip + command rows live BELOW the
            terminal/GitHub-panel row so they span the full content-column
            width and the GitHub panel ends above them. Rendered once for the
            ACTIVE session only -- switching tabs re-resolves these against
            `activeSession`. The telemetry strip is hidden for shell-only
            sessions (matches the old per-TerminalView gate). */}
        {activeSession && !activeSession.shellOnly && (
          <SessionStatusStrip sessionId={activeSession.id} />
        )}
        {activeSession && (
          <CommandBar
            key={activeSession.id + '-commandbar'}
            sessionId={activeSession.id}
            configId={activeSession.configId}
            sessionType={activeSession.sessionType === 'ssh' ? 'ssh' : 'local'}
            partnerEnabled={!!activeSession.partnerTerminalPath}
            isPartnerActive={partnerActive.has(activeSession.id)}
            onTogglePartner={() => togglePartner(activeSession.id)}
            partnerSessionId={activeSession.partnerTerminalPath ? activeSession.id + '-partner' : undefined}
            parentSessionId={activeSession.id}
          />
        )}
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
        <PermissionToastStack />
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

        {newAccountDetected && (
          <NewAccountPrompt
            email={newAccountDetected.email}
            onDismiss={() => setNewAccountDetected(null)}
            onAdd={async (name) => {
              const np = await window.electronAPI.accountProfiles.captureDetected(newAccountDetected.sessionId, name || undefined)
              await useAccountProfilesStore.getState().hydrate()
              if (np) useSessionStore.getState().updateSession(newAccountDetected.sessionId, { profileId: np.id })
              setNewAccountDetected(null)
            }}
          />
        )}

        {configLoaded && !loggingConsentSeen && (
          <LoggingConsentPrompt />
        )}

        {configLoaded && loggingConsentSeen && <LogMigrationPrompt />}

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
          <Sidebar currentView={view} onViewChange={setView} collapsed={!sidebarOpen} tourActive={showTraining || showTrainingAll} onShowFirstRun={() => setShowGuidedConfig(true)} onShowHelp={() => { setShowTrainingAll(true); setShowTraining(true) }} />
          <main className="flex-1 flex flex-col overflow-hidden titlebar-no-drag">
            <div className="flex-1 flex flex-col overflow-hidden min-h-0 relative">
              {showGuidedConfig ? (
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
                    if (newConfig.claudeOptions?.effortLevel) trackUsage('sessions.effort-level')
                    if (newConfig.claudeOptions?.disableAutoMemory) trackUsage('sessions.disable-auto-memory')
                    if (newConfig.claudeOptions?.enableCodexReview) trackUsage('sessions.enable-codex-review')
                    if (newConfig.partnerTerminalPath) trackUsage('sessions.partner-terminal')

                    const session: Session = {
                      id: generateId(),
                      configId: newConfig.id,
                      label: newConfig.label,
                      workingDirectory: newConfig.workingDirectory,
                      model: newConfig.claudeOptions?.model ?? '',
                      color: newConfig.color,
                      status: 'idle',
                      createdAt: Date.now(),
                      sessionType: newConfig.sessionType,
                      shellOnly: newConfig.shellOnly,
                      sshConfig: newConfig.sshConfig,
                      effortLevel: newConfig.claudeOptions?.effortLevel,
                      disableAutoMemory: newConfig.claudeOptions?.disableAutoMemory,
                      enableCodexReview: newConfig.claudeOptions?.enableCodexReview,
                      provider: newConfig.provider,
                      codexOptions: newConfig.codexOptions,
                    }
                    // Both providers support a resume picker. For Codex, the picker
                    // script may not be deployed yet on first boot -- buildCodexSpawn
                    // falls back to direct codex spawn (see src/main/providers/codex/spawn.ts).
                    if (
                      !session.shellOnly &&
                      session.sessionType === 'local'
                    ) {
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
            </div>
          </main>
        </div>
        {/* Runtime footer spans the FULL app width (under the sidebar too) so
            CLI/version sits at the absolute bottom-left of the app -- a global
            status bar, distinct from the per-session statusline strip which
            lives above the command rows inside the terminal column. */}
        <div className="titlebar-no-drag shrink-0">
          <BottomBar currentView={view} onViewChange={setView} onUpdateRequested={() => {
            const state = useSessionStore.getState()
            if (state.sessions.length === 0) {
              setIsClosing(true)
              setIsUpdating(true)
              window.electronAPI.update.installAndRestart().catch(() => { setIsClosing(false); setIsUpdating(false) })
            } else {
              setCloseDialog('update')
            }
          }} />
        </div>
        {showTraining && (
          <TrainingWalkthrough
            onClose={handleTrainingClose}
            showAll={showTrainingAll}
            mode={showTrainingAll ? 'help' : 'first-run'}
          />
        )}
        {/* Pre-spawn account launch gate: asks which account a session runs
            under on its first spawn (multi-account only). App-root so it
            overlays every view. */}
        <AccountLaunchGate />
      </div>
    </ErrorBoundary>
  )
}
