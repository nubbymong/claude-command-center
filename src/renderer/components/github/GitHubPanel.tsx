import { useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useGitHubStore } from '../../stores/githubStore'
import PanelHeader from './PanelHeader'
import SessionContextSection from './sections/SessionContextSection'
import ActivePRSection from './sections/ActivePRSection'
import CISection from './sections/CISection'
import ReviewsSection from './sections/ReviewsSection'
import IssuesSection from './sections/IssuesSection'
import LocalGitSection from './sections/LocalGitSection'
import NotificationsSection from './sections/NotificationsSection'
import AgentIntentSection from './sections/AgentIntentSection'

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
  const sync = useGitHubStore((s) => (slug ? s.syncStatus[slug] : undefined))
  const width = sessionState?.panelWidth ?? 340

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
      />
      <div className="flex-1 overflow-y-auto" aria-live="polite">
        <SessionContextSection sessionId={sessionId} />
        <ActivePRSection sessionId={sessionId} />
        <CISection sessionId={sessionId} />
        <ReviewsSection sessionId={sessionId} />
        <IssuesSection sessionId={sessionId} />
        <LocalGitSection sessionId={sessionId} />
        <NotificationsSection sessionId={sessionId} />
        <AgentIntentSection sessionId={sessionId} />
      </div>
    </aside>
  )
}
