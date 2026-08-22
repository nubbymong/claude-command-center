import React, { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from 'react'
import NoteDialog, { type NoteEntry } from '../NoteDialog'
import { ConfirmCard } from './menus'
import { CHIP_CLASS, CHIP_STYLE } from './chips'
import { trackUsage } from '../../stores/tipsStore'
import { isContextMenuGesture } from '../../lib/pointer'

export interface NotesToolHandle {
  /** Open the note dialog for a NEW note (the Add ▾ menu, the Core menu). */
  addNote: () => void
  /** Open the list, anchored to the tool. */
  openList: () => void
}

interface Props {
  configId?: string
  configName?: string
}

const LOCK = 'M4 11h16v10H4zM8 11V7a4 4 0 0 1 8 0v4'

/** "added 2d ago" -- from the index's createdAt (the only date the index keeps). */
export function addedAgo(createdAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - createdAt) / 1000))
  if (s < 60) return 'added just now'
  const m = Math.round(s / 60)
  if (m < 60) return `added ${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `added ${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `added ${d}d ago`
  const mo = Math.round(d / 30)
  return mo < 12 ? `added ${mo}mo ago` : `added ${Math.round(mo / 12)}y ago`
}

/**
 * The encrypted notes as ONE Core tool (ADR-018 D10): a lock with a quiet
 * count of the notes visible to this session (Global + this config). Click
 * opens the list -- label, colour, scope, when it was added; Edit and Delete
 * per row; Add note; notes from other configs folded under one line. A note
 * opens the NoteDialog, which is the only place content is decrypted. Same
 * store, same IPC (`notes.list` is names-only), same encryption as the header
 * chips it replaces.
 */
