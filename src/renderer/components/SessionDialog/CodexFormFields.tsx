import type { CodexOptions } from '../../stores/configStore'
import { useCodexAccountStore } from '../../stores/codexAccountStore'

interface Props {
  value: CodexOptions
  onChange: (next: CodexOptions) => void
  onOpenSettings: () => void
}

const MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2'] as const
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
const PRESETS = [
  { id: 'read-only' as const,    label: 'Read-only',    desc: 'Safe browsing -- no file writes' },
  { id: 'standard' as const,     label: 'Standard',     desc: 'Recommended -- workspace writes, prompts on tool use' },
  { id: 'auto' as const,         label: 'Auto',         desc: 'Workspace writes, no prompts' },
  { id: 'unrestricted' as const, label: 'Unrestricted', desc: 'Full machine access -- rare' },
]

export function CodexFormFields({ value, onChange, onOpenSettings }: Props) {
  const installed = useCodexAccountStore((s) => s.installed)
  const authMode = useCodexAccountStore((s) => s.authMode)
  const unauthed = installed && authMode === 'none'

  return (
    <div className="space-y-4 my-2">
      {!installed && (
        <div className="rounded-md bg-yellow/10 border border-yellow/30 p-3 text-sm text-yellow">
          Codex CLI is not installed.{' '}
          <button type="button" onClick={onOpenSettings} className="underline">
            Open Settings for install instructions
          </button>
        </div>
      )}
      {unauthed && (
        <div className="rounded-md bg-yellow/10 border border-yellow/30 p-3 text-sm text-yellow">
          Sign in to Codex first.{' '}
          <button type="button" onClick={onOpenSettings} className="underline">
            Sign in to Codex
          </button>
        </div>
      )}

      <div>
        <label className="block text-xs text-subtext0 mb-1">Model</label>
        <select
          value={value.model ?? 'gpt-5.5'}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
          className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-blue"
        >
          {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-xs text-subtext0 mb-1">Reasoning effort</label>
        <select
          value={value.reasoningEffort ?? 'medium'}
          onChange={(e) => onChange({ ...value, reasoningEffort: e.target.value as CodexOptions['reasoningEffort'] })}
          className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-blue"
        >
          {EFFORTS.map((eff) => <option key={eff} value={eff}>{eff}</option>)}
        </select>
      </div>

      <fieldset>
        <legend className="text-xs text-subtext0 mb-1">Permissions</legend>
        <div className="space-y-1">
          {PRESETS.map((p) => (
            <label key={p.id} className="flex cursor-pointer items-start gap-2 rounded p-2 hover:bg-surface0">
              <input
                type="radio"
                name="codex-permissions"
                checked={value.permissionsPreset === p.id}
                onChange={() => onChange({ ...value, permissionsPreset: p.id })}
                className="mt-0.5"
              />
              <div>
                <div className="text-sm text-text">{p.label}</div>
                <div className="text-xs text-subtext0">{p.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  )
}
