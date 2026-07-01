import { useEffect, useState } from 'react'
import { useGitHubStore } from '../stores/githubStore'
import OAuthDeviceFlow from '../components/github/config/OAuthDeviceFlow'
import type { GitHubConfig } from '../../shared/github-types'

declare const __APP_VERSION__: string

const CHECK = String.fromCodePoint(0x2713)
const PR = String.fromCodePoint(0x21c4)
const GEAR = String.fromCodePoint(0x2699)
const SPEECH = String.fromCodePoint(0x1f4ac)
const ISSUE = String.fromCodePoint(0x2317)
const BELL = String.fromCodePoint(0x1f514)
const SPARK = String.fromCodePoint(0x2726)

interface OAuthFlowStart {
  flowId: string
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}

type Method = 'gh' | 'oauth' | 'pat'

const KIND_LABEL: Record<string, string> = {
  'gh-cli': 'GitHub CLI — token never stored',
  oauth: 'Signed in with GitHub',
  'pat-classic': 'Personal access token',
  'pat-fine-grained': 'Personal access token',
}

// The six auth features exactly as Settings presents them (github-feature-meta),
// shown here as value props — the granular toggles stay in Settings. Connections
// are app-wide; each project session gets its own panel.
const FEATURES: { icon: string; title: string; desc: string; offTag?: boolean }[] = [
  { icon: PR, title: 'Active PR card', desc: "Your branch's PR with CI, reviews and merge state." },
  { icon: GEAR, title: 'CI / Actions', desc: 'Workflow runs and logs; re-run failed jobs.' },
  { icon: SPEECH, title: 'Reviews & comments', desc: 'Threaded review comments with inline reply.' },
  { icon: ISSUE, title: 'Linked issues', desc: 'Issues linked by PR body or branch.' },
  { icon: BELL, title: 'Notifications', desc: 'Review requests, mentions, assignments.', offTag: true },
  { icon: SPARK, title: 'Copilot meter', desc: 'Credits used this cycle, in your status line — next page.', offTag: true },
]

