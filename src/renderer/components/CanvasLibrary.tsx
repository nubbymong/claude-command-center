import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CanvasLibraryFilter, CanvasLibraryRow, CanvasLibraryTab, LibraryRowKind } from '../../shared/canvas'
import { trailClockTime } from '../../shared/canvas-review-serialize'
import { useSessionStore } from '../stores/sessionStore'
import { useArmedConfirm } from '../hooks/useArmedConfirm'
import { DismissButton } from './ui/DismissButton'

/**
 * The canvas LIBRARY (v2, M4) — the project's shelf of finished and in-flight
 * artefacts.
 *
 * v1 listed CANVASES and joined its counts client-side from `listAll`. Two
 * things were wrong with that. A canvas is not what the user goes looking for:
 * one canvas accumulates a mockup run, then a plan, then a test pack, and a row
 * per canvas could only ever describe the newest of them while the rest became
 * invisible. And a client-side join cannot enforce the ownership lease — an
 * in-flight canvas is PRIVATE to the live session that rendered it, and privacy
 * decided in the renderer is not privacy.
 *
 * So v2 reads `canvas:libraryList`, which composes ARTEFACT rows in main, one
 * per artefact run, applies the search, the tab and the filter there (so
 * `truncated` means "more matched than fit" and not "more existed"), and drops
 * every row whose owner is another LIVE session unless it is completed.
 *
 * Everything on a row is a LABEL. `canvasId` + `anchorVersionId` are the only
 * things an action is addressed by, and every mutating channel re-checks
 * ownership in main — the states below decide what is worth OFFERING, never
 * what is allowed.
 *
 * NOTHING HERE IS CACHED ACROSS A LOAD. In particular `configName` is resolved
 * at read in main, against configs.json, so a renamed config renames every row
 * on the next list. A local map from canvasId to a config name would freeze the
 * old label back into the UI, which is exactly the bug the resolve-at-read rule
 * exists to prevent.
 */
