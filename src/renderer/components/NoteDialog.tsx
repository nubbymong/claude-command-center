import React, { useState, useEffect, useRef } from 'react'
import { generateId } from '../utils/id'
import { COMMAND_SWATCHES, swatchesFor } from '../lib/command-swatches'
import { ConfirmCard } from './command-bar/menus'
import { ON_BRAND } from './ui/Dialog'

export interface NoteEntry {
  id: string
  label: string
  color: string
  configId?: string
  createdAt: number
}

interface Props {
  /** Existing note to edit (absent = new). */
  note?: NoteEntry | null
  /** The current session's config, for "Session — this config only". */
  configId?: string
  configName?: string
  onSave: (id: string, label: string, content: string, color: string, configId?: string) => void
  onCancel: () => void
  /** Edit only: "Delete…" in the footer, confirmed in place. */
  onDelete?: (id: string) => void
}

/** The default colour of a new note: the pastel yellow of the section palette. */
export const DEFAULT_NOTE_COLOR = COMMAND_SWATCHES[2]

// The E5 tokens the command dialog uses, so the two read as one family.
const INPUT_CLASS = 'w-full h-8 px-2.5 rounded-lg border text-[12.5px] outline-none focus-ring'
const INPUT_STYLE: React.CSSProperties = { background: 'var(--surface-base)', borderColor: 'var(--border-strong)', color: 'var(--text-primary)' }
const LABEL_CLASS = 'block text-[12.5px] font-medium mb-1.5'
const LABEL_STYLE: React.CSSProperties = { color: 'var(--text-primary)' }
const SEG_CHIP = 'h-[30px] px-3 rounded-md border text-xs inline-flex items-center gap-1.5 whitespace-nowrap focus-ring transition-colors'
const segStyle = (selected: boolean, disabled?: boolean): React.CSSProperties => ({
  background: selected ? 'color-mix(in srgb, var(--brand) 14%, transparent)' : 'var(--surface-raised)',
  borderColor: selected ? 'color-mix(in srgb, var(--brand) 55%, transparent)' : 'var(--border-subtle)',
  color: selected ? '#5cb0ff' : 'var(--text-secondary)',
  opacity: disabled ? 0.5 : 1,
  cursor: disabled ? 'not-allowed' : 'pointer',
})

/**
 * The encrypted-note dialog in the E5 look (ADR-018 D10): Label · Content
 * (encrypted at rest; decrypted only while this dialog is open, exactly as
 * before) · Colour (the section pastels; an existing colour outside the set is
 * kept as an extra swatch) · Where it shows (Global / Session -- the same words
 * as the bar). Same store, same IPC, same encryption: `notes.load` happens here
 * and nowhere else, and `notes.save` is the caller's.
 */
