import React, { useState } from 'react'
import { useSessionStore, type Session } from '../stores/sessionStore'
import { useSettingsStore, DEFAULT_STATUS_LINE } from '../stores/settingsStore'
import RateLimitBar from './terminal/RateLimitBar'
import { formatTokens, formatDuration } from '../utils/terminalFormatting'
import { canSwitchAccountForSession } from '../utils/sessionLaunch'
import { useCodexReviewUsage } from '../hooks/useCodexReviewUsage'
import { useRestartSession } from '../hooks/useRestartSession'
import { useSwitchAccount } from '../hooks/useSwitchAccount'
import { useResolvedTheme } from '../hooks/useThemeController'
import { useRegionTypography } from '../hooks/useTypography'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { resolveAccountName, resolveAccountNameByEmail, resolveAccountColourKey, middleTruncateEmail } from '../../shared/account-chip-color'
import { resolveIdentityColor } from '../../shared/identity-colors'
import ToolbarPopup from './ToolbarPopup'
import {
  modelsFromRegistry,
  effortsFromRegistry,
  shortModelName,
  isModelActive,
} from '../lib/claude-cli-options'
import { useRegistryStore } from '../stores/registryStore'
import AiUsageChip from './github/AiUsageChip'

interface SessionStatusStripProps {
  /** The PTY/session id for THIS terminal. Telemetry is read for this
   *  session and control writes (/model, /compact, ...) target its PTY. */
  sessionId: string
}

// Shared pill styling for the control cluster (Mode / Model / Compact /
// Restart). Token-driven so it tracks both themes and reads as one system
// with the CommandBar command chips. (UAT R2 Task 4.)
const CONTROL_PILL =
  'px-2 py-0.5 rounded-md text-xs transition-colors duration-150 focus-ring whitespace-nowrap'

// Stable empty-array reference so the Zustand selector doesn't return a fresh
// [] each render (which would trip the re-render cascade guard).
const EMPTY_HIDDEN: string[] = []

