import React, { useState, useEffect, useRef } from 'react'
import { COLOR_SWATCHES } from './SessionDialog'

interface NoteEntry {
  id: string
  label: string
  color: string
  configId?: string
  createdAt: number
}

interface Props {
  note?: NoteEntry | null       // Existing note to edit (null = new)
  configId?: string             // Current session's configId
  onSave: (id: string, label: string, content: string, color: string, configId?: string) => void
  onCancel: () => void
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export default function NoteDialog({ note, configId, onSave, onCancel }: Props) {
  const [label, setLabel] = useState(note?.label || '')
  const [content, setContent] = useState('')
  const [color, setColor] = useState(note?.color || COLOR_SWATCHES[6]) // default yellow
  const [loading, setLoading] = useState(!!note)
  const contentRef = useRef<HTMLTextAreaElement>(null)
  const id = note?.id || generateId()

  // Load encrypted content when editing existing note
  useEffect(() => {
    if (note) {
      window.electronAPI.notes.load(note.id).then((text) => {
        setContent(text || '')
        setLoading(false)
        setTimeout(() => contentRef.current?.focus(), 50)
      })
    } else {
      setTimeout(() => contentRef.current?.focus(), 50)
    }
  }, [note])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!label.trim()) return
    onSave(id, label.trim(), content, color, configId)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        className="bg-mantle border border-surface0 rounded-lg shadow-xl p-5 w-[520px] max-h-[80vh] flex flex-col"
      >
        <h2 className="text-lg font-semibold text-text mb-4">
          {note ? 'Edit Note' : 'New Note'}
        </h2>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 flex-1 min-h-0">
          <div>
            <label className="block text-xs text-subtext0 mb-1">Label</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full px-3 py-1.5 bg-surface0 text-text text-sm rounded border border-surface1 outline-none focus:border-blue"
              placeholder="e.g., API Keys, Passwords, Notes"
              maxLength={30}
              autoFocus={!note}
            />
          </div>
          <div className="flex-1 min-h-0 flex flex-col">
            <label className="block text-xs text-subtext0 mb-1">Content (encrypted at rest)</label>
            {loading ? (
              <div className="flex-1 flex items-center justify-center bg-surface0 rounded border border-surface1 text-overlay0 text-sm">
                Decrypting...
              </div>
            ) : (
              <textarea
                ref={contentRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="flex-1 w-full px-3 py-2 bg-surface0 text-text text-sm rounded border border-surface1 outline-none focus:border-blue font-mono resize-none"
                style={{ minHeight: '200px' }}
                placeholder="Store passwords, API keys, notes, or any sensitive information here. Content is encrypted with Windows DPAPI."
              />
            )}
          </div>
          <div>
            <label className="block text-xs text-subtext0 mb-1">Color</label>
            <div className="flex gap-1.5 flex-wrap">
              {COLOR_SWATCHES.slice(0, 16).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`w-6 h-6 rounded-full border-2 transition-all ${
                    color === c ? 'border-text scale-110' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-1.5 text-sm text-overlay1 hover:text-text rounded hover:bg-surface0"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!label.trim()}
              className="px-4 py-1.5 text-sm bg-blue text-crust rounded hover:bg-blue/80 disabled:opacity-40"
            >
              {note ? 'Save' : 'Create Note'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
