import type { CodexOptions } from '../../stores/configStore'
import { useCodexAccountStore } from '../../stores/codexAccountStore'
import { CODEX_MODELS } from '../../codex-models'

interface Props {
  value: CodexOptions
  onChange: (next: CodexOptions) => void
  onOpenSettings: () => void
}

const MODELS = CODEX_MODELS
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
        <div className="rounded-[9px] border p-3 text-xs leading-snug" style={{ borderColor: 'color-mix(in srgb, var(--status-warning) 40%, transparent)', background: 'color-mix(in srgb, var(--status-warning) 9%, transparent)', color: 'var(--status-warning)' }}>
          Codex CLI is not installed.{' '}
          <button type="button" onClick={onOpenSettings} className="underline">
            Open Settings for install instructions
          </button>
        </div>
      )}
      {unauthed && (
        <div className="rounded-[9px] border p-3 text-xs leading-snug" style={{ borderColor: 'color-mix(in srgb, var(--status-warning) 40%, transparent)', background: 'color-mix(in srgb, var(--status-warning) 9%, transparent)', color: 'var(--status-warning)' }}>
          Sign in to Codex first.{' '}
          <button type="button" onClick={onOpenSettings} className="underline">
            Sign in to Codex
          </button>
        </div>
      )}

      <div>
        <label className="block text-xs text-[var(--text-secondary)] mb-1">Model</label>
        <select
          value={value.model ?? 'gpt-5.5'}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
          className="w-full bg-[var(--surface-base)] border border-[var(--border-strong)] rounded-lg px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none focus-ring"
        >
          {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-xs text-[var(--text-secondary)] mb-1">Reasoning effort</label>
        <select
          value={value.reasoningEffort ?? 'medium'}
          onChange={(e) => onChange({ ...value, reasoningEffort: e.target.value as CodexOptions['reasoningEffort'] })}
          className="w-full bg-[var(--surface-base)] border border-[var(--border-strong)] rounded-lg px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none focus-ring"
        >
          {EFFORTS.map((eff) => <option key={eff} value={eff}>{eff}</option>)}
        </select>
      </div>

      <fieldset>
        <legend className="text-xs text-[var(--text-secondary)] mb-1">Permissions</legend>
        <div className="space-y-1">
          {PRESETS.map((p) => (
            <label key={p.id} className="flex cursor-pointer items-start gap-2 rounded p-2 hover:bg-[var(--surface-overlay)]">
              <input
                type="radio"
                name="codex-permissions"
                checked={value.permissionsPreset === p.id}
                onChange={() => onChange({ ...value, permissionsPreset: p.id })}
                className="mt-0.5 accent-[var(--brand)]"
              />
              <div>
                <div className="text-sm text-[var(--text-primary)]">{p.label}</div>
                <div className="text-xs text-[var(--text-secondary)]">{p.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  )
}
