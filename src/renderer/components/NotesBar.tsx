import React, { useState, useEffect, useRef } from 'react'
import NoteDialog from './NoteDialog'
import { trackUsage } from '../stores/tipsStore'

interface NoteEntry {
  id: string
  label: string
  color: string
  configId?: string
  createdAt: number
}

interface Props {
  configId?: string
}

export default function NotesBar({ configId }: Props) {
  const [notes, setNotes] = useState<NoteEntry[]>([])
  const [showDialog, setShowDialog] = useState(false)
  const [editingNote, setEditingNote] = useState<NoteEntry | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; noteId?: string } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  // Load notes on mount and when configId changes
  useEffect(() => {
    loadNotes()
  }, [configId])

  const loadNotes = async () => {
    const all = await window.electronAPI.notes.list()
    // Show notes that match this config OR have no configId (global)
    const filtered = all.filter(n => !n.configId || n.configId === configId)
    setNotes(filtered)
  }

  const handleSave = async (id: string, label: string, content: string, color: string, noteConfigId?: string) => {
    await window.electronAPI.notes.save(id, label, content, color, noteConfigId)
    trackUsage('security.encrypted-notes')
    setShowDialog(false)
    setEditingNote(null)
    loadNotes()
  }

  const handleDelete = async (id: string) => {
    await window.electronAPI.notes.delete(id)
    setContextMenu(null)
    loadNotes()
  }

  const handleContextMenu = (e: React.MouseEvent, noteId?: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, noteId })
  }

  // Drag and drop reordering
  const handleDragStart = (e: React.DragEvent, note: NoteEntry) => {
    setDragId(note.id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', note.id)
  }

  const handleDragOver = (e: React.DragEvent, note: NoteEntry) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragId && note.id !== dragId) {
      setDragOverId(note.id)
    }
  }

  const handleDrop = async (e: React.DragEvent, targetNote: NoteEntry) => {
    e.preventDefault()
    if (!dragId || dragId === targetNote.id) return
    const newNotes = [...notes]
    const fromIdx = newNotes.findIndex(n => n.id === dragId)
    const toIdx = newNotes.findIndex(n => n.id === targetNote.id)
    if (fromIdx === -1 || toIdx === -1) return
    const [moved] = newNotes.splice(fromIdx, 1)
    newNotes.splice(toIdx, 0, moved)
    setNotes(newNotes)
    await window.electronAPI.notes.reorder(newNotes.map(n => n.id))
    setDragId(null)
    setDragOverId(null)
  }

  const handleDragEnd = () => {
    setDragId(null)
    setDragOverId(null)
  }

  // Lock icon SVG
  const lockIcon = (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-60">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )

  return (
    <>
      {notes.map((note) => {
        const isDragging = dragId === note.id
        const isDragOver = dragOverId === note.id
        return (
          <button
            key={note.id}
            draggable
            onDragStart={(e) => handleDragStart(e, note)}
            onDragOver={(e) => handleDragOver(e, note)}
            onDrop={(e) => handleDrop(e, note)}
            onDragEnd={handleDragEnd}
            onClick={() => setEditingNote(note)}
            onContextMenu={(e) => handleContextMenu(e, note.id)}
            className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border text-subtext0 hover:text-text transition-colors whitespace-nowrap shrink-0"
            style={{
              backgroundColor: note.color + '20',
              borderColor: isDragOver ? '#89B4FA' : note.color + '40',
              opacity: isDragging ? 0.4 : 1,
              cursor: isDragging ? 'grabbing' : 'pointer',
              borderLeftWidth: isDragOver ? '2px' : undefined,
              borderLeftColor: isDragOver ? '#89B4FA' : undefined,
            }}
            onMouseEnter={(e) => {
              if (!isDragging) {
                (e.currentTarget as HTMLElement).style.backgroundColor = note.color + '35'
                if (!isDragOver) (e.currentTarget as HTMLElement).style.borderColor = note.color + '60'
              }
            }}
            onMouseLeave={(e) => {
              if (!isDragging) {
                (e.currentTarget as HTMLElement).style.backgroundColor = note.color + '20'
                if (!isDragOver) (e.currentTarget as HTMLElement).style.borderColor = note.color + '40'
              }
            }}
            title="Click to view/edit encrypted note"
          >
            {lockIcon}
            {note.label}
          </button>
        )
      })}

      {/* Add note button */}
      <button
        onClick={() => setShowDialog(true)}
        onContextMenu={(e) => handleContextMenu(e)}
        className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-overlay0 hover:text-text rounded hover:bg-surface0 shrink-0 transition-colors"
        title="Add encrypted note"
      >
        {lockIcon}
        <span>+</span>
      </button>

      {/* Dialogs */}
      {showDialog && (
        <NoteDialog
          configId={configId}
          onSave={handleSave}
          onCancel={() => setShowDialog(false)}
        />
      )}
      {editingNote && (
        <NoteDialog
          note={editingNote}
          configId={configId}
          onSave={handleSave}
          onCancel={() => setEditingNote(null)}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <NoteContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          noteId={contextMenu.noteId}
          onClose={() => setContextMenu(null)}
          onAdd={() => { setContextMenu(null); setShowDialog(true) }}
          onEdit={contextMenu.noteId ? () => {
            const note = notes.find(n => n.id === contextMenu.noteId)
            if (note) { setEditingNote(note); setContextMenu(null) }
          } : undefined}
          onDelete={contextMenu.noteId ? () => handleDelete(contextMenu.noteId!) : undefined}
        />
      )}
    </>
  )
}

function NoteContextMenu({ x, y, noteId, onClose, onAdd, onEdit, onDelete }: {
  x: number; y: number; noteId?: string
  onClose: () => void
  onAdd: () => void
  onEdit?: () => void
  onDelete?: () => void
}) {
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top?: number; bottom?: number }>({ left: x })

  React.useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const viewH = window.innerHeight
    const viewW = window.innerWidth
    const left = Math.min(x, viewW - rect.width - 8)
    if (y + rect.height > viewH - 8) {
      setPos({ left, bottom: viewH - y })
    } else {
      setPos({ left, top: y })
    }
  }, [x, y])

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        ref={menuRef}
        className="fixed bg-surface0 border border-surface1 rounded-lg shadow-xl py-1 min-w-[160px]"
        style={pos}
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={onAdd} className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>
          Add Note
        </button>
        {onEdit && (
          <button onClick={onEdit} className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors flex items-center gap-2">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8.5 1.5l2 2-7 7H1.5v-2z"/></svg>
            Edit
          </button>
        )}
        {onDelete && (
          <button onClick={onDelete} className="w-full text-left px-3 py-1.5 text-xs text-red hover:bg-surface1 transition-colors flex items-center gap-2">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
            Delete
          </button>
        )}
      </div>
    </div>
  )
}
