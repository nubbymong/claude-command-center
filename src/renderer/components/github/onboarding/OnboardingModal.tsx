import { useRef, useState } from 'react'
import { useFocusTrap } from '../../../hooks/useFocusTrap'

interface Props {
  onClose: () => void
  onSetup: () => void
}

// Vite glob — same pattern as TrainingWalkthrough's getScreenshot. Eagerly
// resolves so missing files become undefined instead of throwing at render.
const screenshotModules = import.meta.glob('../../../assets/training/*.jpg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

function resolveImage(filename: string): string | undefined {
  const platform = window.electronPlatform === 'darwin' ? 'mac' : 'win'
  const base = filename.replace('.jpg', '')
  const platformFile = `${base}-${platform}.jpg`
  for (const [key, url] of Object.entries(screenshotModules)) {
    if (key.endsWith(`/${platformFile}`)) return url
  }
  for (const [key, url] of Object.entries(screenshotModules)) {
    if (key.endsWith(`/${filename}`)) return url
  }
  return undefined
}

export default function OnboardingModal({ onClose, onSetup }: Props) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const [imgFailed, setImgFailed] = useState(false)
  const imgSrc = resolveImage('github-panel.jpg')

  useFocusTrap(dialogRef, true, onClose)

  return (
    <div
      className="fixed inset-0 bg-base/80 flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="github-onboarding-title"
        className="bg-mantle p-6 rounded max-w-lg text-text shadow-lg border border-surface0"
      >
        <h3 id="github-onboarding-title" className="text-lg font-semibold mb-3">
          New: GitHub sidebar
        </h3>
        {imgSrc && !imgFailed && (
          <div className="bg-surface0 rounded overflow-hidden mb-3">
            <img
              src={imgSrc}
              alt="GitHub panel preview"
              className="w-full"
              onError={() => setImgFailed(true)}
            />
          </div>
        )}
        <p className="text-sm text-subtext0 mb-3">
          See PR, CI, reviews, issues, and session context for whatever
          you&rsquo;re working on, right next to the terminal.
        </p>
        <ol className="text-sm text-subtext0 space-y-2 mb-4 list-decimal list-inside">
          <li>We auto-detect your repos per session. Accept or edit.</li>
          <li>
            Sign in with GitHub (or use <code>gh</code> CLI if you have it).
          </li>
          <li>Enable per session at your own pace. Nothing runs until you opt in.</li>
        </ol>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="text-subtext0 px-3 py-1 hover:text-text transition-colors"
          >
            Later
          </button>
          <button
            onClick={onSetup}
            className="bg-blue text-base px-3 py-1 rounded hover:bg-blue/80 transition-colors font-medium"
          >
            Set up now
          </button>
        </div>
      </div>
    </div>
  )
}
