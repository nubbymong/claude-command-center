// src/renderer/components/github/config/AccountPanel.tsx
// One collapsible per-account panel: header (avatar, identity, connected /
// pending chips, Re-auth / Test / Rename / Remove), a Status & permissions tab
// and a Features tab. Replaces AuthProfilesList's per-profile role; the
// Test/Rename/Remove handlers are moved over faithfully from that component.
import React, { useRef, useState } from 'react'
import type { AuthProfile, Capability, GitHubAuthFeatureKey } from '../../../../shared/github-types'
import { useGitHubStore } from '../../../stores/githubStore'
import { useSessionStore } from '../../../stores/sessionStore'
import {
  AUTH_FEATURE_KEYS,
  FEATURE_CAPABILITIES,
  effectiveToggle,
  masterState,
  pendingReauth,
  profileCoversFeature,
} from '../../../../shared/github-features'
import { DEFAULT_AUTH_FEATURE_TOGGLES } from '../../../../shared/github-constants'
import ToggleSwitch from './ToggleSwitch'
import { Chip, AUTH_FEATURE_META } from './MasterFeaturesSection'
import AddProfileModal from './AddProfileModal'
import ExpiryBanner from '../ExpiryBanner'

const CHECK = String.fromCodePoint(0x2713) // ✓
const CROSS = String.fromCodePoint(0x2717) // ✗
const WARN = String.fromCodePoint(0x26a0) // ⚠
const EMDASH = String.fromCodePoint(0x2014) // em dash glyph (never a literal em dash in JSX)

const ghostBtn = 'text-xs bg-surface0 hover:bg-surface1 px-2 py-1 rounded transition-colors'
const primaryBtn = 'bg-blue text-base px-2 py-1 rounded text-xs font-medium hover:bg-blue/80 transition-colors'

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

  const [open, setOpen] = useState(index === 0)
  const [tab, setTab] = useState<'status' | 'features'>('status')
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

  const openReauth = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    setAdding(true)
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
          <button
            type="button"
            onClick={openReauth}
            className={pending.length > 0 ? primaryBtn : ghostBtn}
          >
            Re-auth
          </button>
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
        <div className="border-t border-surface0 transition-opacity duration-200 ease-out">
          {/* Tab strip */}
          <div className="flex gap-4 px-3 pt-2 text-sm">
            <button
              type="button"
              onClick={() => setTab('status')}
              className={`pb-1.5 transition-colors ${
                tab === 'status' ? 'text-text border-b-2 border-blue' : 'text-overlay0 hover:text-subtext1'
              }`}
            >
              Status &amp; permissions
            </button>
            <button
              type="button"
              onClick={() => setTab('features')}
              className={`pb-1.5 transition-colors ${
                tab === 'features' ? 'text-text border-b-2 border-blue' : 'text-overlay0 hover:text-subtext1'
              }`}
            >
              Features{pending.length > 0 ? ' ' + WARN : ''}
            </button>
          </div>

          {tab === 'status' ? (
            <StatusTab
              profile={profile}
              coveredCount={coveredCount}
              liveSessions={liveSessions.map((s) => s.label)}
              pending={pending}
              onReauth={() => setAdding(true)}
            />
          ) : (
            <FeaturesTab
              profile={profile}
              profiles={profiles}
              layeredDefaults={layeredDefaults}
              multipleAccounts={profiles.length >= 2}
              onToggle={(k, on) => void setProfileFeature(profile.id, k, on)}
              onApplyToAll={() => void applyProfileToAll(profile.id)}
              onReauth={() => setAdding(true)}
            />
          )}
        </div>
      )}

      {adding && <AddProfileModal onClose={() => setAdding(false)} />}
    </div>
  )
}

