import React, { useState } from 'react'
import { CustomCommand, CommandSection, useCommandStore } from '../stores/commandStore'
import { COLOR_SWATCHES } from './SessionDialog'
import { generateId } from '../utils/id'

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
  const [defaultArgs, setDefaultArgs] = useState<string[]>(initial?.defaultArgs || [])
  const [argInput, setArgInput] = useState('')
  const [sectionId, setSectionId] = useState<string | undefined>(initial?.sectionId)
  const [newSectionName, setNewSectionName] = useState('')
  const [showNewSection, setShowNewSection] = useState(false)
  const [webViewEnabled, setWebViewEnabled] = useState<boolean>(!!initial?.webView?.enabled)
  const [webViewUrl, setWebViewUrl] = useState(initial?.webView?.url || '')

  const { sections, addSection } = useCommandStore()
  const visibleSections = sections.filter(
    (s) => s.scope === 'global' || (s.scope === 'config' && s.configId === configId)
  )

  const handleAddArg = () => {
    const arg = argInput.trim()
    if (arg && !defaultArgs.includes(arg)) {
      setDefaultArgs([...defaultArgs, arg])
      setArgInput('')
    }
  }

  const handleRemoveArg = (idx: number) => {
    setDefaultArgs(defaultArgs.filter((_, i) => i !== idx))
  }

  const handleArgKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddArg()
    }
  }

  const handleCreateSection = () => {
    const name = newSectionName.trim()
    if (!name) return
    const newSection: CommandSection = {
      id: generateId(),
      name,
      scope,
      configId: scope === 'config' ? configId : undefined,
    }
    addSection(newSection)
    setSectionId(newSection.id)
    setNewSectionName('')
    setShowNewSection(false)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!label.trim() || !prompt.trim()) return
    if (webViewEnabled && !webViewUrl.trim()) return
    onConfirm({
      label: label.trim(),
      prompt: prompt.trim(),
      scope,
      configId: scope === 'config' ? configId : undefined,
      color,
      target: target === 'any' ? undefined : target,
      defaultArgs: defaultArgs.length > 0 ? defaultArgs : undefined,
      sectionId,
      webView: webViewEnabled
        ? { enabled: true, url: webViewUrl.trim() }
        : undefined,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        className="bg-mantle border border-surface0 rounded-lg shadow-xl p-5 w-[420px] max-h-[80vh] overflow-y-auto"
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
              {([['any', 'Any'], ['claude', 'Claude'], ['partner', 'Partner']] as const).map(([val, lbl]) => {
                const isActive = target === val
                return (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setTarget(val)}
                    className={`flex-1 py-1.5 text-xs rounded border transition-colors ${
                      isActive
                        ? 'bg-blue/20 border-blue text-blue'
                        : 'bg-surface0 border-surface1 text-overlay1'
                    }`}
                  >
                    {lbl}
                  </button>
                )
              })}
            </div>
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs text-subtext0 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={webViewEnabled}
                onChange={(e) => setWebViewEnabled(e.target.checked)}
                className="accent-blue"
              />
              Launch webview on completion
            </label>
            {webViewEnabled && (
              <div className="mt-1.5">
                <input
                  type="url"
                  value={webViewUrl}
                  onChange={(e) => setWebViewUrl(e.target.value)}
                  className="w-full px-3 py-1.5 bg-surface0 text-text text-sm rounded border border-surface1 outline-none focus:border-blue font-mono"
                  placeholder="https://localhost:3000"
                />
                <p className="mt-1 text-[10px] text-overlay0">
                  After the command is sent, the app polls this URL every second for up to 30 s. The webview button pulses green once content is reachable, red on timeout. The button also auto-detects if the server is already up when the app launches.
                </p>
              </div>
            )}
          </div>
          <div>
            <label className="block text-xs text-subtext0 mb-1">Arguments (for script commands)</label>
            <div className="flex flex-wrap gap-1 mb-1.5">
              {defaultArgs.map((arg, idx) => (
                <span
                  key={idx}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-surface0 text-text text-xs rounded border border-surface1 font-mono"
                >
                  {arg}
                  <button
                    type="button"
                    onClick={() => handleRemoveArg(idx)}
                    className="text-overlay0 hover:text-red ml-0.5"
                  >
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="1" y1="1" x2="7" y2="7"/><line x1="7" y1="1" x2="1" y2="7"/></svg>
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-1">
              <input
                type="text"
                value={argInput}
                onChange={(e) => setArgInput(e.target.value)}
                onKeyDown={handleArgKeyDown}
                className="flex-1 px-3 py-1.5 bg-surface0 text-text text-sm rounded border border-surface1 outline-none focus:border-blue font-mono"
                placeholder='e.g. -Background, -Port 8080, start'
              />
              <button
                type="button"
                onClick={handleAddArg}
                disabled={!argInput.trim()}
                className="px-2 py-1.5 text-xs bg-surface0 text-overlay1 hover:text-text rounded border border-surface1 hover:bg-surface1 disabled:opacity-40"
              >
                Add
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs text-subtext0 mb-1">Section</label>
            {!showNewSection ? (
              <select
                value={sectionId || ''}
                onChange={(e) => {
                  const val = e.target.value
                  if (val === '__new__') {
                    setShowNewSection(true)
                  } else {
                    setSectionId(val || undefined)
                  }
                }}
                className="w-full px-3 py-1.5 bg-surface0 text-text text-sm rounded border border-surface1 outline-none focus:border-blue"
              >
                <option value="">No section</option>
                {visibleSections.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
                <option value="__new__">+ New Section</option>
              </select>
            ) : (
              <div className="flex gap-1">
                <input
                  type="text"
                  value={newSectionName}
                  onChange={(e) => setNewSectionName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreateSection() } }}
                  className="flex-1 px-3 py-1.5 bg-surface0 text-text text-sm rounded border border-surface1 outline-none focus:border-blue"
                  placeholder="Section name"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={handleCreateSection}
                  disabled={!newSectionName.trim()}
                  className="px-2 py-1.5 text-xs bg-blue text-crust rounded hover:bg-blue/80 disabled:opacity-40"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => { setShowNewSection(false); setNewSectionName('') }}
                  className="px-2 py-1.5 text-xs text-overlay1 hover:text-text rounded hover:bg-surface0"
                >
                  Cancel
                </button>
              </div>
            )}
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
