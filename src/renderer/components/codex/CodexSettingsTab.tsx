import { useState, useEffect, useRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useCodexAccountStore } from '../../stores/codexAccountStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import {
  DialogOverlay,
  DialogPanel,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogButton,
} from '../ui/Dialog'

/* ---- shared token recipes for this tab ------------------------------------ */

/** A neutral action button inside a settings card (Copy, Test connection, …). */
const NEUTRAL_BTN = 'rounded-lg border transition-colors hover:bg-[var(--surface-overlay)] hover:text-[var(--text-primary)]'
const NEUTRAL_BTN_STYLE: CSSProperties = {
  background: 'var(--surface-base)',
  borderColor: 'var(--border-subtle)',
  color: 'var(--text-secondary)',
}

/** A brand-tinted action (the sign-in paths). */
const BRAND_BTN = 'rounded-lg border transition-colors hover:bg-[color-mix(in_srgb,var(--brand)_25%,transparent)]'
const BRAND_BTN_STYLE: CSSProperties = {
  background: 'color-mix(in srgb, var(--brand) 15%, transparent)',
  borderColor: 'color-mix(in srgb, var(--brand) 40%, transparent)',
  color: 'var(--brand)',
}

/** A code/value well sunk into a card. */
const CODE_WELL_STYLE: CSSProperties = {
  background: 'var(--surface-sunken)',
  borderColor: 'var(--border-subtle)',
  color: 'var(--text-primary)',
}

