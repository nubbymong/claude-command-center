import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { verdictOutcomeOf, type Annotation, type CanvasVersion } from '../../shared/canvas'
import { stampChips, trailLineParts } from '../canvas/canvas-state-stamp'
import { trailClockTime } from '../../shared/canvas-review-serialize'
import { PAGE_REPORTED_MARK, PAGE_REPORTED_TITLE } from '../canvas/page-reported'
import { DismissButton } from './ui/DismissButton'

/**
 * The one sentence that explains why there is no live site here.
 *
 * Said on the banner, once. A user who opens a finished test pack from the
 * Library and finds a picture instead of the page they tested will otherwise
 * assume something is broken — the honest answer is that the evidence is the
 * artefact, and the site was never the thing that was kept.
 */
export const RECALL_BANNER =
  'Every note shows the screen as it was when you saved it — the live site is not stored and isn’t needed to look back.'

interface Props {
  sessionId: string
  canvasId: string
  version: CanvasVersion
  /** The pack's name — the user's own, or the derived default. */
  packName: string
  /** PASSED / FAILED / … — from the shared `verdictLabel`, so this badge and
   *  History cannot disagree about one gesture. */
  verdict: string
  /** The round's notes, in the order they were filed. */
  notes: readonly Annotation[]
  /** The round was a PASS: its notes are observations, not defects. */
  observations: boolean
  /** Where "back" goes — the Library, or the canvas the pane came from. */
  backLabel: string
  onBack: () => void
  onClose: () => void
}

/** One decoded attachment, or the fact that it could not be decoded. `null`
 *  means "asked and got nothing" and is drawn as a placeholder; `undefined`
 *  means "not asked yet". */
type Decoded = string | null | undefined

/**
 * RECALL — a submitted test run, read back as evidence (M3).
 *
 * Once a run is submitted the pack IS the artefact: the version's build may be
 * gone, its dist root revoked, its pages long since rebuilt. Re-serving the
 * site would be, at best, a different build wearing the same version number —
 * so this view never shows one. Every note is its own captured screen, with the
 * drawing laid back over it from its own PNG, the page state as chips and the
 * action trail as timed lines.
 *
 * Everything the PAGE said about itself — the route, a dialog's name, the
 * element a click landed on — is marked, exactly as it is in the live pane.
 */
