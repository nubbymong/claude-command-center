import React, { useCallback, useEffect, useRef, useState } from 'react'
import ExcalidrawPane from './ExcalidrawPane'
import { useCanvasStore } from '../stores/canvasStore'
import { useSessionStore } from '../stores/sessionStore'
import { relativeTime } from '../utils/relativeTime'
import type { ReclaimableCanvas } from '../../shared/canvas'
import { CanvasLibrary } from './CanvasLibrary'

interface Props {
  sessionId: string
  onClose: () => void
}

/** JetBrains Mono ships with the app (@font-face in styles.css) but Tailwind's
 *  `font-mono` resolves to the generic stack, so mono is named explicitly —
 *  the same way ui/Kbd and ui/MetricChip do it. */
const MONO = "'JetBrains Mono', ui-monospace, monospace"

/** What one keypress asks the agent to do. Typed into the terminal WITHOUT a
 *  newline — the user reads it, can edit it, and presses Enter themselves.
 *  Plain words, no tool names: the agent-canvas skill (canvas-plugin.ts)
 *  carries the workflow — htmlPath, data-ux-ids, self-check, hand-back — so
 *  the user never has to speak MCP (owner feedback 2026-08-14). */
const STARTER_PROMPT =
  'Show me a design mockup of what you are building on my Agent Canvas.'

/** The loop, in order. `you` marks the steps the USER owns — those titles are
 *  brand blue so the division of labour reads at a glance, and the return arc
 *  below the track closes 05 back onto 02. */
const LOOP_STEPS: Array<{ title: string; detail: string; you: boolean }> = [
  { title: 'Agent renders', detail: 'a real page appears here', you: false },
  { title: 'You annotate', detail: 'click elements, drag regions, sketch', you: true },
  { title: 'Submit review', detail: 'your notes land in the chat', you: true },
  { title: 'Agent revises', detail: 'it reads every note and re-renders', you: false },
  { title: 'You resolve', detail: 'approve or follow up, note by note', you: true },
]

/**
 * Corner crop mark. Registration marks are the vernacular of proofing and
 * redlines — which is literally what this surface does: a sheet of glass laid
 * over someone else's work. The one decorative move on the sheet, and it earns
 * its place by naming the product's own metaphor.
 */
function RegistrationMark({ corner }: { corner: 'tl' | 'tr' | 'bl' | 'br' }) {
  const top = corner[0] === 't'
  const left = corner[1] === 'l'
  const box: React.CSSProperties = { position: 'absolute', width: 13, height: 13, pointerEvents: 'none' }
  if (top) box.top = 11
  else box.bottom = 11
  if (left) box.left = 11
  else box.right = 11

  const rule: React.CSSProperties = { position: 'absolute', background: 'var(--border-strong)' }
  const horizontal: React.CSSProperties = { ...rule, left: 0, width: 13, height: 1 }
  if (top) horizontal.top = 0
  else horizontal.bottom = 0
  const vertical: React.CSSProperties = { ...rule, top: 0, width: 1, height: 13 }
  if (left) vertical.left = 0
  else vertical.right = 0

  return (
    <span aria-hidden="true" style={box}>
      <span style={horizontal} />
      <span style={vertical} />
    </span>
  )
}

/** Shared ghost-button treatment for the sheet's secondary actions. */
const GHOST_CLASS =
  'shrink-0 rounded-md px-3 py-2 text-[12px] font-medium bg-[var(--surface-panel)] ' +
  'border border-[var(--border-subtle)] text-[var(--text-secondary)] ' +
  'hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] ' +
  'disabled:opacity-40 transition-colors focus-ring'

/** The armed delete confirm — same geometry as GHOST_CLASS, danger colours
 *  (the library's own confirm recipe). */
const DANGER_CLASS =
  'shrink-0 rounded-md px-3 py-2 text-[12px] font-medium ' +
  'bg-[color-mix(in_srgb,var(--status-danger)_15%,transparent)] ' +
  'border border-[color-mix(in_srgb,var(--status-danger)_50%,transparent)] ' +
  'text-[var(--status-danger)] hover:bg-[color-mix(in_srgb,var(--status-danger)_25%,transparent)] ' +
  'disabled:opacity-40 transition-colors focus-ring'

/**
 * The Agent Canvas landing (owner feedback 2026-08-13): with nothing rendered
 * yet, the pane used to fall straight back to the old Draw sketchpad —
 * indistinguishable from the feature it replaced, teaching nothing. This is
 * the empty state's actual job: say what the surface IS, put the first render
 * one keypress away, and keep the classic sketchpad one click away (spec D2 —
 * old Draw behaviour is preserved, it just is not the greeting).
 *
 * Visually the empty state IS the canvas, unfilled: the same bordered sheet
 * with the same registration marks that a rendered version will occupy. It
 * teaches the surface by being it rather than describing it from a card.
 */
