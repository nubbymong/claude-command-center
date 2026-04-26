import React, { useEffect, useRef, useState, lazy, Suspense } from 'react'
import { useWebviewStore } from '../stores/webviewStore'

const ExcalidrawModal = lazy(() => import('./ExcalidrawModal'))

interface Props {
  sessionId: string
  /**
   * Whether this session is currently the active session tab. When false
   * the parent's container has display:none, but the WebContentsView is
   * still attached to the BrowserWindow's contentView and would draw
   * over the active session. We toggle it via setVisible IPC instead of
   * relying on bounds=0 (which has flicker + reliability issues).
   */
  isActive: boolean
}

/**
 * Renderer-side host for the per-session WebContentsView. The actual
 * page pixels are drawn by the main process via WebContentsView, NOT
 * inside this React tree — we just reserve the space and stream
 * bounds updates so the view tracks the placeholder div on resize.
 */
export default function WebviewPane({ sessionId, isActive }: Props) {
  const state = useWebviewStore((s) => s.bySessionId[sessionId])
  const setOpen = useWebviewStore((s) => s.setOpen)
  const containerRef = useRef<HTMLDivElement>(null)
  const [frozenImage, setFrozenImage] = useState<string | null>(null)
  const [navState, setNavState] = useState<{ loading: boolean }>({ loading: false })

  // Open + bounds-tracking lifecycle.
  // Defers webview.open until the placeholder has real dimensions —
  // first React render runs before layout, so getBoundingClientRect
  // returns 0×0 for a frame and the WebContentsView would otherwise be
  // created at full-window initial bounds (manager fallback).
  useEffect(() => {
    const el = containerRef.current
    if (!el || !state?.currentUrl) return
    let cancelled = false
    let openPending = true

    const measure = () => {
      const rect = el.getBoundingClientRect()
      return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
    }

    const reportBounds = () => {
      const b = measure()
      // Skip impossible bounds — happens when an ancestor has
      // display:none, layout pending, etc. The setVisible toggle keeps
      // the view hidden in those cases, so leaving bounds stale is
      // safe and avoids 1×1-flicker in the corner of the screen.
      if (b.width < 1 || b.height < 1) return
      window.electronAPI.webview.setBounds(sessionId, b).catch(() => { /* noop */ })
    }

    const tryOpen = async () => {
      if (cancelled) return
      const b = measure()
      if (b.width < 1 || b.height < 1) {
        // Layout not ready — try next frame.
        requestAnimationFrame(tryOpen)
        return
      }
      openPending = false
      setNavState({ loading: true })
      const ok = await window.electronAPI.webview.open(sessionId, state.currentUrl!, b)
      if (cancelled) return
      setNavState({ loading: false })
      if (!ok) {
        setOpen(sessionId, false)
      }
    }

    tryOpen()

    const ro = new ResizeObserver(() => { if (!openPending) reportBounds() })
    ro.observe(el)
    window.addEventListener('resize', reportBounds)
    // Catch parent-flex changes that don't fire ResizeObserver on this
    // element (sidebar collapse, GitHubPanel toggle, etc).
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

  // Show/hide on session-active changes. Without this, the
  // WebContentsView from an inactive session keeps drawing over the
  // active session's content (display:none on the React parent doesn't
  // reach the native view layer).
  useEffect(() => {
    if (!state?.isOpen) return
    window.electronAPI.webview.setVisible(sessionId, isActive).catch(() => { /* noop */ })
  }, [sessionId, isActive, state?.isOpen])

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
    <div className="flex-1 flex flex-col min-h-0 bg-mantle relative">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-surface0 bg-crust shrink-0 z-10">
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
      {/* Always-visible escape hatch overlay. The native WebContentsView
          draws on top of any HTML below the toolbar, so if anything
          goes wrong with bounds the user can still get out from here.
          Pinned bottom-right with a high z-index — the native view
          can't cover it because it's outside the placeholder bounds. */}
      <button
        onClick={handleClose}
        className="absolute right-2 bottom-2 z-20 px-2 py-1 text-[11px] rounded-full bg-red/80 text-crust shadow-lg hover:bg-red transition-colors"
        title="Force-close webview"
      >
        ✕ exit webview
      </button>
      {frozenImage && (
        <Suspense fallback={null}>
          <ExcalidrawModal backgroundImage={frozenImage} onClose={() => setFrozenImage(null)} />
        </Suspense>
      )}
    </div>
  )
}
