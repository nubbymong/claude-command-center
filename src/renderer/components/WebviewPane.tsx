import React, { useEffect, useRef, useState, lazy, Suspense } from 'react'
import { useWebviewStore } from '../stores/webviewStore'

const ExcalidrawModal = lazy(() => import('./ExcalidrawModal'))

interface Props {
  sessionId: string
}

/**
 * Renderer-side host for the per-session WebContentsView. The actual
 * page pixels are drawn by the main process via WebContentsView, NOT
 * inside this React tree — we just reserve the space and stream
 * bounds updates to the main process so the view tracks the
 * placeholder div on resize/scroll.
 *
 * This pattern lets the webview run with full Chrome capability
 * (cookies, JS, navigation) without polluting the renderer's
 * sandbox or bumping into the deprecated `<webview>` tag.
 */
export default function WebviewPane({ sessionId }: Props) {
  const state = useWebviewStore((s) => s.bySessionId[sessionId])
  const setOpen = useWebviewStore((s) => s.setOpen)
  const containerRef = useRef<HTMLDivElement>(null)
  const [frozenImage, setFrozenImage] = useState<string | null>(null)
  const [navState, setNavState] = useState<{ loading: boolean }>({ loading: false })

  // Open the WebContentsView when this component mounts (i.e. when
  // the user toggles the pane open and our parent renders us).
  // Bounds updates run on every resize via ResizeObserver.
  useEffect(() => {
    const el = containerRef.current
    if (!el || !state?.currentUrl) return
    let cancelled = false

    const reportBounds = () => {
      const rect = el.getBoundingClientRect()
      const bounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      }
      window.electronAPI.webview.setBounds(sessionId, bounds).catch(() => { /* noop */ })
    }

    ;(async () => {
      const rect = el.getBoundingClientRect()
      const bounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      }
      setNavState({ loading: true })
      const ok = await window.electronAPI.webview.open(sessionId, state.currentUrl!, bounds)
      if (cancelled) return
      setNavState({ loading: false })
      if (!ok) {
        // Open failed — close the pane so the user isn't staring
        // at an empty box, the failed pulse is already on the button.
        setOpen(sessionId, false)
      }
    })()

    const ro = new ResizeObserver(() => reportBounds())
    ro.observe(el)
    window.addEventListener('resize', reportBounds)
    // Also push bounds whenever the component re-renders, in case
    // the parent flexbox shifts without firing resize.
    const tick = window.setInterval(reportBounds, 500)

    return () => {
      cancelled = true
      ro.disconnect()
      window.removeEventListener('resize', reportBounds)
      window.clearInterval(tick)
      window.electronAPI.webview.close(sessionId).catch(() => { /* noop */ })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, state?.currentUrl])

  if (!state || !state.isOpen) return null

  const handleReload = () => {
    setNavState({ loading: true })
    window.electronAPI.webview.reload(sessionId)
      .finally(() => setNavState({ loading: false }))
  }

  const handleFreeze = async () => {
    const image = await window.electronAPI.webview.capture(sessionId)
    if (image) setFrozenImage(image)
  }

  const handleClose = () => setOpen(sessionId, false)

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-mantle">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-surface0 bg-crust shrink-0">
        <button
          onClick={() => window.electronAPI.webview.navBack(sessionId)}
          className="px-1.5 py-0.5 text-xs text-overlay1 hover:text-text rounded hover:bg-surface0"
          title="Back"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M10 3l-5 5 5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button
          onClick={() => window.electronAPI.webview.navForward(sessionId)}
          className="px-1.5 py-0.5 text-xs text-overlay1 hover:text-text rounded hover:bg-surface0"
          title="Forward"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button
          onClick={handleReload}
          className="px-1.5 py-0.5 text-xs text-overlay1 hover:text-text rounded hover:bg-surface0"
          title="Hard refresh"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 4v4h4" />
            <path d="M2.5 8a6 6 0 1 0 1.5-3.7" />
          </svg>
        </button>
        <button
          onClick={() => window.electronAPI.webview.goHome(sessionId)}
          className="px-1.5 py-0.5 text-xs text-overlay1 hover:text-text rounded hover:bg-surface0"
          title="Original URL"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
            <path d="M2 7l6-5 6 5M3.5 6.5V14h9V6.5" />
          </svg>
        </button>
        <span className="font-mono text-[11px] text-overlay0 truncate ml-2 mr-2 flex-1" title={state.currentUrl || ''}>
          {state.currentUrl || ''}
        </span>
        {navState.loading && <span className="text-[10px] text-overlay0">loading…</span>}
        <button
          onClick={handleFreeze}
          className="px-2 py-0.5 text-xs rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-surface1 hover:text-text transition-colors"
          title="Freeze + annotate with Excalidraw"
        >
          Freeze
        </button>
        <button
          onClick={handleClose}
          className="px-2 py-0.5 text-xs rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-surface1 hover:text-text transition-colors"
          title="Close webview pane"
        >
          Close
        </button>
      </div>
      {/* Placeholder for the WebContentsView — the main process attaches
          a real Chrome view at this rectangle. We just reserve space. */}
      <div ref={containerRef} className="flex-1 min-h-0 bg-crust" />
      {frozenImage && (
        <Suspense fallback={null}>
          <ExcalidrawModal backgroundImage={frozenImage} onClose={() => setFrozenImage(null)} />
        </Suspense>
      )}
    </div>
  )
}
