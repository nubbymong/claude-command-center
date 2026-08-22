import React, { useEffect, useState } from 'react'
import { DialogOverlay, DialogPanel, DialogHeader, DialogBody, DialogFooter, DialogButton, useDialogEscape } from './ui/Dialog'

interface WindowInfo {
  id: string
  name: string
  thumbnail: string
}

interface Props {
  onCapture: (sourceId: string) => void
  onCancel: () => void
}

export default function WindowPickerModal({ onCapture, onCancel }: Props) {
  const [windows, setWindows] = useState<WindowInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.electronAPI.screenshot.listWindows().then((list) => {
      setWindows(list)
      setLoading(false)
    })
  }, [])

  useDialogEscape(onCancel)

  return (
    <DialogOverlay>
      <DialogPanel width="w-[680px]" labelledBy="window-picker-title" style={{ maxHeight: '80vh' }}>
        <DialogHeader titleId="window-picker-title" title="Select Window to Capture" onClose={onCancel} />

        <DialogBody className="flex-1">
          {loading ? (
            <div className="text-center py-8" style={{ color: 'var(--text-secondary)' }}>Loading windows...</div>
          ) : windows.length === 0 ? (
            <div className="text-center py-8" style={{ color: 'var(--text-secondary)' }}>No windows found</div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {windows.map((win) => (
                <button
                  key={win.id}
                  onClick={() => onCapture(win.id)}
                  className="flex flex-col items-center gap-1.5 p-2 rounded-lg border border-[var(--border-subtle)] hover:border-[var(--brand)] hover:bg-[var(--surface-overlay)] transition-all group focus-ring"
                >
                  <img
                    src={`data:image/png;base64,${win.thumbnail}`}
                    alt={win.name}
                    className="w-full h-[90px] object-contain rounded bg-[var(--surface-sunken)]"
                  />
                  <span className="text-xs truncate w-full text-center text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">
                    {win.name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <DialogButton variant="ghost" onClick={onCancel}>
            Cancel
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