export function CanvasEvidenceRecall({
  sessionId,
  canvasId,
  version,
  packName,
  verdict,
  notes,
  observations,
  backLabel,
  onBack,
  onClose,
}: Props): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [shot, setShot] = useState<Decoded>(undefined)
  const [sketch, setSketch] = useState<Decoded>(undefined)
  const [images, setImages] = useState<Decoded[]>([])
  /** Which note the in-flight reads belong to, so an answer that arrives after
   *  the user has stepped on cannot paint the wrong note's screen. */
  const loadTokenRef = useRef(0)

  const count = notes.length
  const note = count > 0 ? notes[Math.min(index, count - 1)] : null

  // A round that loses a note (deleted elsewhere, reopened) must not leave the
  // stepper pointing past the end.
  useEffect(() => {
    if (index > 0 && index >= count) setIndex(Math.max(0, count - 1))
  }, [count, index])

  const read = useCallback(
    async (path: string | undefined): Promise<string | null> => {
      if (!path) return null
      try {
        const out = await window.electronAPI.canvas.evidenceRead({ sessionId, canvasId, path })
        return out?.dataUrl ?? null
      } catch {
        return null
      }
    },
    [sessionId, canvasId],
  )

  useEffect(() => {
    const token = ++loadTokenRef.current
    setShot(undefined)
    setSketch(undefined)
    setImages((note?.images ?? []).map(() => undefined))
    if (!note) return
    void (async () => {
      const [nextShot, nextSketch] = await Promise.all([
        read(note.evidence?.shotPath),
        read(note.sketch?.pngPath || undefined),
      ])
      if (loadTokenRef.current !== token) return
      setShot(nextShot)
      setSketch(nextSketch)
      const decoded = await Promise.all((note.images ?? []).map((img) => read(img.pngPath)))
      if (loadTokenRef.current !== token) return
      setImages(decoded)
    })()
  }, [note, read])

  const step = useCallback(
    (delta: number) => {
      setIndex((i) => Math.max(0, Math.min(count - 1, i + delta)))
    },
    [count],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        step(-1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        step(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step])

  const chips = useMemo(() => (note?.evidence ? stampChips(note.evidence.stamp) : []), [note])

  /**
   * Where the drawing sits ON the shot, in per cent.
   *
   * The bbox is in CONTENT PAGE coordinates and the shot covers exactly the
   * content viewport as it stood at capture — so subtracting the stamped scroll
   * and dividing by the stamped viewport gives a position that survives every
   * later resize of the pane. Percentages rather than pixels precisely because
   * this element is measured by nothing.
   */
  const sketchBox = useMemo(() => {
    const stamp = note?.evidence?.stamp
    const bbox = note?.sketch?.bboxPage
    if (!stamp || !bbox) return null
    const { width, height, scrollX, scrollY } = stamp.viewport
    if (!(width > 0) || !(height > 0)) return null
    return {
      left: `${((bbox.x - scrollX) / width) * 100}%`,
      top: `${((bbox.y - scrollY) / height) * 100}%`,
      width: `${(bbox.width / width) * 100}%`,
      height: `${(bbox.height / height) * 100}%`,
    }
  }, [note])

  // Through the shared classifier rather than a fourth copy of the prefix
  // ladder: the word arrives already composed by `verdictLabel`, so only the
  // file that mints the vocabulary can be trusted to classify it.
  const badgeOutcome = verdictOutcomeOf(verdict)
  const badgeTone =
    badgeOutcome === 'bad' ? 'var(--color-red)' : badgeOutcome === 'ok' ? 'var(--color-green)' : 'var(--text-muted)'

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--surface-stage)]" data-testid="canvas-recall">
      {/* Header — the pack, its outcome, and the way back. */}
      <div
        className="h-[42px] shrink-0 flex items-center gap-2.5 px-3 bg-[var(--surface-chrome)]"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <button
          onClick={onBack}
          className="shrink-0 flex items-center gap-1 text-[11.5px] rounded px-1.5 py-0.5 text-[var(--text-secondary)] border border-[var(--border-subtle)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-panel)] transition-colors focus-ring"
          data-testid="canvas-recall-back"
        >
          <span aria-hidden className="text-[13px] leading-none">
            &lsaquo;
          </span>{' '}
          {backLabel}
        </button>
        <span
          className="min-w-0 truncate text-[12.5px] font-semibold text-[var(--text-primary)]"
          // The version id lives in the tooltip rather than the label: a pack
          // name is what the user recognises, and `v4` is what a bug report
          // about the pack itself needs.
          title={`${packName} — ${version.id}`}
          data-testid="canvas-recall-pack-name"
        >
          {packName}
        </span>
        <span
          className="shrink-0 text-[8.5px] font-extrabold tracking-[0.05em] rounded px-[7px] py-[2.5px]"
          style={{ background: badgeTone, color: 'var(--surface-chrome)' }}
          data-testid="canvas-recall-verdict"
        >
          {verdict}
        </span>
        <div className="flex-1" />
        <DismissButton onClick={onClose} label="Close Agent Canvas" size={11} data-testid="canvas-recall-close" />
      </div>

      {/* Banner — why the live site is not here. */}
      <div
        className="shrink-0 flex items-center gap-2 px-4 py-2 text-[11px]"
        style={{
          color: 'var(--text-secondary)',
          background: 'color-mix(in srgb, var(--color-blue) 6%, var(--surface-stage))',
          borderBottom: '1px solid var(--border-subtle)',
        }}
        data-testid="canvas-recall-banner"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
          className="shrink-0"
        >
          <rect x="4" y="10" width="16" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
        <span>
          <b style={{ color: 'var(--text-primary)', fontWeight: 650 }}>Saved evidence.</b> {RECALL_BANNER}
        </span>
      </div>

      {count === 0 ? (
        <div className="flex-1 flex items-center justify-center text-[12px]" style={{ color: 'var(--text-muted)' }} data-testid="canvas-recall-empty">
          This run was submitted with no notes — {verdict.toLowerCase()}, nothing written down.
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-0 flex gap-3.5 px-4 py-3.5 overflow-y-auto canvas-review-scroll">
            {/* Stage — the screen as it was. */}
            <div
              className="relative flex-[1.3] min-w-0 rounded-[11px] overflow-hidden self-start"
              style={{ border: '1px solid var(--border-subtle)', background: 'var(--surface-sunken)' }}
              data-testid="canvas-recall-shot"
            >
              {shot ? (
                <img src={shot} alt="" className="block w-full h-auto" />
              ) : (
                <div
                  className="flex items-center justify-center text-[11px] min-h-[220px] px-4 text-center"
                  style={{ color: 'var(--text-muted)' }}
                  data-testid="canvas-recall-no-shot"
                >
                  {shot === undefined
                    ? 'Loading the saved screen…'
                    : note?.evidence
                      ? 'The saved screen for this note could not be read.'
                      : 'No screen was saved with this note.'}
                </div>
              )}
              {/* The drawing, laid back over the shot at the box it was drawn
                  in. A separate PNG rather than baked into the screenshot, so a
                  note's marks can be seen against the page and the page can be
                  read without them. */}
              {sketch && sketchBox && (
                <img
                  src={sketch}
                  alt=""
                  className="absolute pointer-events-none"
                  style={sketchBox}
                  data-testid="canvas-recall-sketch"
                />
              )}
              {note?.evidence && (
                <span
                  className="absolute right-2.5 bottom-2.5 text-[8.5px] rounded px-[7px] py-px"
                  style={{
                    background: 'var(--surface-chrome)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-muted)',
                  }}
                  data-testid="canvas-recall-captured-at"
                >
                  captured {trailClockTime(note.evidence.stamp.capturedAt)}
                </span>
              )}
            </div>

            {/* Side — the note, the page state, the trail, the images. */}
            <div className="flex-1 min-w-0 flex flex-col gap-2.5">
              <div
                className="rounded-[11px] px-3.5 py-3"
                style={{ background: 'var(--surface-panel)', border: '1px solid var(--border-subtle)' }}
                data-testid="canvas-recall-note"
              >
                {note && note.note.trim().length > 0 ? (
                  <div className="text-[12.5px] leading-[1.55] whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
                    {note.note}
                  </div>
                ) : (
                  <div className="text-[12.5px] italic" style={{ color: 'var(--text-muted)' }}>
                    (no words — the screen was the note)
                  </div>
                )}
                <div className="text-[9.5px] mt-1.5" style={{ color: 'var(--text-muted)' }} data-testid="canvas-recall-note-meta">
                  note {index + 1} of {count} · {observations ? 'observation' : 'defect'}
                </div>
              </div>

              {chips.length > 0 && (
                <div className="flex flex-wrap gap-1.5" data-testid="canvas-recall-state">
                  {chips.map((chip) => (
                    <span
                      key={chip.text}
                      className="text-[9.5px] rounded-[6px] px-2 py-[3px]"
                      style={{
                        background: 'var(--surface-sunken)',
                        border: '1px solid var(--border-subtle)',
                        color: 'var(--text-secondary)',
                      }}
                      title={chip.pageReported ? PAGE_REPORTED_TITLE : undefined}
                    >
                      {chip.pageReported && <span style={{ color: 'var(--text-muted)' }}>{PAGE_REPORTED_MARK} </span>}
                      {chip.text}
                    </span>
                  ))}
                </div>
              )}

              {(note?.evidence?.trail.length ?? 0) > 0 && (
                <div
                  className="rounded-[10px] px-3 py-2.5"
                  style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-subtle)' }}
                  data-testid="canvas-recall-trail"
                >
                  {(note?.evidence?.trail ?? []).map((entry, i) => {
                    const parts = trailLineParts(entry)
                    return (
                      <div key={i} className="text-[9.5px] leading-[1.7]" style={{ color: 'var(--text-secondary)' }}>
                        <span style={{ color: 'var(--text-muted)' }}>{trailClockTime(entry.at)} </span>
                        {parts.verb}
                        {parts.subject && (
                          <>
                            {' '}
                            <span
                              style={{ color: 'var(--color-peach)', fontWeight: 650 }}
                              title={parts.subjectIsPageReported ? PAGE_REPORTED_TITLE : undefined}
                            >
                              {parts.subjectIsPageReported && (
                                <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{PAGE_REPORTED_MARK} </span>
                              )}
                              {parts.subject}
                            </span>
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {images.length > 0 && (
                <div className="flex gap-1.5 flex-wrap" data-testid="canvas-recall-images">
                  {images.map((src, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center justify-center w-[52px] h-[36px] rounded-[6px] overflow-hidden text-[8px]"
                      style={{
                        background: 'var(--surface-raised)',
                        border: '1px solid var(--border-subtle)',
                        color: 'var(--text-muted)',
                      }}
                      data-testid={`canvas-recall-image-${i + 1}`}
                    >
                      {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : `IMG ${i + 1}`}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Stepper */}
          <div className="shrink-0 flex items-center justify-center gap-2.5 px-4 pb-3.5" data-testid="canvas-recall-stepper">
            <button
              onClick={() => step(-1)}
              disabled={index === 0}
              aria-label="Previous note"
              className="w-[28px] h-[28px] rounded-[8px] flex items-center justify-center focus-ring disabled:opacity-40 disabled:cursor-default"
              style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', background: 'var(--surface-panel)' }}
              data-testid="canvas-recall-prev"
            >
              <span aria-hidden>&lsaquo;</span>
            </button>
            <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
              note {index + 1} of {count}
            </span>
            <button
              onClick={() => step(1)}
              disabled={index >= count - 1}
              aria-label="Next note"
              className="w-[28px] h-[28px] rounded-[8px] flex items-center justify-center focus-ring disabled:opacity-40 disabled:cursor-default"
              style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', background: 'var(--surface-panel)' }}
              data-testid="canvas-recall-next"
            >
              <span aria-hidden>&rsaquo;</span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default CanvasEvidenceRecall