function StatusTab({
  profile,
  coveredCount,
  liveSessions,
  pending,
  onReauth,
}: {
  profile: AuthProfile
  coveredCount: number
  liveSessions: string[]
  pending: GitHubAuthFeatureKey[]
  onReauth: () => void
}) {
  // Missing capability chips, deduped by capability across uncovered features.
  const seen = new Set<Capability>()
  const missing: Array<{ cap: Capability; label: string }> = []
  for (const k of AUTH_FEATURE_KEYS) {
    if (profileCoversFeature(profile, k)) continue
    for (const cap of FEATURE_CAPABILITIES[k]) {
      if (seen.has(cap)) continue
      seen.add(cap)
      missing.push({ cap, label: AUTH_FEATURE_META[k].label })
    }
  }

  return (
    <div className="p-3 space-y-2">
      <div className="text-xs text-subtext0">
        Powers {coveredCount} of {AUTH_FEATURE_KEYS.length} auth features ·{' '}
        {liveSessions.length > 0
          ? `${liveSessions.length} live session${liveSessions.length === 1 ? '' : 's'}: ${liveSessions.join(', ')}`
          : 'no live sessions right now'}
        <span className="text-overlay0"> (sessions link via their repo; informational)</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {profile.scopes.map((s) => (
          <Chip key={s} tone="ok">
            {s} {CHECK}
          </Chip>
        ))}
        {missing.map((m) => (
          <Chip key={m.cap} tone="warn">
            {m.cap} {CROSS} {EMDASH} {m.label}
          </Chip>
        ))}
      </div>
      {pending.length > 0 && (
        <div className="bg-yellow/10 border border-yellow/25 rounded p-2 text-xs flex items-center justify-between gap-2">
          <span>
            {pending.map((k) => AUTH_FEATURE_META[k].label).join(', ')} switched on but waiting for
            permission.
          </span>
          <button type="button" onClick={onReauth} className={primaryBtn}>
            Re-auth to activate
          </button>
        </div>
      )}
    </div>
  )
}

function FeaturesTab({
  profile,
  profiles,
  layeredDefaults,
  multipleAccounts,
  onToggle,
  onApplyToAll,
  onReauth,
}: {
  profile: AuthProfile
  profiles: AuthProfile[]
  layeredDefaults: Record<GitHubAuthFeatureKey, boolean>
  multipleAccounts: boolean
  onToggle: (key: GitHubAuthFeatureKey, on: boolean) => void
  onApplyToAll: () => void
  onReauth: () => void
}) {
  return (
    <div className="p-3 space-y-2">
      {AUTH_FEATURE_KEYS.map((key) => {
        const meta = AUTH_FEATURE_META[key]
        const on = effectiveToggle(profile, key, layeredDefaults)
        const covered = profileCoversFeature(profile, key)
        const differs = masterState(profiles, layeredDefaults, key) === 'mixed'
        const cap = FEATURE_CAPABILITIES[key][0]

        let chip: React.ReactNode
        if (on && covered) chip = <Chip tone="ok">active {CHECK}</Chip>
        else if (on && !covered) chip = <Chip tone="warn">{WARN} activates after re-auth</Chip>
        else if (!on && !covered) chip = <Chip tone="warn">needs {cap}</Chip>
        else chip = <Chip tone="muted">off</Chip>

        return (
          <div
            key={key}
            className={`bg-base p-2 rounded flex items-center gap-2 ${differs ? 'border border-mauve/40' : ''}`}
          >
            <div className="flex-1 text-text text-sm">{meta.label}</div>
            {differs && <Chip tone="custom">differs across accounts</Chip>}
            {chip}
            {!covered && (
              <button
                type="button"
                onClick={onReauth}
                className="text-blue underline text-xs"
              >
                Re-auth
              </button>
            )}
            <ToggleSwitch
              state={on ? 'on' : 'off'}
              label={meta.label}
              onToggle={() => onToggle(key, !on)}
            />
          </div>
        )
      })}
      {multipleAccounts && (
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-subtext0">
            Toggles here affect {profile.label} only.
          </span>
          <button type="button" onClick={onApplyToAll} className={ghostBtn}>
            Apply to all accounts
          </button>
        </div>
      )}
    </div>
  )
}
