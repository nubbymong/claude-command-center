import { useState, useEffect, useRef } from 'react'
import { useCodexAccountStore } from '../../stores/codexAccountStore'

export function CodexSettingsTab() {
  const installed = useCodexAccountStore((s) => s.installed)
  const version = useCodexAccountStore((s) => s.version)
  const authMode = useCodexAccountStore((s) => s.authMode)
  const planType = useCodexAccountStore((s) => s.planType)
  const hasOpenAiApiKeyEnv = useCodexAccountStore((s) => s.hasOpenAiApiKeyEnv)
  const loginChatgpt = useCodexAccountStore((s) => s.loginChatgpt)
  const loginDevice = useCodexAccountStore((s) => s.loginDevice)
  const logout = useCodexAccountStore((s) => s.logout)
  const testConnection = useCodexAccountStore((s) => s.testConnection)

  const [showApiKey, setShowApiKey] = useState(false)
  const [deviceCode, setDeviceCode] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)
  const testResultTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (testResultTimer.current) clearTimeout(testResultTimer.current)
    }
  }, [])

  const handleLoginChatgpt = async () => {
    await loginChatgpt()
  }

  const handleLoginDevice = async () => {
    const result = await loginDevice()
    if (result.deviceCode) {
      setDeviceCode(result.deviceCode)
    }
  }

  const handleTestConnection = async () => {
    if (testResultTimer.current) clearTimeout(testResultTimer.current)
    setTestResult(null)
    const result = await testConnection()
    setTestResult(result.message)
    testResultTimer.current = setTimeout(() => setTestResult(null), 5000)
  }

  const statusText = () => {
    if (!installed) return 'Codex CLI not installed'
    if (authMode === 'chatgpt') {
      return planType ? `Logged in via ChatGPT ${planType}` : 'Logged in via ChatGPT'
    }
    if (authMode === 'api-key') return 'Logged in via API key'
    return 'Not signed in'
  }

  const statusColor = () => {
    if (!installed) return 'text-overlay0'
    if (authMode === 'none') return 'text-yellow'
    return 'text-green'
  }

  return (
    <div className="space-y-4">
      {/* Status section */}
      <div className="rounded-xl bg-surface0/30 border border-surface0/60 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-surface0/40 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-overlay1 shrink-0">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" fill="none" />
            <path d="M8 5v3.5M8 10v.01" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <h3 className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Codex CLI</h3>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-text shrink-0">Status</span>
            <span className={`text-sm font-medium ${statusColor()}`}>{statusText()}</span>
          </div>

          {installed && version && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-text shrink-0">Version</span>
              <span className="text-sm text-subtext0 font-mono">codex-cli {version}</span>
            </div>
          )}

          {authMode === 'chatgpt' && hasOpenAiApiKeyEnv && (
            <div className="rounded-lg bg-yellow/10 border border-yellow/30 px-3 py-2.5 text-xs text-yellow leading-relaxed">
              OPENAI_API_KEY is set in your environment but you are signed in via ChatGPT. Codex prefers env var over auth.json -- billing may go to your API account, not your ChatGPT plan.
            </div>
          )}
        </div>
      </div>

      {/* Install hint -- shown only when not installed */}
      {!installed && (
        <div className="rounded-xl bg-surface0/30 border border-surface0/60 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-surface0/40 flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-overlay1 shrink-0">
              <path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <h3 className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Install</h3>
          </div>
          <div className="p-4 space-y-3">
            <p className="text-sm text-subtext0">Install the Codex CLI to use OpenAI Codex sessions in CCC.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-crust/80 border border-surface0/80 rounded-lg px-3 py-2 text-sm font-mono text-text">
                npm i -g @openai/codex
              </code>
              <button
                onClick={() => navigator.clipboard.writeText('npm i -g @openai/codex').catch(() => {})}
                className="px-3 py-2 rounded-lg bg-surface0/60 border border-surface0/80 text-xs text-overlay1 hover:text-text hover:bg-surface0 transition-colors shrink-0"
              >
                Copy command
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Auth actions -- shown when installed */}
      {installed && (
        <div className="rounded-xl bg-surface0/30 border border-surface0/60 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-surface0/40 flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-overlay1 shrink-0">
              <path d="M11 7H5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1zM7 7V5a1 1 0 0 1 2 0v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            <h3 className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Authentication</h3>
          </div>
          <div className="p-4 space-y-3">
            {/* Login buttons -- shown when not signed in */}
            {authMode === 'none' && (
              <div className="space-y-2">
                <p className="text-xs text-overlay0">Choose how to authenticate with OpenAI Codex.</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleLoginChatgpt}
                    className="px-4 py-2 rounded-lg bg-blue/15 border border-blue/30 text-sm text-blue hover:bg-blue/25 transition-colors"
                  >
                    Sign in with ChatGPT
                  </button>
                  <button
                    onClick={() => setShowApiKey(true)}
                    className="px-4 py-2 rounded-lg bg-surface0/60 border border-surface0/80 text-sm text-overlay1 hover:text-text hover:bg-surface0 transition-colors"
                  >
                    Use API key
                  </button>
                  <button
                    onClick={handleLoginDevice}
                    className="px-4 py-2 rounded-lg bg-surface0/60 border border-surface0/80 text-sm text-overlay1 hover:text-text hover:bg-surface0 transition-colors"
                  >
                    Use device code
                  </button>
                </div>
              </div>
            )}

            {/* Test connection + sign out -- shown when signed in */}
            {authMode !== 'none' && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleTestConnection}
                    className="px-4 py-2 rounded-lg bg-surface0/60 border border-surface0/80 text-sm text-overlay1 hover:text-text hover:bg-surface0 transition-colors"
                  >
                    Test connection
                  </button>
                  <button
                    onClick={() => logout()}
                    className="px-4 py-2 rounded-lg bg-red/10 border border-red/30 text-sm text-red hover:bg-red/20 transition-colors"
                  >
                    Sign out
                  </button>
                </div>
                {testResult && (
                  <p className="text-xs text-subtext0 pt-1">{testResult}</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* API key modal (inline) */}
      {showApiKey && (
        <ApiKeyModal
          onClose={() => setShowApiKey(false)}
        />
      )}

      {/* Device code panel (inline) */}
      {deviceCode && (
        <DeviceCodePanel
          code={deviceCode}
          onDismiss={() => setDeviceCode(null)}
        />
      )}

      {/* Profile-edit note -- always visible */}
      <p className="text-xs text-overlay0 leading-relaxed px-1">
        Profiles edited in <code className="text-overlay1 bg-crust/60 px-1 py-0.5 rounded">{'~/.codex/config.toml'}</code> outside CCC are ignored when spawning from here. CCC sets model and reasoning effort per session.
      </p>
    </div>
  )
}

/* ---- API key modal (inline) ---- */

function ApiKeyModal({ onClose }: { onClose: () => void }) {
  const loginApiKey = useCodexAccountStore((s) => s.loginApiKey)
  const [apiKey, setApiKey] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (!apiKey.trim() || pending) return
    setPending(true)
    setError(null)
    const result = await loginApiKey(apiKey.trim())
    setPending(false)
    if (result.ok) {
      onClose()
    } else {
      setError(result.error ?? 'Login failed')
    }
  }

  return (
    <div className="rounded-xl bg-surface0/30 border border-blue/30 overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="codex-apikey-modal-title">
      <div className="px-4 py-2.5 border-b border-surface0/40 flex items-center justify-between">
        <h3 id="codex-apikey-modal-title" className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Enter API Key</h3>
        <button
          onClick={onClose}
          className="text-overlay0 hover:text-text transition-colors text-xs"
        >
          Cancel
        </button>
      </div>
      <div className="p-4 space-y-3">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value); if (error) setError(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
          placeholder="sk-..."
          autoFocus
          className="w-full bg-crust/60 border border-surface0/80 rounded-lg px-3 py-2 text-sm text-text font-mono focus:outline-none focus:border-blue/50 placeholder:text-overlay0 transition-colors"
        />
        {error && (
          <p className="text-xs text-red">{error}</p>
        )}
        <div className="flex gap-2">
          <button
            onClick={handleSubmit}
            disabled={!apiKey.trim() || pending}
            className="px-4 py-2 rounded-lg bg-blue/15 border border-blue/30 text-sm text-blue hover:bg-blue/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending ? 'Verifying...' : 'Save key'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---- Device code panel (inline) ---- */

function DeviceCodePanel({ code, onDismiss }: { code: string; onDismiss: () => void }) {
  // The panel stays visible until the user manually dismisses or the next
  // Settings re-mount picks up the updated auth state. We do not actively poll
  // auth.json in v1.5.0 -- acceptable for the initial release.
  return (
    <div className="rounded-xl bg-surface0/30 border border-blue/30 overflow-hidden" aria-live="polite">
      <div className="px-4 py-2.5 border-b border-surface0/40 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Device Code</h3>
        <button
          onClick={onDismiss}
          className="text-overlay0 hover:text-text transition-colors text-xs"
        >
          Dismiss
        </button>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-sm text-subtext0">
          Enter this code at{' '}
          <span className="text-blue font-mono">https://chatgpt.com/codex</span>{' '}
          on a separate device.
        </p>
        <div className="flex items-center gap-3">
          <code className="flex-1 bg-crust/80 border border-surface0/80 rounded-lg px-4 py-3 text-xl font-mono text-text tracking-widest text-center">
            {code}
          </code>
          <button
            onClick={() => navigator.clipboard.writeText(code).catch(() => {})}
            className="px-3 py-2 rounded-lg bg-surface0/60 border border-surface0/80 text-xs text-overlay1 hover:text-text hover:bg-surface0 transition-colors shrink-0"
          >
            Copy
          </button>
        </div>
        <p className="text-xs text-overlay0">
          Enter this code on a separate device to complete sign-in.
        </p>
      </div>
    </div>
  )
}
