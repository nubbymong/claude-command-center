import React, { useState, useCallback } from 'react'
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

interface Props {
  onClose: () => void
  showAll?: boolean
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

export default function TrainingWalkthrough({ onClose, showAll = false }: Props) {
  const steps = showAll
    ? trainingSteps
    : getNewSteps(useAppMetaStore.getState().meta.lastTrainingVersion)

  const [currentIndex, setCurrentIndex] = useState(0)
  const [imgBad, setImgBad] = useState<Set<number>>(new Set())

  const step = steps[currentIndex]
  const isFirst = currentIndex === 0
  const isLast = currentIndex === steps.length - 1
  const progress = ((currentIndex + 1) / steps.length) * 100

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
    setImgBad((prev) => new Set(prev).add(currentIndex))
  }

  if (steps.length === 0) {
    // No new steps to show
    return null
  }

  const imgSrc = getScreenshot(step.screenshotFilename)
  const showFallback = imgBad.has(currentIndex)

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-base">
      {/* Progress bar */}
      <div className="h-1 bg-surface0">
        <div
          className="h-full bg-blue transition-all duration-300 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Header */}
      <div className="px-8 pt-5 pb-3 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-text">{step.title}</h2>
          <span className="text-xs text-overlay0">
            {currentIndex + 1} of {steps.length}
          </span>
        </div>
        <button
          onClick={handleClose}
          className="text-overlay0 hover:text-text transition-colors text-xl leading-none px-2 py-1"
        >
          &times;
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 pb-4">
        <div className="max-w-4xl mx-auto space-y-5">
          {/* Screenshot area */}
          <div className="rounded-lg border border-surface0/60 overflow-hidden bg-crust">
            {!showFallback && imgSrc ? (
              <img
                src={imgSrc}
                alt={step.title}
                className="w-full h-auto object-contain"
                onError={markBad}
                onLoad={(e) => {
                  const img = e.currentTarget
                  if (img.naturalWidth < 10 || img.naturalHeight < 10) markBad()
                }}
              />
            ) : (
              <div className="flex items-center justify-center h-64 text-overlay0">
                <div className="text-center">
                  <div className="text-3xl mb-2 font-mono opacity-40">&gt;_</div>
                  <p className="text-xs">Screenshot will appear here</p>
                </div>
              </div>
            )}
          </div>

          {/* Bullet points */}
          <ul className="space-y-3">
            {step.bullets.map((bullet, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm text-subtext0">
                <span className="text-blue mt-0.5 shrink-0">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
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
      <div className="px-8 py-4 border-t border-surface0 flex items-center justify-between">
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
            />
          ))}
        </div>

        {/* Buttons */}
        <div className="flex items-center gap-2">
          {!isFirst && (
            <button
              onClick={handleBack}
              className="px-3 py-1.5 text-sm text-overlay1 hover:text-text transition-colors"
            >
              Back
            </button>
          )}
          {!isLast && (
            <button
              onClick={handleClose}
              className="px-3 py-1.5 text-sm text-overlay0 hover:text-overlay1 transition-colors"
            >
              Skip
            </button>
          )}
          <button
            onClick={handleNext}
            className="px-4 py-1.5 bg-blue text-crust rounded font-medium text-sm hover:bg-blue/80 transition-colors"
          >
            {isLast ? 'Get Started' : 'Next'}
          </button>
        </div>
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
