import React, { useCallback, useEffect, useState, useRef } from 'react'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import TabBar from './components/TabBar'
import SessionHeader from './components/SessionHeader'
import TerminalView, { killSessionPty } from './components/TerminalView'
import CommandBar from './components/CommandBar'
import SessionStatusStrip from './components/SessionStatusStrip'
import WebviewPane from './components/WebviewPane'
import AgentCanvasPane from './components/AgentCanvasPane'
import LogsPane from './components/LogsPane'
import { useWebviewStore } from './stores/webviewStore'
import { useExcalidrawStore } from './stores/excalidrawStore'
import { setupCanvasListener } from './stores/canvasStore'
import { setupCanvasReviewListener } from './stores/canvasReviewStore'
import { setupCanvasSnapshotHost } from './canvas/canvas-snapshot-host'
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
import { shouldShowWhatsNew } from './onboarding/whats-new-gate'
import AccountLaunchGate from './components/AccountLaunchGate'
import NewAccountPrompt from './components/NewAccountPrompt'
import SentinelPanel from './components/sentinel/SentinelPanel'
import { useAddAccount } from './hooks/useAddAccount'
import TrainingWalkthrough, { shouldShowTraining, isFirstInstall } from './components/TrainingWalkthrough'
import SessionDialog from './components/SessionDialog'
import GuidedTour from './components/GuidedTour'
import FeatureGuidePage from './components/FeatureGuidePage'
import AccountUsagePanel from './components/AccountUsagePanel'
import TipModal from './components/TipModal'
import { useTipsStore, trackUsage, VIEW_FEATURE_IDS } from './stores/tipsStore'
import ErrorBoundary from './components/ErrorBoundary'
import CloseDialog from './components/CloseDialog'
import SshCloseDialog from './components/SshCloseDialog'
import { useSessionStore, structuralSessionsEqual, Session } from './stores/sessionStore'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { useConfigStore } from './stores/configStore'
import { useCommandStore } from './stores/commandStore'
import { useMagicButtonStore } from './stores/magicButtonStore'
import { useAppMetaStore } from './stores/appMetaStore'
import { useConfigWriteLockStore } from './stores/configWriteLockStore'
import { useSettingsStore } from './stores/settingsStore'
import { OnboardingHarness } from './onboarding/OnboardingHarness'
import { deriveOnboarding, shouldReonboardForVersion } from './onboarding/gate'
import { bootWhatsNewSurface } from './onboarding/upgrade-flow'
import { useAccountProfilesStore } from './stores/accountProfilesStore'
import { useRegistryStore } from './stores/registryStore'
import { useSentinelStore } from './stores/sentinelStore'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useThemeController } from './hooks/useThemeController'
import { useTypographyController } from './hooks/useTypography'
import { useLaunchConfig } from './hooks/useLaunchConfig'
import StageEmptyState from './components/StageEmptyState'
import { markSessionForResumePicker } from './utils/resumePicker'
import { flushPendingConfigSaves } from './utils/config-saver'
import { migrateColorRecords } from './utils/migrateIdentityColors'
import { gatherLocalStorageData, hydrateStores, applyConfigColourMigration, retireAskConfig, readFailureLockReason } from './utils/configHydration'
import { isGitHubOnboardingDue as isGitHubOnboardingDuePredicate } from './utils/githubOnboarding'
import { setupCloudAgentListener } from './stores/cloudAgentStore'
import { setupInsightsListener } from './stores/insightsStore'
import { setupConductorMcpListener, useConductorMcpStore } from './stores/conductorMcpStore'
import { setupGitHubListener, useGitHubStore } from './stores/githubStore'
import { setupChannelListeners } from './stores/channelStore'
import LoggingConsentPrompt from './components/LoggingConsentPrompt'
import LogsWipeModal from './components/LogsWipeModal'
import { pickBootGate } from './utils/bootGates'
import ResumeSessionsPrompt from './components/ResumeSessionsPrompt'
import { useCodexAccountStore } from './stores/codexAccountStore'
import GitHubPanel from './components/github/GitHubPanel'
import OnboardingModal from './components/github/onboarding/OnboardingModal'
import AutoDetectBanner from './components/github/AutoDetectBanner'
import { handleAutoDetectAccept } from './utils/githubAutoDetectAccept'
import type { SessionState, SavedSession } from './types/electron'
import { buildSessionState, buildSessionStateWithResumeTargets, markRestoredSessionsPredetermined } from './session-persistence'
import { useSessionAutosave } from './hooks/useSessionAutosave'

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
  // Pages (Tokenomics, Logs, Feature Guide, …) open as TABS in the main strip
  // alongside sessions, in open order, and persist until closed. `view` is the
  // active tab: 'sessions' means a session tab is active, any other value means
  // that page tab is active. Opening a page adds it here if not already open.
  const [openPageTabs, setOpenPageTabs] = useState<ViewType[]>([])
  const setView = (v: ViewType) => {
    setViewRaw(v)
    if (v !== 'sessions') setOpenPageTabs((prev) => (prev.includes(v) ? prev : [...prev, v]))
    // Track view usage for the tips system. The map lives in the tips store
    // beside the prune that has to know which ids are still live -- a copy here
    // would drift, and a drifted id gets its usage row deleted on next launch.
    const featureId = VIEW_FEATURE_IDS[v]
    if (featureId) trackUsage(featureId)
  }
  // Close a page tab. If it was the active tab, fall back to the last remaining
  // page tab, else the sessions view.
  const closePageTab = (v: ViewType) => {
    setOpenPageTabs((prev) => prev.filter((x) => x !== v))
    setViewRaw((cur) => {
      if (cur !== v) return cur
      const remaining = openPageTabs.filter((x) => x !== v)
      return remaining.length ? remaining[remaining.length - 1] : 'sessions'
    })
  }
  // Activate a session tab: switch the pane back to sessions and select it.
  const activateSessionTab = (id: string) => {
    useSessionStore.getState().setActiveSession(id)
    setViewRaw('sessions')
  }
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null)
  const [configLoaded, setConfigLoaded] = useState(false)
  // Logs v2 first-run wipe gate: null = not yet detected, >0 = old artifacts
  // present (show the blocking modal), 0 = nothing to wipe (or already wiped).
  const [logsWipeBytes, setLogsWipeBytes] = useState<number | null>(null)
  const [needsCliSetup, setNeedsCliSetup] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [closeDialog, setCloseDialog] = useState<'close' | 'update' | null>(null)
  /** Run the harness purely to deliver release notes: the user has already
   *  completed the flow, but has not seen the notes for the build now running.
   *  Armed once in postConfigInit, cleared when the harness completes. */
  const [whatsNewOnly, setWhatsNewOnly] = useState(false)
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

  // Deep-link from the Memory page: navigate to Logs and pre-select the slot
  // for a specific sessionId. Consumed once by GlobalLogsView's initialSessionId prop.
  const [pendingLogsSessionId, setPendingLogsSessionId] = useState<string | null>(null)

  // Clear the pending sessionId when navigating away from Logs (mirror of the
  // pendingSettingsTab pattern above).
  useEffect(() => {
    if (view !== 'logs' && pendingLogsSessionId) {
      setPendingLogsSessionId(null)
    }
  }, [view, pendingLogsSessionId])

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
  // Live-app guided tour that follows the onboarding finish step (or the
  // Feature Guide button). Anchored coach-marks over the real UI, ending by
  // opening the first-config dialog.
  const [tourActive, setTourActive] = useState(false)
  // The Feature Guide is a page tab (ViewType 'help'), opened from the sidebar ?
  // button — it opens in the main tab strip like any other page, no longer a
  // portal modal that covered whatever page was open.
  const [showTipModal, setShowTipModal] = useState(false)
  const [partnerActive, setPartnerActive] = useState<Set<string>>(new Set())
  // Sessions whose partner terminal has been opened at least once — gates the
  // lazy mount of the partner TerminalView (see togglePartner).
  const [partnerEverActivated, setPartnerEverActivated] = useState<Set<string>>(new Set())
  const [showMachineNamePrompt, setShowMachineNamePrompt] = useState(false)
  const [machineNameInput, setMachineNameInput] = useState('')
  // Saved sessions awaiting the user's Resume / Don't-open choice (startup gate —
  // previously every boot force-resumed the whole saved set).
  const [pendingRestore, setPendingRestore] = useState<SessionState | null>(null)
  const configs = useConfigStore((s) => s.configs)
  const launchConfig = useLaunchConfig()
  // Keep session-state.json in sync with the live session set so a non-graceful
  // termination (crash / external-installer force-close) never re-offers phantom
  // sessions the user already closed. Resume still reads pendingRestore in-memory.
  useSessionAutosave()
  // onCreateConfigFromStage: App owns the first-config dialog via showGuidedConfig.
  // Sidebar receives onShowFirstRun={() => setShowGuidedConfig(true)}, so we use the
  // same setter here to open the real create dialog from the stage empty state.
  const onCreateConfigFromStage = () => setShowGuidedConfig(true)
  const loggingConsentSeen = useSettingsStore((s) => s.settings.loggingConsentSeen)
  // Reactive onboarding-gate input. MUST be a top-level hook (above the
  // Loading/SetupDialog early returns) — the reactive subscription is what lets
  // the finish step's completion stamp dismiss the harness, but a hook placed
  // after a conditional return breaks the Rules of Hooks and blanks the app.
  const onboardingMeta = useAppMetaStore((s) => s.meta)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  // Subscribe to sessions through a STRUCTURAL equality so the root shell does
  // NOT re-render on the statusline bridge's ~1-3×/s telemetry ticks (which only
  // touch contextPercent / cost / tokens / rate-limit / status). Telemetry is
  // read by self-subscribing leaves (SessionStatusStrip, the sidebar card), so
  // the shell only needs to re-render on structural changes (add/remove/reorder,
  // configId, cwd, github state, …). This is the one cut that stops the whole
  // tree re-rendering per tick — see structuralSessionsEqual.
  const sessions = useStoreWithEqualityFn(
    useSessionStore,
    (s) => s.sessions,
    structuralSessionsEqual,
  )
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
  useKeyboardShortcuts(activeSessionId, setSidebarOpen, setView, view, openPageTabs, closePageTab)
  // Stamp data-theme on <html> from the persisted setting + listen for
  // OS prefers-color-scheme changes when in 'system' mode.
  useThemeController()
  // Apply the global UI font scale (<html> root font-size) + family var.
  useTypographyController()

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
    // Record first activation so the partner PTY mounts LAZILY. The partner
    // terminal is available for every session (2 Aug decision), but eagerly
    // mounting its TerminalView spawned a second PTY per session at creation —
    // 2N PTYs whether or not the pane was ever opened (adversarial review,
    // #188). Mount on first toggle instead, and keep it mounted afterwards so
    // toggling back and forth costs nothing.
    setPartnerEverActivated(prev => prev.has(sessionId) ? prev : new Set(prev).add(sessionId))
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

      // A read that failed WITHOUT rejecting: the CONFIG dir was unreachable
      // (`readFailed`), or one or more files exist but could not be read or
      // parsed (`failedKeys`). Either used to look like "absent" and let the
      // migrations and the stores write defaults over files that were fine.
      // Same latch as the catch below, BEFORE anything runs that writes; the
      // notice offers "start fresh anyway". (ADR-009 pass, beta.16.)
      const readFailure = readFailureLockReason(result)
      if (readFailure) {
        console.error('[App] Config read failed without rejecting:', readFailure)
        useConfigWriteLockStore.getState().lock(readFailure)
      }

      // Both one-time config migrations run BEFORE the stores hydrate, so a
      // retired record never renders even once.
      const prepare = async (data: Record<string, unknown>) =>
        retireAskConfig(await applyConfigColourMigration(data))

      if (result.needsMigration) {
        console.log('[App] CONFIG/ is empty, migrating from localStorage...')
        const lsData = gatherLocalStorageData()
        if (Object.keys(lsData).length > 0) {
          await window.electronAPI.config.migrateFromLocalStorage(lsData)
          console.log('[App] Migration complete, reloading...')
          const reloaded = await window.electronAPI.config.loadAll()
          hydrateStores(await prepare(reloaded.data))
        } else {
          hydrateStores(await prepare(result.data))
        }
      } else {
        hydrateStores(await prepare(result.data))
      }

      setConfigLoaded(true)
    } catch (err) {
      console.error('[App] Failed to load config:', err)
      // Hydrating from `{}` is how the window comes up at all, and it is also
      // how the user's config used to be destroyed: the stores end up holding
      // empty defaults, and the first ordinary action persists that over files
      // that were never the problem. The READ failed; the data is still there.
      // Latch writes off BEFORE hydrating -- hydrateStores itself writes -- and
      // let the notice offer "start fresh anyway" to anyone who would rather
      // have a working app than the config they cannot load.
      useConfigWriteLockStore.getState().lock(
        'the app could not read your configuration this launch',
      )
      hydrateStores({})
      setConfigLoaded(true)
    }
  }

  // Logs v2 first-run wipe detection. Runs once after config loads: detect the
  // OLD log artifacts and, if present, surface the blocking LogsWipeModal (which
  // performs the deletion on confirm). Detection-driven + idempotent — once wiped
  // nothing is detected, so this is a no-op on every subsequent launch.
  useEffect(() => {
    if (!configLoaded || logsWipeBytes !== null) return
    let cancelled = false
    void (async () => {
      try {
        const inv = await window.electronAPI.logsWipe.detect()
        if (!cancelled) setLogsWipeBytes(inv.present ? inv.totalBytes : 0)
      } catch {
        if (!cancelled) setLogsWipeBytes(0)   // fail-open: never block boot on a detect error
      }
    })()
    return () => { cancelled = true }
  }, [configLoaded, logsWipeBytes])

  // Post-config-load initialization
  useEffect(() => {
    if (!configLoaded || hasRestoredRef.current) return
    hasRestoredRef.current = true

    async function postConfigInit() {
      const appMeta = useAppMetaStore.getState().meta

      // Re-fire the first-run tour when the VERSION warrants it: every build on
      // the beta line so testers see the current flow, and on any channel when
      // the user has crossed a release line (2.0.x → 2.1.x). Clearing
      // completedSteps + onboardingCompletedVersion flips deriveOnboarding back
      // to due (the harness re-runs); its finish step re-stamps
      // onboardingAppVersion so it will not re-fire until the next one that
      // qualifies. A first install runs through deriveOnboarding already.
      const reonboard = shouldReonboardForVersion(appMeta, __APP_VERSION__, useSettingsStore.getState().settings.updateChannel)
      if (reonboard) {
        useAppMetaStore.getState().update({ completedSteps: {}, onboardingCompletedVersion: undefined })
      }

      // Release notes. ONE surface — the full-screen harness — for both the
      // cohort that is walking the flow anyway and the far commoner one that
      // has already finished it and only needs the notes. The second case used
      // to fall to a wall-of-text modal, and did so on every build whose
      // changelog head sat ahead of its own version (see whats-new-gate.ts).
      //
      // Read BEFORE the harness can stamp anything.
      const alreadyRunning = reonboard || deriveOnboarding(useAppMetaStore.getState().meta, {}).due
      const surface = bootWhatsNewSurface({
        tourWillRun: alreadyRunning,
        whatsNewDue: shouldShowWhatsNew(),
      })
      // Only arm the notes-only mode when the harness is not already coming up
      // for its own reasons; there, whatsNewV2 is simply its first page.
      if (surface === 'tour' && !alreadyRunning) setWhatsNewOnly(true)

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

      // Resume opt-out: LOAD the saved state but do not auto-restore — the
      // ResumeSessionsPrompt lets the user decline ("Don't open") instead of
      // being forced to resume every boot.
      try {
        const savedState = await window.electronAPI.session.load() as SessionState | null
        if (savedState && savedState.sessions.length > 0) setPendingRestore(savedState)
      } catch (err) {
        console.error('[App] Failed to load saved sessions:', err)
      }

      // Start cloud agent IPC listener early so status updates are
      // never missed (previously only started when CloudAgentsPage mounted)
      setupCloudAgentListener()
      setupInsightsListener()
      setupConductorMcpListener()
      setupGitHubListener()
      setupChannelListeners()
      setupCanvasListener()
      setupCanvasReviewListener()
      setupCanvasSnapshotHost()
      useGitHubStore.getState().loadConfig()
      useConductorMcpStore.getState().loadConfig()
      useConductorMcpStore.getState().fetchStatus()
      useCodexAccountStore.getState().refresh()
      useAccountProfilesStore.getState().hydrate()
      useRegistryStore.getState().hydrate().catch((err) => console.warn('[registry] hydrate failed:', err))
      useSentinelStore.getState().hydrate().catch((err) => console.warn('[sentinel] hydrate failed:', err))

      const magicSettings = useMagicButtonStore.getState().settings
      if (magicSettings.autoDeleteDays != null && magicSettings.autoDeleteDays > 0) {
        window.electronAPI.screenshot.cleanup(magicSettings.autoDeleteDays)
      }

      // NOTE (v2): the legacy first-run auto-popups — the 800ms machine-name
      // prompt, and the 500ms What's-New / training-tour arm — are intentionally
      // GONE. The onboarding harness is their single replacement: it collects the
      // machine name (Transparency step), and its finish step stamps
      // lastSeenVersion + lastTrainingVersion so neither the What's-New modal nor
      // the tour auto-fire this release. The tour remains reachable on demand via
      // the Feature Guide button, and What's-New via a future changelog bump for
      // ALREADY-onboarded users. Machine-name / training-due state is no longer
      // armed here.

      // Pick a tip for this session (one per app launch). Gated on the setting:
      // hiding tips switches the FEATURE off, so with it off nothing is picked
      // and nothing is stamped shown -- otherwise the library would quietly
      // burn down behind a hidden row and the count be wrong on re-enable.
      setTimeout(() => {
        if (!useSettingsStore.getState().settings.showTips) return
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
    if (logsWipeBytes !== 0) return
    // v2: never arm the legacy GitHub modal while the onboarding harness is (or
    // could still be) the active flow — its own GitHub step replaces it, and the
    // finish step stamps seenOnboardingVersion. Without this guard the modal
    // could arm in the background mid-flow and then surface the instant
    // onboarding completes.
    if (deriveOnboarding(useAppMetaStore.getState().meta, {}).due) return
    if (whatsNewOnly || showTraining || showTrainingAll) return
    if (isFirstInstall() || shouldShowWhatsNew() || shouldShowTraining()) return
    const t = setTimeout(() => setShowGitHubOnboarding(true), 120)
    return () => clearTimeout(t)
  }, [githubConfig, logsWipeBytes, whatsNewOnly, showTraining, showTrainingAll, needsCliSetup])

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
  async function restoreSavedSessions(savedState: SessionState) {
    try {
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
          // Without this an Ask Conductor session comes back as an ordinary
          // config-less session: plain tab dot, loose in the project list, no
          // dock. Same silent-drop class as the loggingEnabled / detachable bugs.
          kind: saved.kind,
          label: saved.label,
          customName: saved.customName,
          workingDirectory: saved.workingDirectory,
          model: claude?.model ?? saved.model ?? '',
          color: saved.color,
          identityColorKey: saved.identityColorKey,
          legacyColor: saved.legacyColor,
          sessionType: saved.sessionType,
          shellOnly: saved.shellOnly,
          terminalOptions: saved.terminalOptions,
          partnerTerminalPath: saved.partnerTerminalPath,
          partnerElevated: saved.partnerElevated,
          sshConfig: saved.sshConfig,
          legacyVersion: claude?.legacyVersion ?? saved.legacyVersion,
          agentIds: claude?.agentIds ?? saved.agentIds,
          effortLevel: claude?.effortLevel ?? saved.effortLevel,
          disableAutoMemory: claude?.disableAutoMemory ?? saved.disableAutoMemory,
          enableCodexReview: claude?.enableCodexReview,
          loggingEnabled: claude?.loggingEnabled,
          machineName: saved.machineName,
          githubIntegration: saved.githubIntegration,
          status: 'idle' as const,
          createdAt: Date.now(),
          provider: saved.provider,
          profileId: saved.profileId,
          // T8b (bug #5): carry the persisted exact-conversation resume target so
          // TerminalView passes `resume:{uuid,cwd}` through pty.spawn on relaunch.
          resumeUuid: saved.resumeUuid,
          resumeCwd: saved.resumeCwd,
          codexOptions: saved.codexOptions,
        }
      })

      for (const session of restoredSessions) {
        // Both providers support a resume picker. For Codex, the picker script
        // may not be deployed yet on first boot -- buildCodexSpawn falls back
        // to direct codex spawn in that case (see src/main/providers/codex/spawn.ts).
        // T8b (bug #5): when a persisted exact-conversation target exists, the
        // spawn resumes THAT conversation directly (cwd-overridden) -- so the
        // resume PICKER is only the fallback for sessions WITHOUT a persisted uuid.
        const hasExactResume = !!(session.resumeUuid && session.resumeCwd)
        if (!session.shellOnly && session.sessionType === 'local' && !hasExactResume) {
          markSessionForResumePicker(session.id)
        }
      }

      // Relaunch must CONTINUE each session under the same account it was closed
      // on (issue #76). The account is already determined (persisted profileId),
      // so -- like in-session Restart/Recover/Switch -- mark the restored sessions
      // predetermined BEFORE the store restore mounts their TerminalViews, so each
      // spawn skips the pre-spawn AccountLaunchGate re-prompt and respawns under
      // its saved account.
      markRestoredSessionsPredetermined(restoredSessions.map((s) => s.id))

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
      // Drain debounced config saves (DnD reorders, collapse toggles) made in
      // the last ~300ms so they aren't lost with the renderer.
      await flushPendingConfigSaves()
      // T8b (bug #5): enrich each session with its exact-conversation resume
      // target so this relaunch resumes the SAME conversation. Fail-safe: falls
      // back to the plain (sync) state if enrichment throws.
      let stateToSave: SessionState
      try {
        stateToSave = await buildSessionStateWithResumeTargets()
      } catch {
        stateToSave = buildSessionState()
      }
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
      await flushPendingConfigSaves()
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

  // Single entry point for "install the update now", shared by the bottom-bar
  // Update pill and the Settings > Check for Updates button (#142). Never call
  // update.installAndRestart() directly from a component: with sessions open the
  // restart must go through the 'update' close dialog so session state is saved
  // (and pending config writes flushed) first.
  const handleUpdateRequested = () => {
    const state = useSessionStore.getState()
    if (state.sessions.length === 0) {
      setIsClosing(true)
      setIsUpdating(true)
      window.electronAPI.update.installAndRestart().catch(() => { setIsClosing(false); setIsUpdating(false) })
    } else {
      setCloseDialog('update')
    }
  }

  // Main process sends 'closeRequested' when window close is attempted
  useEffect(() => {
    const handleCloseRequested = () => {
      if (isClosing) return
      const state = useSessionStore.getState()
      if (state.sessions.length === 0) {
        // No dialog on the zero-session path, so drain pending debounced
        // config saves here before letting the window die.
        void flushPendingConfigSaves().finally(() => {
          window.electronAPI.window.allowClose()
        })
        return
      }
      setCloseDialog('close')
    }

    const unsub = window.electronAPI.window.onCloseRequested(handleCloseRequested)
    return () => unsub()
  }, [isClosing])

  // Render one page for a given view. Each open page tab renders its own
  // instance, kept mounted (display-toggled) so it persists while another tab is
  // active — the same way sessions stay alive.
  const renderPage = (v: ViewType) => {
    if (v === 'logs') return <GlobalLogsView initialSessionId={pendingLogsSessionId} onInitialSessionConsumed={() => setPendingLogsSessionId(null)} />
    if (v === 'settings') return <SettingsPage initialTab={pendingSettingsTab ?? undefined} onNavigateToSessions={() => setView('sessions')} onUpdateRequested={handleUpdateRequested} />
    if (v === 'insights') return <InsightsPage onNavigateToSessions={() => setView('sessions')} />
    if (v === 'cloud-agents') return <CloudAgentsPage />
    if (v === 'tokenomics') return <TokenomicsPage />
    if (v === 'vision') return <ConductorMcpPage />
    if (v === 'memory') return <MemoryPage
      onClose={() => setView('sessions')}
      onOpenSessionLogs={(sessionId) => { setPendingLogsSessionId(sessionId); setView('logs') }}
      onJumpToSession={(sessionId) => { useSessionStore.getState().setActiveSession(sessionId); setView('sessions') }}
    />
    if (v === 'account-usage') return <AccountUsagePanel onClose={() => setView('sessions')} onReauthNavigate={() => setView('sessions')} />
    if (v === 'help') return <FeatureGuidePage onNavigateToSessions={() => setView('sessions')} onStartTour={() => { setShowTrainingAll(true); setShowTraining(true) }} />
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
        <SessionHeader session={activeSession} />
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
              // Partner terminal is permanent for every config type (2 Aug):
              // no per-config opt-in. It opens in the working directory for
              // local sessions and at home for SSH (the working directory
              // there is a remote path this PC can't resolve). Mounted LAZILY on
              // first activation so its PTY isn't spawned for every session up
              // front (adversarial review, #188); once opened it stays mounted.
              const hasPartner = partnerEverActivated.has(session.id)
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
                      elevated={session.terminalOptions?.elevated}
                      terminalOptions={session.terminalOptions}
                      ssh={session.sshConfig}
                      isActive={session.id === activeSessionId && view === 'sessions' && !isShowingPartner && !altPaneShowing}
                      legacyVersion={session.legacyVersion}
                      agentIds={session.agentIds}
                      effortLevel={session.effortLevel}
                      permissionMode={session.permissionMode}
                      extraArgs={session.extraArgs}
                      disableAutoMemory={session.disableAutoMemory}
                      enableCodexReview={session.enableCodexReview}
                      loggingEnabled={session.loggingEnabled}
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
                      {/* Which terminal am I in? The Canvas and webview panes
                          answer that by looking different; the partner pane is
                          another terminal, so a user who switched could be
                          typing into a plain shell believing it was Claude, with
                          the only cue a label change on one button in the command
                          bar. This strip states it and carries the way back. */}
                      <div
                        className="flex-none flex items-center gap-2 px-3 py-1 text-[11px] border-b"
                        style={{
                          background: 'color-mix(in srgb, var(--color-green) 12%, transparent)',
                          borderColor: 'color-mix(in srgb, var(--color-green) 28%, transparent)',
                          color: 'var(--color-subtext0)',
                        }}
                        data-ux-id="partner-identity-strip"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-green)' }} aria-hidden>
                          <polyline points="4 17 10 11 4 5" />
                          <line x1="12" y1="19" x2="20" y2="19" />
                        </svg>
                        <span>Partner terminal &mdash; a plain shell, not Claude</span>
                        <button
                          onClick={() => togglePartner(session.id)}
                          className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded focus-ring transition-colors hover:bg-surface1"
                          style={{ color: 'var(--color-text)' }}
                          title="Back to the Claude terminal"
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M19 12H5M11 18l-6-6 6-6" />
                          </svg>
                          Back to Claude
                        </button>
                      </div>
                      <TerminalView
                        key={partnerPtyId + '-' + session.createdAt}
                        sessionId={partnerPtyId}
                        configId={session.configId}
                        cwd={session.sessionType === 'local' ? session.workingDirectory : undefined}
                        shellOnly={true}
                        isActive={session.id === activeSessionId && view === 'sessions' && isShowingPartner && !altPaneShowing}
                      />
                    </div>
                  )}
                  {/* Alt-pane priority: Logs > Webview > Agent Canvas. Each
                      alternative pane replaces the underlying terminal panes.
                      Toggle buttons are independent so multiple flags can be
                      true; render only the highest-priority one. (The canvas
                      with no rendered content is the classic Excalidraw
                      scratchpad — spec D2.) */}
                  {isShowingLogs ? (
                    <LogsPane sessionId={session.id} />
                  ) : isShowingWebview ? (
                    <WebviewPane sessionId={session.id} isActive={session.id === activeSessionId} />
                  ) : isShowingExcalidraw ? (
                    <AgentCanvasPane sessionId={session.id} />
                  ) : null}
                </div>
              )
            })}
          </div>
          {/* BUG-7: the GitHub FAB (absolute top-2 right-2) is a later sibling
              than the session content, so it painted over the draw pane's Close
              button. The FAB is irrelevant while drawing — suppress the whole
              panel when the active session is in draw mode. */}
          {activeSession && !excalidrawBySession[activeSession.id]?.isOpen && (
            <GitHubPanel sessionId={activeSession.id} />
          )}
        </div>
        {/* Per-session telemetry strip + command rows live BELOW the
            terminal/GitHub-panel row so they span the full content-column
            width and the GitHub panel ends above them. Rendered once for the
            ACTIVE session only -- switching tabs re-resolves these against
            `activeSession`. Shell-only sessions render a minimal variant of the
            strip — just a Restart control, no telemetry (the strip handles that
            internally). */}
        {activeSession && (
          <SessionStatusStrip sessionId={activeSession.id} />
        )}
        {activeSession && (
          <CommandBar
            key={activeSession.id + '-commandbar'}
            sessionId={activeSession.id}
            configId={activeSession.configId}
            sessionType={activeSession.sessionType === 'ssh' ? 'ssh' : 'local'}
            partnerEnabled={true}
            isPartnerActive={partnerActive.has(activeSession.id)}
            onTogglePartner={() => togglePartner(activeSession.id)}
            partnerSessionId={activeSession.id + '-partner'}
            parentSessionId={activeSession.id}
            mainPaneIsShell={!!activeSession.shellOnly}
          />
        )}
      </div>
    )
  }

  // Show loading while checking setup status or loading config. Also hold
  // until logsWipe detection resolves: pickBootGate returns null while
  // logsWipeBytes === null, so rendering the shell here would flash an
  // ungated, interactive app for a few frames before a due gate (onboarding,
  // wipe) pops over it.
  if (setupComplete === null || (setupComplete && (!configLoaded || logsWipeBytes === null))) {
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

  const handleTrainingClose = () => {
    setShowTraining(false)
    setShowTrainingAll(false)
    // Onboarding is handled by the useEffect above; no need to schedule it
    // here.
  }

  // First-launch gates each have an independent trigger (wipe detection IPC,
  // version compare, settings flags, staggered boot timers); without a shared
  // priority they mount simultaneously and stack, with DOM order deciding who
  // paints on top. Exactly one gate renders at a time — see pickBootGate.
  // Forced first-run harness gate. onboardingMeta is subscribed at the top of
  // the component (reactive) so the finish step's completion stamp
  // (settleOnboardingFinish) flips due->false and unmounts the harness on the
  // next render. Settings view kept minimal — the codexSignIn when() only
  // narrows the applicable set, never the due decision.
  // `|| whatsNewOnly`: the harness is also the release-notes surface, so it is
  // due when the notes are due even though no step is outstanding.
  const onboardingDue = deriveOnboarding(onboardingMeta, {}).due || whatsNewOnly
  const bootGate = pickBootGate({
    configLoaded,
    onboardingDue,
    logsWipeBytes,
    showTraining,
    showTrainingAll,
    showGitHubOnboarding,
    showMachineNamePrompt,
    loggingConsentSeen: Boolean(loggingConsentSeen),
    resumePending: pendingRestore !== null,
    whatsNewDue: shouldShowWhatsNew(),
    trainingDue: shouldShowTraining() || isFirstInstall(),
    githubOnboardingDue: isGitHubOnboardingDue(),
  })

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-screen bg-base text-text">
        {bootGate === 'logsWipe' && logsWipeBytes !== null && (
          <LogsWipeModal totalBytes={logsWipeBytes} onComplete={() => setLogsWipeBytes(0)} />
        )}
        {bootGate === 'onboarding' && (
          <OnboardingHarness
            whatsNewOnly={whatsNewOnly}
            onComplete={(startTour) => {
              // The settle already stamped this run (the harness unmounts on
              // this render). Clear the notes-only arm explicitly: unlike the
              // full flow, nothing it writes is read back by deriveOnboarding,
              // so the gate would otherwise stay open on this state alone.
              setWhatsNewOnly(false)
              // Launch the live-app tour if chosen.
              if (startTour) setTourActive(true)
            }}
          />
        )}
        {tourActive && bootGate === null && (
          <GuidedTour
            onClose={() => setTourActive(false)}
            onCreateConfig={() => {
              setTourActive(false)
              setShowGuidedConfig(true)
            }}
          />
        )}
        {showTipModal && bootGate === null && <TipModal onClose={() => setShowTipModal(false)} onNavigate={(v) => setView(v)} />}
        {bootGate === 'githubOnboarding' && (
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

        {/* Suppressed under the guided tour and the first-config dialog too:
            the tour's centered steps paint a click-capturing full-viewport dim
            (z-60) over these (z-40/z-50), stranding a real decision prompt
            underneath. State is kept, so they surface once the overlay closes. */}
        {/* darwin: multi-account is Windows-only (Keychain token can't be
            isolated per profile), so never offer to capture a second account. */}
        {newAccountDetected && window.electronPlatform !== 'darwin' && bootGate !== 'onboarding' && !tourActive && !showGuidedConfig && (
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

        {bootGate === 'loggingConsent' && (
          <LoggingConsentPrompt />
        )}

        {/* Now a proper gate (bootGates: 'resume', lowest priority) rather than
            a surface that merely stepped around onboarding. It used to be
            gated on `bootGate !== 'onboarding'` alone, so a launch that showed
            release notes painted this prompt over them. */}
        {bootGate === 'resume' && pendingRestore && !tourActive && !showGuidedConfig && (
          <ResumeSessionsPrompt
            sessions={pendingRestore.sessions}
            onResume={() => {
              const saved = pendingRestore
              setPendingRestore(null)
              void restoreSavedSessions(saved)
            }}
            onDontOpen={() => {
              setPendingRestore(null)
              // Discard the saved cards so the next boot doesn't re-prompt; the
              // conversations themselves stay resumable from inside Claude.
              void window.electronAPI.session.clear()
            }}
            onRefresh={async () => {
              // The list is a boot-time snapshot; re-read the saved set so a
              // session restarted since launch shows up (#130). Keep the current
              // list on a transient empty read rather than dismissing the prompt.
              try {
                const saved = await window.electronAPI.session.load() as SessionState | null
                setPendingRestore((prev) => (saved && saved.sessions.length > 0 ? saved : prev))
              } catch (err) {
                console.error('[App] Resume refresh failed:', err)
              }
            }}
          />
        )}

        {bootGate === 'machineName' && (
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

        <SshCloseDialog />
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
          <Sidebar currentView={view} onViewChange={setView} collapsed={!sidebarOpen} tourActive={showTraining || showTrainingAll} onShowFirstRun={() => setShowGuidedConfig(true)} onShowAccountUsage={() => setView('account-usage')} onShowTip={() => setShowTipModal(true)} />
          <main className="flex-1 flex flex-col overflow-hidden titlebar-no-drag">
            {/* One tab strip for the whole main window: session tabs + any open
                page tabs (Tokenomics, Logs, Feature Guide, …). Always visible so
                a page is a peer of a session, never a full-pane takeover. */}
            <TabBar
              activeView={view}
              openPageTabs={openPageTabs}
              onActivateSession={activateSessionTab}
              onActivatePage={(v) => setView(v)}
              onClosePage={closePageTab}
            />
            <div className="flex-1 flex flex-col overflow-hidden min-h-0 relative">
              {/* The live app is always what's behind — the first-config flow is
                  the REAL SessionDialog rendered as an overlay (below), so the
                  user sees the workbench while creating their first session.
                  (The old full-column GuidedConfigView is retired.) */}
              {renderSessions()}
              {/* Every open page tab is kept mounted and display-toggled, so
                  switching to a session and back preserves its state — the same
                  discipline the session list uses to keep PTYs alive. */}
              {openPageTabs.map((v) => (
                <div key={`page-pane:${v}`} className="flex-1 flex flex-col min-h-0" style={{ display: view === v ? 'flex' : 'none' }}>
                  {renderPage(v)}
                </div>
              ))}
            </div>
          </main>
        </div>
        {/* Runtime footer spans the FULL app width (under the sidebar too) so
            CLI/version sits at the absolute bottom-left of the app -- a global
            status bar, distinct from the per-session statusline strip which
            lives above the command rows inside the terminal column. */}
        <div className="titlebar-no-drag shrink-0">
          <BottomBar currentView={view} onViewChange={setView} onUpdateRequested={handleUpdateRequested} />
        </div>
        {bootGate === 'training' && (
          <TrainingWalkthrough
            onClose={handleTrainingClose}
            showAll={showTrainingAll}
            mode={showTrainingAll ? 'help' : 'first-run'}
          />
        )}
        {/* First-config creation (from the onboarding tour, the sidebar
            FirstRunCard, or the empty-state button). The REAL SessionDialog over
            the live app — same create + launch path as the sidebar's New Session,
            so there is no behaviour drift and no dead controls (retires the old
            GuidedConfigView). */}
        {showGuidedConfig && (
          <SessionDialog
            onCancel={() => setShowGuidedConfig(false)}
            onConfirm={async (data, password, sudoPassword, argSecret) => {
              const { generateId } = await import('./utils/id')
              const config = { ...data, id: generateId() }
              useConfigStore.getState().addConfig(config)
              if (password) await window.electronAPI.credentials.save(config.id, password)
              if (sudoPassword) await window.electronAPI.credentials.save(config.id + '_sudo', sudoPassword)
              if (argSecret) await window.electronAPI.credentials.save(config.id + '_argsecret', argSecret)
              useAppMetaStore.getState().update({ hasCreatedFirstConfig: true })
              trackUsage('sessions.create-config')
              setShowGuidedConfig(false)
              launchConfig(config)
              setView('sessions')
            }}
          />
        )}
        {/* Pre-spawn account launch gate: asks which account a session runs
            under on its first spawn (multi-account only). App-root so it
            overlays every view. */}
        <AccountLaunchGate />
        {/* Sentinel findings panel: global overlay, driven by sentinelStore.
            Suppressed while ANY boot gate is up — it is not a gate itself (it
            owns no turn in the sequence and can arrive at any time), but it
            used to render unconditionally, which is how a first launch could
            paint findings on top of the release notes. Its state is kept, so
            it surfaces the moment the gates clear. */}
        {bootGate === null && <SentinelPanel />}
      </div>
    </ErrorBoundary>
  )
}
