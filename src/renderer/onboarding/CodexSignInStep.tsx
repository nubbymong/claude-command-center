import { useEffect, useState } from 'react'
import { useCodexAccountStore } from '../stores/codexAccountStore'

const CHECK = String.fromCodePoint(0x2713)

// Real Codex auth via codexAccountStore (ChatGPT browser flow / API key) —
// the same machinery as Settings -> Codex. Best-effort: skippable when not
// signed in; already-authed users just see the green state.
export function CodexSignInStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const installed = useCodexAccountStore((s) => s.installed)
  const authMode = useCodexAccountStore((s) => s.authMode)
  const planType = useCodexAccountStore((s) => s.planType)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void useCodexAccountStore.getState().refresh()
  }, [])

  const signed = authMode !== 'none'

  const chatgpt = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await useCodexAccountStore.getState().loginChatgpt()
      if (!r.ok) setError(r.error ?? 'ChatGPT sign-in failed')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ChatGPT sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  const submitKey = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await useCodexAccountStore.getState().loginApiKey(apiKey)
      if (r.ok) setApiKey('')
      else setError(r.error ?? 'API-key sign-in failed')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'API-key sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="p2">
        <div className="p2-inner">
          <h2 className="h2">
            Sign in to Codex.<span className="beta-tag">Beta</span>
          </h2>
          <p className="p2-sub">One sign-in, read by the Codex CLI itself. The Conductor never sees your password.</p>

          {signed ? (
            <div className="checkrow">
              <div className="badge ok">{CHECK}</div>
              <div>
                <div className="nm">
                  {authMode === 'chatgpt' ? 'Signed in with ChatGPT' : 'Signed in with an API key'}
                </div>
                <div className="meta">
                  {authMode === 'chatgpt' && planType ? `${planType} plan. ` : ''}Manage in Settings → Codex.
                </div>
              </div>
            </div>
          ) : !installed ? (
            <div className="checkrow">
              <div className="badge wait">!</div>
              <div>
                <div className="nm">Codex CLI not found</div>
                <div className="meta">
                  Install it with <code>npm i -g @openai/codex</code>, then sign in here or in Settings → Codex.
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="gh-act" style={{ marginBottom: 14 }}>
                <button className="run" onClick={() => void chatgpt()} disabled={busy} type="button">
                  {busy ? 'Waiting for the browser…' : 'Sign in with ChatGPT →'}
                </button>
                <span className="hint">Opens your browser via the Codex CLI's own login.</span>
              </div>
              <p className="connect-l">Or paste an OpenAI API key</p>
              <div className="gh-act">
                <input
                  className="gh-input"
                  type="password"
                  placeholder="sk-…"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <button className="run" onClick={() => void submitKey()} disabled={busy || !apiKey} type="button">
                  {busy ? 'Verifying…' : 'Save key →'}
                </button>
              </div>
              {error && (
                <div className="gh-err" role="alert">
                  {error}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <div className="foot">
        <button className="back" onClick={onBack} type="button">← Back</button>
        {signed ? (
          <button className="cta" onClick={onNext} type="button">Next →</button>
        ) : (
          <button className="skip foot-skip" onClick={onNext} type="button">Skip for now →</button>
        )}
      </div>
    </>
  )
}
