import React, { useEffect, useRef, useState } from 'react'

interface Props {
  email: string
  onAdd: (name: string) => void | Promise<void>
  onDismiss: () => void
}

const CLOSE_ANIMATION_MS = 200

export default function NewAccountPrompt({ email, onAdd, onDismiss }: Props) {
  const [entering, setEntering] = useState(false)
  const [closing, setClosing] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = requestAnimationFrame(() => setEntering(true))
    return () => cancelAnimationFrame(t)
  }, [])

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (entering) inputRef.current?.focus()
  }, [entering])

  const dismiss = () => {
    if (closing || busy) return
    setClosing(true)
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      onDismiss()
    }, CLOSE_ANIMATION_MS)
  }

  const handleAdd = async () => {
    if (busy || closing) return
    setBusy(true)
    try {
      await onAdd(name.trim())
    } finally {
      setBusy(false)
    }
  }

  const visible = entering && !closing
  const backdropClass = `fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 transition-opacity duration-200 ease-out ${visible ? 'opacity-100' : 'opacity-0'}`
  const dialogClass = `bg-mantle rounded-lg shadow-2xl border border-surface0 w-full max-w-sm flex flex-col transition-all duration-200 ease-out ${visible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-2'}`

  return (
    <div className={backdropClass} role="dialog" aria-modal="true" aria-labelledby="new-account-heading">
      <div className={dialogClass}>
        <div className="p-5 border-b border-surface0 flex items-center justify-between">
          <h2 id="new-account-heading" className="text-base font-semibold text-text">
            New account detected
          </h2>
          <button
            onClick={dismiss}
            className="text-overlay0 hover:text-text transition-colors text-xl leading-none ml-2"
            aria-label="Dismiss"
            tabIndex={-1}
          >
            &times;
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-sm text-subtext0">
            You signed in to{' '}
            <span className="text-text font-medium">{email}</span>
            {', '}an account CCC has not seen before. Add it so you can switch back to it later.
          </p>

          <div>
            <label htmlFor="new-account-name" className="block text-xs text-subtext1 mb-1">
              Name (optional)
            </label>
            <input
              id="new-account-name"
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAdd()
                if (e.key === 'Escape') dismiss()
              }}
              placeholder="Optional name, e.g. Work"
              className="w-full bg-base border border-surface1 rounded px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-blue"
            />
          </div>
        </div>

        <div className="px-5 pb-5 flex justify-end gap-2">
          <button
            onClick={dismiss}
            disabled={busy}
            className="px-3 py-1.5 rounded text-xs text-subtext0 hover:text-text hover:bg-surface1 transition-colors disabled:opacity-50"
          >
            Not now
          </button>
          <button
            onClick={() => void handleAdd()}
            disabled={busy}
            className="px-3 py-1.5 rounded text-xs bg-blue text-crust font-medium hover:bg-blue/90 transition-colors disabled:opacity-50"
          >
            {busy ? 'Adding...' : 'Add account'}
          </button>
        </div>
      </div>
    </div>
  )
}
