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

  useEffect(() => {
    let cancelled = false
    async function pollLoop() {
      while (!cancelled && pollingRef.current) {
        await new Promise((r) => setTimeout(r, (flow.interval + 1) * 1000))
        if (cancelled || !pollingRef.current) break
        try {
          const r = await window.electronAPI.github.oauthPoll(flow.flowId)
          if (r.ok && r.profileId) {
            onDone()
            return
          }
          if (!r.ok && r.error && r.error !== 'pending') {
            setError(r.error)
            return
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
          return
        }
      }
    }
    void pollLoop()
    return () => {
      cancelled = true
      pollingRef.current = false
    }
  }, [flow.flowId, flow.interval, onDone])

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