// SessionStatusStrip (v2 shell, UAT R2): the per-session telemetry + controls
// band. Lives directly above the command rows, under the terminal -- the old
// ContextBar position. Replaces the MIDDLE + RIGHT zones that briefly lived in
// the app-level BottomBar; the bar is now a slim global runtime footer.
//
// Rendered per-terminal from TerminalView (Claude/Codex primary pane only),
// so the telemetry and the Mode/Model/Compact/Restart writes always key off
// THIS terminal's session -- not whatever the globally-active session is.
export default function SessionStatusStrip({ sessionId }: SessionStatusStripProps) {
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId) || null)
  const updateSession = useSessionStore((s) => s.updateSession)
  const sl = useSettingsStore((s) => s.settings.statusLine) || DEFAULT_STATUS_LINE
  // Whole-band scale/family for the Status-bars region (Font & Size page). Applied
  // to the OUTER wrapper so telemetry AND the control pills move together.
  const statusType = useRegionTypography('status')
  // Usage buckets the user hid (denylist by label). Empty/absent = show all.
  const hiddenBuckets = useSettingsStore((s) => s.settings.hiddenUsageBuckets) ?? EMPTY_HIDDEN
  // Master status-line switch (onboarding p4 / Settings). Gates ONLY the
  // telemetry band; the Claude controls cluster (Mode/Model/Restart/account)
  // stays regardless. Absent (pre-upgrade config) means on.
  const statusLineEnabled = useSettingsStore((s) => s.settings.statusLineEnabled ?? true)
  // Codex review is authorised globally (2 Aug decision): every local Claude
  // session registers for it, so the usage pill polls whenever this session
  // qualifies — the gate is the global Codex master, not a per-config flag.
  const codexReviewOn = useSettingsStore((s) => s.settings.codexEnabled !== false)
  const codexReviewEligible = codexReviewOn && session?.provider === 'claude' && !session?.shellOnly && session?.sessionType !== 'ssh'
  const codexReview = useCodexReviewUsage(codexReviewEligible ? sessionId : null)
  const { restart } = useRestartSession(session, false)
  const switchAccount = useSwitchAccount(session)
  const theme = useResolvedTheme()
  // Account identity resolved by LIVE email so a mid-session /login instantly
  // reflects the new account name/colour without a respawn. Selector form
  // (never destructure the whole store).
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const accountAliases = useSettingsStore((s) => s.settings.accountAliases)
  const accountColourOverrides = useSettingsStore((s) => s.settings.accountColourOverrides)
  // Mid-session account switch (respawn + resume): gated on having at least 2
  // profiles (need a real choice). Selector form on every read so the strip
  // never re-renders on unrelated store churn.
  const canSwitchAccount = canSwitchAccountForSession({ provider: session?.provider, isSsh: !!session?.sshConfig, shellOnly: !!session?.shellOnly, profileCount: profiles.length })
  const registry = useRegistryStore((s) => s.registry)
  // Copilot AI-credit meter gate. The chip self-gates on githubAiUsageEnabled
  // (returns null when off), so we read the same flag here to avoid rendering
  // an orphaned separator with no chip after it.
  const aiMeterEnabled = useSettingsStore((s) => s.settings.githubAiUsageEnabled)

  const [openPicker, setOpenPicker] = useState<'model' | 'account' | null>(null)
  const [lastEffort, setLastEffort] = useState<string | null>(null)
  const isClaude = (session?.provider ?? 'claude') === 'claude'

  const write = (cmd: string) => {
    window.electronAPI.pty.write(sessionId, cmd)
  }
  const onModel = (si: number, v: string) => {
    if (si === 0) {
      write(`/model ${v}\n`)
    } else {
      setLastEffort(v)
      // Persist the chosen effort on the session so it shows (and stays) in the
      // status strip next to the model name. Without this, /effort was written to
      // the PTY but session.effortLevel never updated, so the strip showed nothing
      // after a mid-session effort change.
      updateSession(sessionId, { effortLevel: v as Session['effortLevel'] })
      write(`/effort ${v}\n`)
    }
    setOpenPicker(null)
  }
  // Account chooser select: value is always a real profile id.
  // switchAccount no-ops when it equals the session's current account.
  const onSwitchAccount = (_si: number, v: string) => {
    switchAccount(sessionId, v || undefined)
    setOpenPicker(null)
  }

  if (!session) return null
  // A Codex strip is telemetry-only (no controls cluster), so with the master
  // off there is nothing left to show — collapse the band entirely.
  if (!statusLineEnabled && !isClaude) return null

  const pct = session.contextPercent ?? 0
  // Context-meter thresholds: >85 danger, >=70 warning -- carried over from
  // the BottomBar middle zone verbatim.
  const ctxColor = pct > 85 ? 'var(--status-danger)' : pct >= 70 ? 'var(--status-warning)' : 'var(--text-muted)'

  // Model pill label: the real short model name, never a bare confusing
  // "default". Falls back to a muted "model" placeholder when unknown.
  const rawModelLabel = shortModelName(session.modelName)
  const hasModelLabel = !!session.modelName && rawModelLabel !== 'default'
  const modelLabel = hasModelLabel ? rawModelLabel : 'model'

  // Account chip (always-on when the session has a resolved account). Name
  // and colour are resolved by live email: a mid-session /login that updates
  // session.accountEmail immediately shows the right name/colour. Override
  // wins over the spawn-time colour key.
  const accountName = session.accountEmail
    ? resolveAccountNameByEmail(session.accountEmail, profiles, accountAliases)
    : null
  const accountDot = resolveIdentityColor(
    resolveAccountColourKey(session.accountEmail, accountColourOverrides, session.accountColour),
    theme,
  )

  // Account chooser: every profile (resolved name + truncated email hint).
  // The current account is marked active; selecting it is a no-op in switchAccount.
  const accountItems = profiles.map((p) => ({
    label: resolveAccountName(p.accountEmail, p.name, accountAliases),
    value: p.id,
    active: p.id === session.profileId,
    hint: middleTruncateEmail(p.accountEmail),
  }))

  return (
    <div
      className="min-h-7 shrink-0 flex items-center gap-3 px-3 text-xs border-t border-b"
      style={{ background: 'var(--surface-raised)', color: 'var(--text-on-chrome)', borderColor: 'var(--border-subtle)', ...statusType }}
    >
      {/* Telemetry. The whole strip (this cluster + the controls) scales as one
          via the Status-bars region on the Font & Size page (zoom on the outer
          wrapper), so there is no per-element font size here anymore -- that split
          was exactly what made the pills stay a different size from the text.
          With the master switch off, a bare spacer keeps the controls cluster
          right-aligned. */}
      {statusLineEnabled ? (
      <div
        className="flex items-center gap-3 flex-1 min-w-0 overflow-hidden"
      >
        {/* Bug 6: for Claude the interactive Model pill (controls cluster, right)
            is the single home for the model + effort, so the read-only telemetry
            copy would double it. Codex has no model pill, so it keeps this. */}
        {sl.showModel && session.modelName && !isClaude && (
          <span className="font-medium truncate shrink-0">
            {session.modelName}
            {/* v1.5.13: surface effort level next to the model name. Codex
                uses reasoningEffort (set by its statusline bridge); Claude
                uses effortLevel (config-time, set when the user pinned
                --effort in Edit Config). Show whichever is set; Codex
                wins on the rare case both are populated. */}
            {/* Effort renders as a suffix of the model name ("Sonnet xhigh"),
                so it is intentionally also gated by showModel above -- an
                orphaned effort with no model would look broken. */}
            {sl.showEffort && (session.reasoningEffort || session.effortLevel) && (
              <span className="ml-1 font-normal" style={{ color: 'var(--text-muted)' }}>
                {session.reasoningEffort || session.effortLevel}
              </span>
            )}
          </span>
        )}
        {/* Bug 6: when the interactive account-switch pill is shown (multi-account),
            it already displays the account + dot, so this read-only chip would
            double it. Single-account sessions (no switch pill) keep this chip. */}
        {sl.showAccount && accountName && !canSwitchAccount && (
          <span
            className="flex items-center gap-1 shrink-0"
            style={{ color: 'var(--text-muted)' }}
            title={session.accountEmail}
            data-testid="account-chip"
          >
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: accountDot }}
              aria-hidden
            />
            <span className="truncate max-w-[14rem]">{accountName}</span>
          </span>
        )}
        {sl.showTokens && session.inputTokens != null && session.contextWindowSize && (
          <span className="tabular-nums shrink-0">{formatTokens(session.inputTokens)} / {formatTokens(session.contextWindowSize)}</span>
        )}
        {sl.showContextBar && session.contextPercent != null && (
          <span className="flex items-center gap-1.5 shrink-0">
            <span className="w-16 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--surface-sunken)' }}>
              <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: ctxColor }} />
            </span>
            <span className="tabular-nums">{Math.round(pct)}%</span>
          </span>
        )}
        {sl.showCost && session.costUsd != null && (
          <span className="tabular-nums shrink-0" title="API equivalent cost (not billed on Max plan)">API eq ${session.costUsd.toFixed(4)}</span>
        )}
        {sl.showLinesChanged && session.linesAdded != null && (
          <span className="tabular-nums shrink-0" style={{ color: 'color-mix(in srgb, var(--status-success) 70%, var(--text-secondary))' }}>+{session.linesAdded}</span>
        )}
        {sl.showLinesChanged && session.linesRemoved ? (
          <span className="tabular-nums shrink-0" style={{ color: 'color-mix(in srgb, var(--status-danger) 70%, var(--text-secondary))' }}>-{session.linesRemoved}</span>
        ) : null}
        {sl.showDuration && session.totalDurationMs != null && (
          <span className="tabular-nums shrink-0" style={{ color: 'var(--text-muted)' }}>{formatDuration(session.totalDurationMs)}</span>
        )}
        {sl.showRateLimits && (() => {
          // Dynamic buckets (5h, Weekly, Fable, future per-model) discovered
          // from the API's limits[]; the user's hidden set is filtered out.
          // Falls back to the legacy 5h/7d fields for older CLIs that don't
          // return limits[]. Hidden-set keyed by label (see hiddenUsageBuckets).
          const shown = (session.usageBuckets ?? []).filter((b) => !hiddenBuckets.includes(b.label))
          if (session.usageBuckets && session.usageBuckets.length > 0) {
            if (shown.length === 0 && !session.rateLimitExtra?.enabled) return null
            return (
              <span className="flex items-center gap-3 shrink-0">
                {shown.map((b) => (
                  <RateLimitBar key={b.key} label={b.label} pct={b.percent} resets={b.resetsAt || undefined} showReset={sl.showResetTime} />
                ))}
                {session.rateLimitExtra?.enabled && (
                  <span className="tabular-nums" style={{ color: 'var(--text-muted)' }}>extra: <span className={session.rateLimitExtra.utilization > 80 ? 'text-red' : ''}>${session.rateLimitExtra.usedUsd.toFixed(2)}</span>/${session.rateLimitExtra.limitUsd.toFixed(0)}</span>
                )}
              </span>
            )
          }
          if (session.rateLimitCurrent == null) return null
          return (
            <span className="flex items-center gap-3 shrink-0">
              {!hiddenBuckets.includes('5h') && <RateLimitBar label="5h" pct={session.rateLimitCurrent} resets={session.rateLimitCurrentResets} showReset={sl.showResetTime} />}
              {session.rateLimitWeekly != null && !hiddenBuckets.includes('Weekly') && (
                <RateLimitBar label="7d" pct={session.rateLimitWeekly} resets={session.rateLimitWeeklyResets} showReset={sl.showResetTime} />
              )}
              {session.rateLimitExtra?.enabled && (
                <span className="tabular-nums" style={{ color: 'var(--text-muted)' }}>extra: <span className={session.rateLimitExtra.utilization > 80 ? 'text-red' : ''}>${session.rateLimitExtra.usedUsd.toFixed(2)}</span>/${session.rateLimitExtra.limitUsd.toFixed(0)}</span>
              )}
            </span>
          )
        })()}
        {codexReview && codexReview.reviewCount > 0 && (
          <span className="tabular-nums shrink-0" style={{ color: 'var(--text-muted)' }}>review {codexReview.reviewCount}</span>
        )}
        {/* Copilot AI-credit meter -- the per-session home for the meter. Gated
            on BOTH the statusLine toggle AND the meter-enabled flag so the
            separator never dangles when the chip itself would render null. The
            chip clicks through to its popover, which deep-links to Settings per
            context: auth/scope prompts open the GitHub tab; the cap / plan /
            cycle config opens the Status Line tab (its new home, default). Lives
            last in the telemetry zone so it shares the shrink budget and clips
            first under overflow. */}
        {sl.showCopilot && aiMeterEnabled && (
          <>
            <span
              data-copilot-separator
              className="w-px self-stretch my-1.5 mx-0.5 shrink-0"
              style={{ background: 'var(--border-subtle)' }}
              aria-hidden
            />
            <AiUsageChip
              onOpenSettings={(tab = 'statusline') =>
                window.dispatchEvent(new CustomEvent('app:openSettings', { detail: { tab } }))
              }
            />
          </>
        )}
      </div>
      ) : (
        <div className="flex-1" aria-hidden />
      )}

      {/* Controls (Claude only): Mode + Model as a pair, Compact as a normal
          action, Restart visually separated behind a divider with a quiet
          danger-on-hover treatment. (UAT R2 Tasks 2 + 4.) */}
      {isClaude && (
        <div className="flex items-center gap-1 shrink-0">
          {/* Account switch (multi-account only): respawns the session under the
              chosen profile and resumes the transcript. Same pill styling as the
              Mode/Model controls; opens upward (ToolbarPopup is bottom-anchored)
              so it isn't clipped by the telemetry zone's overflow. */}
          {canSwitchAccount && (
            <div className="relative">
              <button
                onClick={() => setOpenPicker(openPicker === 'account' ? null : 'account')}
                className={CONTROL_PILL}
                style={{
                  background: 'var(--surface-raised)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-overlay)'; e.currentTarget.style.color = 'var(--text-primary)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface-raised)'; e.currentTarget.style.color = 'var(--text-secondary)' }}
                title="Switch account (respawns + resumes this session)"
              >
                <span className="flex items-center gap-1">
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: accountDot }}
                    aria-hidden
                  />
                  <span className="truncate max-w-[16rem]">{accountName ?? 'Account'}</span>
                </span>
              </button>
              {openPicker === 'account' && (
                <ToolbarPopup
                  sections={[{ title: 'Switch account', items: accountItems }]}
                  onSelect={onSwitchAccount}
                  onClose={() => setOpenPicker(null)}
                />
              )}
            </div>
          )}
          <div className="relative">
            <button
              onClick={() => setOpenPicker(openPicker === 'model' ? null : 'model')}
              className={CONTROL_PILL}
              style={{
                background: 'var(--surface-raised)',
                border: '1px solid var(--border-subtle)',
                color: hasModelLabel ? 'var(--text-secondary)' : 'var(--text-muted)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-overlay)'; e.currentTarget.style.color = 'var(--text-primary)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface-raised)'; e.currentTarget.style.color = hasModelLabel ? 'var(--text-secondary)' : 'var(--text-muted)' }}
              title="Model"
            >
              {modelLabel}
              {/* Bug 6: effort lives on the Model pill now (the telemetry model is
                  hidden for Claude to avoid doubling). Preserves the "Opus 4.8 xhigh"
                  display the user configured via showEffort. */}
              {sl.showEffort && hasModelLabel && (session.reasoningEffort || session.effortLevel) && (
                <span className="ml-1 font-normal" style={{ color: 'var(--text-muted)' }}>
                  {session.reasoningEffort || session.effortLevel}
                </span>
              )}
            </button>
            {openPicker === 'model' && (
              <ToolbarPopup
                alignRight
                sections={[
                  {
                    title: 'Models',
                    items: modelsFromRegistry(registry).map((m) => ({ ...m, active: isModelActive(m.value, session.modelName || session.model || '') })),
                  },
                  {
                    title: 'Effort',
                    items: effortsFromRegistry(registry).map((e) => ({ ...e, active: e.value === lastEffort })),
                  },
                ]}
                onSelect={onModel}
                onClose={() => setOpenPicker(null)}
              />
            )}
          </div>
          <button
            onClick={() => write('/compact\n')}
            className={CONTROL_PILL}
            style={{
              background: 'var(--surface-raised)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-overlay)'; e.currentTarget.style.color = 'var(--text-primary)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface-raised)'; e.currentTarget.style.color = 'var(--text-secondary)' }}
            title="Compact the conversation"
          >
            Compact
          </button>
          {/* Divider -- sets Restart apart as the disruptive action. */}
          <span className="w-px self-stretch my-1.5 mx-0.5" style={{ background: 'var(--border-subtle)' }} aria-hidden />
          <button
            onClick={() => restart()}
            className={CONTROL_PILL}
            style={{
              background: 'transparent',
              border: '1px solid transparent',
              color: 'var(--text-muted)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--status-danger) 14%, transparent)'; e.currentTarget.style.color = 'var(--status-danger)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)' }}
            title="Restart session"
          >
            Restart
          </button>
        </div>
      )}
    </div>
  )
}
