import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useGitHubStore } from '../../stores/githubStore'
import { useSessionStore } from '../../stores/sessionStore'
import PanelHeader from './PanelHeader'
import SessionContextSection from './sections/SessionContextSection'
import ActivePRSection from './sections/ActivePRSection'
import CISection from './sections/CISection'
import ReviewsSection from './sections/ReviewsSection'
import IssuesSection from './sections/IssuesSection'
import LocalGitSection from './sections/LocalGitSection'
import NotificationsSection from './sections/NotificationsSection'
import AgentIntentSection from './sections/AgentIntentSection'
import SessionGitHubConfig from '../session/SessionGitHubConfig'

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
          <div
            className="fixed inset-0 bg-base/80 z-50 flex items-center justify-center"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gh-setup-title"
          >
            <div className="bg-mantle p-6 rounded max-w-md w-full">
              <h3 id="gh-setup-title" className="text-lg mb-3 text-text">
                Configure GitHub for this session
              </h3>
              <SessionGitHubConfig
                sessionId={sessionId}
                cwd={session?.workingDirectory ?? ''}
                initial={session?.githubIntegration}
              />
              <button onClick={() => setShowSetup(false)} className="mt-4 text-xs text-subtext0">
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
          className="text-subtext0 text-xs"
        >
          GH
        </button>
      </aside>
    )
  }

  return (
    <aside
      className="bg-base border-l border-surface0 flex flex-col relative"
      style={{ width, minWidth: 280 }}
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
      <div className="flex-1 overflow-y-auto" aria-live="polite">
        <SessionContextSection sessionId={sessionId} />
        <ActivePRSection sessionId={sessionId} slug={repoSlug} />
        <CISection sessionId={sessionId} slug={repoSlug} />
        <ReviewsSection sessionId={sessionId} slug={repoSlug} />
        <IssuesSection sessionId={sessionId} slug={repoSlug} />
        <LocalGitSection sessionId={sessionId} cwd={session?.workingDirectory} />
        <NotificationsSection sessionId={sessionId} />
        <AgentIntentSection sessionId={sessionId} />
      </div>
    </aside>
  )
}
