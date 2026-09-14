import React, { useRef, useState, useEffect } from 'react'
import { ConfigSection } from '../../stores/configStore'
import { useClickOutside } from '../../hooks/useClickOutside'

interface GroupContextMenuProps {
  x: number
  y: number
  sections: ConfigSection[]
  currentSectionId?: string
  onMoveToSection: (sectionId: string | undefined) => void
  onCreateSection: (name: string) => void
  onClose: () => void
}

export default function GroupContextMenu({ x, y, sections, currentSectionId, onMoveToSection, onCreateSection, onClose }: GroupContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [showNewInput, setShowNewInput] = useState(false)
  const [newName, setNewName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useClickOutside(menuRef, onClose, () => {
    if (showNewInput) setShowNewInput(false)
    else onClose()
  })

  useEffect(() => {
    if (showNewInput) setTimeout(() => inputRef.current?.focus(), 0)
  }, [showNewInput])

  return (
    <div
      ref={menuRef}
      className="fixed z-50 rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ left: x, top: y, background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Move to Section</div>
      {currentSectionId && (
        <button
          onClick={() => onMoveToSection(undefined)}
          className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors"
          style={{ color: 'var(--text-primary)' }}
        >
          Remove from section
        </button>
      )}
      {sections.filter((s) => s.id !== currentSectionId).map((s) => (
        <button
          key={s.id}
          onClick={() => onMoveToSection(s.id)}
          className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors"
          style={{ color: 'var(--text-primary)' }}
        >
          {s.name}
        </button>
      ))}
      <div className="border-t mt-1 pt-1" style={{ borderColor: 'var(--border-subtle)' }}>
        {showNewInput ? (
          <div className="px-2 py-1 flex gap-1">
            <input
              ref={inputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim()) onCreateSection(newName.trim())
                e.stopPropagation()
              }}
              placeholder="Section name"
              className="flex-1 rounded border border-[var(--border-strong)] px-2 py-1 text-xs placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--brand)] min-w-0"
              style={{ background: 'var(--surface-base)', color: 'var(--text-primary)' }}
            />
            <button
              onClick={() => { if (newName.trim()) onCreateSection(newName.trim()) }}
              className="px-2 py-1 rounded text-xs font-medium shrink-0 hover:opacity-90 transition-opacity"
              style={{ background: 'var(--brand)', color: 'var(--text-on-brand)' }}
            >
              OK
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowNewInput(true)}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors"
            style={{ color: 'var(--brand)' }}
          >
            + New Section...
          </button>
        )}
      </div>
    </div>
  )
}
