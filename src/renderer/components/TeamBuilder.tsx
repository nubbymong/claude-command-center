import React, { useState, useEffect } from 'react'
import { useTeamStore } from '../stores/teamStore'
import { useAgentLibraryStore, BUILTIN_TEMPLATES } from '../stores/agentLibraryStore'
import type { TeamTemplate, TeamStep, TeamStepMode } from '../types/electron'

function generateStepId(): string {
  return 'ts-' + Math.random().toString(36).slice(2, 10)
}

function generateTeamId(): string {
  return 'team-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export default function TeamBuilder({ onClose }: { onClose: () => void }) {
  const editingTeam = useTeamStore(s => s.editingTeam)
  const saveTeam = useTeamStore(s => s.saveTeam)
  const allTemplates = useAgentLibraryStore(s => s.getAllTemplates())

  const [name, setName] = useState(editingTeam?.name || '')
  const [description, setDescription] = useState(editingTeam?.description || '')
  const [projectPath, setProjectPath] = useState(editingTeam?.projectPath || '')
  const [steps, setSteps] = useState<TeamStep[]>(editingTeam?.steps || [])
  const [saving, setSaving] = useState(false)

  const handleAddStep = () => {
    const defaultTemplate = allTemplates[0]
    if (!defaultTemplate) return
    setSteps([...steps, {
      id: generateStepId(),
      templateId: defaultTemplate.id,
      label: defaultTemplate.name,
      mode: 'sequential' as TeamStepMode,
    }])
  }

  const handleRemoveStep = (idx: number) => {
    setSteps(steps.filter((_, i) => i !== idx))
  }

  const handleMoveStep = (idx: number, dir: -1 | 1) => {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= steps.length) return
    const next = [...steps]
    ;[next[idx], next[newIdx]] = [next[newIdx], next[idx]]
    setSteps(next)
  }

  const handleStepChange = (idx: number, updates: Partial<TeamStep>) => {
    setSteps(steps.map((s, i) => i === idx ? { ...s, ...updates } : s))
  }

  const handleTemplateChange = (idx: number, templateId: string) => {
    const tmpl = allTemplates.find(t => t.id === templateId)
    handleStepChange(idx, {
      templateId,
      label: tmpl?.name || steps[idx].label,
    })
  }

  const handleSave = async () => {
    if (!name.trim() || steps.length === 0) return
    setSaving(true)
    try {
      const team: TeamTemplate = {
        id: editingTeam?.id || generateTeamId(),
        name: name.trim(),
        description: description.trim(),
        steps,
        projectPath: projectPath.trim(),
        createdAt: editingTeam?.createdAt || Date.now(),
        updatedAt: Date.now(),
      }
      await saveTeam(team)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const handleBrowse = async () => {
    const dir = await window.electronAPI.dialog.openFolder()
    if (dir) setProjectPath(dir)
  }

  const isValid = name.trim().length > 0 && steps.length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-base border border-surface0 rounded-2xl shadow-2xl w-[640px] max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-surface0/80">
          <h2 className="text-base font-semibold text-text">
            {editingTeam ? 'Edit Team' : 'New Team'}
          </h2>
          <p className="text-[11px] text-overlay0 mt-0.5">
            Configure a pipeline of agents that execute in sequence or parallel
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Name + Description */}
          <div className="space-y-2">
            <div>
              <label className="text-[11px] text-subtext0 font-medium block mb-1">Team Name</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Full Review Pipeline"
                className="w-full bg-surface0/40 border border-surface0/80 rounded-lg px-3 py-2 text-sm text-text placeholder:text-overlay0 outline-none focus:border-sapphire/40"
              />
            </div>
            <div>
              <label className="text-[11px] text-subtext0 font-medium block mb-1">Description</label>
              <input
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="What does this team pipeline do?"
                className="w-full bg-surface0/40 border border-surface0/80 rounded-lg px-3 py-2 text-sm text-text placeholder:text-overlay0 outline-none focus:border-sapphire/40"
              />
            </div>
            <div>
              <label className="text-[11px] text-subtext0 font-medium block mb-1">Project Path</label>
              <div className="flex gap-2">
                <input
                  value={projectPath}
                  onChange={e => setProjectPath(e.target.value)}
                  placeholder="/path/to/project"
                  className="flex-1 bg-surface0/40 border border-surface0/80 rounded-lg px-3 py-2 text-sm text-text placeholder:text-overlay0 outline-none focus:border-sapphire/40"
                />
                <button onClick={handleBrowse} className="px-3 py-2 rounded-lg text-xs bg-surface0/50 text-overlay1 hover:bg-surface1 hover:text-text transition-colors border border-surface0/60">
                  Browse
                </button>
              </div>
            </div>
          </div>

          {/* Steps */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] text-subtext0 font-medium">Pipeline Steps</label>
              <button
                onClick={handleAddStep}
                disabled={allTemplates.length === 0}
                className="text-[11px] text-sapphire hover:text-sapphire/80 transition-colors font-medium disabled:opacity-40"
              >
                + Add Step
              </button>
            </div>

            {steps.length === 0 ? (
              <div className="text-center py-8 text-xs text-overlay0 bg-crust/40 rounded-xl border border-surface0/30">
                No steps yet. Add agent steps to build your pipeline.
              </div>
            ) : (
              <div className="space-y-2">
                {steps.map((step, idx) => (
                  <StepRow
                    key={step.id}
                    step={step}
                    index={idx}
                    total={steps.length}
                    templates={allTemplates}
                    prevMode={idx > 0 ? steps[idx - 1].mode : null}
                    onChange={(updates) => handleStepChange(idx, updates)}
                    onTemplateChange={(tid) => handleTemplateChange(idx, tid)}
                    onMove={(dir) => handleMoveStep(idx, dir)}
                    onRemove={() => handleRemoveStep(idx)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-surface0/80 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-surface0/50 text-overlay1 hover:bg-surface1 hover:text-text transition-colors border border-surface0/60"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!isValid || saving}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-sapphire hover:bg-sapphire/85 text-crust transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : editingTeam ? 'Save Changes' : 'Create Team'}
          </button>
        </div>
      </div>
    </div>
  )
}

function StepRow({ step, index, total, templates, prevMode, onChange, onTemplateChange, onMove, onRemove }: {
  step: TeamStep
  index: number
  total: number
  templates: Array<{ id: string; name: string }>
  prevMode: TeamStepMode | null
  onChange: (updates: Partial<TeamStep>) => void
  onTemplateChange: (templateId: string) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  const [showPrompt, setShowPrompt] = useState(!!step.promptOverride)

  // Visual connector indicator
  const isParallel = step.mode === 'parallel'

  return (
    <div className="relative">
      {/* Connector line */}
      {index > 0 && (
        <div className="flex items-center justify-center -mt-1 mb-1">
          <div className="text-[10px] text-overlay0 flex items-center gap-1">
            {isParallel && prevMode === 'parallel' ? (
              <span className="text-lavender">|| parallel</span>
            ) : (
              <svg width="10" height="12" viewBox="0 0 10 12" className="text-overlay0">
                <line x1="5" y1="0" x2="5" y2="8" stroke="currentColor" strokeWidth="1.5" />
                <polyline points="2,6 5,10 8,6" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            )}
          </div>
        </div>
      )}

      <div className={`rounded-xl border p-3 ${isParallel ? 'border-lavender/30 bg-lavender/5' : 'border-surface0/60 bg-surface0/20'}`}>
        <div className="flex items-center gap-2">
          {/* Step number */}
          <span className="text-[10px] text-overlay0 w-4 text-center shrink-0 font-mono">{index + 1}</span>

          {/* Template dropdown */}
          <select
            value={step.templateId}
            onChange={e => onTemplateChange(e.target.value)}
            className="flex-1 bg-crust/60 border border-surface0/60 rounded-lg px-2 py-1.5 text-xs text-text outline-none focus:border-sapphire/40"
          >
            {templates.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>

          {/* Mode toggle */}
          <button
            onClick={() => onChange({ mode: isParallel ? 'sequential' : 'parallel' })}
            className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors border ${
              isParallel
                ? 'bg-lavender/15 text-lavender border-lavender/30'
                : 'bg-surface0/40 text-overlay1 border-surface0/60 hover:text-text'
            }`}
            title={isParallel ? 'Runs in parallel with adjacent parallel steps' : 'Runs after previous step completes'}
          >
            {isParallel ? 'Parallel' : 'Sequential'}
          </button>

          {/* Move buttons */}
          <div className="flex gap-0.5 shrink-0">
            <button
              onClick={() => onMove(-1)}
              disabled={index === 0}
              className="w-6 h-6 rounded-md text-overlay0 hover:text-text hover:bg-surface0/50 transition-colors disabled:opacity-30 flex items-center justify-center text-xs"
            >
              {String.fromCodePoint(0x25B2)}
            </button>
            <button
              onClick={() => onMove(1)}
              disabled={index === total - 1}
              className="w-6 h-6 rounded-md text-overlay0 hover:text-text hover:bg-surface0/50 transition-colors disabled:opacity-30 flex items-center justify-center text-xs"
            >
              {String.fromCodePoint(0x25BC)}
            </button>
          </div>

          {/* Prompt toggle */}
          <button
            onClick={() => setShowPrompt(!showPrompt)}
            className="w-6 h-6 rounded-md text-overlay0 hover:text-text hover:bg-surface0/50 transition-colors flex items-center justify-center text-xs"
            title="Custom prompt override"
          >
            {String.fromCodePoint(0x270E)}
          </button>

          {/* Remove */}
          <button
            onClick={onRemove}
            className="w-6 h-6 rounded-md text-overlay0 hover:text-red hover:bg-red/10 transition-colors flex items-center justify-center text-xs"
          >
            {String.fromCodePoint(0x2715)}
          </button>
        </div>

        {/* Label edit */}
        <div className="mt-2 ml-6">
          <input
            value={step.label}
            onChange={e => onChange({ label: e.target.value })}
            placeholder="Step label"
            className="w-full bg-crust/40 border border-surface0/40 rounded-md px-2 py-1 text-[11px] text-text placeholder:text-overlay0 outline-none focus:border-sapphire/40"
          />
        </div>

        {/* Prompt override */}
        {showPrompt && (
          <div className="mt-2 ml-6">
            <textarea
              value={step.promptOverride || ''}
              onChange={e => onChange({ promptOverride: e.target.value || undefined })}
              placeholder="Optional: override the template's default prompt..."
              rows={3}
              className="w-full bg-crust/40 border border-surface0/40 rounded-md px-2 py-1.5 text-[11px] text-text placeholder:text-overlay0 outline-none focus:border-sapphire/40 resize-y"
            />
          </div>
        )}
      </div>
    </div>
  )
}
