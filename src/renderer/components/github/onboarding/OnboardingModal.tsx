import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../../../hooks/useFocusTrap'
import { DialogOverlay, DialogPanel, DialogHeader, DialogBody, DialogFooter, DialogButton } from '../../ui/Dialog'

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
  // Matches the WhatsNewModal fade-in pattern so the handoff from
  // whats-new → onboarding reads as a smooth transition instead of a
  // blink-and-reappear. Fade + slight scale-up over 200ms on mount.
  const [entering, setEntering] = useState(false)
  useEffect(() => {
    const t = requestAnimationFrame(() => setEntering(true))
    return () => cancelAnimationFrame(t)
  }, [])

  useFocusTrap(dialogRef, true, onClose)

  return (
    <DialogOverlay className={`transition-opacity duration-200 ease-out ${entering ? 'opacity-100' : 'opacity-0'}`}>
      <DialogPanel
        panelRef={dialogRef}
        labelledBy="github-onboarding-title"
        width="w-full"
        style={{ maxWidth: '32rem' }}
        className={`transition-all duration-200 ease-out ${entering ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-2'}`}
      >
        <DialogHeader titleId="github-onboarding-title" title="New: GitHub sidebar" />

        <DialogBody>
          {imgSrc && !imgFailed && (
            <div className="rounded-lg overflow-hidden mb-3" style={{ background: 'var(--surface-base)' }}>
              <img
                src={imgSrc}
                alt="GitHub panel preview"
                className="w-full"
                onError={() => setImgFailed(true)}
              />
            </div>
          )}
          <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
            See PR, CI, reviews, issues, and session context for whatever
            you&rsquo;re working on, right next to the terminal.
          </p>
          <ol className="text-sm space-y-2 list-decimal list-inside" style={{ color: 'var(--text-secondary)' }}>
            <li>We auto-detect your repos per session. Accept or edit.</li>
            <li>
              Sign in with GitHub (or use <code>gh</code> CLI if you have it).
            </li>
            <li>Enable per session at your own pace. Nothing runs until you opt in.</li>
          </ol>
        </DialogBody>

        <DialogFooter>
          <DialogButton variant="ghost" onClick={onClose}>
            Later
          </DialogButton>
          {/* Was `bg-blue text-base` — `text-base` is a font SIZE, so this label
              inherited its colour instead of going dark on the brand fill (#360). */}
          <DialogButton variant="primary" onClick={onSetup}>
            Set up now
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
