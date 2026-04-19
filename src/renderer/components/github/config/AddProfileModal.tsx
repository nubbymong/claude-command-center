import { useEffect, useState } from 'react'
import { useGitHubStore } from '../../../stores/githubStore'
import { trackUsage } from '../../../stores/tipsStore'
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

  useEffect(() => {
    window.electronAPI.github.ghcliDetect().then((r) => setGhUsers(r.users))
  }, [])

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
    const r = await window.electronAPI.github.adoptGhCli(username)
    if (r.ok) {
      trackUsage('github.signed-in')
      await loadConfig()
      onClose()
    }
  }

  const submitPat = async () => {
    setPatSaving(true)
    setPatError(null)
    const repos = patRepos.split(/[\s,]+/).filter(Boolean)
    const r = await window.electronAPI.github.addPat({
      kind: patKind,
      label: patLabel || 'PAT',
      rawToken: patToken,
      allowedRepos: patKind === 'pat-fine-grained' && repos.length > 0 ? repos : undefined,
    })
    setPatSaving(false)
    if (r.ok) {
      trackUsage('github.signed-in')
      await loadConfig()
      onClose()
    } else {
      setPatError(r.error ?? 'error')
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

  return (
    <div
      className="fixed inset-0 bg-base/80 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-mantle p-6 rounded max-w-md w-full">
        <h3 className="text-lg mb-3 text-text">Add GitHub auth</h3>

        <div className="mb-3">
          <label className="text-xs text-subtext0 block mb-1">Scope mode</label>
          <div className="flex gap-2">
            <button
              onClick={() => setOauthMode('public')}
              className={`text-xs px-3 py-1 rounded ${
                oauthMode === 'public' ? 'bg-blue text-base' : 'bg-surface0'
              }`}
            >
              Public repos only (safer)
            </button>
            <button
              onClick={() => setOauthMode('private')}
              className={`text-xs px-3 py-1 rounded ${
                oauthMode === 'private' ? 'bg-blue text-base' : 'bg-surface0'
              }`}
            >
              Include private repos
            </button>
          </div>
        </div>

        <button
          onClick={startOAuth}
          disabled={starting}
          className="w-full bg-blue text-base px-3 py-2 rounded mb-2"
        >
          {starting ? 'Starting' : 'Sign in with GitHub'}
        </button>
        {oauthError && <div className="text-xs text-red mb-2">{oauthError}</div>}

        <button onClick={() => setAdvanced(!advanced)} className="text-xs text-subtext0 mb-2 mt-2">
          {advanced ? 'Hide' : 'Show'} advanced auth options
        </button>

        {advanced && (
          <div className="space-y-4">
            {ghUsers.length > 0 && (
              <div>
                <div className="text-xs text-subtext0 mb-1">`gh` CLI accounts detected</div>
                {ghUsers.map((u) => (
                  <button
                    key={u}
                    onClick={() => adoptGh(u)}
                    className="block w-full text-left text-sm bg-surface0 hover:bg-surface1 p-2 rounded mb-1"
                  >
                    Use <strong>{u}</strong>
                  </button>
                ))}
              </div>
            )}

            <div>
              <div className="text-xs text-subtext0 mb-1">Paste a PAT</div>
              <select
                value={patKind}
                onChange={(e) => setPatKind(e.target.value as typeof patKind)}
                className="bg-surface0 p-1 rounded text-sm mb-2"
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
              {patError && <div className="text-xs text-red mb-2">{patError}</div>}
              <button
                onClick={submitPat}
                disabled={patSaving || !patToken}
                className="bg-blue text-base px-3 py-1 rounded text-sm"
              >
                {patSaving ? 'Verifying' : 'Save PAT'}
              </button>
            </div>
          </div>
        )}

        <button onClick={onClose} className="mt-4 text-xs text-subtext0">
          Close
        </button>
      </div>
    </div>
  )
}