export default function CanvasEmptyState({ sessionId, onClose }: Props) {
  const emptyView = useCanvasStore((s) => s.bySessionId[sessionId]?.emptyView ?? 'intro')
  const setEmptyView = useCanvasStore((s) => s.setEmptyView)
  const [typed, setTyped] = useState(false)
  const [copied, setCopied] = useState(false)
  const [controlsOpen, setControlsOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [reclaimable, setReclaimable] = useState<ReclaimableCanvas[]>([])
  const [reclaiming, setReclaiming] = useState<string | null>(null)
  // Delete on the reclaim rows (#452): the front page has no top bar, so
  // before this the only way to be rid of an old canvas from here was to
  // open the library. Same two-step confirm + IPC as the library's delete.
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const refreshCanvas = useCanvasStore((s) => s.refresh)

  // What this session could take back. A pure read — nothing moves until the
  // user clicks Reopen.
  //
  // The open tiles go WITH the ask. Main has no reliable way to tell that a
  // session whose PTY exited still has a tile on screen (the saved-tile file
  // exists only between a graceful Save & Close and the next restore), so it
  // was offering canvases whose own tile was open and visible. The renderer is
  // the only party that knows, and the hint can only shorten the list.
  //
  // Callable, not just an effect: the library overlay can delete a canvas this
  // list still shows, and a stale row's Delete would then dead-end on a
  // truthful-but-inverted "could not be deleted". The epoch keeps overlapping
  // loads last-write-wins.
  const reclaimEpoch = useRef(0)
  const loadReclaimable = useCallback(async () => {
    const epoch = ++reclaimEpoch.current
    const openTileSessionIds = useSessionStore.getState().sessions.map((s) => s.id)
    try {
      const list = await window.electronAPI.canvas.listReclaimable({ sessionId, openTileSessionIds })
      if (reclaimEpoch.current === epoch) setReclaimable(Array.isArray(list) ? list : [])
    } catch {
      /* nothing to offer is the safe default */
    }
  }, [sessionId])

  useEffect(() => {
    void loadReclaimable()
  }, [loadReclaimable])

  const reclaim = useCallback(
    async (canvasId: string) => {
      setReclaiming(canvasId)
      setDeleteError(null)
      try {
        // Re-read the tiles at CLICK time, not at list time: main applies the
        // same rule on both calls and the truth may have changed in between.
        const openTileSessionIds = useSessionStore.getState().sessions.map((s) => s.id)
        const result = await window.electronAPI.canvas.reclaim({ sessionId, canvasId, openTileSessionIds })
        if (result?.ok) {
          // The pane swaps to the canvas surface as soon as the store has it.
          await refreshCanvas(sessionId)
        } else {
          // Refused (the owner came back, or it is gone) — drop it from the list.
          setReclaimable((list) => list.filter((c) => c.canvasId !== canvasId))
        }
      } catch {
        setReclaimable((list) => list.filter((c) => c.canvasId !== canvasId))
      } finally {
        setReclaiming(null)
      }
    },
    [sessionId, refreshCanvas],
  )

  const removeCanvas = useCallback(async (canvasId: string) => {
    setDeleting(canvasId)
    setDeleteError(null)
    try {
      const res = await window.electronAPI.canvas.deleteCanvas({ canvasId })
      if (res?.ok) setReclaimable((list) => list.filter((c) => c.canvasId !== canvasId))
      else setDeleteError('That canvas could not be deleted.')
    } catch {
      setDeleteError('That canvas could not be deleted.')
    } finally {
      setDeleting(null)
      setConfirmingDelete(null)
    }
  }, [])

  const typeIntoTerminal = useCallback(() => {
    // No newline: the terminal shows the request, the user sends it.
    window.electronAPI.pty.write(sessionId, STARTER_PROMPT)
    setTyped(true)
    window.setTimeout(() => setTyped(false), 4000)
  }, [sessionId])

  const copyPrompt = useCallback(() => {
    void navigator.clipboard?.writeText(STARTER_PROMPT).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    })
  }, [])

  if (emptyView === 'sketchpad') {
    return (
      <div className="flex-1 flex flex-col min-h-0 relative">
        <ExcalidrawPane sessionId={sessionId} />
        {/* The way back to the canvas identity — floating so the classic pane
            keeps its whole chrome untouched. */}
        <button
          onClick={() => setEmptyView(sessionId, 'intro')}
          className="absolute bottom-3 right-3 z-10 px-2.5 py-1 text-[11px] rounded-full border border-[var(--border-strong)] bg-[var(--surface-panel)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] shadow-lg transition-colors focus-ring"
          title="Back to the Agent Canvas introduction"
        >
          Agent Canvas
        </button>
      </div>
    )
  }

  return (
    <div className="canvas-landing relative flex-1 flex flex-col min-h-0 bg-[var(--surface-stage)]">
      {/* Same chrome as the live canvas surface: 38px, one type size, and no
          version affordances — an empty canvas has nothing to version. */}
      <div className="h-[38px] shrink-0 flex items-center gap-2.5 px-3 bg-[var(--surface-chrome)] border-b border-[var(--border-subtle)]">
        <span className="w-[5px] h-[5px] rounded-full bg-[var(--brand)]" aria-hidden="true" />
        <span className="text-[12px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">Agent Canvas</span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          aria-label="Close Agent Canvas"
          title="Close Agent Canvas"
          className="p-[5px] rounded leading-none text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-panel)] transition-colors focus-ring"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
            <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
          </svg>
        </button>
      </div>

      {/* The stage. `canvas-stage` makes this a container query root so the
          sheet answers to the PANE's width, not the window's. */}
      <div className="canvas-stage flex-1 min-h-0 overflow-y-auto px-5 py-7">
        <div className="canvas-sheet relative w-full max-w-[840px] mx-auto flex flex-col rounded border border-[var(--border-subtle)] bg-[var(--surface-raised)]">
          <RegistrationMark corner="tl" />
          <RegistrationMark corner="tr" />
          <RegistrationMark corner="bl" />
          <RegistrationMark corner="br" />

          <p
            className="mb-4 uppercase text-[10.5px] font-medium tracking-[0.16em] text-[var(--text-secondary)]"
            style={{ fontFamily: MONO }}
          >
            Nothing rendered yet
          </p>
          <h2 className="canvas-headline m-0 mb-3 max-w-[19ch] font-semibold text-[var(--text-primary)]">
            Your agent draws here. <span className="text-[var(--brand)]">You mark it up.</span>
          </h2>
          <p className="m-0 mb-7 max-w-[52ch] text-[14px] leading-relaxed text-[var(--text-secondary)]">
            This is a review surface, not a drawing app. Ask the agent for something visual — a
            mockup, a plan, the app you&rsquo;re building — and it renders a real page onto this
            sheet. You point at what&rsquo;s wrong and send it back.
          </p>

          {/* The starter prompt is set in mono because it is literally terminal
              input, not because mono looks technical. */}
          <div className="flex items-stretch flex-wrap gap-2.5 mb-3.5">
            {/* basis, not a min-width: the pane is resizable and a hard
                min-width would push the sheet into horizontal overflow. */}
            <div className="grow shrink basis-[260px] min-w-0 flex items-center gap-2.5 rounded-md px-3.5 py-2.5 bg-[var(--surface-panel)] border border-[var(--border-subtle)]">
              <span className="text-[12px] font-semibold leading-none text-[var(--brand)]" style={{ fontFamily: MONO }} aria-hidden="true">
                &gt;
              </span>
              <code className="min-w-0 break-words text-[12.5px] leading-snug text-[var(--text-primary)]" style={{ fontFamily: MONO }}>
                {STARTER_PROMPT}
              </code>
            </div>
            <button
              onClick={typeIntoTerminal}
              className="shrink-0 inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-4 py-2 text-[12.5px] font-semibold bg-[var(--brand)] text-[var(--ob-on)] hover:brightness-110 transition-colors focus-ring"
              title="Types the request into this session's terminal — you press Enter to send it"
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 7h9M7.5 3.5L11 7l-3.5 3.5" />
              </svg>
              {typed ? 'Typed — press Enter in the terminal' : 'Put this in the terminal'}
            </button>
            <button onClick={copyPrompt} className={GHOST_CLASS}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="m-0 text-[12px] text-[var(--text-secondary)]">
            Lands in your prompt unsent — edit it, then press{' '}
            <kbd
              className="rounded-[3px] px-1.5 py-0.5 text-[11px] leading-none bg-[var(--surface-panel)] text-[var(--text-secondary)]"
              style={{ fontFamily: MONO, border: '1px solid var(--border-subtle)', borderBottomWidth: 2 }}
            >
              Enter
            </kbd>{' '}
            yourself.
          </p>

          {/* The loop, drawn as a loop. The numbering encodes a real sequence
              and the return arc from 05 back to 02 IS the feature. */}
          <div className="mt-9 pt-6 border-t border-dashed border-[var(--border-subtle)]">
            <p
              className="mb-[18px] uppercase text-[10.5px] font-medium tracking-[0.14em] text-[var(--text-secondary)]"
              style={{ fontFamily: MONO }}
            >
              The review loop
            </p>
            <ol className="canvas-loop-track m-0 p-0 list-none">
              {LOOP_STEPS.map((step, i) => (
                <li key={step.title} className="relative pt-[22px]">
                  <span
                    className="absolute top-0 left-0 text-[10px] font-semibold leading-none text-[var(--brand)]"
                    style={{ fontFamily: MONO }}
                    aria-hidden="true"
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <h4
                    className={`m-0 mb-[3px] text-[12.5px] font-semibold tracking-[-0.01em] ${
                      step.you ? 'text-[var(--brand)]' : 'text-[var(--text-primary)]'
                    }`}
                  >
                    {step.title}
                  </h4>
                  <p className="m-0 text-[11.5px] leading-[1.45] text-[var(--text-secondary)]">{step.detail}</p>
                </li>
              ))}
            </ol>
            {/* The return arc: 05 loops back to 02. Deliberately a little
                irregular — the same rough hand the glass layer draws in, so it
                previews what you are about to do. Hidden by the container query
                once the track wraps (it would point at the wrong steps). */}
            <svg
              className="canvas-loop-arc block w-full h-[34px] mt-0.5 overflow-visible"
              viewBox="0 0 1000 34"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path
                d="M905 3 C 902 22, 880 27, 830 28 C 640 31, 420 30, 260 28 C 210 27, 190 22, 187 5"
                fill="none"
                stroke="var(--brand)"
                strokeWidth="1.3"
                strokeLinecap="round"
                opacity="0.55"
              />
              <path
                d="M187 5 l-4.5 7.5 M187 5 l5 7"
                fill="none"
                stroke="var(--brand)"
                strokeWidth="1.3"
                strokeLinecap="round"
                opacity="0.55"
              />
            </svg>
          </div>

          {/* Secondary row: the sketchpad escape hatch (spec D2) and the control
              vocabulary, disclosed rather than always-on so the sheet stays a
              sheet. */}
          <div className="flex items-center flex-wrap gap-2 mt-6">
            <button
              onClick={() => setEmptyView(sessionId, 'sketchpad')}
              className={GHOST_CLASS}
              title="Open the classic free-form sketchpad"
            >
              Open the sketchpad instead
            </button>
            <button
              onClick={() => setControlsOpen((open) => !open)}
              aria-expanded={controlsOpen}
              className={GHOST_CLASS}
            >
              Once something is rendered
            </button>
          </div>
          {controlsOpen && (
            <ul className="mt-3 flex flex-col gap-1.5 rounded-md px-3.5 py-3 bg-[var(--surface-panel)] border border-[var(--border-subtle)] text-[12px] leading-relaxed text-[var(--text-secondary)]">
              <li>
                <span className="text-[var(--text-primary)]">Browse</span> — the page is live: hover to
                inspect, <span className="text-[var(--text-primary)]">click to select</span> what a note
                is about.{' '}
                <span className="text-[11px] px-1 rounded bg-[var(--surface-raised)] border border-[var(--border-subtle)]" style={{ fontFamily: MONO }}>↑</span>{' '}
                selects the parent,{' '}
                <span className="text-[11px] px-1 rounded bg-[var(--surface-raised)] border border-[var(--border-subtle)]" style={{ fontFamily: MONO }}>Esc</span>{' '}
                clears.
              </li>
              <li>
                <span className="text-[var(--text-primary)]">Region</span> — drag a rectangle when a note
                is about an area, not one element.
              </li>
              <li>
                <span className="text-[var(--text-primary)]">Draw</span> — sketch on the glass; attach the
                sketch to a note to show what you mean.
              </li>
              <li>
                <span className="text-[var(--text-primary)]">Submit review</span> — your notes go to the
                agent as one batch; it revises and the loop continues.
              </li>
            </ul>
          )}

          {/* The library. Offered here as well as in the pane header because this
              is the state where the user is asking "what have I got?" — and,
              before it existed, the reclaim list below was the only place old
              canvases appeared, with nothing the user could do about them. */}
          <button
            onClick={() => setLibraryOpen(true)}
            className="mt-4 self-start text-[11.5px] rounded px-2 py-1 border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-ring"
            data-testid="canvas-empty-library-open"
          >
            Browse the canvas library
          </button>

          {/* Reclaim — a canvas from an earlier session (spec D2 continuity).
              Offered, never taken: moving a canvas moves the user's private
              review notes with it, and only the user can authorise that. */}
          {reclaimable.length > 0 && (
            <div className="mt-5">
              <p
                className="mb-2 uppercase text-[10.5px] font-medium tracking-[0.14em] text-[var(--text-secondary)]"
                style={{ fontFamily: MONO }}
              >
                Pick up where you left off
              </p>
              <ul className="flex flex-col gap-2">
                {reclaimable.map((c) => (
                  <li
                    key={c.canvasId}
                    className="flex items-center gap-3 rounded-md px-3.5 py-3 bg-[var(--surface-panel)] border border-[var(--border-subtle)]"
                    style={{ borderLeft: '2px solid var(--accent)' }}
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--accent)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
                      <path d="M14 8A6 6 0 1 1 8 2a6 6 0 0 1 4.5 2M13 2v3h-3" />
                    </svg>
                    <div className="min-w-0 flex-1">
                      {/* The TITLE is what the user reads before clicking, and
                          a constant one made two canvases from the same project
                          indistinguishable — a mis-click re-binds another
                          project's private review notes to this session. The
                          conversation (or, failing that, the canvas's own id)
                          is what actually differs, so it goes in the name. */}
                      <div className="text-[12.5px] font-semibold text-[var(--text-primary)] mb-0.5 truncate">
                        Canvas from conversation{' '}
                        <span style={{ fontFamily: MONO }}>{canvasLabel(c)}</span>
                      </div>
                      <div
                        className="text-[11.5px] text-[var(--text-secondary)] truncate"
                        title={c.cwd || undefined}
                      >
                        {c.versionCount} version{c.versionCount === 1 ? '' : 's'} · last rendered{' '}
                        {lastRenderedLabel(c.lastRenderedAt)}
                        {c.cwd && (
                          <>
                            {' · '}
                            <span style={{ fontFamily: MONO }} className="text-[11px]">
                              {c.sameProject ? 'this project' : c.cwd}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => void reclaim(c.canvasId)}
                      disabled={reclaiming !== null || deleting !== null}
                      className={GHOST_CLASS}
                      title="Reopen this canvas in this session, with its version history and notes"
                    >
                      {reclaiming === c.canvasId ? 'Reopening…' : 'Reopen'}
                    </button>
                    {confirmingDelete === c.canvasId ? (
                      <button
                        onClick={() => void removeCanvas(c.canvasId)}
                        disabled={reclaiming !== null || deleting !== null}
                        className={DANGER_CLASS}
                        aria-label={`Delete ${c.versionCount} version${c.versionCount === 1 ? '' : 's'} of canvas ${canvasLabel(c)}`}
                        data-testid="canvas-reclaim-confirm-delete"
                      >
                        {deleting === c.canvasId
                          ? 'Deleting…'
                          : `Delete ${c.versionCount} version${c.versionCount === 1 ? '' : 's'}`}
                      </button>
                    ) : (
                      <button
                        onClick={() => { setConfirmingDelete(c.canvasId); setDeleteError(null) }}
                        disabled={reclaiming !== null || deleting !== null}
                        className={`${GHOST_CLASS} hover:!text-[var(--status-danger)]`}
                        title="Permanently delete this canvas — its versions and review notes go with it"
                        aria-label={`Delete canvas ${canvasLabel(c)}`}
                        data-testid="canvas-reclaim-delete"
                      >
                        Delete
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {deleteError && (
                <p className="mt-2 m-0 text-[11.5px] text-[var(--status-danger)]" role="alert" data-testid="canvas-reclaim-delete-error">
                  {deleteError}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      {libraryOpen && (
        <CanvasLibrary
          sessionId={sessionId}
          onClose={() => {
            setLibraryOpen(false)
            // The library can delete (or adopt) a canvas the reclaim list still
            // shows — re-read so no row offers an action on a ghost.
            void loadReclaimable()
          }}
        />
      )}
    </div>
  )
}

/** "2d ago" when the stamp parses, the raw stamp when it does not — a stored
 *  value we cannot read is still worth showing, just not worth guessing at. */
function lastRenderedLabel(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? relativeTime(ms) : iso
}

/**
 * The short name that tells one candidate from another.
 *
 * The conversation is the right answer (two canvases from one project are two
 * conversations), and the canvas id is the fallback for a canvas that was never
 * rendered under a conversation the binder could name — it is at least unique,
 * which is the whole job here. Both are already `[0-9a-f]` by construction; the
 * slice bounds what a card can be made to render regardless.
 */
function canvasLabel(c: ReclaimableCanvas): string {
  return (c.conversationShortId || c.canvasId).slice(0, 8)
}
