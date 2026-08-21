import React, { useEffect, useRef, useState, lazy, Suspense, useCallback } from 'react'
import { useWebviewStore } from '../stores/webviewStore'
import { useBrowserStore } from '../stores/browserStore'
import { useSessionStore } from '../stores/sessionStore'
import { normaliseBrowserInput, shortUrlLabel } from '../../shared/browser-url'

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

type Bounds = { x: number; y: number; width: number; height: number }

const Icon = {
  back: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 18l-6-6 6-6" /></svg>,
  forward: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 18l6-6-6-6" /></svg>,
  reload: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>,
  home: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden><path d="M2 7l6-5 6 5M3.5 6.5V14h9V6.5" /></svg>,
  external: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>,
  lock: <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>,
  globe: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>,
  star: (filled: boolean) => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
    </svg>
  ),
  close: <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" /></svg>,
}

const toolBtn = 'px-1.5 py-0.5 text-xs rounded focus-ring transition-colors disabled:opacity-35 disabled:cursor-default'
const toolBtnIdle = 'text-overlay1 hover:text-text hover:bg-surface0'

/**
 * The session's browser pane (item 26). A pane of its own, beside the
 * partner terminal: address bar, history, a home page per session, saved
 * favourites, and a way out to the real browser. A command can still point
 * it at a page ("watch for a page", "open a page") -- a convenience, not the
 * only door in.
 *
 * The page pixels are drawn by the main process via a WebContentsView, NOT
 * inside this React tree -- we reserve the rectangle and stream its bounds
 * so the view tracks the placeholder on resize. Native views paint above
 * all HTML, which is why the favourites bar is a ROW that pushes the page
 * down rather than a menu that would drop over (and under) it.
 */
