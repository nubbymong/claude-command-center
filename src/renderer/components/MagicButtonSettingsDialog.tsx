import React, { useState } from 'react'
import { useMagicButtonStore, MagicButtonSettings } from '../stores/magicButtonStore'
import { COLOR_SWATCHES } from './SessionDialog'

interface Props {
  onClose: () => void
}

export default function MagicButtonSettingsDialog({ onClose }: Props) {
  const { settings, updateSettings } = useMagicButtonStore()
  const [color, setColor] = useState(settings.screenshotColor)
  const [autoDelete, setAutoDelete] = useState(settings.autoDeleteDays != null)
  const [days, setDays] = useState(settings.autoDeleteDays ?? 7)

  const handleSave = () => {
    updateSettings({
      screenshotColor: color,
      autoDeleteDays: autoDelete ? days : null
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-mantle border border-surface0 rounded-lg shadow-xl p-5 w-[380px]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-text mb-4">Screenshot Settings</h2>

        <div className="space-y-4">
          {/* Color picker */}
          <div>
            <label className="block text-xs text-subtext0 mb-1.5">Button Color</label>
            <div className="flex flex-wrap gap-1.5">
              {COLOR_SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`w-7 h-7 rounded-md border-2 transition-all ${
                    color === c ? 'border-text scale-110' : 'border-transparent hover:border-overlay0'
                  }`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
          </div>

          {/* Auto-delete */}
          <div>
            <label className="flex items-center gap-2 text-sm text-subtext0 cursor-pointer">
              <input
                type="checkbox"
                checked={autoDelete}
                onChange={(e) => setAutoDelete(e.target.checked)}
                className="rounded border-surface1"
              />
              Auto-delete old screenshots
            </label>
            {autoDelete && (
              <div className="flex items-center gap-2 mt-2 ml-6">
                <span className="text-xs text-overlay1">After</span>
                <input
                  type="number"
                  value={days}
                  onChange={(e) => setDays(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-16 px-2 py-1 bg-surface0 text-text text-sm rounded border border-surface1 outline-none focus:border-blue"
                  min={1}
                  max={365}
                />
                <span className="text-xs text-overlay1">days</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-surface0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-sm text-overlay1 hover:text-text rounded hover:bg-surface0"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="px-4 py-1.5 text-sm bg-blue text-crust rounded hover:bg-blue/80"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
