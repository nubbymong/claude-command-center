import { useRef, type KeyboardEvent } from 'react'
import type { ProviderId } from '../../stores/configStore'

interface Props {
  value: ProviderId
  onChange: (next: ProviderId) => void
  sessionType: 'local' | 'ssh'
  /** Codex master switch ("Do you use Codex?") is off — Settings → Codex. */
  codexMasterOff?: boolean
}

export function ProviderSegmentedControl({ value, onChange, sessionType, codexMasterOff }: Props) {
  const codexDisabled = sessionType === 'ssh' || codexMasterOff === true
  const claudeBtnRef = useRef<HTMLButtonElement>(null)
  const codexBtnRef = useRef<HTMLButtonElement>(null)

  const onKeyDown = (e: KeyboardEvent, current: ProviderId) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next: ProviderId = current === 'claude' ? 'codex' : 'claude'
    if (next === 'codex' && codexDisabled) return
    onChange(next)
    // Roving tabIndex pattern: also move focus to the newly-selected radio,
    // otherwise focus is stranded on the now-tabIndex=-1 button.
    const target = next === 'claude' ? claudeBtnRef.current : codexBtnRef.current
    target?.focus()
  }

  return (
    <div className="flex flex-col gap-1 mb-4">
      <label className="text-[10px] uppercase tracking-wider text-overlay1 font-medium">Provider</label>
      <div className="flex bg-crust rounded-md p-0.5" role="radiogroup" aria-label="Provider">
        <button
          ref={claudeBtnRef}
          type="button"
          role="radio"
          aria-checked={value === 'claude'}
          tabIndex={value === 'claude' ? 0 : -1}
          onClick={() => onChange('claude')}
          onKeyDown={(e) => onKeyDown(e, 'claude')}
          className={
            'flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ' +
            (value === 'claude' ? 'bg-blue text-crust' : 'text-overlay1 hover:text-text')
          }
        >
          Claude
        </button>
        <button
          ref={codexBtnRef}
          type="button"
          role="radio"
          aria-checked={value === 'codex'}
          aria-disabled={codexDisabled}
          tabIndex={value === 'codex' ? 0 : -1}
          onClick={() => !codexDisabled && onChange('codex')}
          onKeyDown={(e) => onKeyDown(e, 'codex')}
          disabled={codexDisabled}
          className={
            'flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ' +
            (codexDisabled
              ? 'cursor-not-allowed text-overlay0'
              : (value === 'codex' ? 'bg-blue text-crust' : 'text-overlay1 hover:text-text'))
          }
        >
          Codex{' '}
          <span
            className={
              'text-[9px] uppercase tracking-wider border rounded-full px-1.5 py-px align-middle ' +
              (codexDisabled
                ? 'text-overlay0 border-overlay0/40'
                : (value === 'codex' ? 'text-crust border-crust/40' : 'text-peach border-peach/40'))
            }
          >
            Beta
          </span>
        </button>
      </div>
      <p className="text-[10px] text-overlay0 mt-1">
        {sessionType === 'ssh'
          ? 'Codex is not available for SSH sessions yet.'
          : codexMasterOff
            ? "Codex is switched off, so new configs can't use it. Enable it in Settings → Codex."
            : "Which CLI this config runs: Anthropic's Claude Code, or OpenAI's Codex (its own account and sign-in)."}
      </p>
    </div>
  )
}
