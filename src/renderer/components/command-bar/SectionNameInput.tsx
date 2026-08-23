import React from 'react'
import { COMMAND_SWATCHES } from '../../lib/command-swatches'

/** Floating input for creating/renaming a section. Escape cancels; a stray
 *  backdrop click does NOT discard typed text (Ctrl+C in the terminal fires
 *  click events on backdrops) -- only Escape and Cancel do. */
export default function SectionNameInput({ x, y, initialName, initialColor, onConfirm, onCancel }: {
  x: number; y: number
  initialName?: string
  initialColor?: string
  onConfirm: (name: string, color?: string) => void
  onCancel: () => void
}) {
  const [name, setName] = React.useState(initialName || '')
  const [color, setColor] = React.useState<string | undefined>(initialColor)
  const ref = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top?: number; bottom?: number }>({ left: x })

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const viewH = window.innerHeight
    const viewW = window.innerWidth
    const left = Math.max(8, Math.min(x, viewW - rect.width - 8))
    if (y + rect.height > viewH - 8) setPos({ left, bottom: viewH - y })
    else setPos({ left, top: y })
  }, [x, y])

  const submit = () => { if (name.trim()) onConfirm(name.trim(), color) }

  return (
    <div className="fixed inset-0 z-50">
      <div
        ref={ref}
        className="fixed rounded-lg shadow-xl p-3 min-w-[230px]"
        style={{ ...pos, background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)' }}
        role="dialog"
        aria-label={initialName ? 'Rename section' : 'New section'}
      >
        <div className="text-xs mb-2 font-medium" style={{ color: 'var(--text-secondary)' }}>{initialName ? 'Rename section' : 'New section'}</div>
        <div className="flex gap-1 mb-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) { e.preventDefault(); submit() }
              if (e.key === 'Escape') { e.preventDefault(); onCancel() }
            }}
            className="flex-1 px-2 py-1 text-xs rounded border outline-none"
            style={{ background: 'var(--surface-base)', borderColor: 'var(--border-strong)', color: color || 'var(--text-primary)' }}
            placeholder="Section name"
            autoFocus
            data-testid="section-name-input"
          />
          <button onClick={submit} disabled={!name.trim()} className="px-2 py-1 text-xs rounded disabled:opacity-40 font-medium" style={{ background: 'var(--brand)', color: '#0a0e13' }}>
            {initialName ? 'Save' : 'Add'}
          </button>
          <button onClick={onCancel} className="px-2 py-1 text-xs rounded" style={{ color: 'var(--text-secondary)' }}>Cancel</button>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[10px] mr-0.5" style={{ color: 'var(--text-muted)' }}>Colour:</span>
          <button
            onClick={() => setColor(undefined)}
            className={`w-4 h-4 rounded-full border transition-all shrink-0 ${!color ? 'ring-1 ring-offset-1 ring-[var(--brand)] scale-110' : 'hover:scale-110'}`}
            style={{ backgroundColor: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}
            title="Default"
          />
          {COMMAND_SWATCHES.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={`w-4 h-4 rounded-full border transition-all shrink-0 ${c === color ? 'ring-1 ring-offset-1 ring-[var(--brand)] scale-110' : 'hover:scale-110'}`}
              style={{ backgroundColor: c, borderColor: c + '60' }}
              title={c}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
