import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../../stores/sessionStore'
import type { PaneComponentProps } from './PaneRegistry'

function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
  } catch {
    return false
  }
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return ['http:', 'https:', 'file:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

const ARROW_LEFT = String.fromCodePoint(0x2190)
const ARROW_RIGHT = String.fromCodePoint(0x2192)
const REFRESH = String.fromCodePoint(0x21BB)
const EXTERNAL = String.fromCodePoint(0x2197)

export default function PreviewPane({ paneId, paneType, sessionId, isActive, props }: PaneComponentProps) {
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId))

  const initialUrl = (props?.url as string) || ''
  const [urlInput, setUrlInput] = useState(initialUrl)
  const [currentUrl, setCurrentUrl] = useState(initialUrl)
  const [history, setHistory] = useState<string[]>(initialUrl ? [initialUrl] : [])
  const [historyIndex, setHistoryIndex] = useState(initialUrl ? 0 : -1)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [externalWarning, setExternalWarning] = useState<string | null>(null)

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const historyIndexRef = useRef(historyIndex)
  historyIndexRef.current = historyIndex

  const navigateTo = useCallback((url: string) => {
    if (!isValidUrl(url)) {
      setError('Invalid URL. Must be http://, https://, or file://')
      return
    }

    // Non-localhost http/https: show warning
    if ((url.startsWith('http://') || url.startsWith('https://')) && !isLocalUrl(url)) {
      setExternalWarning(url)
      return
    }

    setError(null)
    setExternalWarning(null)
    setIsLoading(true)
    setCurrentUrl(url)
    setUrlInput(url)

    setHistory((prev) => {
      const newHistory = prev.slice(0, historyIndexRef.current + 1)
      newHistory.push(url)
      return newHistory
    })
    setHistoryIndex((prev) => prev + 1)
  }, [])

  // Sync props.url changes
  useEffect(() => {
    const newUrl = (props?.url as string) || ''
    if (newUrl && newUrl !== currentUrl) {
      navigateTo(newUrl)
    }
  }, [props?.url, navigateTo, currentUrl])

  // Listen for dev server detection
  useEffect(() => {
    const unsub = window.electronAPI.preview.onDevServerDetected((detectedSessionId, url) => {
      if (detectedSessionId === sessionId && !currentUrl) {
        navigateTo(url)
      }
    })
    return unsub
  }, [sessionId, currentUrl, navigateTo])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    let url = urlInput.trim()
    if (!url) return

    // Auto-prefix with http:// if no protocol
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
      url = 'http://' + url
      setUrlInput(url)
    }

    navigateTo(url)
  }

  const goBack = () => {
    if (historyIndex <= 0) return
    const newIndex = historyIndex - 1
    const url = history[newIndex]
    setHistoryIndex(newIndex)
    setCurrentUrl(url)
    setUrlInput(url)
    setError(null)
    setExternalWarning(null)
    setIsLoading(true)
  }

  const goForward = () => {
    if (historyIndex >= history.length - 1) return
    const newIndex = historyIndex + 1
    const url = history[newIndex]
    setHistoryIndex(newIndex)
    setCurrentUrl(url)
    setUrlInput(url)
    setError(null)
    setExternalWarning(null)
    setIsLoading(true)
  }

  const refresh = () => {
    if (!currentUrl) return
    setIsLoading(true)
    setError(null)
    if (iframeRef.current) {
      iframeRef.current.src = currentUrl
    }
  }

  const openExternal = () => {
    const url = externalWarning || currentUrl
    if (url) {
      window.electronAPI.shell.openExternal(url)
      setExternalWarning(null)
    }
  }

  const handleIframeLoad = () => {
    setIsLoading(false)
  }

  const handleIframeError = () => {
    setIsLoading(false)
    setError('Failed to load page')
  }

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-overlay0 text-sm">
        No session found
      </div>
    )
  }

  // SSH session: show port forwarding message
  if (session.sessionType === 'ssh') {
    return (
      <div className="flex items-center justify-center h-full text-overlay0 text-sm">
        <div className="text-center px-8">
          <div className="text-2xl mb-3 opacity-40">{String.fromCodePoint(0x1F310)}</div>
          <div className="text-subtext0 mb-1">Preview requires local access</div>
          <div className="text-xs">Use SSH port forwarding for remote previews.</div>
        </div>
      </div>
    )
  }

  const canGoBack = historyIndex > 0
  const canGoForward = historyIndex < history.length - 1
  const detectedUrl = (props?.detectedDevServer as string) || ''

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* URL bar */}
      <div className="flex items-center gap-1 px-2 py-1.5 bg-mantle border-b border-surface0 shrink-0">
        <button
          onClick={goBack}
          disabled={!canGoBack}
          className={`px-1.5 py-0.5 rounded text-sm transition-colors ${
            canGoBack ? 'text-overlay1 hover:text-text hover:bg-surface0' : 'text-surface1 cursor-not-allowed'
          }`}
          title="Back"
        >
          {ARROW_LEFT}
        </button>
        <button
          onClick={goForward}
          disabled={!canGoForward}
          className={`px-1.5 py-0.5 rounded text-sm transition-colors ${
            canGoForward ? 'text-overlay1 hover:text-text hover:bg-surface0' : 'text-surface1 cursor-not-allowed'
          }`}
          title="Forward"
        >
          {ARROW_RIGHT}
        </button>
        <button
          onClick={refresh}
          disabled={!currentUrl}
          className={`px-1.5 py-0.5 rounded text-sm transition-colors ${
            currentUrl ? 'text-overlay1 hover:text-text hover:bg-surface0' : 'text-surface1 cursor-not-allowed'
          }`}
          title="Refresh"
        >
          {REFRESH}
        </button>

        <form onSubmit={handleSubmit} className="flex-1 min-w-0">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Enter URL..."
            className="w-full bg-surface0 border border-surface1 rounded px-2 py-0.5 text-xs text-text placeholder-overlay0 outline-none focus:border-blue transition-colors"
          />
        </form>

        <button
          onClick={openExternal}
          disabled={!currentUrl && !externalWarning}
          className={`px-1.5 py-0.5 rounded text-sm transition-colors ${
            currentUrl || externalWarning ? 'text-overlay1 hover:text-text hover:bg-surface0' : 'text-surface1 cursor-not-allowed'
          }`}
          title="Open in browser"
        >
          {EXTERNAL}
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 relative overflow-hidden bg-base">
        {/* External URL warning */}
        {externalWarning && (
          <div className="absolute inset-0 flex items-center justify-center z-20 bg-base/90">
            <div className="text-center px-8 max-w-sm">
              <div className="text-2xl mb-3 opacity-60">{String.fromCodePoint(0x26A0)}</div>
              <div className="text-subtext0 text-sm mb-2">External URL</div>
              <div className="text-xs text-overlay0 mb-4 break-all">{externalWarning}</div>
              <div className="flex gap-2 justify-center">
                <button
                  onClick={openExternal}
                  className="px-3 py-1.5 rounded text-xs bg-blue text-base font-medium hover:brightness-110 transition-all"
                >
                  Open in browser
                </button>
                <button
                  onClick={() => setExternalWarning(null)}
                  className="px-3 py-1.5 rounded text-xs bg-surface0 text-subtext0 hover:text-text hover:bg-surface1 transition-all"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Error state */}
        {error && !externalWarning && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="text-center px-8">
              <div className="text-2xl mb-3 opacity-40">{String.fromCodePoint(0x26A0)}</div>
              <div className="text-red text-sm mb-1">{error}</div>
              {currentUrl && (
                <button
                  onClick={refresh}
                  className="text-xs text-overlay1 hover:text-text transition-colors mt-2"
                >
                  Try again
                </button>
              )}
            </div>
          </div>
        )}

        {/* Loading spinner */}
        {isLoading && !error && !externalWarning && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-base/80 transition-opacity">
            <div className="text-blue animate-spin text-2xl">{String.fromCodePoint(0x25E0)}</div>
          </div>
        )}

        {/* Empty state */}
        {!currentUrl && !error && !externalWarning && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center px-8">
              <div className="text-2xl mb-3 opacity-30">{String.fromCodePoint(0x25C9)}</div>
              <div className="text-overlay0 text-sm mb-1">Enter a URL or open a file to preview</div>
              {detectedUrl && (
                <button
                  onClick={() => navigateTo(detectedUrl)}
                  className="mt-3 px-3 py-1.5 rounded text-xs bg-surface0 text-teal hover:bg-surface1 transition-colors"
                >
                  Open {detectedUrl}
                </button>
              )}
            </div>
          </div>
        )}

        {/* iframe */}
        {currentUrl && !error && !externalWarning && (
          <iframe
            ref={iframeRef}
            src={currentUrl}
            sandbox="allow-scripts allow-same-origin allow-forms"
            className="w-full h-full border-none"
            onLoad={handleIframeLoad}
            onError={handleIframeError}
          />
        )}
      </div>
    </div>
  )
}
