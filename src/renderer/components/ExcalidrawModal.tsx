import React, { useRef, useState } from 'react'
import { Excalidraw, exportToBlob } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useResolvedTheme } from '../hooks/useThemeController'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { DialogButton } from './ui/Dialog'

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
  // Canvas background must be a concrete colour (Excalidraw paints a <canvas>,
  // not CSS), so resolve the live theme surface token rather than hardcoding a
  // dark-only palette value. Falls back to per-theme defaults if the var is
  // missing (e.g. SSR/tests).
  const canvasBg =
    (typeof window !== 'undefined'
      ? getComputedStyle(document.documentElement).getPropertyValue('--surface-stage').trim()
      : '') || (resolvedTheme === 'light' ? '#e8ecf3' : '#171e27')
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

  // The copy button flashes the outcome. Success/failure are the house tinted
  // status fills; idle falls through to the DialogButton `secondary` look.
  const tinted = (token: string): React.CSSProperties => ({
    background: `color-mix(in srgb, ${token} 16%, transparent)`,
    color: token,
    border: `1px solid color-mix(in srgb, ${token} 40%, transparent)`,
  })
  const copyStyle =
    copyStatus === 'copied' ? tinted('var(--status-success)') :
    copyStatus === 'failed' ? tinted('var(--status-danger)') :
    undefined

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex flex-col backdrop-blur-sm"
      style={{ background: 'color-mix(in srgb, var(--surface-sunken) 95%, transparent)' }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex items-center gap-3 px-4 py-2 shrink-0"
        style={{ background: 'var(--surface-raised)', borderBottom: '1px solid var(--border-subtle)' }}
      >
        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Excalidraw</span>
        {backgroundImage && (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Annotating frozen webview snapshot</span>
        )}
        <div className="flex-1" />
        <DialogButton
          onClick={handleCopy}
          disabled={copyStatus === 'copying'}
          style={copyStyle}
        >
          {buttonLabel}
        </DialogButton>
        <DialogButton onClick={onClose}>
          Close
        </DialogButton>
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
            appState: { viewBackgroundColor: canvasBg, exportBackground: true } as never,
          } : undefined}
        />
      </div>
    </div>
  )
}