export function GitHubStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const profiles = useGitHubStore((s) => s.profiles)
  const [ghUsers, setGhUsers] = useState<string[]>([])
  const [method, setMethod] = useState<Method>('oauth')
  const [oauthMode, setOauthMode] = useState<'public' | 'private'>('public')
  const [oauthFlow, setOauthFlow] = useState<OAuthFlowStart | null>(null)
  const [patKind, setPatKind] = useState<'pat-fine-grained' | 'pat-classic'>('pat-fine-grained')
  const [patToken, setPatToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Master = config.enabledByDefault ("GitHub panel on new sessions"). Local
  // until Next so merely LOOKING at the page never writes config; persisted
  // only when the user touched the toggle or actually connected.
  const [masterOn, setMasterOn] = useState(true)
  const [masterTouched, setMasterTouched] = useState(false)

  useEffect(() => {
    void useGitHubStore.getState().loadConfig()
    void window.electronAPI.github
      .ghcliDetect()
      .then((r) => {
        setGhUsers(r.users)
        if (r.users.length > 0) setMethod('gh')
      })
      .catch(() => setGhUsers([]))
  }, [])

  const connected = profiles.length > 0

  const adoptGh = async (username: string) => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.electronAPI.github.adoptGhCli(username)
      if (r.ok) await useGitHubStore.getState().loadConfig()
      else setError(r.error ?? 'Failed to use the gh account')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to use the gh account')
    } finally {
      setBusy(false)
    }
  }

  const startOAuth = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.electronAPI.github.oauthStart(oauthMode)
      setOauthFlow(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the GitHub sign-in')
    } finally {
      setBusy(false)
    }
  }

  const submitPat = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.electronAPI.github.addPat({ kind: patKind, label: 'PAT', rawToken: patToken })
      if (r.ok) {
        setPatToken('')
        await useGitHubStore.getState().loadConfig()
      } else setError(r.error ?? 'Token verification failed')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Token verification failed')
    } finally {
      setBusy(false)
    }
  }

  // Advancing stamps seenOnboardingVersion (this step replaces the legacy
  // GitHub onboarding modal, which keys off the same field). enabledByDefault
  // is written only on explicit signal: toggle touched, or an account exists.
  const finish = () => {
    const patch: Partial<GitHubConfig> = { seenOnboardingVersion: __APP_VERSION__ }
    if (masterTouched || connected) patch.enabledByDefault = masterOn
    void useGitHubStore.getState().updateConfig(patch).catch(() => {})
    onNext()
  }
  const setMaster = (on: boolean) => {
    setMasterOn(on)
    setMasterTouched(true)
  }

  const oauthScopes =
    oauthMode === 'private'
      ? ['repo', 'read:org', 'notifications', 'workflow']
      : ['public_repo', 'read:org', 'notifications', 'workflow']

  return (
    <>
      <div className="p2">
        <div className="p2-inner" style={{ width: 'min(880px, 95vw)' }}>
          <h2 className="h2">Do you use GitHub?</h2>
          <p className="p2-sub">
            Connect once and every project gets a live GitHub panel — connections are app-wide, panels are per
            project. All optional.
          </p>

          <div className={masterOn ? 'gh-detail' : 'gh-detail off'} inert={!masterOn}>
            <div className="gh-grid">
              {FEATURES.map((f) => (
                <div className="gh-card" key={f.title}>
                  <div className="gh-ic">{f.icon}</div>
                  <div>
                    <div className="gh-t">
                      {f.title}
                      {f.offTag && <span className="gh-tag">off by default</span>}
                    </div>
                    <div className="gh-d">{f.desc}</div>
                  </div>
                </div>
              ))}
            </div>
            <p className="gh-freebie">
              <b>Already on, no account needed:</b> local git state (dirty files, ahead/behind) and session context.
            </p>

            {connected ? (
              <>
                {profiles.map((p) => (
                  <div className="checkrow" key={p.username + p.kind}>
                    <div className="badge ok">{CHECK}</div>
                    <div>
                      <div className="nm">Connected as {p.username}</div>
                      <div className="meta">{KIND_LABEL[p.kind] ?? p.kind} — manage in Settings → GitHub.</div>
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <>
                <p className="connect-l">Connect an account</p>
                {ghUsers.length > 0 && (
                  <button className={method === 'gh' ? 'opt sel' : 'opt'} onClick={() => setMethod('gh')} type="button">
                    <span className="opt-rad" />
                    <span className="opt-body">
                      <span className="opt-t">Use your GitHub CLI login</span>
                      <span className="opt-d">
                        <code>gh</code> is signed in as{' '}
                        {ghUsers.map((u, i) => (
                          <span key={u}>
                            {i > 0 && ', '}
                            <code>{u}</code>
                          </span>
                        ))}{' '}
                        — reuse it. The token is never stored; fetched from <code>gh</code> when needed.
                      </span>
                    </span>
                    <span className="opt-tag">Fastest</span>
                  </button>
                )}
                <button
                  className={method === 'oauth' ? 'opt sel' : 'opt'}
                  onClick={() => setMethod('oauth')}
                  type="button"
                >
                  <span className="opt-rad" />
                  <span className="opt-body">
                    <span className="opt-t">Sign in with GitHub</span>
                    <span className="opt-d">
                      One-time code at <code>github.com/login/device</code> — your password never touches Command
                      Center.
                    </span>
                  </span>
                </button>
                <button className={method === 'pat' ? 'opt sel' : 'opt'} onClick={() => setMethod('pat')} type="button">
                  <span className="opt-rad" />
                  <span className="opt-body">
                    <span className="opt-t">Paste a token</span>
                    <span className="opt-d">Classic or fine-grained PAT — verified, then encrypted on your machine.</span>
                  </span>
                </button>

                {method === 'gh' && (
                  <div className="gh-act">
                    {ghUsers.map((u) => (
                      <button className="run" key={u} onClick={() => void adoptGh(u)} disabled={busy} type="button">
                        {busy ? 'Connecting…' : `Use ${u} →`}
                      </button>
                    ))}
                  </div>
                )}
                {method === 'oauth' && (
                  <div className="gh-act">
                    <div className="gh-modes">
                      <button
                        className={oauthMode === 'public' ? 'fbtn on' : 'fbtn'}
                        onClick={() => setOauthMode('public')}
                        type="button"
                      >
                        Public repos only
                      </button>
                      <button
                        className={oauthMode === 'private' ? 'fbtn on' : 'fbtn'}
                        onClick={() => setOauthMode('private')}
                        type="button"
                      >
                        Include private repos
                      </button>
                    </div>
                    <div className="scopes">
                      <span>Asks for</span>
                      {oauthScopes.map((s) => (
                        <code key={s}>{s}</code>
                      ))}
                    </div>
                    <button className="run" onClick={() => void startOAuth()} disabled={busy} type="button">
                      {busy ? 'Starting…' : 'Sign in with GitHub →'}
                    </button>
                  </div>
                )}
                {method === 'pat' && (
                  <div className="gh-act">
                    <div className="gh-modes">
                      <button
                        className={patKind === 'pat-fine-grained' ? 'fbtn on' : 'fbtn'}
                        onClick={() => setPatKind('pat-fine-grained')}
                        type="button"
                      >
                        Fine-grained
                      </button>
                      <button
                        className={patKind === 'pat-classic' ? 'fbtn on' : 'fbtn'}
                        onClick={() => setPatKind('pat-classic')}
                        type="button"
                      >
                        Classic
                      </button>
                    </div>
                    <input
                      className="gh-input"
                      type="password"
                      placeholder="Paste your token"
                      value={patToken}
                      onChange={(e) => setPatToken(e.target.value)}
                    />
                    <button className="run" onClick={() => void submitPat()} disabled={busy || !patToken} type="button">
                      {busy ? 'Verifying…' : 'Verify & save →'}
                    </button>
                  </div>
                )}
                {error && (
                  <div className="gh-err" role="alert">
                    {error}
                  </div>
                )}
              </>
            )}

            <div className="assure" style={{ marginTop: 14 }}>
              <div className="assure-ic">{CHECK}</div>
              <div>
                <b>Read-only until you click.</b>
                <span>
                  It displays your PRs, checks and issues; the only writes are buttons you press — Merge, Re-run,
                  Reply. Everything talks straight to github.com: no telemetry, and your token is encrypted on this
                  machine.
                </span>
              </div>
            </div>
          </div>

          {!masterOn && (
            <div className="sl-offnote">
              <div className="off-ic">{GEAR}</div>
              <div>
                <b>GitHub is off.</b>
                <span>
                  Connect anytime in <b>Settings → GitHub</b>.
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="foot" style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center' }}>
        <button className="back" onClick={onBack} type="button" style={{ justifySelf: 'start' }}>
          ← Back
        </button>
        <div className="feat-onoff">
          <span className="oo-lbl">GitHub</span>
          <button className={masterOn ? 'oo-btn on' : 'oo-btn'} onClick={() => setMaster(true)} type="button">
            On
          </button>
          <button
            className={masterOn ? 'oo-btn oo-off' : 'oo-btn oo-off on'}
            onClick={() => setMaster(false)}
            type="button"
          >
            Off
          </button>
        </div>
        <button className="cta" onClick={finish} type="button" style={{ justifySelf: 'end', marginLeft: 0 }}>
          Next →
        </button>
      </div>

      {oauthFlow && (
        <OAuthDeviceFlow
          flow={oauthFlow}
          onDone={() => {
            setOauthFlow(null)
            void useGitHubStore.getState().loadConfig()
          }}
          onCancel={() => setOauthFlow(null)}
        />
      )}
    </>
  )
}
