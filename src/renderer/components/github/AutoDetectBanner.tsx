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
    <div role="status" aria-live="polite"
      className="border-b px-3 py-1.5 flex items-center gap-2 text-xs"
      style={{ background: 'color-mix(in srgb, var(--status-info) 10%, var(--surface-panel))', borderColor: 'color-mix(in srgb, var(--status-info) 30%, transparent)' }}>
      <span style={{ color: 'var(--status-info)' }}>Detected repo</span>
      <code className="text-blue">{slug}</code>
      <button onClick={handleAccept} className="px-1.5 py-0.5 rounded text-blue hover:bg-blue/10 transition-colors focus-ring">Use this repo</button>
      <button onClick={onEdit} className="text-overlay1 hover:text-text px-1.5 py-0.5 rounded transition-colors focus-ring">Edit</button>
      <button
        onClick={handleDismiss}
        disabled={dismissing}
        className="text-overlay0 hover:text-text ml-auto px-1 rounded focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
        title="Dismiss"
        aria-label="Dismiss"
      >{String.fromCodePoint(0x00d7)}</button>
    </div>
  )
}
