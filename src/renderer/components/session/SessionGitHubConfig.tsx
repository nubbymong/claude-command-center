import { useEffect, useState } from 'react'
import { useGitHubStore } from '../../stores/githubStore'
import { useSessionStore } from '../../stores/sessionStore'
import { trackUsage } from '../../stores/tipsStore'
import { parseRepoUrlClient } from './parseRepoUrlClient'
import type { SessionGitHubIntegration } from '../../../shared/github-types'

interface Props {
  sessionId: string
  cwd: string
  initial?: SessionGitHubIntegration
}

export default function SessionGitHubConfig({ sessionId, cwd, initial }: Props) {
  const config = useGitHubStore((s) => s.config)
  const profiles = useGitHubStore((s) => s.profiles)
  const updateSession = useSessionStore((s) => s.updateSession)
  const [enabled, setEnabled] = useState(initial?.enabled ?? config?.enabledByDefault ?? false)
  const [userTouchedEnabled, setUserTouchedEnabled] = useState(false)
  const [repoUrl, setRepoUrl] = useState(initial?.repoUrl ?? '')
  const [profileId, setProfileId] = useState(initial?.authProfileId ?? '')
  const [detected, setDetected] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Sync enabled from enabledByDefault when the github config hydrates after
  // mount. useState initializers run once, so if the store hadn't loaded yet
  // the first render defaulted to false even when the user's global default
  // was true. Once the user interacts with the checkbox we stop overriding.
  useEffect(() => {
    if (userTouchedEnabled) return
    if (initial?.enabled !== undefined) return
    if (config?.enabledByDefault !== undefined) setEnabled(config.enabledByDefault)
  }, [config?.enabledByDefault, initial?.enabled, userTouchedEnabled])

  useEffect(() => {
    // Guard state updates against unmount / rapid cwd change. Without this,
    // a stale repoDetect resolving after the component has moved on would
    // call setDetected on a dead component.
    let cancelled = false
    if (!initial?.repoUrl && cwd) {
      window.electronAPI.github.repoDetect(cwd).then((r) => {
        if (cancelled) return
        if (r.ok && r.slug) setDetected(r.slug)
      })
    }
    return () => {
      cancelled = true
    }
  }, [cwd, initial?.repoUrl])

  const slug = parseRepoUrlClient(repoUrl)

  const save = async () => {
    // Prevent save when integration is toggled on with no valid repo. The
    // panel gate would flip true but sync registration requires a repoSlug,
    // so the user would silently get a panel with no sync. Block it here
    // with a visible error instead.
    if (enabled && !slug) {
      setTestResult('A repo URL is required to enable integration')
      setTimeout(() => setTestResult(null), 2500)
      return
    }
    setSaving(true)
    const patch: Partial<SessionGitHubIntegration> = {
      enabled,
      repoUrl: repoUrl || undefined,
      repoSlug: slug,
      authProfileId: profileId || undefined,
      autoDetected: false,
    }
    const r = await window.electronAPI.github.updateSessionConfig(sessionId, patch)
    setSaving(false)
    if (r.ok) {
      // Mirror the patch into the renderer session store so the GitHub panel's
      // enable-gate reacts immediately — otherwise the change only shows up on
      // the next app restart when SavedSession rehydrates.
      const prior = useSessionStore.getState().getSession(sessionId)
      updateSession(sessionId, {
        githubIntegration: {
          ...(prior?.githubIntegration ?? { enabled: false, autoDetected: false }),
          ...patch,
        },
      })
      if (enabled) trackUsage('github.session-enabled')
    }
    setTestResult(r.ok ? 'Saved' : `Error: ${r.error ?? 'unknown'}`)
    setTimeout(() => setTestResult(null), 2000)
  }

  const useDetected = () => {
    if (detected) setRepoUrl(`https://github.com/${detected}`)
  }

  // Auto-match a profile to the slug's owner so common cases save with one
  // click. Runs only when the user hasn't explicitly chosen a profile —
  // manual choice always wins. allowedRepos takes priority over username
  // because fine-grained PATs are scoped per repo, not per owner.
  useEffect(() => {
    if (profileId || !slug) return
    const [owner] = slug.split('/')
    const match = profiles.find(
      (p) =>
        p.allowedRepos?.includes(slug) ||
        p.username.toLowerCase() === owner.toLowerCase(),
    )
    if (match) setProfileId(match.id)
  }, [slug, profileId, profiles])

  return (
    <div className="space-y-3 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setUserTouchedEnabled(true)
            setEnabled(e.target.checked)
          }}
        />
        <span>Enable GitHub integration for this session</span>
      </label>

      {detected && !repoUrl && (
        <div className="bg-mantle p-2 rounded text-xs">
          Detected <strong>{detected}</strong>.{' '}
          <button onClick={useDetected} className="text-blue underline">
            Use this
          </button>
        </div>
      )}

      <label className="block">
        <div className="text-xs text-subtext0 mb-1">Repo URL</div>
        <input
          type="text"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          className="w-full bg-surface0 p-2 rounded text-sm font-mono"
          placeholder="https://github.com/owner/repo"
        />
        {repoUrl && !slug && <div className="text-xs text-red mt-1">Invalid GitHub URL</div>}
      </label>

      <label className="block">
        <div className="text-xs text-subtext0 mb-1">Auth profile</div>
        <select
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
          className="w-full bg-surface0 p-2 rounded text-sm"
        >
          <option value="">(auto — capability routing)</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} ({p.username})
            </option>
          ))}
        </select>
      </label>

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving || (!!repoUrl && !slug) || (enabled && !slug)}
          className="bg-blue text-base px-3 py-1 rounded text-sm"
        >
          {saving ? 'Saving' : 'Save'}
        </button>
        {testResult && <span className="text-xs text-overlay1 self-center">{testResult}</span>}
      </div>
    </div>
  )
}
