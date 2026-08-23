import React, { useState, useEffect, useRef } from 'react'
import type { AgentTemplate, AgentModelOverride } from '../types/electron'
import { useRegistryStore } from '../stores/registryStore'
import { modelGroupsFromRegistry } from '../lib/claude-cli-options'
import {
  DialogOverlay,
  DialogPanel,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogButton,
  DIALOG_INPUT_CLASS,
  DIALOG_INPUT_STYLE,
  DIALOG_TEXTAREA_CLASS,
  DIALOG_LABEL_CLASS,
  DIALOG_LABEL_STYLE,
  DIALOG_HINT_CLASS,
  DIALOG_HINT_STYLE,
} from './ui/Dialog'

const AVAILABLE_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'Task', 'WebFetch', 'WebSearch', 'NotebookEdit', 'NotebookRead', 'TodoWrite',
]

const NAME_REGEX = /^[a-z][a-z0-9-]*$/

/** Placeholder colour: the shared field classes style the value, not the hint. */
const PLACEHOLDER_CLASS = ' placeholder:text-[var(--text-muted)]'

interface Props {
  initial?: AgentTemplate
  onSave: (template: Omit<AgentTemplate, 'id'>) => void
  onCancel: () => void
}

export default function AgentTemplateDialog({ initial, onSave, onCancel }: Props) {
  const registry = useRegistryStore((s) => s.registry)
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [prompt, setPrompt] = useState(initial?.prompt ?? '')
  const [model, setModel] = useState<AgentModelOverride>(initial?.model ?? 'inherit')
  const [tools, setTools] = useState<Set<string>>(new Set(initial?.tools ?? []))
  const [nameError, setNameError] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  // Deliberately NO useDialogEscape: this form holds an unsaved template
  // (name, prompt, tools). Escape is a reflex when leaving a textarea, and
  // discarding the draft on one keypress with no confirm is worse than not
  // having the shortcut. Cancel is the way out.

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
    <DialogOverlay dim={0.5}>
      <DialogPanel width="w-[480px]" labelledBy="agent-template-dialog-title">
        <form onSubmit={handleSubmit} className="flex flex-col min-h-0">
          <DialogHeader
            titleId="agent-template-dialog-title"
            title={initial ? 'Edit Agent Template' : 'New Agent Template'}
            onClose={onCancel}
            closeLabel="Cancel"
          />

          <DialogBody className="space-y-3">
            {/* Name */}
            <div>
              <label className={DIALOG_LABEL_CLASS} style={DIALOG_LABEL_STYLE}>Name</label>
              <input
                ref={nameRef}
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="my-agent"
                className={DIALOG_INPUT_CLASS + PLACEHOLDER_CLASS + ' font-mono'}
                style={DIALOG_INPUT_STYLE}
              />
              {nameError && <p className="text-[10px] mt-0.5" style={{ color: 'var(--status-danger)' }}>{nameError}</p>}
            </div>

            {/* Description */}
            <div>
              <label className={DIALOG_LABEL_CLASS} style={DIALOG_LABEL_STYLE}>Description (when to delegate)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="When should Claude delegate to this agent?"
                rows={2}
                className={DIALOG_TEXTAREA_CLASS + PLACEHOLDER_CLASS}
                style={DIALOG_INPUT_STYLE}
              />
            </div>

            {/* System Prompt */}
            <div>
              <label className={DIALOG_LABEL_CLASS} style={DIALOG_LABEL_STYLE}>System Prompt</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="You are a specialist in..."
                rows={6}
                className={DIALOG_TEXTAREA_CLASS + PLACEHOLDER_CLASS + ' font-mono'}
                style={DIALOG_INPUT_STYLE}
              />
            </div>

            {/* Model */}
            <div>
              <label className={DIALOG_LABEL_CLASS} style={DIALOG_LABEL_STYLE}>Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value as AgentModelOverride)}
                className={DIALOG_INPUT_CLASS}
                style={DIALOG_INPUT_STYLE}
              >
                <option value="inherit">Inherit (use session model)</option>
                {modelGroupsFromRegistry(registry).map((g) => (
                  <optgroup key={g.title} label={g.title}>
                    {g.items.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            {/* Tools */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>Allowed Tools</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={selectAllTools}
                    className="text-[10px] transition-opacity hover:opacity-80"
                    style={{ color: 'var(--brand)' }}
                  >
                    Select All
                  </button>
                  <button
                    type="button"
                    onClick={clearAllTools}
                    className="text-[10px] transition-colors hover:text-[var(--text-primary)]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Clear All
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {AVAILABLE_TOOLS.map(tool => (
                  <label
                    key={tool}
                    className="flex items-center gap-1.5 text-xs cursor-pointer px-2 py-1 rounded transition-colors hover:bg-[var(--surface-overlay)]"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    <input
                      type="checkbox"
                      checked={tools.has(tool)}
                      onChange={() => toggleTool(tool)}
                      className="rounded border-[var(--border-subtle)]"
                    />
                    <span className="font-mono text-[11px]">{tool}</span>
                  </label>
                ))}
              </div>
              <p className={DIALOG_HINT_CLASS} style={DIALOG_HINT_STYLE}>
                Empty = inherit all tools from the parent session
              </p>
            </div>
          </DialogBody>

          <DialogFooter>
            <DialogButton variant="ghost" onClick={onCancel}>Cancel</DialogButton>
            <DialogButton type="submit" variant="primary" disabled={!isValid}>
              {initial ? 'Save' : 'Create'}
            </DialogButton>
          </DialogFooter>
        </form>
      </DialogPanel>
    </DialogOverlay>
  )
}
