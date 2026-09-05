import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useOccludesNativePanes } from '../stores/paneOcclusionStore'
import { useAppMetaStore } from '../stores/appMetaStore'
import {
  trainingSteps,
  getNewSteps,
  currentTrainingVersion,
  SECTION_LABELS,
  type TrainingStep,
} from '../training-steps'
import { DialogOverlay, DialogButton } from './ui/Dialog'

// Vite glob import for training screenshots — automatically picks up all JPGs in the directory
const screenshotModules = import.meta.glob('../assets/training/*.jpg', { eager: true, as: 'url' })

// Build a map from filename to resolved URL
const screenshotMap: Record<string, string> = {}
for (const [path, url] of Object.entries(screenshotModules)) {
  const filename = path.split('/').pop()
  if (filename) screenshotMap[filename] = url
}

// Platform-aware screenshot resolution: prefer platform-specific (e.g. step-welcome-mac.jpg)
// then fall back to generic (step-welcome.jpg)
function getScreenshot(filename: string): string | undefined {
  const platform = window.electronPlatform === 'darwin' ? 'mac' : 'win'
  const base = filename.replace('.jpg', '')
  const platformFile = `${base}-${platform}.jpg`
  return screenshotMap[platformFile] || screenshotMap[filename]
}

/**
 * The walkthrough has two surfaces:
 *  - first-run: shown automatically after install. Steers the user
 *    through new features. Renders as a backdrop-masked, focus-trapping
 *    modal so the rest of the app can't be poked at while the tour
 *    thinks it owns the screen.
 *  - help: re-launched from the sidebar `?` icon or Settings → Replay
 *    Training. Renders as an unmasked floating card the user can dock
 *    next to the live UI so they can read step N and click the
 *    matching surface in the app at the same time.
 *
 * #360: the card is NOT a DialogPanel — help mode is deliberately
 * `aria-modal="false"` (the app stays interactive behind it) and
 * DialogPanel is modal by construction. So the card keeps its own frame,
 * carries the dialog role/aria itself, and takes its colours from the
 * semantic tokens; only the first-run scrim is the shared DialogOverlay.
 */
type WalkthroughMode = 'first-run' | 'help'

interface Props {
  onClose: () => void
  showAll?: boolean
  /** Defaults to 'first-run' for back-compat with existing callers. */
  mode?: WalkthroughMode
}

/** Render bullet text with **bold** segments */
function renderBullet(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <span key={i} className="font-semibold" style={{ color: 'var(--text-primary)' }}>
          {part.slice(2, -2)}
        </span>
      )
    }
    return <span key={i}>{part}</span>
  })
}

const TRANSITION_MS = 160

/** A header icon button (expand / close): muted, brightening on hover. */
const ICON_BTN_CLASS =
  'text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors'

