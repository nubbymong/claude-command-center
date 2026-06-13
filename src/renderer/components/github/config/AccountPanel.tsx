// src/renderer/components/github/config/AccountPanel.tsx
// One collapsible per-account panel: header (avatar, identity, connected /
// pending chips, Test / Rename / Remove) over a single-source body (no tabs):
// the informational "powers N of 6" line, one per-feature toggle list with a
// coverage hint per row, and a pending footer with ONE kind-aware re-auth
// action. The re-auth calls github.reauthProfile (which for oauth requests the
// computed scope union INCLUDING `user`), fixing the legacy bug where re-auth
// ran a generic OAuth flow without `user` so aiCredits never activated.
import React, { useRef, useState } from 'react'
import type { AuthProfile, ReauthPlan } from '../../../../shared/github-types'
import { useGitHubStore } from '../../../stores/githubStore'
import { useSessionStore } from '../../../stores/sessionStore'
import {
  AUTH_FEATURE_KEYS,
  FEATURE_CAPABILITIES,
  effectiveToggle,
  masterState,
  missingScopeForFeature,
  pendingReauth,
  profileCoversFeature,
} from '../../../../shared/github-features'
import { DEFAULT_AUTH_FEATURE_TOGGLES } from '../../../../shared/github-constants'
import ToggleSwitch from './ToggleSwitch'
import { Chip, AUTH_FEATURE_META } from './github-feature-meta'
import AddProfileModal from './AddProfileModal'
import OAuthDeviceFlow from './OAuthDeviceFlow'
import ExpiryBanner from '../ExpiryBanner'

const CHECK = String.fromCodePoint(0x2713) // ✓
const CROSS = String.fromCodePoint(0x2717) // ✗
const WARN = String.fromCodePoint(0x26a0) // ⚠

// GitHub's token settings page (where the `user` scope / Plan permission is added).
const GH_TOKENS_URL = 'https://github.com/settings/tokens'

const ghostBtn = 'text-xs bg-surface0 hover:bg-surface1 px-2 py-1 rounded transition-colors'
const primaryBtn = 'bg-blue text-base px-2 py-1 rounded text-xs font-medium hover:bg-blue/80 transition-colors'

interface OAuthFlowStart {
  flowId: string
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}

interface Props {
  profile: AuthProfile
  index: number
}

