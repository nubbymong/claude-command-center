import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasVersion } from '../../shared/canvas'
import { CanvasArtifact, groupVersionsIntoArtifacts, locateVersion, splitArchived } from '../canvas/canvas-history'
import { relativeTime } from '../utils/relativeTime'
import { useArmedConfirm } from '../hooks/useArmedConfirm'

/**
 * Two-level history (item C, phase 4): the version identity in the pane chrome
 * becomes a per-artifact stepper — "Plan · v3", ‹ › within THIS plan's own
 * versions — plus a History ▾ popover that picks the ARTIFACT (a plan, a
 * mockup, a legacy test build). Picking an artifact opens its latest version;
 * the stepper then walks that artifact's run. A plan's ten versions never mix
 * into one number line with the mockup's.
 *
 * A pure display projection over the flat version list — no ids or anchors
 * move. Row actions (archive, delete) are Phase 5 and arrive as optional props,
 * so wiring them later does not reshape this component.
 */
interface Props {
  versions: CanvasVersion[]
  activeVersionId: string
  onSelectVersion: (versionId: string) => void
  /** Phase 5 — tuck an artifact into ARCHIVED (recoverable). */
  onArchive?: (artifact: CanvasArtifact) => void
  /** Phase 5 — delete an artifact, its versions and their notes (permanent). */
  onDelete?: (artifact: CanvasArtifact) => void
}

function kindBadge(kind: CanvasVersion['mode']): { label: string; color: string } {
  if (kind === 'plan') return { label: 'PLAN', color: 'var(--color-mauve)' }
  if (kind === 'uat') return { label: 'TEST', color: 'var(--text-muted)' }
  return { label: 'MOCKUP', color: 'var(--color-blue)' }
}

/** C1/C3: a version's state badge for the History list — the audit trail,
 *  one glance per row. OPEN = no verdict on the artifact's latest ready
 *  version; everything else reads its verdict. */
function versionBadge(v: CanvasVersion, isOpen: boolean): { label: string; color: string } {
  if (isOpen) return { label: 'OPEN', color: 'var(--color-peach)' }
  // A show-and-tell version is outside the review flow: never OPEN, and the
  // no-verdict fallback below must not mislabel it SUPERSEDED.
  if (v.show && !v.verdict) return { label: 'SHOWN', color: 'var(--text-muted)' }
  switch (v.verdict?.state) {
    case 'approved': return { label: 'APPROVED', color: 'var(--color-green)' }
    case 'rejected': return { label: 'REJECTED', color: 'var(--color-red)' }
    case 'withdrawn': return { label: 'WITHDRAWN', color: 'var(--color-red)' }
    case 'dismissed': return { label: 'DISMISSED', color: 'var(--text-muted)' }
    case 'superseded': return { label: 'SUPERSEDED', color: 'var(--text-muted)' }
    default: return { label: 'SUPERSEDED', color: 'var(--text-muted)' }
  }
}

function updatedLabel(iso: string, now: number): string {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? `updated ${relativeTime(ms, now)}` : 'updated recently'
}

