import React from 'react'
import type { CustomCommand } from '../../stores/commandStore'
import { isContextMenuGesture } from '../../lib/pointer'

/** Popover for customizing command arguments (shown on Ctrl+click, Alt+Enter, or "Run with arguments…"). */
export default function ArgsPopover({ cmd, rect, onRun, onSetDefault, onClose }: {
  cmd: CustomCommand
  rect: DOMRect
  onRun: (args: string[]) => void
  onSetDefault: (args: string[]) => void
  onClose: () => void
}) {
  // Build union of all known args
  const allKnownArgs = React.useMemo(() => {
    const set = new Set<string>()
    cmd.defaultArgs?.forEach((a) => set.add(a))
    cmd.lastCustomArgs?.forEach((a) => set.add(a))
    return Array.from(set)
  }, [cmd.defaultArgs, cmd.lastCustomArgs])

  // Initialize checked state from lastCustomArgs or defaultArgs
  const initialChecked = React.useMemo(() => {
    const checked = new Set<string>()
    const source = cmd.lastCustomArgs || cmd.defaultArgs || []
    source.forEach((a) => checked.add(a))
    return checked
  }, [cmd.lastCustomArgs, cmd.defaultArgs])

  const [checked, setChecked] = React.useState<Set<string>>(initialChecked)
  const [customArgs, setCustomArgs] = React.useState<string[]>([])
  const [inputVal, setInputVal] = React.useState('')
  const popoverRef = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top?: number; bottom?: number }>({ left: 0 })

  // Position the popover above the button
  React.useEffect(() => {
    const el = popoverRef.current
    if (!el) return
    const popRect = el.getBoundingClientRect()
    const viewW = window.innerWidth
    const viewH = window.innerHeight

    let left = rect.left
    if (left + popRect.width > viewW - 8) left = viewW - popRect.width - 8
    if (left < 8) left = 8

    // Position above the button by default; below if no room above
    if (rect.top - popRect.height - 4 > 0) setPos({ left, bottom: viewH - rect.top + 4 })
    else setPos({ left, top: rect.bottom + 4 })
  }, [rect])

  // Escape closes. The backdrop dismisses on MOUSEDOWN, never on click: Ctrl+C
  // in the terminal fires click events on backdrops (house rule -- the
  // TerminalContextMenu pattern), and this popover holds typed input that a
  // stray click must not discard. A context-menu gesture (right button;
  // Ctrl+click on macOS -- lib/pointer.ts) is an INERT dismiss: ignored on
  // mousedown, the contextmenu swallowed on the backdrop, so it never reaches
  // what is under the pointer (the terminal's right-click would paste). Inside
  // the panel a right-click is swallowed too and keeps the popover (typed
  // input survives).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const toggleArg = (arg: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(arg)) next.delete(arg)
      else next.add(arg)
      return next
    })
  }

  const handleAddCustom = () => {
    const val = inputVal.trim()
    if (val && !allKnownArgs.includes(val) && !customArgs.includes(val)) {
      setCustomArgs((prev) => [...prev, val])
      setChecked((prev) => new Set(prev).add(val))
      setInputVal('')
    }
  }

  const getSelectedArgs = (): string[] => {
    const result: string[] = []
    for (const a of allKnownArgs) if (checked.has(a)) result.push(a)
    for (const a of customArgs) if (checked.has(a)) result.push(a)
    return result
  }

  return (
    <div className="fixed inset-0 z-50" onMouseDown={(e) => { if (!isContextMenuGesture(e)) onClose() }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onClose() }} data-testid="command-args-backdrop">
      <div
        ref={popoverRef}
        className="fixed rounded-lg shadow-xl p-3 min-w-[240px] max-w-[340px]"
        style={{ ...pos, background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)' }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`${cmd.label} — arguments`}
      >
        <div className="text-xs mb-2 font-medium truncate" style={{ color: 'var(--text-secondary)' }} title={cmd.prompt}>
          {cmd.label} — Arguments
        </div>

        <div className="space-y-1 mb-2 max-h-[200px] overflow-y-auto">
          {allKnownArgs.map((arg) => (
            <label key={arg} className="flex items-center gap-2 text-xs cursor-pointer rounded px-1 py-0.5" style={{ color: 'var(--text-primary)' }}>
              <input type="checkbox" checked={checked.has(arg)} onChange={() => toggleArg(arg)} className="accent-blue" />
              <span className="font-mono truncate">{arg}</span>
              {cmd.defaultArgs?.includes(arg) && <span className="text-[9px] ml-auto shrink-0" style={{ color: 'var(--text-muted)' }}>default</span>}
            </label>
          ))}
          {customArgs.map((arg) => (
            <label key={arg} className="flex items-center gap-2 text-xs cursor-pointer rounded px-1 py-0.5" style={{ color: 'var(--text-primary)' }}>
              <input type="checkbox" checked={checked.has(arg)} onChange={() => toggleArg(arg)} className="accent-blue" />
              <span className="font-mono truncate">{arg}</span>
              <span className="text-[9px] ml-auto shrink-0 text-green">custom</span>
            </label>
          ))}
        </div>

        <div className="flex gap-1 mb-2">
          <input
            type="text"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddCustom() } }}
            className="flex-1 px-2 py-1 text-xs rounded border outline-none font-mono"
            style={{ background: 'var(--surface-base)', borderColor: 'var(--border-strong)', color: 'var(--text-primary)' }}
            placeholder="Add argument..."
          />
          <button onClick={handleAddCustom} disabled={!inputVal.trim()} className="px-2 py-1 text-xs rounded disabled:opacity-40" style={{ background: 'var(--surface-raised)', color: 'var(--text-primary)' }}>+</button>
        </div>

        <div className="flex gap-1.5">
          <button onClick={() => onRun(getSelectedArgs())} className="flex-1 px-3 py-1.5 text-xs rounded font-medium" style={{ background: 'var(--brand)', color: '#0a0e13' }}>Run</button>
          <button onClick={() => onSetDefault(getSelectedArgs())} className="px-3 py-1.5 text-xs rounded" style={{ background: 'var(--surface-raised)', color: 'var(--text-primary)' }} title="Save selected args as the new default">Set as Default</button>
        </div>
      </div>
    </div>
  )
}
