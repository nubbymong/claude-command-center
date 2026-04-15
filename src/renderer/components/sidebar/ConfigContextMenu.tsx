import React, { useRef, useState, useEffect } from 'react'
import { ConfigGroup, ConfigSection } from '../../stores/configStore'
import { useClickOutside } from '../../hooks/useClickOutside'

interface ConfigContextMenuProps {
  x: number
  y: number
  groups: ConfigGroup[]
  sections: ConfigSection[]
  currentGroupId?: string
  currentSectionId?: string
  isPinned?: boolean
  onMoveToGroup: (groupId: string | undefined) => void
  onCreateGroup: (name: string) => void
  onMoveToSection: (sectionId: string | undefined) => void
  onCreateSection: (name: string) => void
  onEdit: () => void
  onDelete: () => void
  onPin: () => void
  onDuplicate: () => void
  onClose: () => void
}

export default function ConfigContextMenu({ x, y, groups, sections, currentGroupId, currentSectionId, isPinned, onMoveToGroup, onCreateGroup, onMoveToSection, onCreateSection, onEdit, onDelete, onPin, onDuplicate, onClose }: ConfigContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [showNewGroupInput, setShowNewGroupInput] = useState(false)
  const [showNewSectionInput, setShowNewSectionInput] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newSectionName, setNewSectionName] = useState('')
  const groupInputRef = useRef<HTMLInputElement>(null)
  const sectionInputRef = useRef<HTMLInputElement>(null)

  useClickOutside(menuRef, onClose, () => {
    if (showNewGroupInput) setShowNewGroupInput(false)
    else if (showNewSectionInput) setShowNewSectionInput(false)
    else onClose()
  })

  useEffect(() => {
    if (showNewGroupInput) setTimeout(() => groupInputRef.current?.focus(), 0)
  }, [showNewGroupInput])

  useEffect(() => {
    if (showNewSectionInput) setTimeout(() => sectionInputRef.current?.focus(), 0)
  }, [showNewSectionInput])

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-surface0 border border-surface1 rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ left: x, top: y }}
    >
      <button
        onClick={onEdit}
        className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8.5 1.5l2 2-7 7H1.5v-2z"/></svg>
        Edit
      </button>
      <button
        onClick={onPin}
        className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M7.5 1.5L10.5 4.5L8 7L9 10.5L6 7.5L2.5 11L5 7L1.5 4L5 5L7.5 1.5Z" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        {isPinned ? 'Unpin' : 'Pin to Top'}
      </button>
      <button
        onClick={onDuplicate}
        className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
          <rect x="3" y="3" width="7" height="7" rx="1"/>
          <path d="M2 9V2.5A.5.5 0 012.5 2H9"/>
        </svg>
        Duplicate
      </button>
      <button
        onClick={onDelete}
        className="w-full text-left px-3 py-1.5 text-xs text-red hover:bg-surface1 transition-colors flex items-center gap-2"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        Delete
      </button>
      <div className="border-t border-surface1 my-1" />
      <div className="px-3 py-1.5 text-[10px] text-overlay0 uppercase tracking-wider">Move to Group</div>
      {currentGroupId && (
        <button
          onClick={() => onMoveToGroup(undefined)}
          className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors"
        >
          Remove from group
        </button>
      )}
      {groups.filter((g) => g.id !== currentGroupId).map((g) => (
        <button
          key={g.id}
          onClick={() => onMoveToGroup(g.id)}
          className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors"
        >
          {g.name}
        </button>
      ))}
      <div className="border-t border-surface1 mt-1 pt-1">
        {showNewGroupInput ? (
          <div className="px-2 py-1 flex gap-1">
            <input
              ref={groupInputRef}
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newGroupName.trim()) onCreateGroup(newGroupName.trim())
                e.stopPropagation()
              }}
              placeholder="Group name"
              className="flex-1 bg-base border border-surface1 rounded px-2 py-1 text-xs text-text placeholder:text-overlay0 outline-none focus:border-blue min-w-0"
            />
            <button
              onClick={() => { if (newGroupName.trim()) onCreateGroup(newGroupName.trim()) }}
              className="px-2 py-1 rounded text-xs bg-blue text-crust font-medium hover:bg-blue/90 shrink-0"
            >
              OK
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowNewGroupInput(true)}
            className="w-full text-left px-3 py-1.5 text-xs text-blue hover:bg-surface1 transition-colors"
          >
            + New Group...
          </button>
        )}
      </div>
      {/* Move to Section */}
      {!currentGroupId && (
        <>
          <div className="border-t border-surface1 my-1" />
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
            {showNewSectionInput ? (
              <div className="px-2 py-1 flex gap-1">
                <input
                  ref={sectionInputRef}
                  value={newSectionName}
                  onChange={(e) => setNewSectionName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newSectionName.trim()) onCreateSection(newSectionName.trim())
                    e.stopPropagation()
                  }}
                  placeholder="Section name"
                  className="flex-1 bg-base border border-surface1 rounded px-2 py-1 text-xs text-text placeholder:text-overlay0 outline-none focus:border-blue min-w-0"
                />
                <button
                  onClick={() => { if (newSectionName.trim()) onCreateSection(newSectionName.trim()) }}
                  className="px-2 py-1 rounded text-xs bg-blue text-crust font-medium hover:bg-blue/90 shrink-0"
                >
                  OK
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowNewSectionInput(true)}
                className="w-full text-left px-3 py-1.5 text-xs text-blue hover:bg-surface1 transition-colors"
              >
                + New Section...
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
