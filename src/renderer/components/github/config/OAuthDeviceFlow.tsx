import { useEffect, useRef, useState } from 'react'

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

  // Hold the latest onDone / onCancel in refs so the polling effect never has
  // to list them as deps. Inline-arrow props get a fresh identity on every
  // parent re-render, which would otherwise tear down and restart the poll
  // mid-flight — and the restart races the in-flight main-side poll for the
  // single-use device_code. Observed as "GitHub says authorised but modal
  // stays on Waiting".
  const onDoneRef = useRef(onDone)
  const onCancelRef = useRef(onCancel)
  useEffect(() => {
    onDoneRef.current = onDone
    onCancelRef.current = onCancel
  }, [onDone, onCancel])

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
    await navigator.clipboard.writeText(flow.userCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const openGitHub = () => {
    // window.open is denied by setWindowOpenHandler; shell.openExternal enforces https-only.
    void window.electronAPI.shell.openExternal(flow.verificationUri)
  }

  const cancel = async () => {
    pollingRef.current = false
    await window.electronAPI.github.oauthCancel(flow.flowId)
    onCancel()
  }

  return (
    <div
      className="fixed inset-0 bg-base/80 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-mantle p-6 rounded max-w-md w-full">
        <h3 className="text-lg mb-3 text-text">Sign in with GitHub</h3>
        <p className="text-sm text-subtext0 mb-4">
          Open <code className="bg-surface0 px-1 rounded">{flow.verificationUri}</code> and enter
          this code:
        </p>
        <div className="flex items-center gap-3 bg-surface0 p-4 rounded mb-4">
          <code className="text-xl text-text font-mono tracking-wider flex-1 text-center">
            {flow.userCode}
          </code>
          <button onClick={copy} className="bg-surface1 px-2 py-1 rounded text-xs">
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="flex gap-2">
          <button
            onClick={openGitHub}
            className="bg-blue text-base px-3 py-1.5 rounded text-sm flex-1"
          >
            Open GitHub
          </button>
          <button onClick={cancel} className="bg-surface0 px-3 py-1.5 rounded text-sm">
            Cancel
          </button>
        </div>
        <div className="text-xs text-overlay1 mt-3">
          Waiting for you to complete auth in the browser
        </div>
        {error && <div className="text-xs text-red mt-2">Error: {error}</div>}
      </div>
    </div>
  )
}