export default function NoteDialog({ note, configId, configName, onSave, onCancel, onDelete }: Props) {
  const isEdit = !!note
  const [label, setLabel] = useState(note?.label || '')
  const [content, setContent] = useState('')
  const [color, setColor] = useState(note?.color || DEFAULT_NOTE_COLOR)
  const [scope, setScope] = useState<'global' | 'config'>(note ? (note.configId ? 'config' : 'global') : configId ? 'config' : 'global')
  const [loading, setLoading] = useState(!!note)
  // The note could not be decrypted (keychain unavailable, file damaged, IPC
  // failed): say so and refuse to save, so an empty editor never overwrites
  // the ciphertext (ADR-009 pass on #386).
  const [loadFailed, setLoadFailed] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const contentRef = useRef<HTMLTextAreaElement>(null)
  const id = note?.id || generateId()

  // Decrypt the content only once the dialog is open; it never sits in a list.
  useEffect(() => {
    let cancelled = false
    if (note) {
      Promise.resolve(window.electronAPI.notes.load(note.id)).then((text) => {
        if (cancelled) return
        if (text === null || text === undefined) { setLoadFailed(true); setLoading(false); return }
        setContent(text)
        setLoading(false)
        setTimeout(() => contentRef.current?.focus(), 50)
      }).catch(() => { if (!cancelled) { setLoadFailed(true); setLoading(false) } })
    } else {
      setTimeout(() => contentRef.current?.focus(), 50)
    }
    return () => { cancelled = true }
  }, [note])

  const canSave = !!label.trim() && !loading && !loadFailed
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSave) return
    onSave(id, label.trim(), content, color, scope === 'config' ? configId : undefined)
  }

  // Escape closes wherever focus is (the confirm card, when open, takes it first
  // with its own capture listener and stops propagation).
  const escapeRef = React.useRef<() => void>(() => {})
  escapeRef.current = () => { if (confirmDelete) setConfirmDelete(false); else onCancel() }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); escapeRef.current() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" data-testid="note-dialog">
      <div
        className="rounded-[14px] shadow-2xl w-[560px] max-w-[94vw] max-h-[88vh] overflow-y-auto flex flex-col"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-dialog-title"
      >
        <div className="px-[18px] pt-4 pb-3 shrink-0" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <h2 id="note-dialog-title" className="text-[15px] font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-secondary)' }} aria-hidden><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
            {isEdit ? 'Edit note' : 'New note'}
          </h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>Encrypted with the OS keychain. Decrypted only while this dialog is open.</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col min-h-0">
          <div className="px-[18px] pt-3.5 pb-1">
            <div className="mb-3">
              <label className={LABEL_CLASS} style={LABEL_STYLE}>Label</label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className={INPUT_CLASS}
                style={INPUT_STYLE}
                placeholder="e.g. API keys, Deploy runbook"
                maxLength={30}
                autoFocus={!note}
                data-testid="note-label"
              />
            </div>

            <div className="mb-3">
              <label className={`${LABEL_CLASS} flex items-center`} style={LABEL_STYLE}>
                Content <span className="ml-1.5 font-normal" style={{ color: 'var(--text-muted)' }}>encrypted at rest</span>
              </label>
              {loading ? (
                <div className="h-[160px] rounded-lg border grid place-items-center text-xs" style={{ ...INPUT_STYLE, color: 'var(--text-muted)' }} data-testid="note-decrypting">Decrypting…</div>
              ) : loadFailed ? (
                <div className="h-[160px] rounded-lg border grid place-items-center text-xs px-4 text-center leading-relaxed" style={{ ...INPUT_STYLE, color: 'var(--status-danger)' }} role="alert" data-testid="note-decrypt-failed">
                  This note could not be decrypted -- the OS keychain is unavailable or the note file is damaged. Saving is disabled so the stored content is not overwritten; delete the note if it is beyond recovery.
                </div>
              ) : (
                <textarea
                  ref={contentRef}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  className="w-full px-2.5 py-2 rounded-lg border text-[11.5px] leading-relaxed font-mono outline-none focus-ring resize-y"
                  style={{ ...INPUT_STYLE, minHeight: 160 }}
                  placeholder="Passwords, API keys, a runbook -- anything you want kept out of plain text."
                  data-testid="note-content"
                />
              )}
            </div>

            <div className="mb-3">
              <label className={LABEL_CLASS} style={LABEL_STYLE}>Colour</label>
              <div className="flex flex-wrap gap-1.5" data-testid="note-colours">
                {swatchesFor(note?.color).map((c) => {
                  const on = c.toUpperCase() === color.toUpperCase()
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(c)}
                      aria-label={`Colour ${c}`}
                      aria-pressed={on}
                      className={`w-4 h-4 rounded-full border-2 transition-all focus-ring ${on ? 'scale-110' : ''}`}
                      style={{ backgroundColor: c, borderColor: on ? '#fff' : 'transparent', boxShadow: on ? '0 0 0 1px var(--border-strong)' : undefined }}
                      title={COMMAND_SWATCHES.includes(c) ? c : `${c} — your existing colour, kept`}
                    />
                  )
                })}
              </div>
            </div>

            <div className="mb-2">
              <label className={LABEL_CLASS} style={LABEL_STYLE}>Where it shows</label>
              <div className="flex gap-1.5" role="radiogroup" aria-label="Where it shows" data-testid="note-scope">
                <button type="button" role="radio" aria-checked={scope === 'global'} onClick={() => setScope('global')} className={SEG_CHIP} style={segStyle(scope === 'global')} data-testid="note-scope-global">Global — every config</button>
                <button type="button" role="radio" aria-checked={scope === 'config'} aria-disabled={!configId || undefined} disabled={!configId} onClick={() => { if (configId) setScope('config') }} className={SEG_CHIP} style={segStyle(scope === 'config', !configId)} title={!configId ? 'This session has no saved config' : undefined} data-testid="note-scope-config">Session — this config only</button>
              </div>
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                {!configId
                  ? 'This session has no saved config, so the note is Global.'
                  : scope === 'global' ? 'Shows in the Notes list of every config.' : `Shows only in this config's Notes list${configName ? ` (${configName})` : ''}.`}
              </p>
            </div>
          </div>

          <div className="px-[18px] pt-3 pb-3.5 mt-2 flex items-center gap-2 shrink-0" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            {isEdit && onDelete && (
              <button type="button" onClick={() => setConfirmDelete(true)} className="h-7 px-3 rounded-[7px] text-xs mr-auto" style={{ background: 'color-mix(in srgb, var(--status-danger) 16%, transparent)', color: 'var(--status-danger)', border: '1px solid color-mix(in srgb, var(--status-danger) 40%, transparent)' }} data-testid="note-delete">
                Delete…
              </button>
            )}
            <button type="button" onClick={onCancel} className={`h-7 px-3 rounded-[7px] text-xs ${isEdit && onDelete ? '' : 'ml-auto'}`} style={{ background: 'var(--surface-overlay)', color: 'var(--text-secondary)' }}>
              Cancel
            </button>
            <button type="submit" disabled={!canSave} className="h-7 px-3 rounded-[7px] text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed" style={{ background: 'var(--brand)', color: ON_BRAND }} data-testid="note-save">
              {isEdit ? 'Save' : 'Create note'}
            </button>
          </div>
        </form>
      </div>

      {confirmDelete && note && onDelete && (
        <ConfirmCard
          testId="confirm-note-delete"
          title={`Delete the note "${note.label}"?`}
          body={<>
            <p>The encrypted content is destroyed. This cannot be undone.</p>
            <p className="mt-1">{note.configId ? <><b>This note is Session</b> — it disappears from this config only.</> : <><b>This note is Global</b> — it disappears from every config.</>}</p>
          </>}
          actions={[{ label: 'Delete note', danger: true, testId: 'confirm-note-delete-ok', onClick: () => { setConfirmDelete(false); onDelete(note.id) } }]}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}