export function CodexSettingsTab() {
  // Master "Do you use Codex?" answer — the recovery surface for the
  // onboarding page's Off state. Absent (never answered) counts as on.
  const codexEnabled = useSettingsStore((s) => s.settings.codexEnabled)
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
  const [loginError, setLoginError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)
  const testResultTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (testResultTimer.current) clearTimeout(testResultTimer.current)
    }
  }, [])

  const handleLoginChatgpt = async () => {
    setLoginError(null)
    const result = await loginChatgpt()
    if (!result.ok) setLoginError(result.error ?? 'ChatGPT login failed')
  }

  const handleLoginDevice = async () => {
    setLoginError(null)
    const result = await loginDevice()
    if (!result.ok) {
      setLoginError(result.error ?? 'Device login failed')
    } else if (result.deviceCode) {
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

  // Returns a token, not a palette class: the status hue has to follow the
  // theme the same way the rest of the chrome does.
  const statusColor = () => {
    if (!installed) return 'var(--text-muted)'
    if (authMode === 'none') return 'var(--status-warning)'
    return 'var(--status-success)'
  }

  return (
    <div className="space-y-4">
      {/* Master switch (Beta) */}
      <div className="settings-card px-4 py-3 flex items-center gap-3">
        <input
          type="checkbox"
          checked={codexEnabled !== false}
          onChange={(e) => void useSettingsStore.getState().updateSettings({ codexEnabled: e.target.checked })}
          className="rounded border-[var(--border-subtle)]"
        />
        <div className="min-w-0">
          <div className="text-sm leading-tight" style={{ color: 'var(--text-primary)' }}>
            Enable Codex{' '}
            <span
              className="text-[9px] uppercase tracking-wider border rounded-full px-1.5 py-px align-middle"
              style={{ color: 'var(--brand)', borderColor: 'color-mix(in srgb, var(--brand) 40%, transparent)' }}
            >
              Beta
            </span>
          </div>
          <div className="text-[11px] leading-tight" style={{ color: 'var(--text-muted)' }}>
            Off blocks launching Codex configs and removes the code-review tool from new Claude sessions.
          </div>
        </div>
      </div>

      {/* Body dims + goes inert when the master is off, matching the Status
          Line and Built-in Tools tabs. The master above stays live as the
          recovery surface. */}
      <div
        inert={codexEnabled === false}
        className={codexEnabled === false ? 'space-y-4 opacity-40 pointer-events-none' : 'space-y-4'}
      >

      {/* Status section */}
      <div className="settings-card overflow-hidden">
        <div className="px-4 py-2.5 border-b settings-divider flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0" style={{ color: 'var(--text-muted)' }}>
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" fill="none" />
            <path d="M8 5v3.5M8 10v.01" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Codex CLI</h3>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm shrink-0" style={{ color: 'var(--text-primary)' }}>Status</span>
            <span className="text-sm font-medium" style={{ color: statusColor() }}>{statusText()}</span>
          </div>

          {installed && version && (
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm shrink-0" style={{ color: 'var(--text-primary)' }}>Version</span>
              <span className="text-sm font-mono" style={{ color: 'var(--text-secondary)' }}>codex-cli {version}</span>
            </div>
          )}

          {authMode === 'chatgpt' && hasOpenAiApiKeyEnv && (
            <div
              className="rounded-lg border px-3 py-2.5 text-xs leading-relaxed"
              style={{
                background: 'color-mix(in srgb, var(--status-warning) 10%, transparent)',
                borderColor: 'color-mix(in srgb, var(--status-warning) 40%, transparent)',
                color: 'var(--status-warning)',
              }}
            >
              OPENAI_API_KEY is set in your environment but you are signed in via ChatGPT. Codex prefers env var over auth.json -- billing may go to your API account, not your ChatGPT plan.
            </div>
          )}
        </div>
      </div>

      {/* Install hint -- shown only when not installed */}
      {!installed && (
        <div className="settings-card overflow-hidden">
          <div className="px-4 py-2.5 border-b settings-divider flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0" style={{ color: 'var(--text-muted)' }}>
              <path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Install</h3>
          </div>
          <div className="p-4 space-y-3">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Install the Codex CLI to use OpenAI Codex sessions in AI Code Conductor.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 border rounded-lg px-3 py-2 text-sm font-mono" style={CODE_WELL_STYLE}>
                npm i -g @openai/codex
              </code>
              <button
                onClick={() => navigator.clipboard.writeText('npm i -g @openai/codex').catch(() => {})}
                className={`px-3 py-2 text-xs shrink-0 ${NEUTRAL_BTN}`}
                style={NEUTRAL_BTN_STYLE}
              >
                Copy command
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Auth actions -- shown when installed */}
      {installed && (
        <div className="settings-card overflow-hidden">
          <div className="px-4 py-2.5 border-b settings-divider flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0" style={{ color: 'var(--text-muted)' }}>
              <path d="M11 7H5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1zM7 7V5a1 1 0 0 1 2 0v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Authentication</h3>
          </div>
          <div className="p-4 space-y-3">
            {/* Login buttons -- shown when not signed in */}
            {authMode === 'none' && (
              <div className="space-y-2">
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Choose how to authenticate with OpenAI Codex.</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleLoginChatgpt}
                    className={`px-4 py-2 text-sm ${BRAND_BTN}`}
                    style={BRAND_BTN_STYLE}
                  >
                    Sign in with ChatGPT
                  </button>
                  <button
                    onClick={() => setShowApiKey(true)}
                    className={`px-4 py-2 text-sm ${NEUTRAL_BTN}`}
                    style={NEUTRAL_BTN_STYLE}
                  >
                    Use API key
                  </button>
                  <button
                    onClick={handleLoginDevice}
                    className={`px-4 py-2 text-sm ${NEUTRAL_BTN}`}
                    style={NEUTRAL_BTN_STYLE}
                  >
                    Use device code
                  </button>
                </div>
                {loginError && (
                  <p className="text-xs mt-2" style={{ color: 'var(--status-danger)' }}>{loginError}</p>
                )}
              </div>
            )}

            {/* Test connection + sign out -- shown when signed in */}
            {authMode !== 'none' && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleTestConnection}
                    className={`px-4 py-2 text-sm ${NEUTRAL_BTN}`}
                    style={NEUTRAL_BTN_STYLE}
                  >
                    Test connection
                  </button>
                  <button
                    onClick={() => logout()}
                    className="px-4 py-2 rounded-lg border text-sm transition-colors hover:bg-[color-mix(in_srgb,var(--status-danger)_20%,transparent)]"
                    style={{
                      background: 'color-mix(in srgb, var(--status-danger) 10%, transparent)',
                      borderColor: 'color-mix(in srgb, var(--status-danger) 30%, transparent)',
                      color: 'var(--status-danger)',
                    }}
                  >
                    Sign out
                  </button>
                </div>
                {testResult && (
                  <p className="text-xs pt-1" style={{ color: 'var(--text-secondary)' }}>{testResult}</p>
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
      <p className="text-xs leading-relaxed px-1" style={{ color: 'var(--text-muted)' }}>
        Profiles edited in <code className="px-1 py-0.5 rounded" style={{ color: 'var(--text-secondary)', background: 'var(--surface-sunken)' }}>{'~/.codex/config.toml'}</code> outside AI Code Conductor are ignored when spawning from here. The app sets model and reasoning effort per session.
      </p>
      </div>
    </div>
  )
}

/* ---- API key modal (inline) ---- */

function ApiKeyModal({ onClose }: { onClose: () => void }) {
  const loginApiKey = useCodexAccountStore((s) => s.loginApiKey)
  const [apiKey, setApiKey] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // The trap owns Escape here (it also restores focus on close), so this dialog
  // does not additionally call useDialogEscape.
  useFocusTrap(dialogRef, true, onClose)

  // Explicitly focus the password input rather than the first focusable (Cancel button).
  useEffect(() => { inputRef.current?.focus() }, [])

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

  return createPortal(
    <DialogOverlay>
      <DialogPanel width="w-[384px]" labelledBy="codex-apikey-modal-title" panelRef={dialogRef}>
        <DialogHeader
          titleId="codex-apikey-modal-title"
          title="Enter API Key"
          onClose={onClose}
          closeLabel="Cancel"
        />
        <DialogBody className="space-y-3">
          <input
            ref={inputRef}
            type="password"
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); if (error) setError(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
            placeholder="sk-..."
            className="w-full border rounded-lg px-3 py-2 text-sm font-mono outline-none focus-ring placeholder:text-[var(--text-muted)] transition-colors"
            style={{ background: 'var(--surface-base)', borderColor: 'var(--border-strong)', color: 'var(--text-primary)' }}
          />
          {error && (
            <p className="text-xs" style={{ color: 'var(--status-danger)' }}>{error}</p>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogButton variant="ghost" onClick={onClose}>Cancel</DialogButton>
          <DialogButton
            variant="primary"
            onClick={handleSubmit}
            disabled={!apiKey.trim() || pending}
          >
            {pending ? 'Verifying...' : 'Save key'}
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>,
    document.body,
  )
}

/* ---- Device code panel (inline) ---- */

function DeviceCodePanel({ code, onDismiss }: { code: string; onDismiss: () => void }) {
  // The panel stays visible until the user manually dismisses or the next
  // Settings re-mount picks up the updated auth state. We do not actively poll
  // auth.json in v1.5.0 -- acceptable for the initial release.
  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ background: 'var(--surface-raised)', borderColor: 'color-mix(in srgb, var(--brand) 40%, transparent)' }}
      aria-live="polite"
    >
      <div className="px-4 py-2.5 border-b settings-divider flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>Device Code</h3>
        <button
          onClick={onDismiss}
          className="transition-colors text-xs hover:text-[var(--text-primary)]"
          style={{ color: 'var(--text-muted)' }}
        >
          Dismiss
        </button>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Enter this code at{' '}
          <span className="font-mono" style={{ color: 'var(--brand)' }}>https://chatgpt.com/codex</span>{' '}
          on a separate device.
        </p>
        <div className="flex items-center gap-3">
          <code className="flex-1 border rounded-lg px-4 py-3 text-xl font-mono tracking-widest text-center" style={CODE_WELL_STYLE}>
            {code}
          </code>
          <button
            onClick={() => navigator.clipboard.writeText(code).catch(() => {})}
            className={`px-3 py-2 text-xs shrink-0 ${NEUTRAL_BTN}`}
            style={NEUTRAL_BTN_STYLE}
          >
            Copy
          </button>
        </div>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Enter this code on a separate device to complete sign-in.
        </p>
      </div>
    </div>
  )
}
