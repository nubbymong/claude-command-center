import React, { useEffect, useRef, useState } from 'react'
import type { TerminalConfig } from '../../stores/configStore'
import { stepIndex, type ConfigGlyph } from './savedConfigsView'

// The pieces the cards view and the find view share (#362): the search box
// with inline auto-complete, the arrow/Enter selection over a flat list, and
// the type glyph drawn into an identity-colour swatch.

// ---------------------------------------------------------------------------
// Selection: type -> arrow -> Enter launches

export interface LaunchSelection {
  selected: number
  setSelected: (i: number) => void
  move: (delta: number) => void
  /** Launch the selected item, or the first one when nothing is selected yet. */
  enter: () => void
}

export function useLaunchSelection(flat: ReadonlyArray<TerminalConfig>, launch: (config: TerminalConfig) => void): LaunchSelection {
  const [selected, setSelected] = useState(-1)
  // The list can shrink under the selection (a config starts running, the
  // query narrows): clamp rather than point past the end.
  const clamped = selected >= flat.length ? flat.length - 1 : selected
  return {
    selected: clamped,
    setSelected,
    move: (delta) => setSelected(stepIndex(clamped, delta, flat.length)),
    enter: () => {
      const target = flat[clamped >= 0 ? clamped : 0]
      if (target) launch(target)
    },
  }
}

/** Scrolls the selected row/card into view whenever the selection moves. */
export function useScrollSelectedIntoView(container: React.RefObject<HTMLElement | null>, selected: number) {
  useEffect(() => {
    if (selected < 0) return
    const el = container.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [container, selected])
}

// ---------------------------------------------------------------------------
// Search box with inline completion

interface SearchProps {
  value: string
  onChange: (value: string) => void
  /** Full completed text (typed prefix + tail), or null when nothing completes. */
  completion: string | null
  onMove: (delta: number) => void
  onEnter: () => void
  placeholder?: string
  /** Bumped by the parent when the panel is opened deliberately; the box takes focus. */
  focusRequest?: number
  /** Announced count, e.g. "4 of 9". */
  hint?: string
}

export function SavedConfigsSearch({ value, onChange, completion, onMove, onEnter, placeholder = 'Find a config...', focusRequest, hint }: SearchProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusRequest) inputRef.current?.focus()
  }, [focusRequest])

  const accept = () => { if (completion) onChange(completion) }
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); onMove(1); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); onMove(-1); return }
    if (e.key === 'Enter') { e.preventDefault(); onEnter(); return }
    if (e.key === 'Tab' && !e.shiftKey && completion) { e.preventDefault(); accept(); return }
    if (e.key === 'ArrowRight' && completion) {
      const el = e.currentTarget
      if (el.selectionStart === value.length && el.selectionEnd === value.length) { e.preventDefault(); accept() }
      return
    }
    if (e.key === 'Escape') {
      if (value) { e.preventDefault(); onChange('') } else { e.currentTarget.blur() }
    }
  }

  const tail = completion && completion.length > value.length ? completion.slice(value.length) : ''
  return (
    <div className="px-2 pt-2 pb-1 shrink-0">
      <div
        className="relative rounded border text-xs"
        style={{ background: 'var(--surface-base)', borderColor: 'var(--border-subtle)' }}
        data-ux-id="saved-configs-search"
      >
        {/* Ghost completion: the typed text invisibly, then the tail in muted
            ink, in the SAME box and padding as the input so it sits exactly
            under the caret. */}
        <span aria-hidden className="absolute inset-0 px-2 py-1 whitespace-pre overflow-hidden pointer-events-none">
          <span className="invisible">{value}</span>
          <span data-ux-id="saved-configs-completion" style={{ color: 'var(--text-muted)' }}>{tail}</span>
        </span>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label="Find a saved config"
          aria-autocomplete="inline"
          autoComplete="off"
          spellCheck={false}
          className="relative w-full bg-transparent px-2 py-1 text-xs outline-none focus-ring placeholder:text-overlay0"
          style={{ color: 'var(--text-primary)' }}
        />
        {hint && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] pointer-events-none" style={{ color: 'var(--text-muted)' }}>
            {hint}
          </span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Glyph

/** The type mark: Claude asterisk, Codex rosette, shell prompt, or SSH arrows. */
export function ConfigGlyphIcon({ glyph, size = 12 }: { glyph: ConfigGlyph; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  switch (glyph) {
    case 'codex':
      return (
        <svg {...common} strokeWidth={2}>
          <path d="M12 2C9 2 6.5 4 6 7c-2.5 1-4 3.5-4 6.5C2 17 5 20 8.5 20c1.5 0 3-.5 4-1.5 1 1 2.5 1.5 4 1.5 3.5 0 6.5-3 6.5-6.5 0-3-1.5-5.5-4-6.5C18.5 4 15.5 2 12 2z" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      )
    case 'shell':
      return (
        <svg {...common} strokeWidth={2.4}>
          <polyline points="4 6 10 12 4 18" />
          <rect x="12.5" y="14.5" width="8" height="4" rx="1" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'ssh':
      return (
        <svg {...common}>
          <path d="M8 3v18M8 3L4 7M8 3l4 4M16 21V3M16 21l4-4M16 21l-4-4" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <path d="M12 2v8.5M12 13.5V22M2 12h8.5M13.5 12H22M4.93 4.93l6.01 6.01M13.06 13.06l6.01 6.01M19.07 4.93l-6.01 6.01M10.94 13.06l-6.01 6.01" />
        </svg>
      )
  }
}

/** The empty-list lines both views share. */
export function SavedConfigsEmpty({ total, launchable, visible, query }: { total: number; launchable: number; visible: number; query: string }) {
  if (total === 0) return null // the panel's own "No saved configs" message covers this
  if (launchable === 0) {
    return (
      <div className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }} data-ux-id="saved-configs-all-running">
        All {total} saved {total === 1 ? 'config is' : 'configs are'} running.
      </div>
    )
  }
  if (visible === 0) {
    return (
      <div className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }} data-ux-id="saved-configs-no-match">
        Nothing matches {query ? `"${query}"` : 'this filter'}.
      </div>
    )
  }
  return null
}

/** "2 running, not listed" -- why the list is shorter than the header count. */
export function RunningFootnote({ hidden }: { hidden: number }) {
  if (hidden <= 0) return null
  return (
    <div className="px-2 pt-1.5 pb-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }} data-ux-id="saved-configs-running-note">
      {hidden} running, not listed
    </div>
  )
}
