import React, { useEffect, useState } from 'react'

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div
        className="bg-mantle border border-surface0 rounded-lg shadow-xl p-5 w-[680px] max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-text mb-4">Select Window to Capture</h2>

        {loading ? (
          <div className="text-center text-overlay1 py-8">Loading windows...</div>
        ) : windows.length === 0 ? (
          <div className="text-center text-overlay1 py-8">No windows found</div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {windows.map((win) => (
              <button
                key={win.id}
                onClick={() => onCapture(win.id)}
                className="flex flex-col items-center gap-1.5 p-2 rounded-lg border border-surface1 hover:border-blue hover:bg-surface0/50 transition-all group"
              >
                <img
                  src={`data:image/png;base64,${win.thumbnail}`}
                  alt={win.name}
                  className="w-full h-[90px] object-contain rounded bg-crust"
                />
                <span className="text-xs text-overlay1 group-hover:text-text truncate w-full text-center">
                  {win.name}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="flex justify-end pt-4 mt-4 border-t border-surface0">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 text-sm text-overlay1 hover:text-text rounded hover:bg-surface0"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
