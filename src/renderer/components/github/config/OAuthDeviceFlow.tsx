import { useEffect, useRef, useState } from 'react'
import {
  DialogOverlay,
  DialogPanel,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogButton,
  useDialogEscape,
} from '../../ui/Dialog'

interface Props {
  flow: {
    flowId: string
    userCode: string
    verificationUri: string
    interval: number
    expiresIn: number
  }
  onDone: () => void
  onCancel: () => void
}

export default function OAuthDeviceFlow({ flow, onDone, onCancel }: Props) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollingRef = useRef(true)

  // Hold onDone in a ref so the polling effect can invoke it without listing
  // it as a dep. Inline-arrow props get a fresh identity on every parent
  // re-render, which would otherwise tear down and restart the poll mid-
  // flight — racing the in-flight main-side poll for the single-use
  // device_code. Observed as "GitHub says authorised but modal stays on
  // Waiting". onCancel is only called from the Cancel button handler
  // directly, so it doesn't need the ref indirection.
  const onDoneRef = useRef(onDone)
  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  useEffect(() => {
    // Main's oauthPoll runs its own long-lived polling loop inside
    // pollForAccessToken: it waits interval seconds between GitHub calls and
    // only returns once a token arrives, the flow is cancelled, or the
    // endpoint errors. So the renderer calls oauthPoll exactly once and
    // awaits.
    let cancelled = false
    async function start() {
      try {
        const r = await window.electronAPI.github.oauthPoll(flow.flowId)
        if (cancelled || !pollingRef.current) return
        if (r.ok && r.profileId) {
          onDoneRef.current()
          return
        }
        if (r.error && r.error !== 'pending' && r.error !== 'cancelled') {
          setError(r.error)
        }
      } catch (e) {
        if (cancelled || !pollingRef.current) return
        setError(e instanceof Error ? e.message : String(e))
      }
    }
    void start()
    return () => {
      cancelled = true
      pollingRef.current = false
    }
  }, [flow.flowId])

  const copy = async () => {
    // Clipboard access can reject when the window isn't focused or OS policy
    // blocks it. Swallow so the click doesn't surface as an unhandled promise
    // rejection; the button simply doesn't flip to "Copied" on failure.
    try {
      await navigator.clipboard.writeText(flow.userCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore — user can still see and type the code
    }
  }

  const openGitHub = () => {
    // window.open is denied by setWindowOpenHandler; shell.openExternal enforces https-only.
    void window.electronAPI.shell.openExternal(flow.verificationUri)
  }

  const cancel = async () => {
    pollingRef.current = false
    // Run oauthCancel in a try/finally so a rejected IPC (main crash, channel
    // torn down during shutdown) can't leave the modal open. The user clicked
    // Cancel, so always tear down the modal.
    try {
      await window.electronAPI.github.oauthCancel(flow.flowId)
    } catch {
      // ignore — we're cancelling anyway
    } finally {
      onCancel()
    }
  }

  // Escape is the third way out alongside Cancel and the panel's own controls;
  // it runs the same teardown so the device_code is always released.
  useDialogEscape(() => { void cancel() })

  return (
    <DialogOverlay>
      <DialogPanel labelledBy="gh-device-flow-title" width="w-full" style={{ maxWidth: '28rem' }}>
        <DialogHeader titleId="gh-device-flow-title" title="Sign in with GitHub" />

        <DialogBody>
          <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
            Open{' '}
            <code className="px-1 rounded" style={{ background: 'var(--surface-overlay)', color: 'var(--text-primary)' }}>
              {flow.verificationUri}
            </code>{' '}
            and enter this code:
          </p>
          <div
            className="flex items-center gap-3 p-4 rounded-lg mb-4"
            style={{ background: 'var(--surface-base)', border: '1px solid var(--border-subtle)' }}
          >
            <code className="text-xl font-mono tracking-wider flex-1 text-center" style={{ color: 'var(--text-primary)' }}>
              {flow.userCode}
            </code>
            <DialogButton onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </DialogButton>
          </div>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Waiting for you to complete auth in the browser
          </div>
          {error && (
            <div className="text-xs mt-2" style={{ color: 'var(--status-danger)' }} role="alert" aria-live="polite">
              Error: {error}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <DialogButton variant="ghost" onClick={cancel}>
            Cancel
          </DialogButton>
          {/* Was `bg-blue text-base`: `text-base` is a font SIZE, so the label
              inherited its colour and sat unreadable on the brand fill (#360).
              The primary variant owns both the fill and the on-brand text. */}
          <DialogButton variant="primary" onClick={openGitHub}>
            Open GitHub
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
