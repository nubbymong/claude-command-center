import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useAppMetaStore } from '../stores/appMetaStore'
import {
  trainingSteps,
  getNewSteps,
  currentTrainingVersion,
  type TrainingStep,
} from '../training-steps'

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
        <span key={i} className="text-text font-semibold">
          {part.slice(2, -2)}
        </span>
      )
    }
    return <span key={i}>{part}</span>
  })
}

const TRANSITION_MS = 160

export default function TrainingWalkthrough({ onClose, showAll = false, mode = 'first-run' }: Props) {
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
  const card = (
    <div className="flex flex-col overflow-hidden bg-base border border-surface0 rounded-xl shadow-2xl w-full h-full">
      {/* Progress bar */}
      <div className="h-1 bg-surface0 shrink-0">
        <div
          className="h-full bg-blue transition-all duration-300 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Header */}
      <div className="px-6 pt-4 pb-3 flex items-center justify-between shrink-0 border-b border-surface0/60">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-overlay0 mb-0.5">
            {mode === 'help' ? 'Help' : 'Welcome tour'} · step {currentIndex + 1} of {steps.length}
          </div>
          <h2 className="text-base font-semibold text-text truncate">{step?.title}</h2>
        </div>
        <button
          onClick={handleClose}
          className="text-overlay0 hover:text-text transition-colors text-lg leading-none px-2 py-1 shrink-0"
          title="Close"
          aria-label="Close walkthrough"
        >
          &times;
        </button>
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
          <div className="rounded-lg border border-surface0/60 overflow-hidden bg-crust">
            {!showFallback && imgSrc ? (
              <img
                src={imgSrc}
                alt={step?.title ?? ''}
                className="w-full h-auto object-contain"
                onError={markBad}
                onLoad={(e) => {
                  const img = e.currentTarget
                  if (img.naturalWidth < 10 || img.naturalHeight < 10) markBad()
                }}
              />
            ) : (
              <div className="flex items-center justify-center h-48 text-overlay0">
                <div className="text-center">
                  <div className="text-3xl mb-2 font-mono opacity-40">&gt;_</div>
                  <p className="text-xs">Screenshot will appear here</p>
                </div>
              </div>
            )}
          </div>

          {/* Bullet points */}
          <ul className="space-y-2.5">
            {step?.bullets.map((bullet, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm text-subtext0">
                <span className="text-blue mt-0.5 shrink-0">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="3" fill="currentColor" />
                  </svg>
                </span>
                <span>{renderBullet(bullet)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Footer */}
      <div className="px-6 py-3 border-t border-surface0 flex items-center justify-between shrink-0 bg-mantle/30">
        {/* Dot navigation */}
        <div className="flex items-center gap-1.5">
          {steps.map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrentIndex(i)}
              className={`w-2 h-2 rounded-full transition-all duration-200 ${
                i === currentIndex
                  ? 'bg-blue scale-125'
                  : 'bg-surface1 hover:bg-overlay0'
              }`}
              aria-label={`Go to step ${i + 1}`}
            />
          ))}
        </div>

        {/* Buttons */}
        <div className="flex items-center gap-2">
          {!isFirst && (
            <button
              onClick={handleBack}
              className="px-3 py-1 text-xs text-overlay1 hover:text-text transition-colors"
            >
              Back
            </button>
          )}
          {!isLast && mode === 'first-run' && (
            <button
              onClick={handleClose}
              className="px-3 py-1 text-xs text-overlay0 hover:text-overlay1 transition-colors"
            >
              Skip
            </button>
          )}
          <button
            onClick={handleNext}
            className="px-3 py-1 bg-blue text-crust rounded font-medium text-xs hover:bg-blue/85 transition-colors"
          >
            {isLast ? (mode === 'help' ? 'Done' : 'Get started') : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )

  if (mode === 'help') {
    // Unmasked floating card. The user keeps full pointer access to
    // the rest of the app — they can read step N and click the matching
    // UI at the same time. Pinned bottom-right so it stays out of the
    // primary work area but is always reachable.
    return (
      <div className="fixed bottom-4 right-4 z-50 w-[420px] max-h-[min(78vh,640px)] flex pointer-events-auto" role="dialog" aria-modal="false" aria-label="Help walkthrough">
        {card}
      </div>
    )
  }

  // first-run: full mask + centered card. Backdrop swallows clicks so
  // sidebar nav, session tabs, etc. can't be reached while the tour
  // is up. Backdrop click does nothing — only Skip / × dismiss, since
  // accidentally clicking off would lose progress.
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-crust/80 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Welcome walkthrough">
      <div className="w-[min(820px,92vw)] h-[min(720px,86vh)] flex">
        {card}
      </div>
    </div>
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
