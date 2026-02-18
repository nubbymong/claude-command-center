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
      className="fixed z-50 bg-surface0 border border-surface1 rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ left: x, top: y }}
    >
      <div className="px-3 py-1.5 text-[10px] text-overlay0 uppercase tracking-wider">Move to Section</div>
      {currentSectionId && (
        <button
          onClick={() => onMoveToSection(undefined)}
          className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors"
        >
          Remove from section
        </button>
      )}
      {sections.filter((s) => s.id !== currentSectionId).map((s) => (
        <button
          key={s.id}
          onClick={() => onMoveToSection(s.id)}
          className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors"
        >
          {s.name}
        </button>
      ))}
      <div className="border-t border-surface1 mt-1 pt-1">
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
              className="flex-1 bg-base border border-surface1 rounded px-2 py-1 text-xs text-text placeholder:text-overlay0 outline-none focus:border-blue min-w-0"
            />
            <button
              onClick={() => { if (newName.trim()) onCreateSection(newName.trim()) }}
              className="px-2 py-1 rounded text-xs bg-blue text-crust font-medium hover:bg-blue/90 shrink-0"
            >
              OK
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowNewInput(true)}
            className="w-full text-left px-3 py-1.5 text-xs text-blue hover:bg-surface1 transition-colors"
          >
            + New Section...
          </button>
        )}
      </div>
    </div>
  )
}
