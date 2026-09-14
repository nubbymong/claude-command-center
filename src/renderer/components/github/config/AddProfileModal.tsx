import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useGitHubStore } from '../../../stores/githubStore'
import { trackUsage } from '../../../stores/tipsStore'
import { useFocusTrap } from '../../../hooks/useFocusTrap'
import {
  DialogOverlay,
  DialogPanel,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogButton,
  DIALOG_INPUT_CLASS,
  DIALOG_INPUT_STYLE,
} from '../../ui/Dialog'
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

  // Escape closes the dialog through the trap's onEscape, so no
  // useDialogEscape here. One caveat: the trap listens on `document` in the
  // bubble phase, so while the device flow below is up -- it calls
  // useDialogEscape, which is window-capture -- Escape cancels the OAuth poll
  // and leaves this dialog open. Innermost wins, deliberately.
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

  // A segmented choice: the SELECTED half carries the brand fill, so its label
  // must be the on-brand colour. It used to say `bg-blue text-base`, and
  // `text-base` is a font SIZE — the label inherited its colour and sat on the
  // fill unreadable (#360).
  const scopeBtnClass = (selected: boolean) =>
    `text-sm px-3 py-2 rounded transition-colors text-center ${
      selected
        ? 'font-medium bg-[var(--brand)] text-[var(--text-on-brand)]'
        : 'bg-[var(--surface-base)] hover:bg-[var(--surface-overlay)] text-[var(--text-primary)]'
    }`
  const errorClass = 'text-xs mb-2'
  const errorStyle = { color: 'var(--status-danger)' } as const
  const eyebrowClass = 'text-xs uppercase tracking-wide mb-2'
  const eyebrowStyle = { color: 'var(--text-secondary)' } as const

  // Rendered via portal to document.body so ancestor containers (Settings
  // page, AuthProfilesList section) can't trap `position: fixed` and
  // park the modal bottom-left.
  return createPortal(
    <DialogOverlay className={`transition-opacity duration-200 ease-out ${entering ? 'opacity-100' : 'opacity-0'}`}>
      <DialogPanel
        panelRef={dialogRef}
        labelledBy="gh-add-profile-title"
        width="w-full"
        className={`transition-all duration-200 ease-out ${entering ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-2'}`}
        style={{ maxWidth: '28rem', maxHeight: '85vh' }}
      >
        <DialogHeader
          titleId="gh-add-profile-title"
          title="Add GitHub auth"
          subtitle="Connect an account so the GitHub sidebar can read your PRs, CI runs, and issues."
          onClose={onClose}
        />

        {/* Content */}
        <DialogBody className="flex-1">
          <div className="mb-4">
            <label className={`${eyebrowClass} block`} style={eyebrowStyle}>
              Scope mode
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setOauthMode('public')}
                className={scopeBtnClass(oauthMode === 'public')}
              >
                Public repos only
                <span className="block text-[10px] opacity-70 font-normal">safer</span>
              </button>
              <button
                onClick={() => setOauthMode('private')}
                className={scopeBtnClass(oauthMode === 'private')}
              >
                Include private repos
                <span className="block text-[10px] opacity-70 font-normal">full access</span>
              </button>
            </div>
          </div>

          <DialogButton
            variant="primary"
            size="md"
            block
            onClick={startOAuth}
            disabled={starting}
            className="mb-2"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            {starting ? 'Starting' : 'Sign in with GitHub'}
          </DialogButton>
          {oauthError && (
            <div className={errorClass} style={errorStyle} role="alert" aria-live="polite">
              {oauthError}
            </div>
          )}

          {advanced && (
            <div className="mt-6 pt-4 space-y-5" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              {ghUsers.length > 0 && (
                <div>
                  <div className={eyebrowClass} style={eyebrowStyle}>
                    <code>gh</code> CLI accounts detected
                  </div>
                  {ghUsers.map((u) => (
                    <button
                      key={u}
                      onClick={() => adoptGh(u)}
                      className="block w-full text-left text-sm p-2 rounded mb-1 transition-colors bg-[var(--surface-base)] hover:bg-[var(--surface-overlay)] text-[var(--text-primary)]"
                    >
                      Use <strong>{u}</strong>
                    </button>
                  ))}
                </div>
              )}

              <div>
                <div className={eyebrowClass} style={eyebrowStyle}>
                  Paste a PAT
                </div>
                <select
                  value={patKind}
                  onChange={(e) => setPatKind(e.target.value as typeof patKind)}
                  className={`${DIALOG_INPUT_CLASS} mb-2`}
                  style={DIALOG_INPUT_STYLE}
                >
                  <option value="pat-fine-grained">Fine-grained PAT</option>
                  <option value="pat-classic">Classic PAT</option>
                </select>
                <input
                  placeholder="Label (e.g., work)"
                  value={patLabel}
                  onChange={(e) => setPatLabel(e.target.value)}
                  className={`${DIALOG_INPUT_CLASS} mb-2`}
                  style={DIALOG_INPUT_STYLE}
                />
                <input
                  type="password"
                  placeholder="Token"
                  value={patToken}
                  onChange={(e) => setPatToken(e.target.value)}
                  className={`${DIALOG_INPUT_CLASS} mb-2 font-mono`}
                  style={DIALOG_INPUT_STYLE}
                />
                {patKind === 'pat-fine-grained' && (
                  <input
                    placeholder="Allowed repos (owner/repo, comma or space separated)"
                    value={patRepos}
                    onChange={(e) => setPatRepos(e.target.value)}
                    className={`${DIALOG_INPUT_CLASS} mb-2`}
                    style={DIALOG_INPUT_STYLE}
                  />
                )}
                {patError && (
                  <div className={errorClass} style={errorStyle} role="alert" aria-live="polite">
                    {patError}
                  </div>
                )}
                <DialogButton
                  variant="primary"
                  onClick={submitPat}
                  disabled={patSaving || !patToken}
                >
                  {patSaving ? 'Verifying' : 'Save PAT'}
                </DialogButton>
              </div>
            </div>
          )}
        </DialogBody>

        {/* Footer — advanced toggle left, close button right, clear separation */}
        <DialogFooter
          left={
            <DialogButton variant="ghost" onClick={() => setAdvanced(!advanced)}>
              {advanced ? 'Hide' : 'Show'} advanced auth options
            </DialogButton>
          }
        >
          <DialogButton variant="ghost" onClick={onClose}>
            Close
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>,
    document.body,
  )
}