export default function TrainingWalkthrough({ onClose, showAll = false, mode = 'first-run' }: Props) {
  // Whole-window overlay for its entire life (its own spotlight layer sits
  // outside the dialog backdrops it also uses): the native browser / account
  // panes must not paint over it.
  useOccludesNativePanes()
  const steps = showAll
    ? trainingSteps
    : getNewSteps(useAppMetaStore.getState().meta.lastTrainingVersion)

  const [currentIndex, setCurrentIndex] = useState(0)
  const [imgBad, setImgBad] = useState<Set<number>>(new Set())
  // `displayIndex` is the step the body is currently rendering. It lags
  // `currentIndex` by `TRANSITION_MS` so the old body fades out before
  // the new one fades in — without React unmounting in the middle of
  // the transition.
  const [displayIndex, setDisplayIndex] = useState(0)
  const [phase, setPhase] = useState<'in' | 'out'>('in')
  const transitionTimer = useRef<number | null>(null)
  // Help-mode only: user can expand the floating card to a centred
  // larger panel (still unmasked, app remains interactive). first-run
  // is always full-screen so the toggle is hidden in that mode.
  const [expanded, setExpanded] = useState(false)

  const step = steps[displayIndex]
  const isFirst = currentIndex === 0
  const isLast = currentIndex === steps.length - 1
  const progress = ((currentIndex + 1) / steps.length) * 100

  // Cross-fade scheduler. When the user advances/goes-back/jumps via
  // dot-nav, we set phase=out (body fades to 0), wait TRANSITION_MS,
  // swap displayIndex to currentIndex, then phase=in (body fades back).
  useEffect(() => {
    if (currentIndex === displayIndex) return
    setPhase('out')
    if (transitionTimer.current != null) window.clearTimeout(transitionTimer.current)
    transitionTimer.current = window.setTimeout(() => {
      setDisplayIndex(currentIndex)
      setPhase('in')
    }, TRANSITION_MS)
    return () => {
      if (transitionTimer.current != null) window.clearTimeout(transitionTimer.current)
    }
  }, [currentIndex, displayIndex])

  const handleClose = useCallback(() => {
    useAppMetaStore
      .getState()
      .update({ lastTrainingVersion: currentTrainingVersion() })
    onClose()
  }, [onClose])

  const handleNext = () => {
    if (isLast) {
      handleClose()
    } else {
      setCurrentIndex((i) => i + 1)
    }
  }

  const handleBack = () => {
    if (!isFirst) setCurrentIndex((i) => i - 1)
  }

  const markBad = () => {
    setImgBad((prev) => new Set(prev).add(displayIndex))
  }

  // Esc closes in both modes. In help mode the user is already poking
  // around the app so this lets them dismiss without reaching for the
  // close button. In first-run, Esc is a deliberate "I want out".
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [handleClose])

  if (steps.length === 0) {
    return null
  }

  const imgSrc = step ? getScreenshot(step.screenshotFilename) : undefined
  const showFallback = imgBad.has(displayIndex)

  // ── Inner card ──
  // Same content for both modes, just different framing wrappers below.
  // It carries the dialog role/aria: first-run is modal, help is not.
  const card = (
    <div
      role="dialog"
      aria-modal={mode === 'first-run' ? 'true' : 'false'}
      aria-label={mode === 'help' ? 'Help walkthrough' : 'Welcome walkthrough'}
      className="flex flex-col overflow-hidden border rounded-xl shadow-2xl w-full h-full"
      style={{
        background: 'var(--surface-raised)',
        borderColor: 'var(--border-subtle)',
        color: 'var(--text-primary)',
      }}
    >
      {/* Progress bar */}
      <div className="h-1 shrink-0" style={{ background: 'var(--surface-overlay)' }}>
        <div
          className="h-full transition-all duration-300 ease-out"
          style={{ width: `${progress}%`, background: 'var(--brand)' }}
        />
      </div>

      {/* Header */}
      <div
        className="px-6 pt-4 pb-3 flex items-center justify-between shrink-0 border-b"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div className="min-w-0">
          <div
            className="text-[10px] uppercase tracking-wider mb-0.5"
            style={{ color: 'var(--text-muted)' }}
          >
            {mode === 'help' ? 'Help' : 'Welcome tour'} · step {currentIndex + 1} of {steps.length}
          </div>
          <h2 className="text-base font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {step?.title}
          </h2>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {mode === 'help' && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className={`${ICON_BTN_CLASS} p-1 rounded`}
              title={expanded ? 'Collapse to corner panel' : 'Expand to full panel'}
              aria-label={expanded ? 'Collapse walkthrough' : 'Expand walkthrough'}
            >
              {expanded ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  {/* Collapse arrows pointing inward */}
                  <path d="M9 3v4h4M3 9v-4h4M7 3L3 7M9 9l4 4M3 13l4-4" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  {/* Expand arrows pointing outward */}
                  <path d="M9 3h4v4M3 9v4h4M9 7l4-4M7 9l-4 4" />
                </svg>
              )}
            </button>
          )}
          <button
            onClick={handleClose}
            className={`${ICON_BTN_CLASS} text-lg leading-none px-2 py-1`}
            title="Close"
            aria-label="Close walkthrough"
          >
            &times;
          </button>
        </div>
      </div>

      {/* Content (cross-faded) */}
      <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
        <div
          className="max-w-3xl mx-auto space-y-4 transition-all ease-out"
          style={{
            transitionDuration: `${TRANSITION_MS}ms`,
            opacity: phase === 'in' ? 1 : 0,
            transform: phase === 'in' ? 'translateY(0)' : 'translateY(6px)',
          }}
        >
          {/* Screenshot area */}
          <div
            className="rounded-lg border overflow-hidden aspect-video"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-sunken)' }}
          >
            {!showFallback && imgSrc ? (
              <img
                src={imgSrc}
                alt={step?.title ?? ''}
                className="w-full h-full object-contain"
                onError={markBad}
                onLoad={(e) => {
                  const img = e.currentTarget
                  if (img.naturalWidth < 10 || img.naturalHeight < 10) markBad()
                }}
              />
            ) : (
              <div
                className="flex items-center justify-center h-full"
                style={{ color: 'var(--text-muted)' }}
              >
                <div className="text-center">
                  <div className="text-3xl mb-2 font-mono opacity-40">&gt;_</div>
                  <p className="text-xs">Screenshot will appear here</p>
                </div>
              </div>
            )}
          </div>

          {/* Body — hero layout when summary is set, legacy bullets otherwise */}
          {step?.summary ? (
            <>
              {step.section && (
                <div
                  className="text-[10px] uppercase tracking-wider"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {SECTION_LABELS[step.section]}{' '}
                  <span className="mx-1" style={{ color: 'var(--text-muted)' }}>→</span>{' '}
                  {step.title}
                </div>
              )}
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {step.summary}
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                <div>
                  <div
                    className="text-[10px] uppercase tracking-wider font-medium mb-2"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Highlights
                  </div>
                  <ul className="space-y-2">
                    {(step.highlights ?? step.bullets).map((b, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 text-[13px] leading-snug"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        <span className="mt-1.5 shrink-0" style={{ color: 'var(--brand)' }}>
                          <svg width="6" height="6" viewBox="0 0 6 6" fill="currentColor"><circle cx="3" cy="3" r="3" /></svg>
                        </span>
                        <span>{renderBullet(b)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="space-y-3">
                  {step.howToTrigger && step.howToTrigger.length > 0 && (
                    <div>
                      <div
                        className="text-[10px] uppercase tracking-wider font-medium mb-2"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        How to open
                      </div>
                      <dl className="space-y-1.5">
                        {step.howToTrigger.map((row, i) => (
                          <div key={i} className="flex items-start gap-2 text-[12px]">
                            <dt className="shrink-0 w-16" style={{ color: 'var(--text-muted)' }}>
                              {row.label}
                            </dt>
                            <dd style={{ color: 'var(--text-primary)' }}>{row.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  )}
                  {step.proTip && (
                    <div
                      className="rounded-md border px-3 py-2"
                      style={{
                        borderColor: 'color-mix(in srgb, var(--brand) 25%, transparent)',
                        background: 'color-mix(in srgb, var(--brand) 6%, transparent)',
                      }}
                    >
                      <div
                        className="text-[10px] uppercase tracking-wider font-medium mb-1"
                        style={{ color: 'var(--brand)' }}
                      >
                        Pro tip
                      </div>
                      <p className="text-[12px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
                        {step.proTip}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            // Legacy renderer — flat bullet list. Steps migrate to the
            // hero layout one at a time by adding a `summary` field.
            <ul className="space-y-2.5">
              {step?.bullets.map((bullet, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2.5 text-sm"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <span className="mt-0.5 shrink-0" style={{ color: 'var(--brand)' }}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="3" fill="currentColor" />
                    </svg>
                  </span>
                  <span>{renderBullet(bullet)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Footer */}
      <div
        className="px-6 py-3 border-t flex items-center justify-between shrink-0"
        style={{
          borderColor: 'var(--border-subtle)',
          background: 'color-mix(in srgb, var(--surface-sunken) 40%, transparent)',
        }}
      >
        {/* Dot navigation */}
        <div className="flex items-center gap-1.5">
          {steps.map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrentIndex(i)}
              className={`w-2 h-2 rounded-full transition-all duration-200 ${
                i === currentIndex
                  ? 'bg-[var(--brand)] scale-125'
                  : 'bg-[var(--surface-overlay)] hover:bg-[var(--text-muted)]'
              }`}
              aria-label={`Go to step ${i + 1}`}
            />
          ))}
        </div>

        {/* Buttons */}
        <div className="flex items-center gap-2">
          {!isFirst && (
            <DialogButton variant="ghost" onClick={handleBack}>
              Back
            </DialogButton>
          )}
          {!isLast && mode === 'first-run' && (
            <DialogButton variant="ghost" onClick={handleClose}>
              Skip
            </DialogButton>
          )}
          <DialogButton variant="primary" onClick={handleNext}>
            {isLast ? (mode === 'help' ? 'Done' : 'Get started') : 'Next'}
          </DialogButton>
        </div>
      </div>
    </div>
  )

  if (mode === 'help') {
    // Unmasked floating card in both states — user keeps full pointer
    // access to the rest of the app. Two layouts:
    //   collapsed: 420×600 pinned bottom-right. Fixed height so the
    //              panel doesn't jump as steps change content length.
    //   expanded:  centred 820×720 (clamped to 92vw / 86vh) — bigger
    //              hero for detail-heavy steps. Still NO backdrop mask
    //              so the rest of the app remains interactive.
    if (expanded) {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="w-[min(1200px,95vw)] h-[min(880px,92vh)] flex pointer-events-auto">
            {card}
          </div>
        </div>
      )
    }
    return (
      <div className="fixed bottom-4 right-4 z-50 w-[460px] h-[min(680px,84vh)] flex pointer-events-auto">
        {card}
      </div>
    )
  }

  // first-run: full mask + centered card. Backdrop swallows clicks so
  // sidebar nav, session tabs, etc. can't be reached while the tour
  // is up. Backdrop click does nothing — only Skip / × dismiss, since
  // accidentally clicking off would lose progress (DialogOverlay has no
  // click-to-close by construction).
  return (
    <DialogOverlay className="backdrop-blur-sm" style={{ padding: 0 }}>
      <div className="w-[min(1200px,95vw)] h-[min(880px,92vh)] flex">
        {card}
      </div>
    </DialogOverlay>
  )
}

/** Check if training walkthrough should be shown (new steps available) */
export function shouldShowTraining(): boolean {
  try {
    const lastVer = useAppMetaStore.getState().meta.lastTrainingVersion
    if (!lastVer) return true
    return getNewSteps(lastVer).length > 0
  } catch {
    return false
  }
}

/** Check if this is a first install (no training version recorded) */
export function isFirstInstall(): boolean {
  try {
    return !useAppMetaStore.getState().meta.lastTrainingVersion
  } catch {
    return false
  }
}
