// src/renderer/components/github/config/ToggleSwitch.tsx
// Tri-state switch for the per-account feature model: masters show 'mixed'
// when accounts disagree (knob centred, mauve). Animated per app convention.
import React from 'react'

export type ToggleSwitchState = 'on' | 'off' | 'mixed'

interface Props {
  state: ToggleSwitchState
  onToggle: () => void
  label: string
  disabled?: boolean
  title?: string
}

export default function ToggleSwitch({ state, onToggle, label, disabled, title }: Props) {
  const track =
    state === 'on' ? 'bg-blue' : state === 'mixed' ? 'bg-mauve' : 'bg-surface1'
  const knob =
    state === 'on'
      ? 'translate-x-[15px] bg-crust'
      : state === 'mixed'
        ? 'translate-x-[7.5px] bg-crust'
        : 'translate-x-0 bg-text'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => { if (!disabled) onToggle() }}
      className={`relative w-[34px] h-[19px] rounded-full shrink-0 transition-colors duration-200 ${track} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`absolute top-[2px] left-[2px] w-[15px] h-[15px] rounded-full transition-transform duration-200 ${knob}`}
      />
    </button>
  )
}
