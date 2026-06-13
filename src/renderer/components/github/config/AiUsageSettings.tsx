import { useEffect, useState } from 'react'
import type { AuthProfile } from '../../../../shared/github-types'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useGitHubStore } from '../../../stores/githubStore'
import OAuthDeviceFlow from './OAuthDeviceFlow'

interface OAuthFlowStart {
  flowId: string
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}

// GitHub's classic-token settings page (where the `user` scope is added).
const GH_TOKENS_URL = 'https://github.com/settings/tokens'

/**
 * Resolves the auth profile the AI-usage meter actually fetches with. Mirrors
 * the main process's resolveAiUsageTarget: the FIRST profile holding a token.
 * The meter has no "active account" concept (known limitation, review note on
 * adad712), so the action guidance targets this same first profile.
 */
function activeAiUsageProfile(profiles: AuthProfile[]): AuthProfile | null {
  return profiles[0] ?? null
}

/**
 * Settings for the GitHub AI-credits (Copilot) usage meter. Reads/writes the
 * app settings store (githubAiUsageEnabled + copilotIncludedCredits). Toggling
 * the meter on kicks an immediate fetch via loadAiUsage so the meter UI has
 * data to render.
 *
 * When the meter is enabled but the fetch reports 'scope-missing' or 'no-auth',
 * an "Action needed" row appears with guidance tailored to the active auth
 * profile's type: OAuth gets a one-click "Re-authorize GitHub" (re-running the
 * device flow with the broadened `user` scope); PAT and gh-cli get the exact
 * inline instruction to add the scope to their existing credential.
 */
export default function AiUsageSettings() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const loadAiUsage = useGitHubStore((s) => s.loadAiUsage)
  const loadConfig = useGitHubStore((s) => s.loadConfig)
  const aiUsageStatus = useGitHubStore((s) => s.aiUsageStatus)
  const profiles = useGitHubStore((s) => s.profiles)

  const [oauthFlow, setOauthFlow] = useState<OAuthFlowStart | null>(null)
  const [reauthError, setReauthError] = useState<string | null>(null)
  const [reauthStarting, setReauthStarting] = useState(false)

  const enabled = settings.githubAiUsageEnabled === true
  const cap = settings.copilotIncludedCredits

  // Pull the latest status when the meter is on so the action row reflects the
  // current scope state without waiting for the 60-minute poll.
  useEffect(() => {
    if (enabled) void loadAiUsage().catch(() => {})
  }, [enabled, loadAiUsage])

  const toggle = async (next: boolean): Promise<void> => {
    await updateSettings({ githubAiUsageEnabled: next })
    // Drive an immediate refresh on enable so the meter populates without
    // waiting for the 60-minute poll. On disable, loadAiUsage returns a null
    // report (main clears the cache) and the store reflects the cleared state.
    await loadAiUsage().catch(() => {})
  }

  const onCapChange = (raw: string): void => {
    const trimmed = raw.trim()
    // Empty input = "unknown" (null). Otherwise parse a non-negative number;
    // ignore garbage so a stray keystroke can't persist NaN.
    if (trimmed === '') {
      void updateSettings({ copilotIncludedCredits: null })
      return
    }
    const n = Number(trimmed)
    if (Number.isFinite(n) && n >= 0) {
      void updateSettings({ copilotIncludedCredits: n })
    }
  }

  const startReauth = async (): Promise<void> => {
    setReauthStarting(true)
    setReauthError(null)
    try {
      // 'private' keeps the existing repo reach; includeUserScope adds the
      // `user` scope that unlocks the billing endpoint. Default sign-in scopes
      // elsewhere are untouched.
      const r = await window.electronAPI.github.oauthStart('private', { includeUserScope: true })
      setOauthFlow(r)
    } catch (e) {
      setReauthError(e instanceof Error ? e.message : String(e))
    } finally {
      setReauthStarting(false)
    }
  }

  const active = activeAiUsageProfile(profiles)
  const needsAction = enabled && (aiUsageStatus === 'scope-missing' || aiUsageStatus === 'no-auth')

  return (
    <section>
      <h3 className="text-sm uppercase text-subtext0 mb-3">AI credits usage</h3>
      <div className="bg-mantle p-3 rounded space-y-3">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => void toggle(e.target.checked)}
            className="mt-1"
          />
          <div>
            <div className="text-text">Show Copilot AI-credits usage</div>
            <div className="text-xs text-subtext0 mt-1">
              Polls your billed AI-credit usage from GitHub every 60 minutes and shows how
              much you are spending beyond your plan&apos;s included credits. This needs an
              extra token permission: classic tokens require the <code>user</code> scope;
              fine-grained tokens require Account permissions{' '}
              <strong>Plan: read</strong>. Without it GitHub returns no data and the meter
              stays empty. Default: off.
            </div>
          </div>
        </label>

        {needsAction && (
          <AiUsageActionRow
            status={aiUsageStatus}
            profile={active}
            starting={reauthStarting}
            error={reauthError}
            onReauth={startReauth}
          />
        )}

        <label className="flex items-center justify-between text-sm pt-2 border-t border-surface0">
          <div className="pr-3">
            <div className="text-text">Included credits (USD)</div>
            <div className="text-xs text-subtext0 mt-1">
              GitHub does not expose your plan&apos;s included-credit cap through the API for
              personal accounts. Enter it from your plan / billing page so the meter can show
              progress toward the cap. Leave blank if unknown.
            </div>
          </div>
          <input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            className="bg-surface0 p-1 rounded w-24 text-right"
            value={cap ?? ''}
            placeholder=""
            onChange={(e) => onCapChange(e.target.value)}
          />
        </label>
      </div>

      {oauthFlow && (
        <OAuthDeviceFlow
          flow={oauthFlow}
          onDone={async () => {
            setOauthFlow(null)
            // Refresh profiles (new scopes recorded) then re-pull usage so the
            // action row clears once the broadened token starts returning data.
            await loadConfig().catch(() => {})
            await loadAiUsage().catch(() => {})
          }}
          onCancel={() => setOauthFlow(null)}
        />
      )}
    </section>
  )
}