export default function CanvasHistoryControl({ versions, activeVersionId, onSelectVersion, onArchive, onDelete }: Props) {
  const [open, setOpen] = useState(false)
  /** Withdrawn versions stay out of the default list (C1) — the audit trail
   *  keeps them; this reveals them for the session. */
  const [showWithdrawn, setShowWithdrawn] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  // Double-click-proofing (#456).
  const delConfirm = useArmedConfirm(confirmDelete)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const artifacts = useMemo(() => groupVersionsIntoArtifacts(versions), [versions])
  const located = useMemo(() => locateVersion(artifacts, activeVersionId), [artifacts, activeVersionId])
  const { live, archived } = useMemo(() => splitArchived(artifacts), [artifacts])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  useEffect(() => setConfirmDelete(null), [open])

  const stepTo = useCallback(
    (delta: number) => {
      if (!located) return
      const next = located.artifact.versions[located.index + delta]
      if (next) onSelectVersion(next.id)
    },
    [located, onSelectVersion],
  )

  // C3: the control renders whenever there is anything to show — a canvas
  // with one version still gets "v1 of 1 ▾" and its one-row history, so the
  // dropdown is never a control that exists only sometimes.
  if (!located) return null

  const badge = kindBadge(located.artifact.kind)
  const count = located.artifact.versions.length
  const pos = located.index + 1
  const now = Date.now()

  const pickArtifact = (a: CanvasArtifact) => {
    // Open the artifact's LATEST version — the freshest of that run.
    onSelectVersion(a.versions[a.versions.length - 1].id)
    setOpen(false)
  }

  const artifactRow = (a: CanvasArtifact, isArchivedGroup: boolean) => {
    const b = kindBadge(a.kind)
    const isCurrent = a.key === located.artifact.key
    const confirming = confirmDelete === a.key
    return (
      <div
        key={a.key}
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-md group"
        style={{ background: isCurrent ? 'var(--surface-overlay)' : undefined, opacity: isArchivedGroup ? 0.72 : 1 }}
        data-testid="canvas-history-row"
        data-artifact-kind={a.kind}
      >
        <button
          type="button"
          onClick={() => pickArtifact(a)}
          className="min-w-0 flex-1 flex items-center gap-2 text-left focus-ring rounded"
          title={`Open ${a.label} — ${a.versions.length} version${a.versions.length === 1 ? '' : 's'}`}
        >
          <span
            className="shrink-0 text-[9.5px] font-bold tracking-[0.06em] rounded px-1.5 py-px"
            style={{ background: `color-mix(in srgb, ${b.color} 18%, transparent)`, color: b.color }}
          >
            {/* A legacy uat build reads as ARCHIVED; a user-archived plan or
                mockup keeps its KIND badge — it did not stop being a plan. */}
            {a.kind === 'uat' ? 'ARCHIVED' : b.label}
          </span>
          <span className="min-w-0 truncate text-[12px]" style={{ color: 'var(--text-primary)' }}>
            {a.label}
          </span>
          <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            · {a.versions.length} version{a.versions.length === 1 ? '' : 's'}
          </span>
          <span className="ml-auto shrink-0 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
            {updatedLabel(a.updatedAt, now)}
          </span>
        </button>
        {/* Row actions (Phase 5). Archive is recoverable; delete is permanent
            and takes the notes with it, so it confirms first. */}
        {(onArchive || onDelete) && (
          <span className="shrink-0 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {/* Archive is reversible for a user-archived artifact; a legacy uat
                build is inherently archived and has no toggle. */}
            {onArchive && a.kind !== 'uat' && (
              <button
                type="button"
                onClick={() => onArchive(a)}
                className="text-[10.5px] focus-ring rounded px-0.5"
                style={{ color: 'var(--text-secondary)' }}
                title={a.archived
                  ? 'Bring this artifact back out of Archived into the live picker.'
                  : 'Tuck this artifact into Archived — out of the picker, recoverable any time.'}
                data-testid="canvas-history-archive"
              >
                {a.archived ? 'unarchive' : 'archive'}
              </button>
            )}
            {/* Delete is offered only when another artifact would remain — the
                store refuses deleting a canvas's only artifact (that is the
                library's delete-canvas), so showing it there is a dead end. */}
            {onDelete && artifacts.length > 1 &&
              (confirming ? (
                <button
                  type="button"
                  ref={delConfirm.confirmRef}
                  onClick={delConfirm.guarded(() => { onDelete(a); setConfirmDelete(null); setOpen(false) })}
                  className="text-[10.5px] font-semibold focus-ring rounded px-1"
                  style={{ color: 'var(--status-danger)', background: 'color-mix(in srgb, var(--status-danger) 15%, transparent)' }}
                  title="Permanently delete this artifact, its versions and their review notes. This cannot be undone."
                  data-testid="canvas-history-delete-confirm"
                >
                  delete {a.versions.length} + notes
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(a.key)}
                  className="text-[10.5px] focus-ring rounded px-0.5"
                  style={{ color: 'var(--text-muted)' }}
                  title="Delete this artifact, its versions and their review notes — permanent, and it stays gone across restarts and re-renders."
                  data-testid="canvas-history-delete"
                >
                  delete…
                </button>
              ))}
          </span>
        )}
      </div>
    )
  }

  // C1/C3 projections over the current artifact's run: the one OPEN version
  // (latest ready, no verdict), withdrawn rows hidden by default (the audit
  // trail keeps them; a footer line reveals), newest first for reading.
  const run = located.artifact.versions
  // `!v.show` matches shared openVersionOf: a show-and-tell after the open
  // review version must not steal its OPEN badge (nor demote it to the
  // no-verdict SUPERSEDED fallback).
  const lastReady = [...run].reverse().find((v) => !v.draft && !v.show && v.verdict?.state !== 'withdrawn')
  const openVersionId = lastReady && !lastReady.verdict ? lastReady.id : null
  const withdrawnCount = run.filter((v) => v.verdict?.state === 'withdrawn').length
  const listed = [...run].reverse().filter((v) => showWithdrawn || v.verdict?.state !== 'withdrawn')
  const otherLive = live.filter((a) => a.key !== located.artifact.key)

  const versionRow = (v: CanvasVersion) => {
    const isCurrent = v.id === activeVersionId
    const vb = versionBadge(v, v.id === openVersionId)
    const gist = v.verdict?.note ? v.verdict.note.split('\n')[0].slice(0, 42) : null
    // Provenance (adv FINDING 3): a verdict RECORDED FROM CHAT by the agent
    // must never read as the user's own click. The store stamps it
    // `by: 'agent-chat'`; the row says so out loud, exactly as the note-level
    // panel does with "by the agent on your instruction". 'system' (an
    // automatic supersession) and 'user' need no marker.
    const fromChat = v.verdict?.by === 'agent-chat'
    return (
      <button
        key={v.id}
        type="button"
        role="menuitem"
        onClick={() => { onSelectVersion(v.id); setOpen(false) }}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left focus-ring"
        style={{ background: isCurrent ? 'var(--surface-overlay)' : undefined }}
        data-testid="canvas-history-version-row"
        data-version={v.id}
      >
        <span className="shrink-0 w-[26px] text-[12px] font-bold tabular-nums" style={{ color: 'var(--text-primary)' }}>{v.id}</span>
        <span
          className="shrink-0 text-[8.5px] font-bold tracking-[0.05em] rounded px-1.5 py-px"
          style={{ background: `color-mix(in srgb, ${vb.color} 16%, transparent)`, color: vb.color }}
          data-testid={`canvas-history-badge-${v.id}`}
        >
          {vb.label}
        </span>
        {fromChat && (
          <span
            className="shrink-0 text-[8.5px] italic"
            style={{ color: 'var(--text-muted)' }}
            title="Recorded by the agent from what you said in chat — not your own click in the pane."
            data-testid={`canvas-history-fromchat-${v.id}`}
          >
            from chat
          </span>
        )}
        {gist && (
          <span className="min-w-0 truncate text-[11px]" style={{ color: 'var(--text-secondary)' }}>{gist}</span>
        )}
        <span className="ml-auto shrink-0 text-[10.5px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
          {relativeTime(Date.parse(v.createdAt), now)}
        </span>
      </button>
    )
  }

  return (
    <div className="relative shrink-0 flex items-center" ref={rootRef}>
      {/* ONE version control (C3): the ‹ › stepper folded into the History
          trigger, with the pending pill riding it — "v8 of 8 (1 pending) ▾". */}
      <div
        className="flex items-center gap-0.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-panel)] text-[12px] px-1"
        data-testid="canvas-version-stepper"
      >
        <button
          type="button"
          onClick={() => stepTo(-1)}
          disabled={pos <= 1}
          className="px-1.5 leading-none text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30 focus-ring rounded"
          aria-label="Previous version of this artifact"
          title="Previous version of this artifact"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="menu"
          data-testid="canvas-history-button"
          className="flex items-center gap-1.5 px-1 tabular-nums leading-none py-0.5 focus-ring rounded hover:bg-[var(--surface-overlay)] transition-colors"
          style={{ color: 'var(--text-secondary)' }}
          title={`History — every version of ${located.artifact.label}, with its outcome; click a row to jump`}
        >
          <span style={{ color: badge.color, fontWeight: 600 }}>{badge.label.toLowerCase()}</span>{' '}
          <span style={{ color: 'var(--text-primary)' }}>{activeVersionId}</span>{' '}
          <span style={{ color: 'var(--text-muted)' }}>of {count}</span>
          {openVersionId && (
            <span
              className="text-[9px] font-bold rounded-full px-1.5 py-px"
              style={{ background: 'var(--color-peach)', color: 'var(--surface-chrome)' }}
              data-testid="canvas-history-pending"
            >
              1 pending
            </span>
          )}
          <span aria-hidden style={{ color: 'var(--text-muted)', fontSize: 9 }}>▾</span>
        </button>
        <button
          type="button"
          onClick={() => stepTo(1)}
          disabled={pos >= count}
          className="px-1.5 leading-none text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30 focus-ring rounded"
          aria-label="Next version of this artifact"
          title="Next version of this artifact"
        >
          ›
        </button>
      </div>

      {open && (
        <div
          role="menu"
          data-testid="canvas-history-popover"
          className="absolute right-0 top-full mt-1 z-30 w-[320px] rounded-lg p-1.5 max-h-[420px] overflow-y-auto"
          style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', boxShadow: '0 16px 40px rgba(0,0,0,0.55)' }}
        >
          {/* THE HISTORY (C3): the current artifact's versions, newest first,
              each wearing its outcome — the thing the old dropdown never had. */}
          <div className="px-2 py-1 text-[9.5px] font-semibold uppercase tracking-[0.09em]" style={{ color: 'var(--text-muted)' }}>
            Versions — {located.artifact.label}
          </div>
          {listed.map(versionRow)}
          {withdrawnCount > 0 && !showWithdrawn && (
            <button
              type="button"
              onClick={() => setShowWithdrawn(true)}
              className="w-full text-left px-2.5 py-1 text-[10.5px] focus-ring rounded"
              style={{ color: 'var(--text-muted)' }}
              data-testid="canvas-history-show-withdrawn"
            >
              {withdrawnCount} withdrawn — kept in the audit trail, click to show
            </button>
          )}
          {otherLive.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-1 text-[9.5px] font-semibold uppercase tracking-[0.09em]" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)', marginTop: 4 }}>
                Other artifacts on this canvas
              </div>
              {otherLive.map((a) => artifactRow(a, false))}
            </>
          )}
          {archived.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-1 text-[9.5px] font-semibold uppercase tracking-[0.09em]" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)', marginTop: 4 }}>
                Archived
              </div>
              {archived.map((a) => artifactRow(a, true))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
