import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useGitHubStore } from '../../stores/githubStore'
import { useSessionStore } from '../../stores/sessionStore'
import { trackUsage } from '../../stores/tipsStore'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import PanelHeader from './PanelHeader'
import SessionContextSection from './sections/SessionContextSection'
import ActivePRSection from './sections/ActivePRSection'
import CISection from './sections/CISection'
import ReviewsSection from './sections/ReviewsSection'
import IssuesSection from './sections/IssuesSection'
import LocalGitSection from './sections/LocalGitSection'
import NotificationsSection from './sections/NotificationsSection'
import SessionGitHubConfig from '../session/SessionGitHubConfig'
import RateLimitBanner from './RateLimitBanner'

interface Props {
  sessionId: string
  slug?: string
  branch?: string
  ahead?: number
  behind?: number
  dirty?: number
}

export default function GitHubPanel({
  sessionId,
  slug,
  branch,
  ahead,
  behind,
  dirty,
}: Props) {
  const visible = useGitHubStore((s) => s.panelVisible)
  const togglePanel = useGitHubStore((s) => s.togglePanel)
  const sessionState = useGitHubStore((s) => s.sessionStates[sessionId])
  const setPanelWidth = useGitHubStore((s) => s.setPanelWidth)
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId))
  const integrationEnabled = session?.githubIntegration?.enabled ?? false
  // Derive the slug from the session's integration; `slug` prop is kept for
  // tests / future external drivers but isn't wired from App.tsx anymore.
  // Without this fall-through the panel header would be stuck at 'idle'
  // because syncStatus is keyed by slug.
  const repoSlug = slug ?? session?.githubIntegration?.repoSlug
  const sync = useGitHubStore((s) => (repoSlug ? s.syncStatus[repoSlug] : undefined))
  const [showSetup, setShowSetup] = useState(false)
  const setupDialogRef = useRef<HTMLDivElement | null>(null)
  const closeSetup = useCallback(() => setShowSetup(false), [])
  useFocusTrap(setupDialogRef, showSetup, closeSetup)
  const width = sessionState?.panelWidth ?? 340

  // Auto-close the setup modal once the user saves + integration flips on.
  // Without this, disabling integration later would re-enter the rail
  // branch with `showSetup` still true and spontaneously pop the modal.
  useEffect(() => {
    if (integrationEnabled && showSetup) setShowSetup(false)
  }, [integrationEnabled, showSetup])

  // Reset the setup modal when the active session changes. App.tsx mounts a
  // single <GitHubPanel> instance and only swaps the sessionId prop, so
  // component state survives tab switches — without this, opening setup for
  // session A and then switching to session B would leave the modal open
  // but targeting B's sessionId / cwd. Clearing on id change keeps the
  // modal strictly scoped to an explicit click.
  useEffect(() => {
    setShowSetup(false)
  }, [sessionId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac = window.electronPlatform === 'darwin'
      if (e.key === '/' && (isMac ? e.metaKey : e.ctrlKey)) {
        e.preventDefault()
        togglePanel()
        trackUsage('github.panel-toggled')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePanel])

  // Store the active drag's teardown so we can detach listeners even when
  // the panel unmounts (or the user toggles visibility via Ctrl+/) mid-drag,
  // instead of relying solely on pointerup.
  const dragCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    return () => dragCleanupRef.current?.()
  }, [])

  const startResize = (e: ReactPointerEvent) => {
    dragCleanupRef.current?.()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: PointerEvent) => {
      // Panel lives on the right; resize handle is on its left edge, so
      // dragging left (negative dx) widens the panel. Clamp 280..520.
      const newW = Math.max(280, Math.min(520, startW - (ev.clientX - startX)))
      setPanelWidth(sessionId, newW)
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      dragCleanupRef.current = null
    }
    const onUp = () => cleanup()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    dragCleanupRef.current = cleanup
  }

  // Integration-not-enabled: render the rail only, with "Configure" click.
  // The rail still answers Ctrl+/ but there's nothing to show until the user
  // opts this session in via the setup modal.
  if (!integrationEnabled) {
    return (
      <>
        <aside
          className="w-7 bg-mantle border-l border-surface0 flex flex-col items-center py-3"
          aria-label="GitHub panel (integration not configured)"
        >
          <button
            onClick={() => setShowSetup(true)}
            aria-label="Configure GitHub integration for this session"
            title="Configure GitHub integration for this session"
            className="text-subtext0 text-xs hover:text-text"
          >
            GH
          </button>
        </aside>
        {showSetup && (
          <div className="fixed inset-0 bg-base/80 z-50 flex items-center justify-center">
            <div
              ref={setupDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="gh-setup-title"
              className="bg-mantle p-6 rounded max-w-md w-full"
            >
              <h3 id="gh-setup-title" className="text-lg mb-3 text-text">
                Configure GitHub for this session
              </h3>
              <SessionGitHubConfig
                sessionId={sessionId}
                cwd={session?.workingDirectory ?? ''}
                initial={session?.githubIntegration}
              />
              <button
                onClick={closeSetup}
                className="mt-4 text-xs text-subtext0 hover:text-text transition-colors"
                aria-label="Close GitHub configuration"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </>
    )
  }

  if (!visible) {
    return (
      <aside
        className="w-7 bg-mantle border-l border-surface0 flex flex-col items-center py-3"
        aria-label="GitHub panel (collapsed)"
      >
        <button
          onClick={togglePanel}
          title={`Show GitHub panel (${
            window.electronPlatform === 'darwin' ? '\u2318+/' : 'Ctrl+/'
          })`}
          aria-label="Show GitHub panel"
          className="text-overlay0 hover:text-text transition-colors p-1 rounded"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
        </button>
      </aside>
    )
  }

  // Drive the per-session accent through a CSS variable so descendant
  // sections can opt in (chevrons, focus rings) without prop-drilling.
  // Same color the active tab underline + SessionHeader top border use,
  // so the eye traces a single continuous identity for the active session.
  const sessionAccent = session?.color || '#737373'
  return (
    <aside
      className="bg-base border-l border-surface0 flex flex-col relative"
      style={{
        width,
        minWidth: 280,
        borderTopWidth: '3px',
        borderTopStyle: 'solid',
        borderTopColor: sessionAccent,
        '--session-color': sessionAccent,
      } as React.CSSProperties}
      aria-label="GitHub panel"
    >
      <div
        onPointerDown={startResize}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-surface1"
        aria-hidden="true"
      />
      <PanelHeader
        branch={branch}
        ahead={ahead}
        behind={behind}
        dirty={dirty}
        syncState={sync?.state ?? 'idle'}
        syncedAt={sync?.at}
        nextResetAt={sync?.nextResetAt}
        onRefresh={() => void window.electronAPI.github.syncNow(sessionId)}
        // branch / ahead / behind / dirty still come from props; PR 3b wires
        // them to a local-git poller so the header reflects live state.
      />
      {sync?.state === 'rate-limited' && sync.nextResetAt && (
        <RateLimitBanner resetAt={sync.nextResetAt} />
      )}
      <div className="flex-1 overflow-y-auto" aria-live="polite">
        <SessionContextSection sessionId={sessionId} />
        <ActivePRSection sessionId={sessionId} slug={repoSlug} />
        <CISection sessionId={sessionId} slug={repoSlug} />
        <ReviewsSection sessionId={sessionId} slug={repoSlug} />
        <IssuesSection sessionId={sessionId} slug={repoSlug} />
        <LocalGitSection sessionId={sessionId} cwd={session?.workingDirectory} />
        <NotificationsSection sessionId={sessionId} />
      </div>
    </aside>
  )
}
