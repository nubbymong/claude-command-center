import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Excalidraw, exportToBlob } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useExcalidrawStore, ExcalidrawDrawing } from '../stores/excalidrawStore'
import { useResolvedTheme } from '../hooks/useThemeController'

interface Props {
  sessionId: string
}

/**
 * Per-session Excalidraw scratchpad — replaces the prior fixed-overlay
 * modal. Lives in the same content area as Claude/Partner/Webview so
 * it never covers the full app window.
 *
 * Layout: collapsible drawing list on the left, canvas on the right,
 * toolbar across the top with name/rename/save indicator/copy/close.
 *
 * Autosave: every onChange from the Excalidraw component triggers a
 * debounced persist via the store. Indicator in the toolbar shows
 * "Saving…" → "Saved" → idle.
 */
export default function ExcalidrawPane({ sessionId }: Props) {
  const state = useExcalidrawStore((s) => s.bySessionId[sessionId])
  const togglePane = useExcalidrawStore((s) => s.togglePane)
  const newDrawing = useExcalidrawStore((s) => s.newDrawing)
  const selectDrawing = useExcalidrawStore((s) => s.selectDrawing)
  const renameDrawing = useExcalidrawStore((s) => s.renameDrawing)
  const deleteDrawing = useExcalidrawStore((s) => s.deleteDrawing)
  const updateScene = useExcalidrawStore((s) => s.updateScene)
  const resolvedTheme = useResolvedTheme()

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const savedFlashTimerRef = useRef<number | null>(null)
  const copyResetTimerRef = useRef<number | null>(null)

  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')

  // Auto-create a first drawing when the pane opens with no library.
  useEffect(() => {
    if (state && state.drawings.length === 0) {
      newDrawing(sessionId)
    }
  }, [sessionId, state, newDrawing])

  const activeDrawing: ExcalidrawDrawing | undefined = useMemo(() => {
    if (!state) return undefined
    return state.drawings.find((d) => d.id === state.activeDrawingId)
      ?? state.drawings[0]
  }, [state])

  const initialData = useMemo(() => {
    if (!activeDrawing?.scene) return undefined
    // Excalidraw expects { elements, appState, files } — accept the
    // serialised shape we stored and pass it through.
    return activeDrawing.scene as never
  }, [activeDrawing])

  // Autosave handler. Excalidraw fires onChange on every micro-event
  // (pointer move while drawing, etc.) so we can't write to the store
  // on each tick — that would trigger a Zustand re-render storm AND
  // a JSON.stringify on the full scene to dirty-check, which can be
  // megabytes for a busy whiteboard. The pane debounces store updates
  // (300 ms idle); the store itself then debounces disk persistence
  // (400 ms inside excalidrawStore). Combined latency is "300 ms
  // after last edit → React state, then ~400 ms → disk", which matches
  // user expectation of "I stopped editing, it's saved".
  //
  // No more JSON.stringify dirty-check — Excalidraw bumps versionNonce
  // on every fire so the equality test almost always missed and just
  // burned CPU on the serialisation.
  const handleSceneChange = (elements: unknown, appState: unknown, files: unknown) => {
    if (!activeDrawing) return
    const scene = { elements, appState, files }
    setSaveStatus('saving')
    if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current)
    if (savedFlashTimerRef.current != null) window.clearTimeout(savedFlashTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      updateScene(sessionId, activeDrawing.id, scene)
      setSaveStatus('saved')
      savedFlashTimerRef.current = window.setTimeout(() => setSaveStatus('idle'), 1200)
    }, 300)
  }

  // Clear pending save / saved-flash / copy-reset timers on unmount so
  // a closed pane can't fire setSaveStatus or setCopyStatus on an
  // unmounted component.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current)
      if (savedFlashTimerRef.current != null) window.clearTimeout(savedFlashTimerRef.current)
      if (copyResetTimerRef.current != null) window.clearTimeout(copyResetTimerRef.current)
    }
  }, [])

  const handleCopy = async () => {
    if (!apiRef.current) return
    if (copyResetTimerRef.current != null) window.clearTimeout(copyResetTimerRef.current)
    setCopyStatus('copying')
    try {
      const elements = apiRef.current.getSceneElements()
      const appState = apiRef.current.getAppState()
      const files = apiRef.current.getFiles()
      const blob = await exportToBlob({
        elements,
        appState: { ...appState, exportBackground: true, viewBackgroundColor: '#ffffff' },
        files,
        mimeType: 'image/png',
      })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      setCopyStatus('copied')
      copyResetTimerRef.current = window.setTimeout(() => setCopyStatus('idle'), 1500)
    } catch (err) {
      console.error('[ExcalidrawPane] copy failed', err)
      setCopyStatus('failed')
      copyResetTimerRef.current = window.setTimeout(() => setCopyStatus('idle'), 2000)
    }
  }

  const handleStartRename = (drawing: ExcalidrawDrawing) => {
    setRenaming(drawing.id)
    setRenameValue(drawing.name)
  }

  const handleConfirmRename = () => {
    if (renaming) renameDrawing(sessionId, renaming, renameValue)
    setRenaming(null)
    setRenameValue('')
  }

  const handleNewDrawing = () => {
    const id = newDrawing(sessionId)
    selectDrawing(sessionId, id)
    // Excalidraw's initialData is captured on mount; switching id forces
    // a remount via the key prop on <Excalidraw />.
  }

  const handleClose = () => togglePane(sessionId)

  if (!state || !state.isOpen) return null

  const copyLabel =
    copyStatus === 'copying' ? 'Copying…' :
    copyStatus === 'copied' ? 'Copied' :
    copyStatus === 'failed' ? 'Copy failed' :
    'Copy'

  const saveLabel =
    saveStatus === 'saving' ? 'Saving…' :
    saveStatus === 'saved' ? 'Saved' :
    ''

  return (
    <div className="flex-1 flex flex-row min-h-0 bg-mantle">
      {/* Drawing library — collapsible left rail. */}
      <div className="w-44 shrink-0 flex flex-col border-r border-surface0 bg-crust">
        <div className="flex items-center gap-1 px-2 py-1 border-b border-surface0 shrink-0">
          <span className="text-[11px] text-overlay0 flex-1">Drawings</span>
          <button
            onClick={handleNewDrawing}
            className="px-1.5 py-0.5 text-[11px] rounded text-overlay1 hover:text-text hover:bg-surface0"
            title="New drawing"
          >
            +
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {state.drawings.length === 0 ? (
            <div className="text-[11px] text-overlay0 px-2 py-2">No drawings yet.</div>
          ) : (
            state.drawings.map((d) => {
              const isActive = d.id === activeDrawing?.id
              const isRenaming = renaming === d.id
              return (
                <div
                  key={d.id}
                  className={`group flex items-center px-2 py-1 cursor-pointer transition-colors ${
                    isActive ? 'bg-surface0' : 'hover:bg-surface0/60'
                  }`}
                  onClick={() => !isRenaming && selectDrawing(sessionId, d.id)}
                  onDoubleClick={() => handleStartRename(d)}
                >
                  {isRenaming ? (
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); handleConfirmRename() }
                        if (e.key === 'Escape') { setRenaming(null); setRenameValue('') }
                      }}
                      onBlur={handleConfirmRename}
                      autoFocus
                      className="flex-1 px-1 py-0.5 text-[11px] bg-surface1 text-text rounded border border-blue outline-none"
                    />
                  ) : (
                    <>
                      <span className={`flex-1 text-[11px] truncate ${isActive ? 'text-text' : 'text-subtext0'}`}>
                        {d.name}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleStartRename(d) }}
                        className="opacity-0 group-hover:opacity-100 text-[10px] text-overlay0 hover:text-text px-1"
                        title="Rename"
                      >
                        ✎
                      </button>
                      {state.drawings.length > 1 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            if (confirm(`Delete "${d.name}"?`)) deleteDrawing(sessionId, d.id)
                          }}
                          className="opacity-0 group-hover:opacity-100 text-[10px] text-overlay0 hover:text-red px-1"
                          title="Delete"
                        >
                          ×
                        </button>
                      )}
                    </>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* Canvas + toolbar. */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-surface0 bg-crust shrink-0">
          <span className="text-xs font-medium text-text truncate" title={activeDrawing?.name || ''}>
            {activeDrawing?.name || 'No drawing'}
          </span>
          {saveLabel && (
            <span className={`text-[10px] ${saveStatus === 'saved' ? 'text-green' : 'text-overlay0'}`}>
              {saveLabel}
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={handleCopy}
            disabled={copyStatus === 'copying' || !activeDrawing}
            className={`px-2.5 py-0.5 text-xs rounded border transition-colors ${
              copyStatus === 'copied'
                ? 'border-green/60 bg-green/10 text-green'
                : copyStatus === 'failed'
                ? 'border-red/60 bg-red/10 text-red'
                : 'border-surface1 bg-surface0 text-overlay1 hover:bg-surface1 hover:text-text'
            } disabled:opacity-50`}
            title="Copy current drawing as PNG"
          >
            {copyLabel}
          </button>
          <button
            onClick={handleClose}
            className="px-2.5 py-0.5 text-xs rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-surface1 hover:text-text transition-colors"
            title="Close Excalidraw pane"
          >
            Close
          </button>
        </div>
        <div className="flex-1 min-h-0 relative">
          {activeDrawing ? (
            <Excalidraw
              key={activeDrawing.id}
              excalidrawAPI={(api) => { apiRef.current = api }}
              theme={resolvedTheme}
              initialData={initialData}
              onChange={handleSceneChange}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-overlay0 text-sm">
              Click "+" in the sidebar to start a new drawing.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