export function CanvasLibrary({
  sessionId,
  onClose,
  onOpened,
  initialTab,
}: {
  sessionId: string
  onClose: () => void
  /** Called after a canvas is adopted into THIS session, so the pane can show it. */
  onOpened?: () => void
  /**
   * Which typed tab to OPEN on — the front page's per-column "See all" links
   * (Mockups, Plans, Test packs) arrive through here.
   *
   * A SEED, not a controlled value: it is read once, when the component mounts,
   * and the user's own tab presses win from then on. A prop that kept
   * reasserting itself would snap the tab back under somebody mid-browse every
   * time the parent happened to re-render.
   */
  initialTab?: CanvasLibraryTab
}) {
  const [rows, setRows] = useState<CanvasLibraryRow[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  // `useState`'s initial value IS "applied once on mount" — no effect, so there
  // is no first render on the wrong tab and no re-seed on a prop change.
  const [tab, setTab] = useState<CanvasLibraryTab>(initialTab ?? 'all')
  const [filter, setFilter] = useState<CanvasLibraryFilter | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [expanded, setExpanded] = useState<string[]>([])
  const [confirming, setConfirming] = useState<string | null>(null)
  const [bulkConfirming, setBulkConfirming] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  // Double-click-proofing (#456): each confirm kind guards its own arm moment.
  const deleteConfirm = useArmedConfirm(confirming)
  const bulkConfirm = useArmedConfirm(bulkConfirming ? 'bulk' : null)
  const openSessionIds = useSessionStore((s) => s.sessions.map((x) => x.id).join(','))

  /** The typed query, debounced into the IPC parameter. Search runs in MAIN
   *  (titles, pack names and note text), so every keystroke would otherwise be
   *  a bounded read of every review store on the project. */
  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedQuery(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  const load = useCallback(async () => {
    try {
      // sessionId scopes the list to THIS project AND names the caller, whose
      // liveness decides which in-flight rows exist at all. `openTileSessionIds`
      // is a hint that can only EXTEND liveness — it never shortens another
      // session's, so it cannot be used to make somebody else's work visible.
      const res = await window.electronAPI.canvas.libraryList({
        sessionId,
        openTileSessionIds: openSessionIds ? openSessionIds.split(',') : [],
        ...(appliedQuery ? { query: appliedQuery } : {}),
        tab,
        ...(filter ? { filter } : {}),
        sort: 'recent',
      })
      setRows(Array.isArray(res?.rows) ? res.rows : [])
      setTruncated(!!res?.truncated)
    } catch {
      setRows([])
      setTruncated(false)
      setError('The library could not be read.')
    }
  }, [openSessionIds, sessionId, appliedQuery, tab, filter])

  useEffect(() => { void load() }, [load])

  /** `/` focuses the box, Esc clears it — the two shortcuts a list with a
   *  search box is expected to have. Both stand down while the user is typing
   *  somewhere else, and Esc inside the box clears rather than closing the
   *  Library, because a half-typed query is the thing the user meant to undo. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      if (e.key === '/' && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (e.key === 'Escape' && target === searchRef.current) {
        e.preventDefault()
        e.stopPropagation()
        setQuery('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const rowKey = useCallback((r: CanvasLibraryRow) => `${r.canvasId}::${r.anchorVersionId}`, [])

  /** Selection survives a reload only for rows that are still THERE and still
   *  the user's own — a row that went read-only, archived out of the tab or was
   *  deleted elsewhere must not stay silently in a bulk delete. */
  useEffect(() => {
    if (!rows) return
    const selectable = new Set(rows.filter((r) => r.ownedByThisSession && !r.readOnly).map(rowKey))
    setSelected((prev) => {
      const next = prev.filter((k) => selectable.has(k))
      return next.length === prev.length ? prev : next
    })
  }, [rows, rowKey])

  const selectedRows = useMemo(
    () => (rows ?? []).filter((r) => selected.includes(rowKey(r))),
    [rows, selected, rowKey],
  )

  const fail = useCallback((message: string) => {
    setError(message)
  }, [])

  /**
   * Open one of the caller's OWN canvases here.
   *
   * `canvas:reclaim`, deliberately, and not `canvas:resume`: this session
   * already owns the row (the button is offered nowhere else), so nothing is
   * being taken from anybody. Reclaim re-points the session's CURRENT canvas
   * and transfers no ownership; resume is the first-wins adopt of an OWNERLESS
   * canvas, and it lives on the front page where the confirm can say what a
   * dismiss would delete.
   */
  const openHere = useCallback(async (row: CanvasLibraryRow) => {
    setBusy(row.canvasId)
    setError(null)
    try {
      const res = await window.electronAPI.canvas.reclaim({
        sessionId,
        canvasId: row.canvasId,
        openTileSessionIds: openSessionIds ? openSessionIds.split(',') : [],
      })
      if (res?.ok) {
        onOpened?.()
        onClose()
      } else {
        fail('That canvas could not be opened here — it may have moved to another session.')
        void load()
      }
    } catch {
      fail('That canvas could not be opened here.')
    } finally {
      setBusy(null)
    }
  }, [sessionId, openSessionIds, onOpened, onClose, fail, load])

  /** Look at a completed canvas this session does not own. The pane takes over
   *  in READ-ONLY mode; nothing about ownership moves. */
  const view = useCallback((row: CanvasLibraryRow) => {
    requestCanvasReadonlyView(sessionId, row.canvasId)
    onClose()
  }, [sessionId, onClose])

  /** Put a completed canvas back in play (#476) — owner only, by invariant:
   *  a foreign canvas's sign-off is its owner's to undo. */
  const reopen = useCallback(async (row: CanvasLibraryRow) => {
    setBusy(row.canvasId)
    setError(null)
    try {
      const res = await window.electronAPI.canvas.completeReopen({ sessionId, canvasId: row.canvasId })
      if (res?.ok) await load()
      else fail('That canvas could not be reopened.')
    } catch {
      fail('That canvas could not be reopened.')
    } finally {
      setBusy(null)
    }
  }, [sessionId, load, fail])

  /** Archive is per ARTEFACT and reversible: it sets the flag on every version
   *  of the run the anchor belongs to. Nothing on disk is removed. Owner-guarded
   *  in main since M4 — `sessionId` is who is asking, not who may. */
  const archive = useCallback(async (targets: CanvasLibraryRow[], archived: boolean) => {
    setError(null)
    setBusy(targets[0]?.canvasId ?? 'bulk')
    let refused = false
    try {
      for (const row of targets) {
        const res = await window.electronAPI.canvas.archiveArtifact({
          sessionId,
          canvasId: row.canvasId,
          versionId: row.anchorVersionId,
          archived,
          openTileSessionIds: openSessionIds ? openSessionIds.split(',') : [],
        })
        if (!res?.ok) refused = true
      }
      if (refused) fail(archived ? 'Some of that could not be archived.' : 'Some of that could not be restored.')
      await load()
    } catch {
      fail(archived ? 'That could not be archived.' : 'That could not be restored.')
    } finally {
      setBusy(null)
    }
  }, [sessionId, openSessionIds, load, fail])

  /**
   * Delete one artefact run — its versions, their files and their notes.
   *
   * `deleteArtifact` refuses when the run is the canvas's ONLY artefact,
   * because that is "delete the canvas", a different operation with its own
   * path discipline. The Library is where that operation lives, so the refusal
   * is the hand-off rather than an error: the same armed confirm carries
   * through to `deleteCanvas`.
   */
  const remove = useCallback(async (targets: CanvasLibraryRow[]) => {
    setError(null)
    setBusy(targets[0]?.canvasId ?? 'bulk')
    let refused = false
    try {
      const openTileSessionIds = openSessionIds ? openSessionIds.split(',') : []
      for (const row of targets) {
        const res = await window.electronAPI.canvas.deleteArtifact({
          sessionId,
          canvasId: row.canvasId,
          versionId: row.anchorVersionId,
          openTileSessionIds,
        })
        if (!res?.ok) {
          if (res?.reason === 'only-artifact') {
            const gone = await window.electronAPI.canvas.deleteCanvas({ sessionId, canvasId: row.canvasId, openTileSessionIds })
            if (!gone?.ok) refused = true
          } else {
            refused = true
          }
        }
      }
      if (refused) fail('Some of that could not be deleted — it may belong to a session that is still running.')
      await load()
    } catch {
      fail('That could not be deleted.')
    } finally {
      setBusy(null)
      setConfirming(null)
      setBulkConfirming(false)
      setSelected([])
    }
  }, [sessionId, openSessionIds, load, fail])

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }, [])

  const toggleExpand = useCallback((key: string) => {
    setExpanded((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }, [])

  const count = rows?.length ?? 0

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-[var(--surface-stage)]" data-testid="canvas-library">
      {/* Header — the way out, the name, and how much is on the shelf. The
          count says `this project` out loud because the Library is project
          scoped and the pane above it is session scoped; without the words the
          number reads as "everything on this machine". */}
      <div
        className="flex items-center gap-2.5 px-4 py-2.5 shrink-0"
        style={{ background: 'var(--surface-chrome)', borderBottom: '1px solid var(--border-subtle)' }}
        data-testid="canvas-library-header"
      >
        {/* The ONE dismiss control (M2), as a back affordance: the Library is a
            full-pane overlay reached FROM the canvas, so the gesture that
            leaves it is "back", not "delete this". */}
        <button
          onClick={onClose}
          className="shrink-0 flex items-center gap-1 text-[12px] rounded-lg px-3 py-[5px] focus-ring transition-colors"
          style={{ background: 'var(--surface-panel)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
          title="Back to the canvas"
          data-testid="canvas-library-back"
        >
          <span aria-hidden className="text-[13px] leading-none">&lsaquo;</span> Canvas
        </button>
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>Library</span>
        <span className="font-mono text-[11px]" style={{ color: 'var(--text-muted)' }} data-testid="canvas-library-count">
          {rows === null ? '' : `${count} artefact${count === 1 ? '' : 's'} · this project`}
          {truncated && ' · more not shown'}
        </span>
      </div>

      {error && (
        <div className="px-4 py-1.5 text-[11px] shrink-0" style={{ color: 'var(--status-danger)' }} data-testid="canvas-library-error">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[880px] mx-auto px-6 pt-4 pb-14">
          {/* Toolbar — search over the row, then tabs, chips and the sort. */}
          <div className="flex flex-col gap-3 mb-3.5" data-testid="canvas-library-toolbar">
            <div
              className="flex items-center gap-2.5 rounded-[10px] px-3 py-2"
              style={{ background: 'var(--surface-panel)', border: '1px solid var(--border-subtle)' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className="shrink-0" style={{ color: 'var(--text-muted)' }}>
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search titles and notes"
                aria-label="Search the library"
                className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[13px]"
                style={{ color: 'var(--text-primary)' }}
                data-testid="canvas-library-search"
              />
              <kbd
                className="font-mono text-[10px] rounded px-1.5 shrink-0"
                style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
                aria-hidden
              >
                /
              </kbd>
            </div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <div
                className="flex rounded-[9px] overflow-hidden"
                style={{ border: '1px solid var(--border-subtle)' }}
                role="group"
                aria-label="Artefact kind"
                data-testid="canvas-library-tabs"
              >
                {TABS.map((t) => (
                  <button
                    key={t.value}
                    onClick={() => { setTab(t.value); setConfirming(null) }}
                    aria-pressed={tab === t.value}
                    className="text-[12px] px-3.5 py-1.5 focus-ring transition-colors"
                    style={tab === t.value
                      ? { background: 'var(--surface-raised)', color: 'var(--text-primary)', fontWeight: 650 }
                      : { color: 'var(--text-secondary)' }}
                    data-testid={`canvas-library-tab-${t.value}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-1.5" role="group" aria-label="Filter" data-testid="canvas-library-filters">
                {FILTERS.map((f) => {
                  const on = filter === f.value
                  return (
                    <button
                      key={f.value}
                      onClick={() => { setFilter(on ? null : f.value); setConfirming(null) }}
                      aria-pressed={on}
                      className="text-[11px] px-2.5 py-1 rounded-full focus-ring transition-colors"
                      style={on
                        ? {
                            color: 'var(--accent-tip)',
                            borderWidth: 1,
                            borderStyle: 'solid',
                            borderColor: 'color-mix(in srgb, var(--accent-tip) 45%, transparent)',
                            background: 'color-mix(in srgb, var(--accent-tip) 9%, transparent)',
                          }
                        : { color: 'var(--text-muted)', borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--border-subtle)' }}
                      data-testid={`canvas-library-filter-${f.value}`}
                    >
                      {f.label}
                    </button>
                  )
                })}
              </div>
              {/* Sort is stated, not offered: main sorts needs-you first and
                  then by recency, and a control with one option is furniture. */}
              <span className="ml-auto text-[11.5px]" style={{ color: 'var(--text-muted)' }} data-testid="canvas-library-sort">
                Sort <b style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>Recent</b>
              </span>
            </div>
          </div>

          {rows !== null && rows.length === 0 && (
            <p className="py-8 text-[12px] text-center" style={{ color: 'var(--text-secondary)' }} data-testid="canvas-library-empty">
              {emptyWords(appliedQuery, tab, filter)}
            </p>
          )}

          <div className="flex flex-col gap-[7px]" data-testid="canvas-library-rows">
            {(rows ?? []).map((row) => {
              const key = rowKey(row)
              const isSelected = selected.includes(key)
              const isExpanded = expanded.includes(key)
              const packRow = row.kind === 'pack'
              const rowBusy = busy === row.canvasId
              return (
                <div
                  key={key}
                  className="rounded-[11px] px-3 py-2.5"
                  style={{
                    background: 'var(--surface-panel)',
                    border: `1px solid ${isSelected ? 'color-mix(in srgb, var(--brand) 55%, var(--border-subtle))' : 'var(--border-subtle)'}`,
                  }}
                  data-testid="canvas-library-row"
                  data-canvas-id={row.canvasId}
                  data-row-kind={row.kind}
                >
                  <div className="flex items-center gap-2.5">
                    {/* Only the user's OWN rows join a selection: the bulk bar
                        does archive and delete, and neither is offered on
                        someone else's finished work. A read-only row has no
                        checkbox at all rather than a disabled one, because a
                        disabled control still reads as "this could apply". */}
                    {row.ownedByThisSession && !row.readOnly ? (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(key)}
                        aria-label={`Select ${row.title}`}
                        className="shrink-0 w-[15px] h-[15px] focus-ring"
                        data-testid="canvas-library-select"
                      />
                    ) : (
                      <span className="shrink-0 w-[15px]" aria-hidden />
                    )}
                    <KindIcon kind={row.kind} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className="min-w-0 truncate text-[13px] font-semibold"
                          style={{ color: 'var(--text-primary)' }}
                          title={row.title}
                          data-testid="canvas-library-title"
                        >
                          {row.title}
                        </span>
                        <VerdictBadge row={row} />
                        {/* Peach for what is OWED, muted for what is merely
                            recorded — the same split the front page uses. */}
                        {row.owed && (
                          <span className="text-[11px] shrink-0" style={{ color: 'var(--accent-tip)' }} data-testid="canvas-library-owed">
                            {row.owed}
                          </span>
                        )}
                        {!row.owed && packRow && (
                          <span className="text-[11px] shrink-0" style={{ color: packNoteTone(row) }} data-testid="canvas-library-pack-notes">
                            {packNoteWords(row)}
                          </span>
                        )}
                      </div>
                      <div
                        className="flex items-center gap-1.5 mt-[3px] font-mono text-[10.5px]"
                        style={{ color: 'var(--text-muted)' }}
                        data-testid="canvas-library-audit"
                      >
                        {auditParts(row).map((part, i) => (
                          // Keyed by POSITION as well as text: two parts can be
                          // the same string (a config named after its account),
                          // and a duplicate key drops one of them.
                          <React.Fragment key={`${i}-${part}`}>
                            {i > 0 && <span aria-hidden>·</span>}
                            <span className="truncate">{part}</span>
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {packRow && !!row.evidence?.length && (
                        // The caret is a TEXT glyph, exactly as on the History
                        // trigger — house style, and the repo takes no emoji in
                        // JSX. It says which way the row is about to move.
                        <RowAction onClick={() => toggleExpand(key)} testId="canvas-library-expand">
                          {isExpanded ? 'Collapse ▴' : 'Expand ▾'}
                        </RowAction>
                      )}
                      {/* READ-ONLY rows get a read-back and nothing else — the
                          row's own `readOnly` flag, composed in main, not a
                          permission the renderer worked out.

                          WHICH read-back depends on the kind, and the reason is
                          what is actually readable. A mockup or a plan is a
                          DOCUMENT: main can serve it to a read-only pane. A test
                          pack is its NOTES, and no channel hands a non-owner
                          another session's annotations — `canvas:reviewGetState`
                          is keyed by session, so it answers about the caller's
                          own canvas. What IS readable for a pack is its evidence
                          images (`canvas:evidenceRead` is owner-or-project), and
                          that is exactly what Expand shows. So a pack reads back
                          in place rather than opening a pane that could only say
                          "no notes" about a run that has plenty. */}
                      {row.readOnly ? (
                        !packRow && (
                          <RowAction onClick={() => view(row)} testId="canvas-library-view">
                            View
                          </RowAction>
                        )
                      ) : row.ownedByThisSession ? (
                        <>
                          {row.completed ? (
                            !packRow && (
                              <RowAction onClick={() => view(row)} testId="canvas-library-view">
                                View
                              </RowAction>
                            )
                          ) : (
                            <RowAction onClick={() => void openHere(row)} disabled={rowBusy} testId="canvas-library-open-here">
                              Open
                            </RowAction>
                          )}
                          {row.completed && (
                            <RowAction
                              onClick={() => void reopen(row)}
                              disabled={rowBusy}
                              testId="canvas-library-reopen"
                              title="Put this canvas back in play — clears the sign-off"
                            >
                              Reopen
                            </RowAction>
                          )}
                          <RowAction
                            onClick={() => void archive([row], !row.archived)}
                            disabled={rowBusy}
                            testId="canvas-library-archive"
                          >
                            {row.archived ? 'Restore' : 'Archive'}
                          </RowAction>
                          {confirming === key ? (
                            <button
                              ref={deleteConfirm.confirmRef}
                              onClick={deleteConfirm.guarded(() => void remove([row]))}
                              disabled={rowBusy}
                              className="shrink-0 text-[11.5px] rounded-[7px] px-2.5 py-[5px] focus-ring disabled:opacity-50"
                              style={{
                                color: 'var(--status-danger)',
                                background: 'color-mix(in srgb, var(--status-danger) 15%, transparent)',
                                border: '1px solid color-mix(in srgb, var(--status-danger) 50%, transparent)',
                              }}
                              data-testid="canvas-library-confirm-delete"
                            >
                              Delete {row.versionLabel} and its notes
                            </button>
                          ) : (
                            <RowAction
                              onClick={() => { setConfirming(key); setError(null) }}
                              danger
                              testId="canvas-library-delete"
                            >
                              Delete
                            </RowAction>
                          )}
                        </>
                      ) : (
                        // Ownerless in-flight work on this project: visible, but
                        // not the Library's to open. Resuming it is an explicit,
                        // first-wins gesture and it lives on the front page,
                        // where the confirm can say what a dismiss would delete.
                        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }} data-testid="canvas-library-unowned">
                          another session&apos;s work
                        </span>
                      )}
                    </div>
                  </div>

                  {packRow && isExpanded && (
                    <div className="flex gap-2.5 flex-wrap pt-3 pl-[42px]" data-testid="canvas-library-evidence">
                      {(row.evidence ?? []).map((item, i) => (
                        <EvidenceCard
                          key={`${item.at}-${i}`}
                          sessionId={sessionId}
                          canvasId={row.canvasId}
                          note={item.note}
                          route={item.route}
                          at={item.at}
                          shotPath={item.shotPath}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {selectedRows.length > 0 && (
            <div
              className="sticky bottom-0 mt-3.5 flex items-center gap-2.5 rounded-[11px] px-3.5 py-2.5"
              style={{
                background: 'var(--surface-chrome)',
                border: '1px solid var(--border-strong)',
                boxShadow: '0 -8px 24px rgba(0,0,0,.35)',
              }}
              data-testid="canvas-library-bulk"
            >
              <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                <b>{selectedRows.length} selected</b>
              </span>
              <RowAction onClick={() => void archive(selectedRows, true)} testId="canvas-library-bulk-archive">
                Archive
              </RowAction>
              {bulkConfirming ? (
                <button
                  ref={bulkConfirm.confirmRef}
                  onClick={bulkConfirm.guarded(() => void remove(selectedRows))}
                  className="shrink-0 text-[11.5px] rounded-[7px] px-2.5 py-[5px] focus-ring"
                  style={{
                    color: 'var(--status-danger)',
                    background: 'color-mix(in srgb, var(--status-danger) 15%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--status-danger) 50%, transparent)',
                  }}
                  data-testid="canvas-library-bulk-confirm-delete"
                >
                  Delete {selectedRows.length} and their notes
                </button>
              ) : (
                <RowAction onClick={() => { setBulkConfirming(true); setError(null) }} danger testId="canvas-library-bulk-delete">
                  Delete…
                </RowAction>
              )}
              <div className="flex-1" />
              <DismissButton
                onClick={() => { setSelected([]); setBulkConfirming(false) }}
                text="Clear"
                label="Clear the selection"
                data-testid="canvas-library-bulk-clear"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** How long the typed query waits before it becomes an IPC parameter. */
const SEARCH_DEBOUNCE_MS = 250

const TABS: { value: CanvasLibraryTab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'mockup', label: 'Mockups' },
  { value: 'plan', label: 'Plans' },
  { value: 'pack', label: 'Test packs' },
]

const FILTERS: { value: CanvasLibraryFilter; label: string }[] = [
  { value: 'needs-you', label: 'Needs you' },
  { value: 'open', label: 'Open' },
  { value: 'signed-off', label: 'Signed off' },
  { value: 'archived', label: 'Archived' },
]

/** A row's hover action. One shape for all of them so the row never becomes a
 *  ladder of slightly different buttons. */
function RowAction({
  onClick,
  children,
  disabled,
  danger,
  title,
  testId,
}: {
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
  danger?: boolean
  title?: string
  testId: string
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="shrink-0 text-[11.5px] rounded-[7px] px-2.5 py-[5px] focus-ring transition-colors disabled:opacity-50 disabled:cursor-default"
      style={{
        color: danger ? 'var(--status-danger)' : 'var(--text-secondary)',
        border: `1px solid ${danger ? 'color-mix(in srgb, var(--status-danger) 35%, transparent)' : 'var(--border-subtle)'}`,
        background: 'transparent',
      }}
      data-testid={testId}
    >
      {children}
    </button>
  )
}

/** The three kinds, drawn: a screen for a mockup, a document for a plan, a
 *  flask for a test pack. Stroke-only SVG — the repo takes no emoji in JSX. */
function KindIcon({ kind }: { kind: LibraryRowKind }): React.JSX.Element {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: 'shrink-0',
    style: { color: 'var(--text-muted)' },
  }
  const label = kind === 'pack' ? 'Test pack' : kind === 'plan' ? 'Plan' : 'Mockup'
  if (kind === 'pack') {
    return (
      <svg {...common} role="img" aria-label={label}>
        <path d="M6 2v4L2.5 12a1.5 1.5 0 0 0 1.3 2.2h8.4A1.5 1.5 0 0 0 13.5 12L10 6V2" />
        <path d="M5 2h6" />
      </svg>
    )
  }
  if (kind === 'plan') {
    return (
      <svg {...common} role="img" aria-label={label}>
        <path d="M4 2.5h8v11H4z" />
        <path d="M6 5.5h4M6 8h4M6 10.5h2.5" />
      </svg>
    )
  }
  return (
    <svg {...common} role="img" aria-label={label}>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1" />
      <path d="M5 14h6" />
    </svg>
  )
}

/**
 * The row's ONE state badge.
 *
 * Strictly derived from what is recorded, and deliberately one badge rather
 * than three: ARCHIVED is the dominant state (an archived run is out of play
 * whatever its verdict was), SIGNED OFF is next (the subject is closed), and
 * only then does the anchor version's own verdict speak. The verdict a
 * sign-off rode in on is not lost — it is the badge's tooltip.
 */
function VerdictBadge({ row }: { row: CanvasLibraryRow }): React.JSX.Element {
  const base = 'shrink-0 text-[8.5px] font-extrabold uppercase tracking-[0.05em] rounded-[5px] px-[7px] py-[2.5px]'
  if (row.archived) {
    return (
      <span
        className={base}
        style={{ color: 'var(--text-muted)', background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
        title={`Archived — ${row.verdict}`}
        data-testid="canvas-library-badge"
      >
        Archived
      </span>
    )
  }
  if (row.completed) {
    return (
      <span
        className={base}
        style={{
          color: 'var(--status-success)',
          background: 'color-mix(in srgb, var(--status-success) 13%, transparent)',
          border: '1px solid color-mix(in srgb, var(--status-success) 38%, transparent)',
        }}
        title={`Signed off — ${row.verdict}`}
        data-testid="canvas-library-badge"
      >
        Signed off
      </span>
    )
  }
  const tone = verdictTone(row.verdict)
  return (
    <span
      className={base}
      style={{ color: 'var(--surface-chrome)', background: tone }}
      title={row.verdict}
      data-testid="canvas-library-badge"
    >
      {row.verdict}
    </span>
  )
}

/** Which colour a verdict word wears. The WORDS come from the shared
 *  `verdictLabel` in main, so this maps rather than decides. */
function verdictTone(verdict: string): string {
  if (verdict.startsWith('APPROVED') || verdict.startsWith('PASSED')) return 'var(--status-success)'
  if (verdict.startsWith('REJECTED') || verdict.startsWith('FAILED')) return 'var(--status-danger)'
  if (verdict === 'OPEN' || verdict === 'DRAFT') return 'var(--accent-tip)'
  return 'var(--text-muted)'
}

/**
 * What a collapsed PACK row says about its notes.
 *
 * A run that PASSED carries observations; a run that FAILED carries defects —
 * that is the same rule the composer and the recall view apply, so the word is
 * derived, not guessed. A run with no verdict yet is neither: its notes are
 * just notes.
 */
function packNoteWords(row: CanvasLibraryRow): string {
  const n = row.noteCount
  if (n <= 0) return 'no notes'
  if (row.verdict.startsWith('PASSED') || row.verdict.startsWith('APPROVED')) return `${n} observation${n === 1 ? '' : 's'}`
  if (row.verdict.startsWith('FAILED') || row.verdict.startsWith('REJECTED')) return `${n} defect${n === 1 ? '' : 's'}`
  return `${n} note${n === 1 ? '' : 's'}`
}

function packNoteTone(row: CanvasLibraryRow): string {
  return row.verdict.startsWith('FAILED') || row.verdict.startsWith('REJECTED') ? 'var(--accent-tip)' : 'var(--text-muted)'
}

/**
 * The mono audit line: kind · version · config · account · session · when.
 *
 * ABSENT PARTS ARE DROPPED, never filled with a placeholder. A row that cannot
 * say which account rendered it says nothing about accounts — an "unknown"
 * would be a claim, and the whole line is provenance the user may be reading to
 * work out who did what.
 */
function auditParts(row: CanvasLibraryRow): string[] {
  const parts: string[] = [KIND_WORDS[row.kind], row.versionLabel]
  if (row.configName) parts.push(`cfg ${row.configName}`)
  if (row.audit.account) parts.push(row.audit.account)
  if (row.audit.sessionLabel) parts.push(row.audit.sessionLabel)
  parts.push(`${whenPrefix(row)} ${relTime(row.audit.when)}`)
  return parts
}

const KIND_WORDS: Record<LibraryRowKind, string> = {
  mockup: 'mockup',
  plan: 'plan',
  pack: 'test pack',
}

/** What the timestamp on a row IS. The four states say different things about
 *  the same instant, and "updated" on an archived row is the wrong word. */
function whenPrefix(row: CanvasLibraryRow): string {
  if (row.archived) return 'archived'
  if (row.completed) return 'signed off'
  if (row.kind === 'pack') return 'ran'
  return 'updated'
}

/** The empty state, in the words of whatever narrowed the list. */
function emptyWords(query: string, tab: CanvasLibraryTab, filter: CanvasLibraryFilter | null): string {
  if (query) return `Nothing here matches “${query}”.`
  if (filter === 'needs-you') return 'Nothing in this project is waiting on you.'
  if (filter === 'open') return 'Nothing is open here — every artefact has had its verdict.'
  if (filter === 'signed-off') return 'Nothing has been signed off in this project yet.'
  if (filter === 'archived') return 'Nothing is archived here.'
  if (tab === 'mockup') return 'No mockups yet. Ask for one and it will show up here.'
  if (tab === 'plan') return 'No plans yet. Ask for a plan of work before it starts.'
  if (tab === 'pack') return 'No test packs yet. Point the canvas at a built site to run one.'
  return 'Nothing here yet. Ask for a mockup, or point the canvas at a built site, and it will show up.'
}

/**
 * One evidence card in an expanded pack row: the screen as it was, the note,
 * and where and when it was written.
 *
 * The thumb is read LAZILY and exactly once per card — mounting the card is the
 * request, unmounting stops mattering. Reading every shot of every pack the
 * moment the Library opened would decode megabytes of PNG for rows the user
 * never looks at.
 */
function EvidenceCard({
  sessionId,
  canvasId,
  note,
  route,
  at,
  shotPath,
}: {
  sessionId: string
  canvasId: string
  note: string
  route?: string
  at: string
  shotPath?: string
}): React.JSX.Element {
  const [shot, setShot] = useState<string | null>(null)
  useEffect(() => {
    if (!shotPath) return
    let live = true
    void (async () => {
      try {
        const out = await window.electronAPI.canvas.evidenceRead({ sessionId, canvasId, path: shotPath })
        if (live) setShot(out?.dataUrl ?? null)
      } catch {
        if (live) setShot(null)
      }
    })()
    return () => {
      live = false
    }
  }, [sessionId, canvasId, shotPath])

  return (
    <div
      className="w-[172px] rounded-[9px] overflow-hidden"
      style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}
      data-testid="canvas-library-evidence-card"
    >
      <div className="h-[86px] flex items-center justify-center" style={{ background: 'var(--surface-stage)' }}>
        {shot ? (
          <img src={shot} alt="" className="block w-full h-full object-cover" data-testid="canvas-library-evidence-shot" />
        ) : (
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {shotPath ? 'no screen kept' : 'written without a screen'}
          </span>
        )}
      </div>
      <div className="px-2.5 pt-2 pb-2.5">
        <div className="text-[11px] leading-[1.45] line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
          {note}
        </div>
        <div className="font-mono text-[9.5px] mt-1.5" style={{ color: 'var(--text-muted)' }}>
          {[route, trailClockTime(at)].filter(Boolean).join(' · ')}
        </div>
      </div>
    </div>
  )
}

/** Short relative time; absolute dates read as noise in a list this dense. */
function relTime(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return 'unknown'
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

/* ── the read-only VIEW request ──────────────────────────────────────────────
 *
 * The Library is mounted in two places — inside the pane (over a live canvas)
 * and inside the front page — and only the PANE can host the read-only surface.
 * A prop from the parent would therefore work in one of the two mounts, so the
 * request is published here instead and the pane subscribes.
 *
 * Deliberately one slot per session and nothing else: it carries a canvas id
 * that main will re-check on `canvas:getReadonly` anyway. It is a NAVIGATION
 * intent, never an authorization — the renderer cannot grant itself a read by
 * writing into it.
 */
let readonlyRequests: Record<string, string | undefined> = {}
const readonlyListeners = new Set<() => void>()

function publishReadonly(): void {
  for (const fn of readonlyListeners) fn()
}

/** The Library asks the pane to open a canvas read-only. */
export function requestCanvasReadonlyView(sessionId: string, canvasId: string): void {
  readonlyRequests = { ...readonlyRequests, [sessionId]: canvasId }
  publishReadonly()
}

/** The pane is done with it (the user went back, or the read failed). */
export function clearCanvasReadonlyView(sessionId: string): void {
  if (readonlyRequests[sessionId] === undefined) return
  const next = { ...readonlyRequests }
  delete next[sessionId]
  readonlyRequests = next
  publishReadonly()
}

/** Which canvas this session has been asked to show read-only, if any. */
export function useCanvasReadonlyRequest(sessionId: string): string | null {
  return useSyncExternalStore(
    (cb) => {
      readonlyListeners.add(cb)
      return () => {
        readonlyListeners.delete(cb)
      }
    },
    () => readonlyRequests[sessionId] ?? null,
    () => null,
  )
}

/** Test seam: the request slot is module state, so a suite that opened one must
 *  be able to put it back. */
export function _resetCanvasReadonlyRequestsForTest(): void {
  readonlyRequests = {}
  publishReadonly()
}
