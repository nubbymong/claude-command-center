import React, { useEffect, useRef, useState } from 'react'
import {
  DialogOverlay,
  DialogPanel,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogButton,
  useDialogEscape,
  DIALOG_INPUT_CLASS,
  DIALOG_INPUT_STYLE,
  DIALOG_LABEL_CLASS,
  DIALOG_LABEL_STYLE,
} from './ui/Dialog'

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

  // Escape anywhere in the dialog dismisses it, not just while the name input
  // holds focus (the input's own handler stays as the in-field path).
  useDialogEscape(dismiss)

  const visible = entering && !closing

  return (
    <DialogOverlay className={`transition-opacity duration-200 ease-out ${visible ? 'opacity-100' : 'opacity-0'}`}>
      <DialogPanel
        labelledBy="new-account-heading"
        width="w-full"
        style={{ maxWidth: '24rem' }}
        className={`transition-all duration-200 ease-out ${visible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-2'}`}
      >
        <DialogHeader
          titleId="new-account-heading"
          title="New account detected"
          right={
            // Kept as a local button rather than DialogHeader's `onClose` so the
            // deliberate `tabIndex={-1}` survives: the name input is the focus
            // target on open, and the dismiss glyph must not sit in front of it
            // in the tab order.
            <button
              type="button"
              onClick={dismiss}
              className="shrink-0 -mr-1.5 -mt-1 w-7 h-7 rounded-md inline-flex items-center justify-center focus-ring transition-colors hover:bg-[var(--surface-overlay)]"
              style={{ color: 'var(--text-muted)' }}
              aria-label="Dismiss"
              title="Dismiss"
              tabIndex={-1}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><path d="M2 2l8 8M10 2l-8 8" /></svg>
            </button>
          }
        />

        <DialogBody className="space-y-4">
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            You signed in to{' '}
            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{email}</span>
            {', '}an account AI Code Conductor has not seen before. Add it so you can switch back to it later.
          </p>

          <div>
            <label htmlFor="new-account-name" className={DIALOG_LABEL_CLASS} style={DIALOG_LABEL_STYLE}>
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
              className={`${DIALOG_INPUT_CLASS} placeholder:text-[var(--text-muted)]`}
              style={DIALOG_INPUT_STYLE}
            />
          </div>
        </DialogBody>

        <DialogFooter>
          <DialogButton variant="ghost" onClick={dismiss} disabled={busy}>
            Not now
          </DialogButton>
          <DialogButton variant="primary" onClick={() => void handleAdd()} disabled={busy}>
            {busy ? 'Adding...' : 'Add account'}
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
