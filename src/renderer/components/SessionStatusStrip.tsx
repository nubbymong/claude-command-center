import React, { useState } from 'react'
import { useSessionStore, type Session } from '../stores/sessionStore'
import { useSettingsStore, DEFAULT_STATUS_LINE } from '../stores/settingsStore'
import RateLimitBar from './terminal/RateLimitBar'
import { formatResetTime, formatTokens, formatDuration } from '../utils/terminalFormatting'
import { useCodexReviewUsage } from '../hooks/useCodexReviewUsage'
import { useRestartSession } from '../hooks/useRestartSession'
import { useResolvedTheme } from '../hooks/useThemeController'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { resolveAccountName } from '../../shared/account-chip-color'
import { resolveIdentityColor } from '../../shared/identity-colors'
import ToolbarPopup from './ToolbarPopup'
import {
  MODELS,
  EFFORTS,
  PERMISSION_MODES,
  shortModelName,
  isModelActive,
} from '../lib/claude-cli-options'

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
  const codexReview = useCodexReviewUsage(session?.enableCodexReview ? sessionId : null)
  const { restart } = useRestartSession(session, false)
  const theme = useResolvedTheme()
  // Account identity (drift-immune source: spawn-time capture -> Session fields).
  // The chip is always-on for every session that has a resolved account; the
  // profile name + alias map let it render the friendly name, falling back to
  // the raw email. Selector form (never destructure the store).
  // Reactive name selection: pick THIS session's profile name directly so a
  // rename re-renders the chip (selecting the stable profileName fn would not).
  // No profileId -> undefined -> resolveAccountName falls back to alias/email.
  const profileName = useAccountProfilesStore((s) => s.profiles.find((p) => p.id === session?.profileId)?.name)
  const accountAliases = useSettingsStore((s) => s.settings.accountAliases)

  const [openPicker, setOpenPicker] = useState<'mode' | 'model' | null>(null)
  const [lastMode, setLastMode] = useState<string | null>(null)
  const [lastEffort, setLastEffort] = useState<string | null>(null)
  const isClaude = (session?.provider ?? 'claude') === 'claude'

  const write = (cmd: string) => {
    window.electronAPI.pty.write(sessionId, cmd)
  }
  const onMode = (_si: number, v: string) => {
    setLastMode(v)
    write(`/permission-mode ${v}\n`)
    setOpenPicker(null)
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

  if (!session) return null

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
  // resolves profile > alias > email; dot uses the session's identity colour
  // key (fallback to neutral 'mauve' so a missing colour never crashes).
  const accountName = session.accountEmail
    ? resolveAccountName(session.accountEmail, profileName, accountAliases)
    : null
  const accountDot = resolveIdentityColor(session.accountColour ?? 'mauve', theme)

  return (
    <div
      className="min-h-7 shrink-0 flex items-center gap-3 px-3 text-xs border-t border-b"
      style={{ background: 'var(--surface-raised)', color: 'var(--text-on-chrome)', borderColor: 'var(--border-subtle)' }}
    >
      {/* Telemetry -- inherits statusLine font + fontSize so Settings controls
          stay honest. Carried over verbatim from BottomBar's middle zone. */}
      <div
        className="flex items-center gap-3 flex-1 min-w-0 overflow-hidden"
        style={{ fontSize: `${sl.fontSize}px`, fontFamily: sl.font === 'mono' ? "'JetBrains Mono', monospace" : undefined }}
      >
        {sl.showModel && session.modelName && (
          <span className="font-medium truncate shrink-0">
            {session.modelName}
            {/* v1.5.13: surface effort level next to the model name. Codex
                uses reasoningEffort (set by its statusline bridge); Claude
                uses effortLevel (config-time, set when the user pinned
                --effort in Edit Config). Show whichever is set; Codex
                wins on the rare case both are populated. */}
            {(session.reasoningEffort || session.effortLevel) && (
              <span className="ml-1 font-normal" style={{ color: 'var(--text-muted)' }}>
                {session.reasoningEffort || session.effortLevel}
              </span>
            )}
          </span>
        )}
        {accountName && (
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
        {sl.showRateLimits && session.rateLimitCurrent != null && (
          <span className="flex items-center gap-3 shrink-0">
            <RateLimitBar label="5h" pct={session.rateLimitCurrent} resets={session.rateLimitCurrentResets} />
            {session.rateLimitWeekly != null && (
              <RateLimitBar label="7d" pct={session.rateLimitWeekly} resets={session.rateLimitWeeklyResets} />
            )}
            {session.rateLimitExtra?.enabled && (
              <span className="tabular-nums" style={{ color: 'var(--text-muted)' }}>extra: <span className={session.rateLimitExtra.utilization > 80 ? 'text-red' : ''}>${session.rateLimitExtra.usedUsd.toFixed(2)}</span>/${session.rateLimitExtra.limitUsd.toFixed(0)}</span>
            )}
          </span>
        )}
        {sl.showResetTime && session.rateLimitCurrentResets && (
          <span className="tabular-nums shrink-0" style={{ color: 'var(--text-muted)' }} title="5h window resets">resets {formatResetTime(session.rateLimitCurrentResets)}</span>
        )}
        {codexReview && codexReview.reviewCount > 0 && (
          <span className="tabular-nums shrink-0" style={{ color: 'var(--text-muted)' }}>review {codexReview.reviewCount}</span>
        )}
      </div>

      {/* Controls (Claude only): Mode + Model as a pair, Compact as a normal
          action, Restart visually separated behind a divider with a quiet
          danger-on-hover treatment. (UAT R2 Tasks 2 + 4.) */}
      {isClaude && (
        <div className="flex items-center gap-1 shrink-0">
          <div className="relative">
            <button
              onClick={() => setOpenPicker(openPicker === 'mode' ? null : 'mode')}
              className={CONTROL_PILL}
              style={{
                background: 'var(--surface-raised)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-secondary)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-overlay)'; e.currentTarget.style.color = 'var(--text-primary)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface-raised)'; e.currentTarget.style.color = 'var(--text-secondary)' }}
              title="Permission mode"
            >
              Mode
            </button>
            {openPicker === 'mode' && (
              <ToolbarPopup
                sections={[{ title: 'Mode', items: PERMISSION_MODES.map((m) => ({ ...m, active: m.value === lastMode })) }]}
                onSelect={onMode}
                onClose={() => setOpenPicker(null)}
              />
            )}
          </div>
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
            </button>
            {openPicker === 'model' && (
              <ToolbarPopup
                alignRight
                sections={[
                  {
                    title: 'Models',
                    items: MODELS.map((m) => ({ ...m, active: isModelActive(m.value, session.modelName || session.model || '') })),
                  },
                  {
                    title: 'Effort',
                    items: EFFORTS.map((e) => ({ ...e, active: e.value === lastEffort })),
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
            onClick={restart}
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