export default function AccountPanel({ profile, index }: Props) {
  const config = useGitHubStore((s) => s.config)
  const profiles = useGitHubStore((s) => s.profiles)
  const sessions = useSessionStore((s) => s.sessions)
  const setProfileFeature = useGitHubStore((s) => s.setProfileFeature)
  const applyProfileToAll = useGitHubStore((s) => s.applyProfileToAll)
  const removeProfile = useGitHubStore((s) => s.removeProfile)
  const renameProfile = useGitHubStore((s) => s.renameProfile)
  const loadConfig = useGitHubStore((s) => s.loadConfig)
  const loadAiUsage = useGitHubStore((s) => s.loadAiUsage)

  const [open, setOpen] = useState(index === 0)
  // Orthogonal token-EXPIRY re-sign-in path (AddProfileModal), NOT the scope
  // re-auth below. ExpiryBanner.onRenew drives this.
  const [adding, setAdding] = useState(false)

  // Moved verbatim from AuthProfilesList: inline rename + its double-fire guard.
  const [editing, setEditing] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  // In-flight guard for commitRename: pressing Enter fires onKeyDown AND
  // onBlur (the input loses focus when the form processes the key), so
  // without this the IPC would fire twice per commit.
  const renamingRef = useRef(false)

  // Moved verbatim from AuthProfilesList: Test handler with its try/finally.
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  // Kind-aware re-auth state. For oauth we mount OAuthDeviceFlow; for PAT/gh-cli
  // we render the plan's inline instructions.
  const [oauthFlow, setOauthFlow] = useState<OAuthFlowStart | null>(null)
  const [reauthPlan, setReauthPlan] = useState<ReauthPlan | null>(null)
  const [reauthError, setReauthError] = useState<string | null>(null)
  const [reauthBusy, setReauthBusy] = useState(false)

  if (!config) return null

  // masterState/pendingReauth require a COMPLETE defaults map; the renderer's
  // first hydrate can race the boot migration and see featureDefaults undefined.
  const layeredDefaults = {
    ...DEFAULT_AUTH_FEATURE_TOGGLES,
    ...(config.featureDefaults ?? {}),
  }

  const pending = pendingReauth(profile, layeredDefaults)
  const coveredCount = AUTH_FEATURE_KEYS.filter((k) => profileCoversFeature(profile, k)).length
  const liveSessions = sessions.filter((s) => s.githubIntegration?.authProfileId === profile.id)
  const multipleAccounts = profiles.length >= 2

  const doTest = async () => {
    setTesting(true)
    try {
      const r = await window.electronAPI.github.testProfile(profile.id)
      setTestResult(
        r.ok
          ? { ok: true, msg: CHECK + ' ' + (r.username ?? '') }
          : { ok: false, msg: CROSS + ' ' + (r.error ?? 'error') },
      )
    } catch (err) {
      // IPC throw leaves `testing` stuck without the finally below. Surface the
      // error to the user in the same slot the normal fail path uses.
      setTestResult({
        ok: false,
        msg: CROSS + ' ' + (err instanceof Error ? err.message : 'test failed'),
      })
    } finally {
      setTesting(false)
    }
  }

  const startRename = () => {
    setEditing(true)
    setNewLabel(profile.label)
  }
  const commitRename = async () => {
    if (!editing || renamingRef.current) return
    renamingRef.current = true
    try {
      await renameProfile(profile.id, newLabel)
      setEditing(false)
    } catch {
      // IPC throw on renameProfile: leave the input open so the user can
      // retry. Silent: the label stays as what the user typed.
    } finally {
      renamingRef.current = false
    }
  }

  // The core fix: per-profile, kind-aware re-auth. For oauth, reauthProfile
  // returns a device flow whose scope set already includes `user` (computed
  // from the pending features), so completing it grants the `plan` capability
  // and the pending state self-clears. For PAT/gh-cli it returns inline
  // instructions.
  const startReauth = async () => {
    setReauthBusy(true)
    setReauthError(null)
    setReauthPlan(null)
    try {
      const r = await window.electronAPI.github.reauthProfile(profile.id)
      if (!r.ok) {
        setReauthError(r.error)
        return
      }
      if (r.plan.kind === 'oauth' && r.flow) setOauthFlow(r.flow)
      else setReauthPlan(r.plan)
    } catch (e) {
      setReauthError(e instanceof Error ? e.message : String(e))
    } finally {
      setReauthBusy(false)
    }
  }

  const initials = (profile.label || profile.username).trim().slice(0, 2).toUpperCase()

  return (
    <div className="bg-mantle rounded overflow-hidden">
      <ExpiryBanner profile={profile} onRenew={() => setAdding(true)} />

      {/* Header: click toggles open */}
      <div
        className="p-3 flex items-start gap-3 cursor-pointer"
        onClick={() => setOpen((o) => !o)}
      >
        {/* Initials avatar: CSP blocks remote https <img>; avatarUrl persisted for a future main-process data:-URL proxy. */}
        <div
          className="w-8 h-8 rounded-full bg-surface0 text-text text-xs font-semibold flex items-center justify-center shrink-0"
          aria-label={`${profile.username} avatar`}
          title={profile.username}
        >
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          {editing ? (
            <input
              className="w-full bg-surface0 p-1 rounded text-sm"
              value={newLabel}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setNewLabel(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => e.key === 'Enter' && commitRename()}
              autoFocus
            />
          ) : (
            <div className="text-text font-medium">{profile.label}</div>
          )}
          <div className="text-xs text-subtext0">
            {profile.username} · {profile.kind}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            <Chip tone="ok">connected</Chip>
            {pending.length > 0 && (
              <Chip tone="warn">
                re-auth needed: {pending.map((k) => AUTH_FEATURE_META[k].label).join(', ')}
              </Chip>
            )}
          </div>
        </div>
        <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={doTest} disabled={testing} className={ghostBtn}>
            {testing ? 'Testing' : 'Test'}
          </button>
          <button type="button" onClick={startRename} className={ghostBtn}>
            Rename
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm(`Remove profile "${profile.label}"? The token is wiped from keychain.`)) {
                void removeProfile(profile.id)
              }
            }}
            className="text-xs bg-red/20 hover:bg-red/40 text-red px-2 py-1 rounded transition-colors"
          >
            Remove
          </button>
        </div>
      </div>

      {testResult && (
        <div className={`px-3 pb-2 text-xs ${testResult.ok ? 'text-green' : 'text-red'}`}>
          {testResult.msg}
        </div>
      )}

      {/* Body mounts/unmounts under a 200ms transition (app convention). */}
      {open && (
        <div className="border-t border-surface0 transition-opacity duration-200 ease-out p-3 space-y-2">
          {/* Informational line (moved from the old Status tab). */}
          <div className="text-xs text-subtext0">
            Powers {coveredCount} of {AUTH_FEATURE_KEYS.length} auth features ·{' '}
            {liveSessions.length > 0
              ? `${liveSessions.length} live session${liveSessions.length === 1 ? '' : 's'}: ${liveSessions
                  .map((s) => s.label)
                  .join(', ')}`
              : 'no live sessions right now'}
            <span className="text-overlay0"> (sessions link via their repo; informational)</span>
          </div>

          {/* Single feature list with per-row coverage hint. */}
          {AUTH_FEATURE_KEYS.map((key) => {
            const meta = AUTH_FEATURE_META[key]
            const on = effectiveToggle(profile, key, layeredDefaults)
            const covered = profileCoversFeature(profile, key)
            const differs = masterState(profiles, layeredDefaults, key) === 'mixed'
            const needScope = missingScopeForFeature(profile, key) ?? FEATURE_CAPABILITIES[key][0]

            return (
              <div
                key={key}
                className={`bg-base p-2 rounded flex items-center gap-2 ${differs ? 'border border-mauve/40' : ''}`}
              >
                <ToggleSwitch
                  state={on ? 'on' : 'off'}
                  label={meta.label}
                  onToggle={() => void setProfileFeature(profile.id, key, !on)}
                />
                <div className="flex-1 text-text text-sm">{meta.label}</div>
                {differs && <Chip tone="custom">differs across accounts</Chip>}
                {covered ? (
                  <Chip tone="ok">covered {CHECK}</Chip>
                ) : (
                  <Chip tone="warn">
                    {WARN} needs {needScope}
                  </Chip>
                )}
              </div>
            )
          })}

          {/* Pending footer: ONE kind-aware re-auth action. */}
          {pending.length > 0 && (
            <div className="bg-yellow/10 border border-yellow/25 rounded p-2.5 text-xs space-y-2">
              <div className="text-text">
                {pending.length} feature{pending.length === 1 ? '' : 's'} need re-authorization
              </div>
              <button
                type="button"
                onClick={() => void startReauth()}
                disabled={reauthBusy}
                className={`${primaryBtn} disabled:opacity-60`}
              >
                {reauthBusy ? 'Starting' : 'Re-authorize this account'}
              </button>
              {reauthError && (
                <div className="text-[11px] text-red" role="alert">
                  {reauthError}
                </div>
              )}
              {reauthPlan && reauthPlan.kind !== 'oauth' && (
                <ReauthInstructions plan={reauthPlan} />
              )}
            </div>
          )}

          {/* Apply-to-all (only with 2+ accounts). */}
          {multipleAccounts && (
            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-subtext0">
                Toggles here affect {profile.label} only.
              </span>
              <button
                type="button"
                onClick={() => void applyProfileToAll(profile.id)}
                className={ghostBtn}
              >
                Apply to all accounts
              </button>
            </div>
          )}
        </div>
      )}

      {adding && <AddProfileModal onClose={() => setAdding(false)} />}

      {oauthFlow && (
        <OAuthDeviceFlow
          flow={oauthFlow}
          onDone={async () => {
            setOauthFlow(null)
            // loadConfig re-derives capabilities so the pending state self-clears;
            // loadAiUsage repopulates the meter.
            await loadConfig().catch(() => {})
            await loadAiUsage().catch(() => {})
          }}
          onCancel={() => setOauthFlow(null)}
        />
      )}
    </div>
  )
}

