import { useEffect, useState } from 'react'

interface Props {
  cwd: string
  onAccept: (slug: string) => void
  onEdit: () => void
  // Allowed to return a Promise — the dismiss button awaits it so the
  // disabled state stays on screen until the IPC write lands. Without
  // awaiting, setDismissing(false) fires synchronously before the IPC
  // completes and lets the user click the button multiple times.
  onDismiss: () => void | Promise<void>
}

export default function AutoDetectBanner({ cwd, onAccept, onEdit, onDismiss }: Props) {
  const [slug, setSlug] = useState<string | null>(null)
  const [dismissing, setDismissing] = useState(false)

  // Reset detected slug on cwd change so a stale fetch from a previous
  // session doesn't surface on the new one. The cancelled flag protects
  // against the stale-resolve racing a fresh fetch.
  useEffect(() => {
    let cancelled = false
    setSlug(null)
    const run = async () => {
      try {
        const r = await window.electronAPI.github.repoDetect(cwd)
        if (cancelled) return
        if (r.ok && r.slug) setSlug(r.slug)
      } catch {
        // repoDetect may reject transiently (SSH disconnect, IPC timing).
        // Silent fail — the banner just doesn't render, which is correct.
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [cwd])

  if (!slug) return null

  const handleAccept = () => {
    onAccept(slug)
  }

  const handleDismiss = async () => {
    setDismissing(true)
    try {
      await onDismiss()
    } finally {
      setDismissing(false)
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-mantle border-b border-surface0 px-3 py-1.5 flex items-center gap-2 text-xs"
    >
      <span className="text-subtext0">Detected</span>
      <code className="text-blue">{slug}</code>
      <button
        onClick={handleAccept}
        className="bg-surface0 hover:bg-surface1 transition-colors px-2 py-0.5 rounded"
      >
        Use this
      </button>
      <button onClick={onEdit} className="text-overlay1 hover:text-text transition-colors">
        Edit
      </button>
      <button
        onClick={handleDismiss}
        disabled={dismissing}
        className="text-overlay1 hover:text-text transition-colors ml-auto disabled:opacity-50"
        aria-label="Dismiss repo auto-detect banner"
      >
        {String.fromCodePoint(0x00d7)}
      </button>
    </div>
  )
}
