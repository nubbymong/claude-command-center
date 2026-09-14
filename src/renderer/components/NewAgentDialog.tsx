import React, { useState, useRef, useEffect } from 'react'
import { useConfigStore } from '../stores/configStore'
import { useCloudAgentStore } from '../stores/cloudAgentStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useSettingsStore } from '../stores/settingsStore'
import { resolveAccountName } from '../../shared/account-chip-color'
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
} from './ui/Dialog'

interface Props {
  onClose: () => void
  // Prefill from a first-run example card (project still required).
  initialName?: string
  initialDescription?: string
}

export default function NewAgentDialog({ onClose, initialName, initialDescription }: Props) {
  const [name, setName] = useState(initialName ?? '')
  const [description, setDescription] = useState(initialDescription ?? '')
  const [projectPath, setProjectPath] = useState('')
  const [selectedConfigId, setSelectedConfigId] = useState<string>('')
  const [dispatching, setDispatching] = useState(false)
  // Per-run, ephemeral skip-permissions opt-in. Default OFF and never persisted.
  const [skipPermissions, setSkipPermissions] = useState(false)
  const configs = useConfigStore(s => s.configs)
  const dispatch = useCloudAgentStore(s => s.dispatch)
  const nameRef = useRef<HTMLInputElement>(null)

  // Account selection (multi-account): default to the captured primary so an
  // agent never silently runs on whatever the global login happens to be. Only
  // surfaced when more than one account profile exists.
  const profiles = useAccountProfilesStore(s => s.profiles)
  const accountAliases = useSettingsStore(s => s.settings.accountAliases)
  const defaultProfileId = (profiles.find(p => p.isPrimary) ?? profiles[0])?.id ?? ''
  const [selectedProfileId, setSelectedProfileId] = useState<string>('')
  const effectiveProfileId = selectedProfileId || defaultProfileId

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
    if (!name.trim() || !description.trim() || !projectPath.trim() || dispatching) return
    setDispatching(true)
    const selectedConfig = selectedConfigId ? localConfigs.find(c => c.id === selectedConfigId) : undefined
    await dispatch({
      name: name.trim(),
      description: description.trim(),
      projectPath: projectPath.trim(),
      configId: selectedConfigId || undefined,
      profileId: effectiveProfileId || undefined,
      legacyVersion: selectedConfig?.legacyVersion,
      skipPermissions,
    })
    onClose()
  }

  // Escape/Ctrl+Enter ride the overlay's key handler (they always have), so
  // this dialog does not also register useDialogEscape.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    if (e.key === 'Enter' && e.ctrlKey) handleDispatch()
  }



  return (
    <DialogOverlay position="absolute" onKeyDown={handleKeyDown}>
      <DialogPanel width="w-full" style={{ maxWidth: '32rem' }} labelledBy="new-agent-title">
        <DialogHeader titleId="new-agent-title" title="New agent" />

        <DialogBody>
          {/* Task name */}
          <div className="mb-3">
            <label className={DIALOG_LABEL_CLASS} style={DIALOG_LABEL_STYLE}>Task Name</label>
            <input
              ref={nameRef}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Auth Refactor"
              className={`${DIALOG_INPUT_CLASS} placeholder:text-[var(--text-muted)]`}
              style={DIALOG_INPUT_STYLE}
            />
          </div>

          {/* Task description (the prompt) */}
          <div className="mb-3">
            <label className={DIALOG_LABEL_CLASS} style={DIALOG_LABEL_STYLE}>Task Description (Prompt)</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Describe what the agent should do..."
              rows={4}
              className={`${DIALOG_TEXTAREA_CLASS} placeholder:text-[var(--text-muted)]`}
              style={DIALOG_INPUT_STYLE}
            />
          </div>

          {/* Project picker */}
          <div className="mb-4">
            <label className={DIALOG_LABEL_CLASS} style={DIALOG_LABEL_STYLE}>Project Directory</label>
            <div className="flex gap-2">
              <select
                value={selectedConfigId}
                onChange={e => handleConfigSelect(e.target.value)}
                className={DIALOG_INPUT_CLASS.replace('w-full', 'flex-1')}
                style={DIALOG_INPUT_STYLE}
              >
                <option value="">Select a config...</option>
                {localConfigs.map(c => (
                  <option key={c.id} value={c.id}>{c.label} - {c.workingDirectory}</option>
                ))}
              </select>
              <DialogButton
                variant="secondary"
                onClick={handleBrowse}
                className="shrink-0"
                style={{ height: 'auto', alignSelf: 'stretch' }}
              >
                Browse
              </DialogButton>
            </div>
            {projectPath && (
              <div className="mt-1 text-xs truncate" style={{ color: 'var(--text-muted)' }}>{projectPath}</div>
            )}
          </div>

          {/* Account picker (multi-account only) */}
          {profiles.length >= 2 && (
            <div className="mb-4">
              <label className={DIALOG_LABEL_CLASS} style={DIALOG_LABEL_STYLE}>Account</label>
              <select
                value={effectiveProfileId}
                onChange={e => setSelectedProfileId(e.target.value)}
                className={DIALOG_INPUT_CLASS}
                style={DIALOG_INPUT_STYLE}
              >
                {profiles.map(p => (
                  <option key={p.id} value={p.id}>
                    {(resolveAccountName(p.accountEmail, p.name, accountAliases) || 'Account')}{p.isPrimary ? ' (primary)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Per-run permission opt-in (P1.3 default OFF + FEAT-1, ephemeral and
              never persisted). The note adapts so neither state is a footgun. */}
          <label
            className="flex items-start gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors"
            style={skipPermissions
              ? { background: 'color-mix(in srgb, var(--status-danger) 9%, transparent)', border: '1px solid color-mix(in srgb, var(--status-danger) 32%, transparent)' }
              : { background: 'color-mix(in srgb, var(--status-warning) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--status-warning) 22%, transparent)' }}
          >
            <input
              type="checkbox"
              checked={skipPermissions}
              onChange={e => setSkipPermissions(e.target.checked)}
              className="mt-0.5 shrink-0 rounded"
            />
            <span className="min-w-0">
              {skipPermissions ? (
                <>
                  <span className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--status-danger)' }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    Skipping permission prompts
                  </span>
                  <span className="block mt-1 text-[11px] leading-relaxed" style={{ color: 'color-mix(in srgb, var(--status-danger) 78%, var(--text-primary))' }}>
                    Dangerous: the agent edits files and runs commands with no confirmation. Only use with prompts and project paths you trust.
                  </span>
                </>
              ) : (
                <>
                  <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                    Skip permission prompts for this run
                    <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>--dangerously-skip-permissions</span>
                  </span>
                  <span className="block mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    The agent asks before editing files or running commands. A headless run has no one to answer, so it may pause. Enable for a fully unattended run.
                  </span>
                </>
              )}
            </span>
          </label>
        </DialogBody>

        {/* Actions */}
        <DialogFooter
          left={<span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Ctrl+Enter to dispatch</span>}
        >
          <DialogButton variant="secondary" onClick={onClose}>
            Cancel
          </DialogButton>
          <DialogButton
            variant="primary"
            onClick={handleDispatch}
            disabled={!name.trim() || !description.trim() || !projectPath.trim() || dispatching}
          >
            {dispatching ? 'Dispatching...' : 'Dispatch agent'}
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
