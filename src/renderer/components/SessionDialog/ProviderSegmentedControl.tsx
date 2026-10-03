import { useRef, type KeyboardEvent } from 'react'
import type { ProviderId } from '../../stores/configStore'
import { DIALOG_SEG_CHIP, dialogSegStyle } from '../ui/Dialog'

interface Props {
  value: ProviderId
  onChange: (next: ProviderId) => void
  sessionType: 'local' | 'ssh'
  /** Codex is switched off (the Providers card in Settings, Accounts). */
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
      <label className="text-[10px] uppercase tracking-wider font-medium" style={{ color: 'var(--text-secondary)' }}>Provider</label>
      <div className="flex gap-1.5" role="radiogroup" aria-label="Provider">
        <button
          ref={claudeBtnRef}
          type="button"
          role="radio"
          aria-checked={value === 'claude'}
          tabIndex={value === 'claude' ? 0 : -1}
          onClick={() => onChange('claude')}
          onKeyDown={(e) => onKeyDown(e, 'claude')}
          className={`${DIALOG_SEG_CHIP} flex-1 justify-center font-medium`}
          style={dialogSegStyle(value === 'claude')}
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
          className={`${DIALOG_SEG_CHIP} flex-1 justify-center font-medium`}
          style={dialogSegStyle(value === 'codex', codexDisabled)}
        >
          Codex
        </button>
      </div>
      <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
        {sessionType === 'ssh'
          ? 'Codex is not available for SSH sessions yet.'
          : codexMasterOff
            ? "Codex is switched off: its configs won't launch and new ones can't use it. Turn it on in Settings, Accounts."
            : "Which CLI this config runs: Anthropic's Claude Code, or OpenAI's Codex (its own account and sign-in)."}
      </p>
    </div>
  )
}
