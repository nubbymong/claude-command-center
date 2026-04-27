import React, { useRef, useState } from 'react'
import { Excalidraw, exportToBlob } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useResolvedTheme } from '../hooks/useThemeController'
import { useFocusTrap } from '../hooks/useFocusTrap'

interface Props {
  /**
   * Optional background image to render below the drawing canvas.
   * Used by the webview-freeze flow: the user freezes a page, we
   * pass the captured PNG here, then they annotate over it before
   * copying. Plain scratch mode passes nothing.
   */
  backgroundImage?: string | null
  onClose: () => void
}

export default function ExcalidrawModal({ backgroundImage, onClose }: Props) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const copyResetTimerRef = useRef<number | null>(null)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const resolvedTheme = useResolvedTheme()
  // Trap focus inside the modal so keyboard users can't tab into the
  // underlying app while annotating. Also handles Escape → close, so
  // we don't need a separate document keydown listener — `useFocusTrap`
  // owns both concerns the same way it does in the GitHub onboarding
  // / config modals.
  useFocusTrap(dialogRef, true, onClose)

  // Clear any pending copy-status reset on unmount so a quick close
  // after pressing Copy doesn't fire setState on an unmounted component.
  React.useEffect(() => () => {
    if (copyResetTimerRef.current != null) window.clearTimeout(copyResetTimerRef.current)
  }, [])

  const handleCopy = async () => {
    const api = apiRef.current
    if (!api) return
    if (copyResetTimerRef.current != null) window.clearTimeout(copyResetTimerRef.current)
    setCopyStatus('copying')
    try {
      const elements = api.getSceneElements()
      const appState = api.getAppState()
      const files = api.getFiles()
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
      console.error('[Excalidraw] copy to clipboard failed', err)
      setCopyStatus('failed')
      copyResetTimerRef.current = window.setTimeout(() => setCopyStatus('idle'), 2000)
    }
  }

  const buttonLabel =
    copyStatus === 'copying' ? 'Copying…' :
    copyStatus === 'copied' ? 'Copied' :
    copyStatus === 'failed' ? 'Copy failed' :
    'Copy to clipboard'

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex flex-col bg-crust/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex items-center gap-3 px-4 py-2 border-b border-surface0 bg-mantle shrink-0">
        <span className="text-sm font-medium text-text">Excalidraw</span>
        {backgroundImage && (
          <span className="text-[11px] text-overlay0">Annotating frozen webview snapshot</span>
        )}
        <div className="flex-1" />
        <button
          onClick={handleCopy}
          disabled={copyStatus === 'copying'}
          className={`px-3 py-1 text-xs rounded border transition-colors ${
            copyStatus === 'copied'
              ? 'border-green/60 bg-green/10 text-green'
              : copyStatus === 'failed'
              ? 'border-red/60 bg-red/10 text-red'
              : 'border-surface1 bg-surface0 text-text hover:bg-surface1'
          } disabled:opacity-50`}
        >
          {buttonLabel}
        </button>
        <button
          onClick={onClose}
          className="px-3 py-1 text-xs rounded border border-surface1 bg-surface0 text-text hover:bg-surface1 transition-colors"
        >
          Close
        </button>
      </div>
      <div className="flex-1 min-h-0 relative">
        <Excalidraw
          excalidrawAPI={(api) => { apiRef.current = api }}
          theme={resolvedTheme}
          initialData={backgroundImage ? {
            elements: [{
              id: 'frozen-bg',
              type: 'image',
              x: 0, y: 0, width: 1280, height: 720,
              angle: 0,
              strokeColor: 'transparent',
              backgroundColor: 'transparent',
              fillStyle: 'solid',
              strokeWidth: 1,
              strokeStyle: 'solid',
              roughness: 0,
              opacity: 100,
              groupIds: [],
              frameId: null,
              roundness: null,
              seed: 1,
              version: 1,
              versionNonce: 1,
              isDeleted: false,
              boundElements: null,
              updated: Date.now(),
              link: null,
              locked: true,
              fileId: 'frozen' as never,
              status: 'saved',
              scale: [1, 1],
              index: 'a0' as never,
            }] as never,
            files: {
              frozen: {
                mimeType: 'image/png',
                id: 'frozen' as never,
                dataURL: backgroundImage as never,
                created: Date.now(),
              },
            } as never,
            appState: { viewBackgroundColor: resolvedTheme === 'light' ? '#eff1f5' : '#1e1e2e', exportBackground: true } as never,
          } : undefined}
        />
      </div>
    </div>
  )
}
