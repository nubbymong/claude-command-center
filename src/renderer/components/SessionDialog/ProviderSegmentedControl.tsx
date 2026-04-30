import type { ProviderId } from '../../stores/configStore'

interface Props {
  value: ProviderId
  onChange: (next: ProviderId) => void
  sessionType: 'local' | 'ssh'
}

export function ProviderSegmentedControl({ value, onChange, sessionType }: Props) {
  const codexDisabled = sessionType === 'ssh'
  return (
    <div className="flex flex-col gap-1 mb-4">
      <label className="text-[10px] uppercase tracking-wider text-overlay1 font-medium">Provider</label>
      <div className="flex bg-crust rounded-md p-0.5" role="radiogroup" aria-label="Provider">
        <button
          type="button"
          role="radio"
          aria-checked={value === 'claude'}
          onClick={() => onChange('claude')}
          className={
            'flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ' +
            (value === 'claude' ? 'bg-blue text-crust' : 'text-overlay1 hover:text-text')
          }
        >
          Claude
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={value === 'codex'}
          aria-disabled={codexDisabled}
          onClick={() => !codexDisabled && onChange('codex')}
          disabled={codexDisabled}
          className={
            'flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ' +
            (codexDisabled
              ? 'cursor-not-allowed text-overlay0'
              : (value === 'codex' ? 'bg-blue text-crust' : 'text-overlay1 hover:text-text'))
          }
        >
          Codex
        </button>
      </div>
      {codexDisabled && (
        <p className="text-[10px] text-overlay0 mt-1">SSH Codex coming in v1.5.x</p>
      )}
    </div>
  )
}
