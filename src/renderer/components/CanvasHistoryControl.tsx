import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasVersion } from '../../shared/canvas'
import { CanvasArtifact, groupVersionsIntoArtifacts, locateVersion, splitArchived } from '../canvas/canvas-history'
import { relativeTime } from '../utils/relativeTime'

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

function updatedLabel(iso: string, now: number): string {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? `updated ${relativeTime(ms, now)}` : 'updated recently'
}

export default function CanvasHistoryControl({ versions, activeVersionId, onSelectVersion, onArchive, onDelete }: Props) {
  const [open, setOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
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

  // A canvas with a single version and a single artifact needs neither control.
  if (!located || (artifacts.length === 1 && located.artifact.versions.length === 1)) {
    return null
  }

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
            {isArchivedGroup ? 'ARCHIVED' : b.label}
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
            {onDelete &&
              (confirming ? (
                <button
                  type="button"
                  onClick={() => { onDelete(a); setConfirmDelete(null); setOpen(false) }}
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

  return (
    <div className="relative shrink-0 flex items-center gap-1.5" ref={rootRef}>
      {/* Per-artifact version stepper. */}
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
        <span className="px-1 tabular-nums" style={{ color: 'var(--text-secondary)' }} title={`${activeVersionId} — ${pos} of ${count}`}>
          <span style={{ color: badge.color, fontWeight: 600 }}>{badge.label.toLowerCase()}</span>{' '}
          <span style={{ color: 'var(--text-primary)' }}>{activeVersionId}</span>{' '}
          <span style={{ color: 'var(--text-muted)' }}>of {count}</span>
        </span>
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

      {/* History ▾ — pick the artifact. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="canvas-history-button"
        className="text-[12px] rounded-md border border-[var(--border-subtle)] px-2 py-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-ring"
        title="History — the artifacts on this canvas (a plan, a mockup); step versions with the ‹ › control"
      >
        History ▾
      </button>

      {open && (
        <div
          role="menu"
          data-testid="canvas-history-popover"
          className="absolute left-0 top-full mt-1 z-30 w-[300px] rounded-lg p-1.5"
          style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', boxShadow: '0 16px 40px rgba(0,0,0,0.55)' }}
        >
          <div className="px-2 py-1 text-[9.5px] font-semibold uppercase tracking-[0.09em]" style={{ color: 'var(--text-muted)' }}>
            Artifacts on this canvas
          </div>
          {live.map((a) => artifactRow(a, false))}
          {archived.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-1 text-[9.5px] font-semibold uppercase tracking-[0.09em]" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)', marginTop: 4 }}>
                Archived — legacy test builds
              </div>
              {archived.map((a) => artifactRow(a, true))}
            </>
          )}
          <div className="px-2 pt-2 pb-1 text-[10.5px]" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)', marginTop: 4 }}>
            Pick an artifact here; step its versions with ‹ ›. Tests are live and never versioned — builds saved by older betas stay under Archived.
          </div>
        </div>
      )}
    </div>
  )
}