export default function WebviewPane({ sessionId, isActive }: Props) {
  const state = useWebviewStore((s) => s.bySessionId[sessionId])
  const setOpen = useWebviewStore((s) => s.setOpen)
  const navigate = useWebviewStore((s) => s.navigate)
  const setPage = useWebviewStore((s) => s.setPage)
  const setHomeUrl = useWebviewStore((s) => s.setHomeUrl)

  const configId = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.configId)
  const favourites = useBrowserStore((s) => s.favourites)
  const persistedHome = useBrowserStore((s) => (configId ? s.homeByConfig[configId] ?? null : null))
  const toggleFavourite = useBrowserStore((s) => s.toggleFavourite)
  const removeFavourite = useBrowserStore((s) => s.removeFavourite)
  const setConfigHome = useBrowserStore((s) => s.setHome)

  const containerRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const tryOpenRef = useRef<(() => void) | null>(null)
  /** True once main has a WebContentsView for this session. */
  const viewReadyRef = useRef(false)
  const [frozenImage, setFrozenImage] = useState<string | null>(null)
  const [showFavourites, setShowFavourites] = useState(false)
  const [address, setAddress] = useState('')
  const [addressEditing, setAddressEditing] = useState(false)
  const [addressError, setAddressError] = useState<string | null>(null)

  const currentUrl = state?.currentUrl ?? null
  const page = state?.page ?? null
  const shownUrl = page?.url || currentUrl || ''
  // A session-scoped home wins over the config's; either is "home".
  const home = state?.homeUrl ?? persistedHome
  const isFav = !!shownUrl && favourites.some((f) => f.url === shownUrl)

  // Track latest isActive in a ref so the bounds-reporting helpers and the
  // rAF retry loop can read it without re-firing the lifecycle effect on
  // session switch.
  const isActiveRef = useRef(isActive)
  useEffect(() => { isActiveRef.current = isActive }, [isActive])

  // Keep the address bar showing where the page IS, unless the user is
  // typing in it.
  useEffect(() => {
    if (!addressEditing) setAddress(shownUrl)
  }, [shownUrl, addressEditing])

  // Navigation state from main: the real URL (after redirects), title,
  // history flags, loading. One subscription per pane; filter by session.
  useEffect(() => {
    return window.electronAPI.webview.onNavigated((st) => {
      if (st.sessionId === sessionId) setPage(st)
    })
  }, [sessionId, setPage])

  // The pane opened on its start page but this session has a home: go there.
  useEffect(() => {
    if (state?.isOpen && !currentUrl && home) navigate(sessionId, home)
  }, [state?.isOpen, currentUrl, home, sessionId, navigate])

  const measure = useCallback((): Bounds | null => {
    const el = containerRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
  }, [])

  // ── View lifecycle ────────────────────────────────────────────────────
  // ONE WebContentsView per pane mount, created lazily the first time there
  // is a URL to show and destroyed on unmount. Navigation after that goes
  // through `webview.navigate` so history survives -- the previous pane tore
  // the view down and rebuilt it on every URL change, which is why Back
  // never had anywhere to go.
  useEffect(() => {
    let cancelled = false
    let rafId: number | null = null
    let openInFlight = false

    const tryOpen = () => {
      if (cancelled || viewReadyRef.current || openInFlight) return
      const url = useWebviewStore.getState().bySessionId[sessionId]?.currentUrl
      if (!url) return
      if (!isActiveRef.current) return // parked; retried when the session becomes active
      const b = measure()
      if (!b || b.width < 1 || b.height < 1) {
        rafId = requestAnimationFrame(tryOpen)
        return
      }
      openInFlight = true
      window.electronAPI.webview.open(sessionId, url, b).then((ok) => {
        openInFlight = false
        if (cancelled) return
        if (ok) {
          viewReadyRef.current = true
          // The URL may have moved on while the IPC was in flight.
          const latest = useWebviewStore.getState().bySessionId[sessionId]?.currentUrl
          if (latest && latest !== url) void window.electronAPI.webview.navigate(sessionId, latest)
        } else {
          setOpen(sessionId, false)
        }
      }).catch(() => {
        openInFlight = false
        if (!cancelled) setOpen(sessionId, false)
      })
    }
    tryOpenRef.current = tryOpen
    tryOpen()

    return () => {
      cancelled = true
      if (rafId !== null) cancelAnimationFrame(rafId)
      tryOpenRef.current = null
      viewReadyRef.current = false
      window.electronAPI.webview.close(sessionId).catch(() => { /* noop */ })
    }
  }, [sessionId, measure, setOpen])

  // React to the requested URL: navigate the existing view, or create one.
  // Keyed on navSeq as well as the url: asking for the SAME page again must
  // still go there (the page may have moved on via Back or a link).
  const navSeq = state?.navSeq ?? 0
  useEffect(() => {
    if (!currentUrl) return
    if (!viewReadyRef.current) { tryOpenRef.current?.(); return }
    window.electronAPI.webview.navigate(sessionId, currentUrl).then((ok) => {
      if (!ok) {
        // Main has no view for us after all (it was closed under us) --
        // fall back to creating one.
        viewReadyRef.current = false
        tryOpenRef.current?.()
      }
    }).catch(() => { /* noop */ })
  }, [sessionId, currentUrl, navSeq])

  // When isActive flips true after the lifecycle parked tryOpen (because the
  // session was inactive at mount), re-trigger the open.
  useEffect(() => {
    if (isActive) tryOpenRef.current?.()
  }, [isActive])

  // ── Bounds tracking ───────────────────────────────────────────────────
  // ResizeObserver + window resize for real size changes, plus a 500 ms
  // safety-net tick for parent-flex shifts (sidebar collapse, GitHub panel)
  // that fire neither. Only sends when the rect actually changed.
  useEffect(() => {
    if (!isActive || !currentUrl) return
    const el = containerRef.current
    if (!el) return
    let last: Bounds | null = null
    const report = (force = false) => {
      if (!viewReadyRef.current) return
      const next = measure()
      if (!next || next.width < 1 || next.height < 1) return
      if (!force && last && last.x === next.x && last.y === next.y && last.width === next.width && last.height === next.height) return
      last = next
      window.electronAPI.webview.setBounds(sessionId, next).catch(() => { /* noop */ })
    }
    const ro = new ResizeObserver(() => report(true))
    ro.observe(el)
    const onResize = () => report(true)
    window.addEventListener('resize', onResize)
    const tick = window.setInterval(() => report(false), 500)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onResize)
      window.clearInterval(tick)
    }
    // showFavourites changes the placeholder's height; the observer catches it.
  }, [sessionId, isActive, currentUrl, measure])

  // Show/hide on session-active changes. Without this, the WebContentsView
  // from an inactive session keeps drawing over the active session's content
  // (display:none on the React parent doesn't reach the native view layer).
  // While the freeze-annotate modal is up we ALSO force the live view hidden
  // — native WebContentsView always paints above HTML.
  useEffect(() => {
    if (!state?.isOpen || !currentUrl) return
    const visible = isActive && !frozenImage
    window.electronAPI.webview.setVisible(sessionId, visible).catch(() => { /* noop */ })
  }, [sessionId, isActive, state?.isOpen, currentUrl, frozenImage])

  if (!state || !state.isOpen) return null

  // ── Actions ───────────────────────────────────────────────────────────
  const go = (raw: string) => {
    const result = normaliseBrowserInput(raw)
    if (!result.ok) { setAddressError(result.error); return }
    setAddressError(null)
    setAddressEditing(false)
    addressRef.current?.blur()
    navigate(sessionId, result.url)
  }
  const handleAddressKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); go(address) }
    else if (e.key === 'Escape') {
      // Revert and leave the field. Stop here: the app-level Esc handler
      // closes the whole pane, and cancelling an edit is not that.
      e.preventDefault(); e.stopPropagation()
      setAddress(shownUrl); setAddressError(null); setAddressEditing(false)
      addressRef.current?.blur()
    }
  }
  const handleReload = () => { void window.electronAPI.webview.reload(sessionId) }
  const handleFreeze = async () => {
    const image = await window.electronAPI.webview.capture(sessionId)
    if (image) setFrozenImage(image)
  }
  const handleClose = () => setOpen(sessionId, false)
  const handleOpenExternal = () => { if (shownUrl) void window.electronAPI.webview.openExternal(shownUrl) }
  const handleStar = () => { if (shownUrl) toggleFavourite(shownUrl, page?.title ?? '') }
  const handleHome = () => { if (home) navigate(sessionId, home) }
  const handleSetHome = () => {
    if (!shownUrl) return
    if (configId) setConfigHome(configId, shownUrl)
    else setHomeUrl(sessionId, shownUrl)
  }
  const handleClearHome = () => {
    if (configId && persistedHome) setConfigHome(configId, null)
    setHomeUrl(sessionId, null)
  }

  const status = state.status
  const watchPill = status === 'available'
    ? { text: 'responding', cls: 'text-green border-green/40 bg-green/10', dot: 'bg-green' }
    : status === 'pending'
      ? { text: 'waiting for the page…', cls: 'text-blue border-blue/40 bg-blue/10', dot: 'bg-blue animate-pulse' }
      : status === 'failed'
        ? { text: 'no answer', cls: 'text-red border-red/40 bg-red/10', dot: 'bg-red' }
        : null

  const isHttps = shownUrl.startsWith('https:')
  const atHome = !!home && shownUrl === home

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-mantle relative" data-testid="browser-pane">
      {/* Nav row: history, address, watch state, open-externally, favourites, freeze, close. */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-surface0 bg-crust shrink-0 z-10" data-testid="browser-nav">
        <button onClick={() => window.electronAPI.webview.navBack(sessionId)} disabled={!page?.canGoBack} className={`${toolBtn} ${toolBtnIdle}`} title="Back" data-testid="browser-back">{Icon.back}</button>
        <button onClick={() => window.electronAPI.webview.navForward(sessionId)} disabled={!page?.canGoForward} className={`${toolBtn} ${toolBtnIdle}`} title="Forward" data-testid="browser-forward">{Icon.forward}</button>
        <button onClick={handleReload} disabled={!currentUrl} className={`${toolBtn} ${toolBtnIdle}`} title="Hard refresh" data-testid="browser-reload">{Icon.reload}</button>
        <button
          onClick={handleHome}
          disabled={!home}
          className={`${toolBtn} ${atHome ? 'text-blue' : toolBtnIdle}`}
          title={home ? `Home: ${home}` : 'No home page yet — open the favourites bar to set one'}
          data-testid="browser-home"
        >
          {Icon.home}
        </button>

        <div className="flex-1 min-w-0 flex flex-col">
          <div
            className={`flex items-center gap-1.5 px-2 h-6 rounded border bg-surface0/70 ${addressError ? 'border-red' : 'border-surface1 focus-within:border-blue'}`}
          >
            <span className={`shrink-0 ${isHttps ? 'text-green' : 'text-overlay0'}`} title={isHttps ? 'https' : shownUrl ? 'http — not encrypted' : ''}>
              {shownUrl ? Icon.lock : Icon.globe}
            </span>
            <input
              ref={addressRef}
              type="text"
              value={address}
              onChange={(e) => { setAddress(e.target.value); if (addressError) setAddressError(null) }}
              onFocus={() => setAddressEditing(true)}
              onBlur={() => { setAddressEditing(false); setAddress(shownUrl) }}
              onKeyDown={handleAddressKey}
              placeholder="Type an address — localhost:5173, example.com"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 min-w-0 bg-transparent outline-none font-mono text-[11px] text-text placeholder:text-overlay0"
              aria-label="Address"
              aria-invalid={!!addressError}
              data-testid="browser-address"
            />
            {page?.loading && <span className="text-[10px] text-overlay0 shrink-0">loading…</span>}
          </div>
          {addressError && <div className="text-[10px] text-red mt-0.5 px-1" role="alert" data-testid="browser-address-error">{addressError}</div>}
        </div>

        {watchPill && (
          <span className={`flex items-center gap-1 px-1.5 h-5 rounded-full border text-[10px] shrink-0 ${watchPill.cls}`} title={state.watchUrl ? `Watching ${state.watchUrl}` : undefined} data-testid="browser-watch">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${watchPill.dot}`} aria-hidden />
            {watchPill.text}
          </span>
        )}

        <button onClick={handleStar} disabled={!shownUrl} className={`${toolBtn} ${isFav ? 'text-yellow' : toolBtnIdle}`} title={isFav ? 'Remove from favourites' : 'Save to favourites'} aria-pressed={isFav} data-testid="browser-star">{Icon.star(isFav)}</button>
        <button
          onClick={() => setShowFavourites((v) => !v)}
          className={`${toolBtn} ${showFavourites ? 'text-text bg-surface0' : toolBtnIdle} text-[11px]`}
          title={showFavourites ? 'Hide the favourites bar' : 'Show the favourites bar'}
          aria-expanded={showFavourites}
          data-testid="browser-favourites-toggle"
        >
          Favourites{favourites.length > 0 ? ` ${favourites.length}` : ''}
        </button>
        <button onClick={handleOpenExternal} disabled={!shownUrl} className={`${toolBtn} ${toolBtnIdle}`} title="Open in your real browser" data-testid="browser-open-external">{Icon.external}</button>
        <div className="w-px h-4 bg-surface1 mx-0.5" />
        <button onClick={handleFreeze} disabled={!currentUrl} className="px-2 py-0.5 text-xs rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-surface1 hover:text-text transition-colors disabled:opacity-35" title="Freeze + annotate with Excalidraw">Freeze</button>
        <button onClick={handleClose} className="px-2 py-0.5 text-xs rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-surface1 hover:text-text transition-colors" title="Back to the terminal" data-testid="browser-close">Close</button>
      </div>

      {/* Favourites bar -- a ROW, so it pushes the native view down instead
          of dropping a menu over it that the view would paint on top of. */}
      {showFavourites && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-surface0 bg-crust/80 shrink-0 overflow-x-auto" data-testid="browser-favourites-bar">
          {favourites.length === 0 && (
            <span className="text-[10px] text-overlay0">No favourites yet — press the star on a page you want to keep.</span>
          )}
          {favourites.map((f) => (
            <span key={f.id} className="group inline-flex items-center gap-1 pl-2 pr-1 h-5 rounded border border-surface1 bg-surface0/60 text-[10px] text-overlay1 hover:text-text hover:bg-surface1 shrink-0" title={f.url}>
              <button onClick={() => navigate(sessionId, f.url)} className="truncate max-w-[180px] focus-ring" data-testid="browser-favourite">{f.title || shortUrlLabel(f.url)}</button>
              <button onClick={() => removeFavourite(f.id)} className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-overlay0 hover:text-red px-0.5" aria-label={`Remove favourite ${f.title || shortUrlLabel(f.url)}`}>{Icon.close}</button>
            </span>
          ))}
          <span className="flex-1" />
          {home ? (
            <span className="inline-flex items-center gap-1 pl-1.5 pr-1 h-5 rounded border border-surface1 text-[10px] text-overlay1 shrink-0" title={home} data-testid="browser-home-chip">
              {Icon.home}
              <span className="truncate max-w-[160px]">Home: {shortUrlLabel(home)}</span>
              {!atHome && shownUrl && (
                <button onClick={handleSetHome} className="ml-1 text-blue hover:underline" data-testid="browser-set-home">use this page</button>
              )}
              <button onClick={handleClearHome} className="text-overlay0 hover:text-red px-0.5" aria-label="Clear home page">{Icon.close}</button>
            </span>
          ) : (
            <button onClick={handleSetHome} disabled={!shownUrl} className={`${toolBtn} ${toolBtnIdle} text-[10px] flex items-center gap-1 shrink-0`} title={configId ? 'Sessions from this config will open the browser here' : 'This session will open the browser here'} data-testid="browser-set-home">
              {Icon.home} Set as home
            </button>
          )}
        </div>
      )}

      {currentUrl ? (
        // Placeholder for the WebContentsView — the main process attaches a
        // real Chrome view at this rectangle. We just reserve space.
        <div ref={containerRef} className="flex-1 min-h-0 bg-crust" data-testid="browser-viewport" />
      ) : (
        <StartPage
          favourites={favourites}
          home={home}
          onGo={go}
          onOpenFavourite={(url) => navigate(sessionId, url)}
          onRemoveFavourite={removeFavourite}
          error={addressError}
        />
      )}

      {/* Always-visible escape hatch overlay. The native WebContentsView
          draws on top of any HTML below the toolbar, so if anything goes
          wrong with bounds the user can still get out from here. Pinned
          bottom-right with a high z-index — the native view can't cover it
          because it's outside the placeholder bounds. */}
      {currentUrl && (
        <button
          onClick={handleClose}
          className="absolute right-2 bottom-2 z-20 px-2 py-1 text-[11px] rounded-full bg-red/80 text-crust shadow-lg hover:bg-red transition-colors"
          title="Force-close the browser pane"
        >
          ✕ back to terminal
        </button>
      )}
      {frozenImage && (
        <Suspense fallback={null}>
          <ExcalidrawModal backgroundImage={frozenImage} onClose={() => setFrozenImage(null)} />
        </Suspense>
      )}
    </div>
  )
}

/**
 * What the pane shows before it has a page: a place to type, the home page
 * if there is one, the favourites, and a line on the other doors in. Nothing
 * native is drawn here, so this is plain HTML and can be anything.
 */
function StartPage(props: {
  favourites: { id: string; url: string; title: string }[]
  home: string | null
  onGo: (raw: string) => void
  onOpenFavourite: (url: string) => void
  onRemoveFavourite: (id: string) => void
  error: string | null
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  return (
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center px-6 py-8" data-testid="browser-start">
      <div className="w-full max-w-[520px]">
        <div className="flex items-center gap-2 mb-1 text-text">
          <span className="text-overlay1">{Icon.globe}</span>
          <h2 className="text-base font-semibold">Browser</h2>
        </div>
        <p className="text-xs text-overlay1 mb-4">A page of your own, beside the terminal. Type an address, or pick a favourite.</p>
        <form
          onSubmit={(e) => { e.preventDefault(); props.onGo(value) }}
          className="flex items-center gap-2"
        >
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="localhost:5173, example.com, https://…"
            spellCheck={false}
            autoComplete="off"
            className={`flex-1 min-w-0 px-3 h-8 bg-surface0 text-text text-sm rounded border outline-none font-mono ${props.error ? 'border-red' : 'border-surface1 focus:border-blue'}`}
            aria-label="Address"
            data-testid="browser-start-address"
          />
          <button type="submit" className="px-3 h-8 text-sm bg-blue text-crust rounded hover:bg-blue/80" data-testid="browser-start-go">Open</button>
        </form>
        {props.error && <p className="mt-1 text-[11px] text-red" role="alert">{props.error}</p>}

        {props.home && (
          <button
            onClick={() => props.onOpenFavourite(props.home!)}
            className="mt-4 w-full flex items-center gap-2 px-3 py-2 rounded border border-surface1 bg-surface0/50 hover:bg-surface0 text-left focus-ring"
            data-testid="browser-start-home"
          >
            <span className="text-blue">{Icon.home}</span>
            <span className="text-xs text-text truncate">{shortUrlLabel(props.home)}</span>
            <span className="ml-auto text-[10px] text-overlay0">home</span>
          </button>
        )}

        {props.favourites.length > 0 && (
          <div className="mt-4">
            <div className="text-[10px] uppercase tracking-wide text-overlay0 mb-1.5">Favourites</div>
            <div className="flex flex-col gap-1">
              {props.favourites.map((f) => (
                <div key={f.id} className="group flex items-center gap-2 px-3 py-1.5 rounded border border-surface1 bg-surface0/40 hover:bg-surface0" title={f.url}>
                  <button onClick={() => props.onOpenFavourite(f.url)} className="flex-1 min-w-0 text-left focus-ring" data-testid="browser-start-favourite">
                    <div className="text-xs text-text truncate">{f.title || shortUrlLabel(f.url)}</div>
                    {f.title && <div className="text-[10px] text-overlay0 truncate font-mono">{shortUrlLabel(f.url)}</div>}
                  </button>
                  <button onClick={() => props.onRemoveFavourite(f.id)} className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-overlay0 hover:text-red px-1" aria-label={`Remove favourite ${f.title || shortUrlLabel(f.url)}`}>{Icon.close}</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="mt-6 text-[10px] text-overlay0 leading-relaxed">
          A command button can point the browser at a page too: tick <span className="text-subtext0">Watch for a page</span> on a
          command that starts a server, or make an <span className="text-subtext0">Open a page</span> button. Pages open here in a
          sandbox with every permission off; for anything that needs more, use <span className="text-subtext0">open in your real browser</span>.
        </p>
      </div>
    </div>
  )
}
