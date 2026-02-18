import React, { useState, useRef, useEffect } from 'react'
import { useConfigStore } from '../stores/configStore'
import { useCloudAgentStore } from '../stores/cloudAgentStore'

interface Props {
  onClose: () => void
}

export default function NewAgentDialog({ onClose }: Props) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [selectedConfigId, setSelectedConfigId] = useState<string>('')
  const configs = useConfigStore(s => s.configs)
  const dispatch = useCloudAgentStore(s => s.dispatch)
  const nameRef = useRef<HTMLInputElement>(null)

  // Filter to local configs only
  const localConfigs = configs.filter(c => c.sessionType === 'local')

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  // When a config is selected, set the project path
  const handleConfigSelect = (configId: string) => {
    setSelectedConfigId(configId)
    if (configId) {
      const config = localConfigs.find(c => c.id === configId)
      if (config) setProjectPath(config.workingDirectory)
    }
  }

  const handleBrowse = async () => {
    const path = await window.electronAPI.dialog.openFolder()
    if (path) {
      setProjectPath(path)
      setSelectedConfigId('')
    }
  }

  const handleDispatch = async () => {
    if (!name.trim() || !description.trim() || !projectPath.trim()) return
    const selectedConfig = selectedConfigId ? localConfigs.find(c => c.id === selectedConfigId) : undefined
    await dispatch({
      name: name.trim(),
      description: description.trim(),
      projectPath: projectPath.trim(),
      configId: selectedConfigId || undefined,
      legacyVersion: selectedConfig?.legacyVersion,
    })
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    if (e.key === 'Enter' && e.ctrlKey) handleDispatch()
  }

  return (
    <div className="absolute inset-0 bg-base/80 z-50 flex items-center justify-center" onKeyDown={handleKeyDown}>
      <div className="bg-surface0 border border-surface1 rounded-lg shadow-2xl p-6 w-full max-w-lg mx-4">
        <h2 className="text-lg font-semibold text-text mb-4">New Cloud Agent</h2>

        {/* Task name */}
        <div className="mb-3">
          <label className="block text-xs text-subtext0 mb-1">Task Name</label>
          <input
            ref={nameRef}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Auth Refactor"
            className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 outline-none focus:border-blue"
          />
        </div>

        {/* Task description (the prompt) */}
        <div className="mb-3">
          <label className="block text-xs text-subtext0 mb-1">Task Description (Prompt)</label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Describe what the agent should do..."
            rows={4}
            className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 outline-none focus:border-blue resize-none"
          />
        </div>

        {/* Project picker */}
        <div className="mb-4">
          <label className="block text-xs text-subtext0 mb-1">Project Directory</label>
          <div className="flex gap-2">
            <select
              value={selectedConfigId}
              onChange={e => handleConfigSelect(e.target.value)}
              className="flex-1 bg-base border border-surface1 rounded px-3 py-2 text-sm text-text outline-none focus:border-blue"
            >
              <option value="">Select a config...</option>
              {localConfigs.map(c => (
                <option key={c.id} value={c.id}>{c.label} - {c.workingDirectory}</option>
              ))}
            </select>
            <button
              onClick={handleBrowse}
              className="px-3 py-2 rounded bg-surface1 hover:bg-surface2 text-text text-sm transition-colors shrink-0"
            >
              Browse
            </button>
          </div>
          {projectPath && (
            <div className="mt-1 text-xs text-overlay0 truncate">{projectPath}</div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded bg-surface1 hover:bg-surface2 text-text transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleDispatch}
            disabled={!name.trim() || !description.trim() || !projectPath.trim()}
            className="px-4 py-2 text-sm font-medium rounded bg-blue hover:bg-blue/80 text-crust transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Dispatch Agent
          </button>
        </div>

        <div className="mt-2 text-[10px] text-overlay0 text-center">Ctrl+Enter to dispatch</div>
      </div>
    </div>
  )
}
