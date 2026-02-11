import React, { useState } from 'react'
import { CustomCommand } from '../stores/commandStore'
import { COLOR_SWATCHES } from './SessionDialog'

interface Props {
  onConfirm: (command: Omit<CustomCommand, 'id'>) => void
  onCancel: () => void
  initial?: CustomCommand
  configId?: string
}

export default function CommandDialog({ onConfirm, onCancel, initial, configId }: Props) {
  const [label, setLabel] = useState(initial?.label || '')
  const [prompt, setPrompt] = useState(initial?.prompt || '')
  const [scope, setScope] = useState<'global' | 'config'>(initial?.scope || (configId ? 'config' : 'global'))
  const [color, setColor] = useState(initial?.color || COLOR_SWATCHES[0])
  const [target, setTarget] = useState<'claude' | 'partner' | 'any'>(initial?.target || 'any')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!label.trim() || !prompt.trim()) return
    onConfirm({
      label: label.trim(),
      prompt: prompt.trim(),
      scope,
      configId: scope === 'config' ? configId : undefined,
      color,
      target: target === 'any' ? undefined : target
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div
        className="bg-mantle border border-surface0 rounded-lg shadow-xl p-5 w-[420px] max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-text mb-4">
          {initial ? 'Edit Command' : 'New Command'}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs text-subtext0 mb-1">Button Label</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full px-3 py-1.5 bg-surface0 text-text text-sm rounded border border-surface1 outline-none focus:border-blue"
              placeholder="e.g., Fix Lint"
              maxLength={20}
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs text-subtext0 mb-1">Prompt (sent to terminal)</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full px-3 py-1.5 bg-surface0 text-text text-sm rounded border border-surface1 outline-none focus:border-blue font-mono resize-none"
              rows={3}
              placeholder="e.g., Fix all lint errors and run the linter again"
            />
          </div>
          <div>
            <label className="block text-xs text-subtext0 mb-1">Scope</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setScope('global')}
                className={`flex-1 py-1.5 text-xs rounded border ${
                  scope === 'global'
                    ? 'bg-blue/20 border-blue text-blue'
                    : 'bg-surface0 border-surface1 text-overlay1'
                }`}
              >
                Global
              </button>
              {configId && (
                <button
                  type="button"
                  onClick={() => setScope('config')}
                  className={`flex-1 py-1.5 text-xs rounded border ${
                    scope === 'config'
                      ? 'bg-blue/20 border-blue text-blue'
                      : 'bg-surface0 border-surface1 text-overlay1'
                  }`}
                >
                  This Config Only
                </button>
              )}
            </div>
          </div>
          <div>
            <label className="block text-xs text-subtext0 mb-1">Target Terminal</label>
            <div className="flex gap-2">
              {([['any', 'Any'], ['claude', 'Claude'], ['partner', 'Partner']] as const).map(([val, lbl]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setTarget(val)}
                  className={`flex-1 py-1.5 text-xs rounded border ${
                    target === val
                      ? 'bg-blue/20 border-blue text-blue'
                      : 'bg-surface0 border-surface1 text-overlay1'
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-subtext0 mb-1">Color</label>
            <div className="flex gap-1.5">
              {COLOR_SWATCHES.slice(0, 16).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`w-6 h-6 rounded-full border-2 transition-all ${
                    color === c ? 'border-text scale-110' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-1.5 text-sm text-overlay1 hover:text-text rounded hover:bg-surface0"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!label.trim() || !prompt.trim()}
              className="px-4 py-1.5 text-sm bg-blue text-crust rounded hover:bg-blue/80 disabled:opacity-40"
            >
              {initial ? 'Save' : 'Add Command'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
