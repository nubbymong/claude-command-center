import React, { useState, useEffect, useRef } from 'react'
import type { AgentTemplate, AgentModelOverride } from '../types/electron'

const AVAILABLE_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'Task', 'WebFetch', 'WebSearch', 'NotebookEdit', 'NotebookRead', 'TodoWrite',
]

const NAME_REGEX = /^[a-z][a-z0-9-]*$/

interface Props {
  initial?: AgentTemplate
  onSave: (template: Omit<AgentTemplate, 'id'>) => void
  onCancel: () => void
}

export default function AgentTemplateDialog({ initial, onSave, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [prompt, setPrompt] = useState(initial?.prompt ?? '')
  const [model, setModel] = useState<AgentModelOverride>(initial?.model ?? 'inherit')
  const [tools, setTools] = useState<Set<string>>(new Set(initial?.tools ?? []))
  const [nameError, setNameError] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const handleNameChange = (value: string) => {
    const lower = value.toLowerCase().replace(/\s+/g, '-')
    setName(lower)
    if (lower && !NAME_REGEX.test(lower)) {
      setNameError('Lowercase letters, numbers, hyphens only. Must start with a letter.')
    } else {
      setNameError('')
    }
  }

  const toggleTool = (tool: string) => {
    setTools(prev => {
      const next = new Set(prev)
      if (next.has(tool)) next.delete(tool)
      else next.add(tool)
      return next
    })
  }

  const selectAllTools = () => setTools(new Set(AVAILABLE_TOOLS))
  const clearAllTools = () => setTools(new Set())

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !NAME_REGEX.test(name)) return
    if (!description.trim()) return
    if (!prompt.trim()) return

    onSave({
      name: name.trim(),
      description: description.trim(),
      prompt: prompt.trim(),
      model,
      tools: Array.from(tools),
    })
  }

  const isValid = name.trim() && NAME_REGEX.test(name) && description.trim() && prompt.trim()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <form
        onSubmit={handleSubmit}
        className="bg-surface0 rounded-lg p-6 w-[480px] shadow-2xl border border-surface1 max-h-[90vh] overflow-y-auto"
      >
        <h3 className="text-base font-semibold text-text mb-4">
          {initial ? 'Edit Agent Template' : 'New Agent Template'}
        </h3>

        <div className="space-y-3">
          {/* Name */}
          <div>
            <label className="block text-xs text-subtext0 mb-1">Name</label>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="my-agent"
              className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue font-mono"
            />
            {nameError && <p className="text-[10px] text-red mt-0.5">{nameError}</p>}
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs text-subtext0 mb-1">Description (when to delegate)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="When should Claude delegate to this agent?"
              rows={2}
              className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue resize-none"
            />
          </div>

          {/* System Prompt */}
          <div>
            <label className="block text-xs text-subtext0 mb-1">System Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="You are a specialist in..."
              rows={6}
              className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue resize-none font-mono text-xs"
            />
          </div>

          {/* Model */}
          <div>
            <label className="block text-xs text-subtext0 mb-1">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as AgentModelOverride)}
              className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-blue"
            >
              <option value="inherit">Inherit (use session model)</option>
              <option value="sonnet">Sonnet</option>
              <option value="opus">Opus</option>
              <option value="haiku">Haiku</option>
            </select>
          </div>

          {/* Tools */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-subtext0">Allowed Tools</label>
              <div className="flex gap-2">
                <button type="button" onClick={selectAllTools} className="text-[10px] text-blue hover:text-blue/80 transition-colors">Select All</button>
                <button type="button" onClick={clearAllTools} className="text-[10px] text-overlay1 hover:text-text transition-colors">Clear All</button>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {AVAILABLE_TOOLS.map(tool => (
                <label key={tool} className="flex items-center gap-1.5 text-xs text-text cursor-pointer px-2 py-1 rounded hover:bg-surface1/50 transition-colors">
                  <input
                    type="checkbox"
                    checked={tools.has(tool)}
                    onChange={() => toggleTool(tool)}
                    className="rounded border-surface1"
                  />
                  <span className="font-mono text-[11px]">{tool}</span>
                </label>
              ))}
            </div>
            <p className="text-[10px] text-overlay0 mt-1">
              Empty = inherit all tools from the parent session
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 rounded text-sm text-subtext0 hover:text-text hover:bg-surface1 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!isValid}
            className="px-4 py-1.5 rounded text-sm bg-blue text-crust font-medium hover:bg-blue/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {initial ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}