const NotesTool = forwardRef<NotesToolHandle, Props>(function NotesTool({ configId, configName }, ref) {
  const [notes, setNotes] = useState<NoteEntry[]>([])
  const [open, setOpen] = useState<DOMRect | null>(null)
  const [showOthers, setShowOthers] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<NoteEntry | null>(null)
  const [deleting, setDeleting] = useState<NoteEntry | null>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number }>({ left: 0 })

  const load = useCallback(async () => {
    try {
      const all = await window.electronAPI.notes.list()
      setNotes(Array.isArray(all) ? all : [])
    } catch {
      setNotes([])
    }
  }, [])
  useEffect(() => { void load() }, [load, configId])

  const here = notes.filter((n) => !n.configId || n.configId === configId)
  const others = notes.filter((n) => !!n.configId && n.configId !== configId)

  const openAt = (el: HTMLElement | null) => {
    const r = el?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0)
    setShowOthers(false)
    setOpen(r)
    void load()
  }
  useImperativeHandle(ref, () => ({
    addNote: () => { setOpen(null); setAdding(true) },
    openList: () => openAt(chipRef.current),
  }), [])

  useEffect(() => {
    if (!open) return
    const el = panelRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const viewW = window.innerWidth
    const viewH = window.innerHeight
    const left = Math.max(8, Math.min(open.left, viewW - r.width - 8))
    if (open.top - r.height - 6 > 0) setPos({ left, bottom: viewH - open.top + 6 })
    else setPos({ left, top: open.bottom + 6 })
    el.focus()
  }, [open])

  const save = async (id: string, label: string, content: string, color: string, noteConfigId?: string) => {
    await window.electronAPI.notes.save(id, label, content, color, noteConfigId)
    trackUsage('security.encrypted-notes')
    setAdding(false)
    setEditing(null)
    await load()
  }
  const remove = async (id: string) => {
    await window.electronAPI.notes.delete(id)
    setDeleting(null)
    setEditing(null)
    await load()
  }

  const title = here.length === 0
    ? 'Notes · none here — add one'
    : `Notes · ${here.length} here — encrypted at rest. Click to open`

  const row = (n: NoteEntry, other: boolean) => (
    <div
      key={n.id}
      className="flex items-center gap-2 px-1.5 py-1 rounded-md text-xs"
      style={{ color: 'var(--text-primary)', opacity: other ? 0.6 : 1 }}
      data-testid="notes-row"
      data-note-id={n.id}
      data-other={other ? 'true' : undefined}
    >
      <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: n.color }} aria-hidden />
      <span className="truncate">{n.label}</span>
      <span className="text-[9.5px] font-semibold uppercase tracking-[.08em] shrink-0" style={{ color: 'var(--text-muted)' }} data-testid="notes-row-scope">{n.configId ? 'Session' : 'Global'}</span>
      <span className="ml-auto text-[10.5px] shrink-0" style={{ color: 'var(--text-muted)' }}>{addedAgo(n.createdAt)}</span>
      <button type="button" className="text-[10.5px] hover:underline shrink-0" style={{ color: 'var(--text-secondary)' }} onClick={() => { setOpen(null); setEditing(n) }} data-testid="notes-edit">Edit</button>
      <button type="button" className="text-[10.5px] hover:underline shrink-0" style={{ color: 'var(--status-danger)' }} onClick={() => { setOpen(null); setDeleting(n) }} data-testid="notes-delete">Delete</button>
    </div>
  )

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={CHIP_CLASS}
        style={{ ...CHIP_STYLE, opacity: here.length ? 1 : 0.6 }}
        onClick={(e) => (open ? setOpen(null) : openAt(e.currentTarget))}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={!!open}
        data-testid="notes-tool"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={LOCK} /></svg>
        {here.length > 0 && <span className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }} data-testid="notes-count">{here.length}</span>}
      </button>

      {open && (
        // mousedown (not click): Ctrl+C in the terminal fires click events on
        // backdrops -- the TerminalContextMenu pattern (house rule). A
        // context-menu gesture (right button; Ctrl+click on macOS --
        // lib/pointer.ts) is an inert dismiss: ignored here, the contextmenu
        // swallowed, so it never reaches the terminal underneath (would paste).
        <div className="fixed inset-0 z-50" onMouseDown={(e) => { if (!isContextMenuGesture(e)) setOpen(null) }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(null) }} data-testid="notes-popover-backdrop">
          <div
            ref={panelRef}
            className="fixed rounded-lg shadow-xl p-2 w-[330px] text-xs outline-none"
            style={{ ...pos, background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)' }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(null); chipRef.current?.focus() } }}
            role="dialog"
            aria-label="Notes"
            tabIndex={-1}
            data-testid="notes-popover"
          >
            <div className="flex items-center gap-2 px-1.5 pb-1.5 mb-1 text-[9.5px] font-semibold uppercase tracking-[.09em]" style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-strong)' }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden style={{ color: 'var(--text-secondary)' }}><path d={LOCK} /></svg>
              <span data-testid="notes-popover-title">Notes · {here.length} here</span>
              <span className="ml-auto font-medium normal-case tracking-normal">encrypted at rest</span>
            </div>
            <div className="max-h-[300px] overflow-y-auto">
              {here.length === 0 && <div className="px-1.5 py-2" style={{ color: 'var(--text-muted)' }} data-testid="notes-empty">No notes here yet{configId ? ' — Global notes and this config\'s show here.' : '.'}</div>}
              {here.map((n) => row(n, false))}
              {others.length > 0 && (
                <button type="button" className="w-full text-left px-1.5 py-1 text-[10.5px] hover:underline" style={{ color: 'var(--text-muted)' }} onClick={() => setShowOthers((v) => !v)} aria-expanded={showOthers} data-testid="notes-others-toggle">
                  {showOthers ? '▾' : '▸'} {others.length} more in other config{others.length === 1 ? '' : 's'}
                </button>
              )}
              {showOthers && others.map((n) => row(n, true))}
            </div>
            <div className="flex items-center gap-2 mt-1 pt-2 text-[10.5px]" style={{ borderTop: '1px solid var(--border-strong)', color: 'var(--text-muted)' }}>
              <button
                type="button"
                className="inline-flex items-center gap-1 h-6 px-2 rounded-md border text-xs font-semibold focus-ring"
                style={{ color: '#5cb0ff', borderColor: 'color-mix(in srgb, var(--brand) 55%, transparent)', background: 'color-mix(in srgb, var(--brand) 16%, transparent)' }}
                onClick={() => { setOpen(null); setAdding(true) }}
                data-testid="notes-add"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
                Add note
              </button>
              <span className="ml-auto">Right-click the tool → Hide</span>
            </div>
          </div>
        </div>
      )}

      {adding && (
        <NoteDialog configId={configId} configName={configName} onSave={save} onCancel={() => setAdding(false)} />
      )}
      {editing && (
        <NoteDialog note={editing} configId={configId} configName={configName} onSave={save} onCancel={() => setEditing(null)} onDelete={remove} />
      )}
      {deleting && (
        <ConfirmCard
          testId="confirm-note-delete"
          title={`Delete the note "${deleting.label}"?`}
          body={<>
            <p>The encrypted content is destroyed. This cannot be undone.</p>
            <p className="mt-1">{deleting.configId ? <><b>This note is Session</b> — it disappears from this config only.</> : <><b>This note is Global</b> — it disappears from every config.</>}</p>
          </>}
          actions={[{ label: 'Delete note', danger: true, testId: 'confirm-note-delete-ok', onClick: () => { void remove(deleting.id) } }]}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  )
})

export default NotesTool