/**
 * Inline instructions for a non-oauth re-auth plan. Text is driven by the
 * plan's instruction/command (computed by the main process from the missing
 * scopes), NOT hardcoded, so it reflects the exact scope union re-auth requests.
 * The per-kind chrome (token-settings link / code block) is lifted from the old
 * AiUsageActionRow.
 */
function ReauthInstructions({ plan }: { plan: ReauthPlan }) {
  const openTokens = () => void window.electronAPI.shell.openExternal(GH_TOKENS_URL)

  if (plan.kind === 'pat-classic' || plan.kind === 'pat-fine-grained') {
    return (
      <div className="text-subtext0">
        {plan.instruction} Open{' '}
        <button
          type="button"
          onClick={openTokens}
          className="underline decoration-dotted text-blue hover:text-text transition-colors"
        >
          github.com/settings/tokens
        </button>
        .
      </div>
    )
  }

  // gh-cli: show the exact command to run. (oauth never reaches here — the
  // caller mounts OAuthDeviceFlow for it — but the type union still includes it,
  // so guard explicitly.)
  if (plan.kind === 'gh-cli') {
    return (
      <div className="text-subtext0">
        Refresh your <code>gh</code> CLI auth to add the missing scope, then this account will pick
        it up:
        <code className="block mt-1.5 bg-surface0 px-2 py-1 rounded font-mono text-[11px] text-text">
          {plan.command}
        </code>
      </div>
    )
  }

  return null
}