/**
 * The "Action needed" row. Copy varies by status and by the active profile's
 * auth kind so the user gets the exact next step for their credential type.
 */
function AiUsageActionRow({
  status,
  profile,
  starting,
  error,
  onReauth,
}: {
  status: 'scope-missing' | 'no-auth'
  profile: AuthProfile | null
  starting: boolean
  error: string | null
  onReauth: () => void
}) {
  const openTokens = () => void window.electronAPI.shell.openExternal(GH_TOKENS_URL)

  // No GitHub auth at all: nothing to broaden, point the user at sign-in.
  if (status === 'no-auth' || !profile) {
    return (
      <div
        className="rounded border border-yellow/40 bg-yellow/10 p-2.5 text-xs text-subtext0 transition-colors duration-200"
        role="status"
      >
        <div className="text-text font-medium mb-0.5">Action needed</div>
        <div>
          Connect a GitHub account in <strong>Accounts</strong> above, then this meter
          will read your billed AI-credit usage.
        </div>
      </div>
    )
  }

  return (
    <div
      className="rounded border border-yellow/40 bg-yellow/10 p-2.5 text-xs text-subtext0 transition-colors duration-200"
      role="status"
    >
      <div className="text-text font-medium mb-0.5">Action needed</div>
      <div className="mb-2">
        The token for <strong>{profile.label || profile.username}</strong> can&apos;t read your
        billing usage. Add the missing permission to keep the meter populated:
      </div>

      {profile.kind === 'oauth' && (
        <>
          <button
            type="button"
            onClick={onReauth}
            disabled={starting}
            className="bg-blue text-base px-3 py-1.5 rounded text-xs font-medium hover:bg-blue/80 transition-colors disabled:opacity-60"
          >
            {starting ? 'Starting' : 'Re-authorize GitHub'}
          </button>
          <div className="mt-1.5 text-[11px] text-overlay1">
            Re-runs GitHub sign-in to grant the <code>user</code> scope (unlocks the billing
            endpoint). Your existing access is preserved.
          </div>
          {error && (
            <div className="text-[11px] text-red mt-1" role="alert">
              {error}
            </div>
          )}
        </>
      )}

      {profile.kind === 'pat-fine-grained' && (
        <div>
          Edit this fine-grained token and add Account permissions{' '}
          <strong>Plan: read</strong>, then re-save it here. Open{' '}
          <button
            type="button"
            onClick={openTokens}
            className="underline decoration-dotted text-blue hover:text-text transition-colors"
          >
            github.com/settings/tokens
          </button>
          .
        </div>
      )}

      {profile.kind === 'pat-classic' && (
        <div>
          Edit this classic token and add the <code>user</code> scope, then re-save it here.
          Open{' '}
          <button
            type="button"
            onClick={openTokens}
            className="underline decoration-dotted text-blue hover:text-text transition-colors"
          >
            github.com/settings/tokens
          </button>
          .
        </div>
      )}

      {profile.kind === 'gh-cli' && (
        <div>
          Refresh your <code>gh</code> CLI auth to add the <code>user</code> scope, then this
          meter will pick it up:
          <code className="block mt-1.5 bg-surface0 px-2 py-1 rounded font-mono text-[11px] text-text">
            gh auth refresh -h github.com -s user
          </code>
        </div>
      )}
    </div>
  )
}
