import React, { useRef, useState, useEffect } from 'react'
import { ConfigGroup, ConfigSection } from '../../stores/configStore'
import { useClickOutside } from '../../hooks/useClickOutside'
import { pinMenuLabel, PIN_WHILE_RUNNING_HINT } from './sessionsPanelState'

interface ConfigContextMenuProps {
  x: number
  y: number
  groups: ConfigGroup[]
  sections: ConfigSection[]
  currentGroupId?: string
  currentSectionId?: string
  isPinned?: boolean
  /** The config's session is live: Edit/Delete lock (a running template must
   *  not be edited by accident) and the pin item explains its deferral. */
  running?: boolean
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

export default function ConfigContextMenu({ x, y, groups, sections, currentGroupId, currentSectionId, isPinned, running, onMoveToGroup, onCreateGroup, onMoveToSection, onCreateSection, onEdit, onDelete, onPin, onDuplicate, onClose }: ConfigContextMenuProps) {
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
      className="fixed z-50 rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ left: x, top: y, background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <button
        onClick={running ? undefined : onEdit}
        disabled={running}
        aria-disabled={running}
        className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${running ? 'cursor-not-allowed opacity-45' : 'hover:bg-[var(--surface-overlay)]'}`}
        style={{ color: 'var(--text-primary)' }}
        title={running ? 'Running — a live config cannot be edited' : undefined}
        data-testid="ctx-edit"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8.5 1.5l2 2-7 7H1.5v-2z"/></svg>
        Edit
      </button>
      <button
        onClick={onPin}
        className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors flex items-center gap-2"
        style={{ color: 'var(--text-primary)' }}
        data-testid="ctx-pin"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="text-yellow">
          <path d="M13 2L3 14h7l-1 8 11-13h-8z" />
        </svg>
        {pinMenuLabel(isPinned)}
      </button>
      {running && !isPinned && (
        <div className="px-3 pb-1 pl-8 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
          {PIN_WHILE_RUNNING_HINT}
        </div>
      )}
      <button
        onClick={onDuplicate}
        className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors flex items-center gap-2"
        style={{ color: 'var(--text-primary)' }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
          <rect x="3" y="3" width="7" height="7" rx="1"/>
          <path d="M2 9V2.5A.5.5 0 012.5 2H9"/>
        </svg>
        Duplicate
      </button>
      <button
        onClick={running ? undefined : onDelete}
        disabled={running}
        aria-disabled={running}
        className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${running ? 'cursor-not-allowed opacity-45' : 'hover:bg-[var(--surface-overlay)]'}`}
        style={{ color: 'var(--status-danger)' }}
        title={running ? 'Running — close the session before deleting this config' : undefined}
        data-testid="ctx-delete"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        Delete
      </button>
      <div className="border-t my-1" style={{ borderColor: 'var(--border-subtle)' }} />
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Move to Group</div>
      {currentGroupId && (
        <button
          onClick={() => onMoveToGroup(undefined)}
          className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors"
          style={{ color: 'var(--text-primary)' }}
        >
          Remove from group
        </button>
      )}
      {groups.filter((g) => g.id !== currentGroupId).map((g) => (
        <button
          key={g.id}
          onClick={() => onMoveToGroup(g.id)}
          className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors"
          style={{ color: 'var(--text-primary)' }}
        >
          {g.name}
        </button>
      ))}
      <div className="border-t mt-1 pt-1" style={{ borderColor: 'var(--border-subtle)' }}>
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
              className="flex-1 rounded border border-[var(--border-strong)] px-2 py-1 text-xs placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--brand)] min-w-0"
              style={{ background: 'var(--surface-base)', color: 'var(--text-primary)' }}
            />
            <button
              onClick={() => { if (newGroupName.trim()) onCreateGroup(newGroupName.trim()) }}
              className="px-2 py-1 rounded text-xs font-medium shrink-0 hover:opacity-90 transition-opacity"
              style={{ background: 'var(--brand)', color: 'var(--text-on-brand)' }}
            >
              OK
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowNewGroupInput(true)}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors"
            style={{ color: 'var(--brand)' }}
          >
            + New Group...
          </button>
        )}
      </div>
      {/* Move to Section */}
      {!currentGroupId && (
        <>
          <div className="border-t my-1" style={{ borderColor: 'var(--border-subtle)' }} />
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
                  className="flex-1 rounded border border-[var(--border-strong)] px-2 py-1 text-xs placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--brand)] min-w-0"
                  style={{ background: 'var(--surface-base)', color: 'var(--text-primary)' }}
                />
                <button
                  onClick={() => { if (newSectionName.trim()) onCreateSection(newSectionName.trim()) }}
                  className="px-2 py-1 rounded text-xs font-medium shrink-0 hover:opacity-90 transition-opacity"
                  style={{ background: 'var(--brand)', color: 'var(--text-on-brand)' }}
                >
                  OK
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowNewSectionInput(true)}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-overlay)] transition-colors"
                style={{ color: 'var(--brand)' }}
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
