import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useGitHubStore } from '../../../stores/githubStore'
import { trackUsage } from '../../../stores/tipsStore'
import { useFocusTrap } from '../../../hooks/useFocusTrap'
import OAuthDeviceFlow from './OAuthDeviceFlow'

interface OAuthFlowStart {
  flowId: string
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}

interface Props {
  onClose: () => void
}

export default function AddProfileModal({ onClose }: Props) {
  const loadConfig = useGitHubStore((s) => s.loadConfig)
  const [advanced, setAdvanced] = useState(false)
  const [ghUsers, setGhUsers] = useState<string[]>([])
  const [starting, setStarting] = useState(false)
  const [oauthMode, setOauthMode] = useState<'public' | 'private'>('public')
  const [oauthFlow, setOauthFlow] = useState<OAuthFlowStart | null>(null)
  const [oauthError, setOauthError] = useState<string | null>(null)

  const [patKind, setPatKind] = useState<'pat-fine-grained' | 'pat-classic'>('pat-fine-grained')
  const [patToken, setPatToken] = useState('')
  const [patLabel, setPatLabel] = useState('')
  const [patRepos, setPatRepos] = useState('')
  const [patError, setPatError] = useState<string | null>(null)
  const [patSaving, setPatSaving] = useState(false)

  const dialogRef = useRef<HTMLDivElement | null>(null)

  // Matches the OnboardingModal / WhatsNewModal fade-in pattern for a
  // consistent first-interaction feel.
  const [entering, setEntering] = useState(false)
  useEffect(() => {
    const t = requestAnimationFrame(() => setEntering(true))
    return () => cancelAnimationFrame(t)
  }, [])

  useEffect(() => {
    window.electronAPI.github.ghcliDetect().then((r) => setGhUsers(r.users))
  }, [])

  useFocusTrap(dialogRef, true, onClose)

  const startOAuth = async () => {
    setStarting(true)
    setOauthError(null)
    try {
      const r = await window.electronAPI.github.oauthStart(oauthMode)
      setOauthFlow(r)
    } catch (e) {
      setOauthError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  const adoptGh = async (username: string) => {
    try {
      const r = await window.electronAPI.github.adoptGhCli(username)
      if (r.ok) {
        trackUsage('github.signed-in')
        await loadConfig()
        onClose()
      } else {
        setOauthError(r.error ?? 'Failed to adopt gh account')
      }
    } catch (err) {
      // Main-side throw — without the catch this becomes an unhandled
      // promise rejection from the click handler and the user gets no
      // feedback why the button click did nothing.
      setOauthError(err instanceof Error ? err.message : 'Failed to adopt gh account')
    }
  }

  const submitPat = async () => {
    setPatSaving(true)
    setPatError(null)
    const repos = patRepos.split(/[\s,]+/).filter(Boolean)
    try {
      const r = await window.electronAPI.github.addPat({
        kind: patKind,
        label: patLabel || 'PAT',
        rawToken: patToken,
        allowedRepos: patKind === 'pat-fine-grained' && repos.length > 0 ? repos : undefined,
      })
      if (r.ok) {
        trackUsage('github.signed-in')
        await loadConfig()
        onClose()
      } else {
        setPatError(r.error ?? 'error')
      }
    } catch (err) {
      // Main-side throw (network error on verify, IPC crash). Without this
      // catch, patSaving stays true forever because the sync reset below
      // is skipped on throw.
      setPatError(err instanceof Error ? err.message : 'Failed to save PAT')
    } finally {
      setPatSaving(false)
    }
  }

  if (oauthFlow) {
    return (
      <OAuthDeviceFlow
        flow={oauthFlow}
        onDone={async () => {
          trackUsage('github.signed-in')
          await loadConfig()
          onClose()
        }}
        onCancel={() => setOauthFlow(null)}
      />
    )
  }

  const backdropClass = `fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 transition-opacity duration-200 ease-out ${entering ? 'opacity-100' : 'opacity-0'}`
  const dialogClass = `bg-mantle rounded-lg shadow-2xl border border-surface0 w-full max-w-md max-h-[85vh] flex flex-col transition-all duration-200 ease-out ${entering ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-2'}`

  // Rendered via portal to document.body so ancestor containers (Settings
  // page, AuthProfilesList section) can't trap `position: fixed` and
  // park the modal bottom-left.
  return createPortal(
    <div className={backdropClass}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gh-add-profile-title"
        className={dialogClass}
      >
        {/* Header */}
        <div className="p-5 border-b border-surface0 shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 id="gh-add-profile-title" className="text-lg font-bold text-text">
                Add GitHub auth
              </h3>
              <p className="text-xs text-subtext0 mt-1">
                Connect an account so the GitHub sidebar can read your PRs, CI runs, and issues.
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-overlay0 hover:text-text transition-colors text-xl leading-none shrink-0"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          <div className="mb-4">
            <label className="text-xs uppercase tracking-wide text-subtext0 block mb-2">
              Scope mode
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setOauthMode('public')}
                className={`text-sm px-3 py-2 rounded transition-colors text-center ${
                  oauthMode === 'public'
                    ? 'bg-blue text-base font-medium'
                    : 'bg-surface0 hover:bg-surface1 text-text'
                }`}
              >
                Public repos only
                <span className="block text-[10px] opacity-70 font-normal">safer</span>
              </button>
              <button
                onClick={() => setOauthMode('private')}
                className={`text-sm px-3 py-2 rounded transition-colors text-center ${
                  oauthMode === 'private'
                    ? 'bg-blue text-base font-medium'
                    : 'bg-surface0 hover:bg-surface1 text-text'
                }`}
              >
                Include private repos
                <span className="block text-[10px] opacity-70 font-normal">full access</span>
              </button>
            </div>
          </div>

          <button
            onClick={startOAuth}
            disabled={starting}
            className="w-full bg-blue text-base font-medium px-4 py-2.5 rounded mb-2 hover:bg-blue/80 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            {starting ? 'Starting' : 'Sign in with GitHub'}
          </button>
          {oauthError && (
            <div className="text-xs text-red mb-2" role="alert" aria-live="polite">
              {oauthError}
            </div>
          )}

          {advanced && (
            <div className="mt-6 pt-4 border-t border-surface0 space-y-5">
              {ghUsers.length > 0 && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-subtext0 mb-2">
                    <code className="text-subtext1">gh</code> CLI accounts detected
                  </div>
                  {ghUsers.map((u) => (
                    <button
                      key={u}
                      onClick={() => adoptGh(u)}
                      className="block w-full text-left text-sm bg-surface0 hover:bg-surface1 p-2 rounded mb-1 transition-colors"
                    >
                      Use <strong>{u}</strong>
                    </button>
                  ))}
                </div>
              )}

              <div>
                <div className="text-xs uppercase tracking-wide text-subtext0 mb-2">
                  Paste a PAT
                </div>
                <select
                  value={patKind}
                  onChange={(e) => setPatKind(e.target.value as typeof patKind)}
                  className="bg-surface0 p-1.5 rounded text-sm mb-2 w-full"
                >
                  <option value="pat-fine-grained">Fine-grained PAT</option>
                  <option value="pat-classic">Classic PAT</option>
                </select>
                <input
                  placeholder="Label (e.g., work)"
                  value={patLabel}
                  onChange={(e) => setPatLabel(e.target.value)}
                  className="w-full bg-surface0 p-2 rounded text-sm mb-2"
                />
                <input
                  type="password"
                  placeholder="Token"
                  value={patToken}
                  onChange={(e) => setPatToken(e.target.value)}
                  className="w-full bg-surface0 p-2 rounded text-sm mb-2 font-mono"
                />
                {patKind === 'pat-fine-grained' && (
                  <input
                    placeholder="Allowed repos (owner/repo, comma or space separated)"
                    value={patRepos}
                    onChange={(e) => setPatRepos(e.target.value)}
                    className="w-full bg-surface0 p-2 rounded text-sm mb-2"
                  />
                )}
                {patError && (
                  <div className="text-xs text-red mb-2" role="alert" aria-live="polite">
                    {patError}
                  </div>
                )}
                <button
                  onClick={submitPat}
                  disabled={patSaving || !patToken}
                  className="bg-blue text-base font-medium px-3 py-1.5 rounded text-sm hover:bg-blue/80 transition-colors disabled:opacity-60"
                >
                  {patSaving ? 'Verifying' : 'Save PAT'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer — advanced toggle left, close button right, clear separation */}
        <div className="p-4 border-t border-surface0 flex items-center justify-between shrink-0">
          <button
            onClick={() => setAdvanced(!advanced)}
            className="text-xs text-subtext0 hover:text-text transition-colors"
          >
            {advanced ? 'Hide' : 'Show'} advanced auth options
          </button>
          <button
            onClick={onClose}
            className="text-xs text-subtext0 hover:text-text transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
