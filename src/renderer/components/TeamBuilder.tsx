import React, { useState, useEffect } from 'react'
import { useTeamStore } from '../stores/teamStore'
import { useAgentLibraryStore, BUILTIN_TEMPLATES } from '../stores/agentLibraryStore'
import type { TeamTemplate, TeamStep, TeamStepMode } from '../types/electron'
import { generateId } from '../utils/id'
import {
  DialogOverlay,
  DialogPanel,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogButton,
  DIALOG_INPUT_CLASS,
  DIALOG_INPUT_STYLE,
  DIALOG_LABEL_CLASS,
  DIALOG_LABEL_STYLE,
} from './ui/Dialog'

function generateStepId(): string {
  return 'ts-' + generateId()
}

function generateTeamId(): string {
  return 'team-' + generateId()
}

/** Placeholder colour: the shared field classes style the value, not the hint. */
const PLACEHOLDER_CLASS = ' placeholder:text-[var(--text-muted)]'

/** A step running in parallel is flagged with the info token — the same hue the
 *  connector, the card tint and the mode chip share, so "parallel" reads as one
 *  state rather than three unrelated accents. */
const PARALLEL = 'var(--status-info)'

export default function TeamBuilder({ onClose }: { onClose: () => void }) {
  const editingTeam = useTeamStore(s => s.editingTeam)
  const saveTeam = useTeamStore(s => s.saveTeam)
  const allTemplates = useAgentLibraryStore(s => s.getAllTemplates())

  const [name, setName] = useState(editingTeam?.name || '')
  const [description, setDescription] = useState(editingTeam?.description || '')
  const [projectPath, setProjectPath] = useState(editingTeam?.projectPath || '')
  const [steps, setSteps] = useState<TeamStep[]>(editingTeam?.steps || [])
  const [saving, setSaving] = useState(false)

  // Deliberately NO useDialogEscape: this is a multi-step pipeline with a
  // per-step prompt in each field, and Escape is a reflex when leaving a
  // textarea. Losing a whole draft team to one keypress, with no confirm and
  // no undo, is worse than not having the shortcut. The backdrop deliberately
  // does not close either; Cancel is the way out.

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
    <DialogOverlay dim={0.5}>
      <DialogPanel width="w-[640px]" className="max-h-[85vh]" labelledBy="team-builder-title">
        <DialogHeader
          titleId="team-builder-title"
          title={editingTeam ? 'Edit Pipeline' : 'New Pipeline'}
          subtitle="Configure a pipeline of agents that execute in sequence or parallel"
          onClose={onClose}
        />

        <DialogBody className="flex-1 space-y-4">
          {/* Name + Description */}
          <div className="space-y-2">
            <div>
              <label className={DIALOG_LABEL_CLASS} style={DIALOG_LABEL_STYLE}>Pipeline Name</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Full Review Pipeline"
                className={DIALOG_INPUT_CLASS + PLACEHOLDER_CLASS}
                style={DIALOG_INPUT_STYLE}
              />
            </div>
            <div>
              <label className={DIALOG_LABEL_CLASS} style={DIALOG_LABEL_STYLE}>Description</label>
              <input
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="What does this pipeline do?"
                className={DIALOG_INPUT_CLASS + PLACEHOLDER_CLASS}
                style={DIALOG_INPUT_STYLE}
              />
            </div>
            <div>
              <label className={DIALOG_LABEL_CLASS} style={DIALOG_LABEL_STYLE}>Project Path</label>
              <div className="flex gap-2">
                <input
                  value={projectPath}
                  onChange={e => setProjectPath(e.target.value)}
                  placeholder="/path/to/project"
                  className={(DIALOG_INPUT_CLASS + PLACEHOLDER_CLASS).replace('w-full', 'flex-1')}
                  style={DIALOG_INPUT_STYLE}
                />
                <DialogButton variant="secondary" onClick={handleBrowse} className="shrink-0" style={{ height: 'auto', alignSelf: 'stretch' }}>
                  Browse
                </DialogButton>
              </div>
            </div>
          </div>

          {/* Steps */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>Pipeline Steps</label>
              <button
                onClick={handleAddStep}
                disabled={allTemplates.length === 0}
                className="text-[11px] font-medium transition-opacity hover:opacity-80 disabled:opacity-40"
                style={{ color: 'var(--brand)' }}
              >
                + Add Step
              </button>
            </div>

            {steps.length === 0 ? (
              <div
                className="text-center py-8 text-xs rounded-xl border"
                style={{ background: 'var(--surface-sunken)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
              >
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
        </DialogBody>

        <DialogFooter>
          <DialogButton variant="ghost" onClick={onClose}>Cancel</DialogButton>
          <DialogButton variant="primary" onClick={handleSave} disabled={!isValid || saving}>
            {saving ? 'Saving...' : editingTeam ? 'Save Changes' : 'Create Pipeline'}
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
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

  // The small square icon buttons in the step's toolbar.
  const iconBtn = 'w-6 h-6 rounded-md transition-colors flex items-center justify-center text-xs hover:text-[var(--text-primary)] hover:bg-[var(--surface-overlay)] disabled:opacity-30'

  return (
    <div className="relative">
      {/* Connector line */}
      {index > 0 && (
        <div className="flex items-center justify-center -mt-1 mb-1">
          <div className="text-[10px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
            {isParallel && prevMode === 'parallel' ? (
              <span style={{ color: PARALLEL }}>|| parallel</span>
            ) : (
              <svg width="10" height="12" viewBox="0 0 10 12" style={{ color: 'var(--text-muted)' }}>
                <line x1="5" y1="0" x2="5" y2="8" stroke="currentColor" strokeWidth="1.5" />
                <polyline points="2,6 5,10 8,6" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            )}
          </div>
        </div>
      )}

      <div
        className="rounded-xl border p-3"
        style={isParallel
          ? { borderColor: `color-mix(in srgb, ${PARALLEL} 40%, transparent)`, background: `color-mix(in srgb, ${PARALLEL} 8%, transparent)` }
          : { borderColor: 'var(--border-subtle)', background: 'var(--surface-base)' }}
      >
        <div className="flex items-center gap-2">
          {/* Step number */}
          <span className="text-[10px] w-4 text-center shrink-0 font-mono" style={{ color: 'var(--text-muted)' }}>{index + 1}</span>

          {/* Template dropdown */}
          <select
            value={step.templateId}
            onChange={e => onTemplateChange(e.target.value)}
            className="flex-1 rounded-lg border px-2 py-1.5 text-xs outline-none focus-ring"
            style={DIALOG_INPUT_STYLE}
          >
            {templates.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>

          {/* Mode toggle */}
          <button
            onClick={() => onChange({ mode: isParallel ? 'sequential' : 'parallel' })}
            className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors border ${isParallel ? '' : 'hover:text-[var(--text-primary)]'}`}
            style={isParallel
              ? { background: `color-mix(in srgb, ${PARALLEL} 15%, transparent)`, color: PARALLEL, borderColor: `color-mix(in srgb, ${PARALLEL} 40%, transparent)` }
              : { background: 'var(--surface-overlay)', color: 'var(--text-secondary)', borderColor: 'var(--border-subtle)' }}
            title={isParallel ? 'Runs in parallel with adjacent parallel steps' : 'Runs after previous step completes'}
          >
            {isParallel ? 'Parallel' : 'Sequential'}
          </button>

          {/* Move buttons */}
          <div className="flex gap-0.5 shrink-0">
            <button
              onClick={() => onMove(-1)}
              disabled={index === 0}
              className={iconBtn}
              style={{ color: 'var(--text-muted)' }}
            >
              {String.fromCodePoint(0x25B2)}
            </button>
            <button
              onClick={() => onMove(1)}
              disabled={index === total - 1}
              className={iconBtn}
              style={{ color: 'var(--text-muted)' }}
            >
              {String.fromCodePoint(0x25BC)}
            </button>
          </div>

          {/* Prompt toggle */}
          <button
            onClick={() => setShowPrompt(!showPrompt)}
            className={iconBtn}
            style={{ color: 'var(--text-muted)' }}
            title="Custom prompt override"
          >
            {String.fromCodePoint(0x270E)}
          </button>

          {/* Remove */}
          <button
            onClick={onRemove}
            className="w-6 h-6 rounded-md transition-colors flex items-center justify-center text-xs hover:text-[var(--status-danger)] hover:bg-[color-mix(in_srgb,var(--status-danger)_12%,transparent)]"
            style={{ color: 'var(--text-muted)' }}
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
            className={'w-full rounded-md border px-2 py-1 text-[11px] outline-none focus-ring' + PLACEHOLDER_CLASS}
            style={DIALOG_INPUT_STYLE}
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
              className={'w-full rounded-md border px-2 py-1.5 text-[11px] outline-none focus-ring resize-y' + PLACEHOLDER_CLASS}
              style={DIALOG_INPUT_STYLE}
            />
          </div>
        )}
      </div>
    </div>
  )
}
