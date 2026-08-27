import React from 'react'
import { Session } from '../../stores/sessionStore'
import { MoonBadge, SessionTypeBadge, SshBadge, SshPersistentBadge, WatchdogBadge, WorkingBadge } from './Badges'
import { isAsleep, useSleepStore } from '../../stores/sleepStore'
import { useActiveStore } from '../../stores/activeStore'
import { type SessionState } from '../ui/StatusDot'
import { EffortPill } from '../ui/EffortPill'
import { FastBolt } from '../ui/FastBolt'
import { StatusPill } from '../ui/StatusPill'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../../shared/identity-colors'
import { useResolvedTheme } from '../../hooks/useThemeController'
import { useAccountProfilesStore } from '../../stores/accountProfilesStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { resolveAccountNameByEmail, resolveAccountColourKey } from '../../../shared/account-chip-color'

interface SessionRowProps {
  session: Session
  isActive: boolean
  needsAttention: boolean
  isRenaming: boolean
  renameValue: string
  renameRef: React.RefObject<HTMLInputElement | null>
  onRenameChange: (val: string) => void
  onRenameFinish: () => void
  onRenameCancel: () => void
  onClick: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  isSelected?: boolean
  isFocused?: boolean
  /** 1-based instance number among live sessions of the SAME config (#454),
   *  present only when that config has 2+ instances. Rendered as a muted "#2"
   *  after the name so otherwise-identical rows are tellable apart. */
  ordinal?: number
}

// Map store SessionStatus -> UI SessionState (see ui/StatusDot). error wins over
// needsAttention (spec section 10 priority: error > awaiting > running).
function toSessionState(status: Session['status'], needsAttention: boolean): SessionState {
  if (status === 'error') return 'error'
  if (needsAttention) return 'awaiting'
  switch (status) {
    case 'working':      return 'running'
    case 'idle':         return 'idle'
    case 'complete':     return 'idle'
    case 'disconnected': return 'background'
    default:             return 'idle'
  }
}

function meterClass(pct: number): string {
  if (pct > 85) return 'meter-danger'
  if (pct >= 70) return 'meter-warn'
  return 'meter-neutral'
}

export default function SessionRow({ session, isActive, needsAttention, isRenaming, renameValue, renameRef, onRenameChange, onRenameFinish, onRenameCancel, onClick, onContextMenu, isSelected, isFocused, ordinal }: SessionRowProps) {
  const theme = useResolvedTheme()
  const identity = resolveIdentityColor(session.identityColorKey ?? bucketLegacyColorToKey(session.color), theme)
  const st = toSessionState(session.status, needsAttention)
  const pct = session.contextPercent ?? 0

  // Sleeping (canvas "Session sleep indicator"): Watchdog-only source, Claude
  // sessions only for now (owner calls, 2026-08-27). Attention outranks the
  // moon inside isAsleep; the graceTick subscription re-derives when a dismiss
  // grace window expires without any other store change.
  const isClaudeSession = !session.shellOnly && (session.provider ?? 'claude') === 'claude'
  const silentSince = useSleepStore((s) => s.silentSince[session.id])
  const dismissedAt = useSleepStore((s) => s.attentionDismissedAt[session.id])
  useSleepStore((s) => s.graceTick)
  // The raw store flag joins the prop: at the dismissal click the prop goes
  // false before the passive effect stamps the grace, so the prop alone would
  // flash the moon for one frame between those two moments.
  const asleep =
    isClaudeSession &&
    isAsleep({ silentSince, dismissedAt, needsAttention: needsAttention || session.needsAttention === true, now: Date.now() })
  // Active (owner call, 2026-08-27): a subtle green sweep on the context bar
  // while this Claude session's PTY output is moving — the inverse of the moon.
  // Precedence ATTENTION > ACTIVE > SLEEP > idle: attention and sleep both
  // suppress it (sleep can't co-occur anyway — moving vs. 120s silent). Claude
  // only, like the moon.
  const outputMoving = useActiveStore((s) => s.activeIds.has(session.id))
  const showActive =
    isClaudeSession &&
    outputMoving &&
    !asleep &&
    !(needsAttention || session.needsAttention === true)
  const providerLabel = session.shellOnly ? 'shell' : (session.provider ?? 'claude')
  const metaLine = `${session.modelName ?? session.model ?? ''}${providerLabel ? ` · ${providerLabel}` : ''}`.trim()

  // Persistent account stamp -- resolved by LIVE email so a mid-session /login
  // that changes accountEmail immediately shows the right name/colour without
  // waiting for a respawn. Selector form (never destructure the whole store).
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const accountAliases = useSettingsStore((s) => s.settings.accountAliases)
  const accountColourOverrides = useSettingsStore((s) => s.settings.accountColourOverrides)
  const accountName = session.accountEmail
    ? resolveAccountNameByEmail(session.accountEmail, profiles, accountAliases)
    : null
  const accountDot = session.accountEmail
    ? resolveIdentityColor(
        resolveAccountColourKey(session.accountEmail, accountColourOverrides, session.accountColour),
        theme,
      )
    : null

  // #398: when renaming, render a plain <div> (NOT a <button>) so the text input
  // is never nested inside interactive button content (invalid HTML / a11y).
  if (isRenaming) {
    return (
      <div className="session-card" style={{ gridTemplateColumns: '1fr' }}>
        <input
          ref={renameRef}
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameFinish}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') onRenameFinish()
            if (e.key === 'Escape') onRenameCancel()
          }}
          onClick={(e) => e.stopPropagation()}
          className="w-full bg-base border border-blue rounded px-1.5 py-0.5 text-xs text-text outline-none min-w-0"
        />
      </div>
    )
  }

  // Selection channel: inset box-shadow rail -- no layout shift (no padding math).
  // inactive: muted 3px rail only. multi-select: muted rail + light tint.
  // active: full identity rail + tint + border + elevation.
  const identityMuted = `color-mix(in srgb, ${identity} 55%, transparent)`
  const selectedStyle: React.CSSProperties = isActive
    ? {
        backgroundColor: identity + '20',
        borderColor: identityMuted,
        boxShadow: `inset 4px 0 0 ${identity}, 0 2px 8px rgba(0,0,0,.22)`,
      }
    : isSelected
    ? {
        backgroundColor: identity + '12',
        boxShadow: `inset 3px 0 0 ${identityMuted}`,
      }
    : {
        boxShadow: `inset 3px 0 0 ${identityMuted}`,
      }

  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`session-card w-full text-left transition-all duration-150 group relative overflow-hidden ${
        isActive ? 'text-text' : 'text-subtext0 hover:text-text'
      } ${isFocused ? 'card-focus' : ''}`}
      style={selectedStyle}
      onMouseEnter={(e) => { if (!isActive && !isSelected) (e.currentTarget as HTMLElement).style.backgroundColor = identity + '12' }}
      onMouseLeave={(e) => { if (!isActive && !isSelected) (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
    >
      {st === 'awaiting' && (
        <div className="absolute inset-0 rounded-md attention-pulse-bg" style={{ backgroundColor: identity }} />
      )}

      {/* Line 1, col 2: name + (non-default) provider/ssh badges + optional
          v1.5.9 account alias. The project name keeps the higher visual weight;
          the alias sits to the right in non-bold text-secondary. Truncation
          priority comes from order, not from min-width inheritance: .nm has
          overflow:hidden, so whichever child sits past .nm's right edge gets
          clipped. The alias is the rightmost child, so it clips first; the
          project-name span stays at its content width and never ellipses on
          its own. If a future change inserts something to the right of the
          alias, that new element will be the one to clip -- reorder
          deliberately or add min-w-0 + flex-shrink rules at that point. */}
      <span className="nm relative z-10 row-start-1 flex items-center gap-1.5">
        <span className="text-[13px] truncate" style={{ fontWeight: isActive ? 700 : 600, opacity: asleep ? 0.7 : undefined }} title={session.customName?.trim() ? `${session.customName.trim()} · ${session.label}` : session.label}>{session.customName?.trim() || session.label}</span>
        {ordinal !== undefined && (
          <span
            className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]"
            title={`Instance ${ordinal} of this config`}
            data-testid="session-row-ordinal"
          >
            #{ordinal}
          </span>
        )}
      </span>

      {/* Line 1, col 3: status pill only. The account colour dot lives on line 3
          next to the account name; the old right-side account dot + identity chip
          were redundant with that dot and the card's left identity rail. */}
      <span className="relative z-10 row-start-1 flex items-center gap-1.5 justify-self-end">
        <StatusPill state={st} />
        {/* Session TYPE, in one place on every card (canvas review 2026-08-19).
            Transport first (SSH, or SSH+tmux — the link icon), then the type
            icon, then effort. A local Claude Code session used to be marked
            by having NOTHING here while Codex and Shell had an icon after the
            name and SSH had a text badge in the same spot: four treatments,
            with the common case as the odd one out. The name column gets its
            full width back. */}
        {session.sessionType === 'ssh' && (session.sshTmuxPersistent === true ? <SshPersistentBadge /> : <SshBadge />)}
        {/* Moon BESIDE the type badge (variant B): the type mark stays — the
            moon is additional Watchdog state, not a replacement identity. The
            working pill is its inverse and shares the slot (mutually exclusive:
            asleep vs. moving). */}
        {asleep && silentSince != null && <MoonBadge sinceMs={silentSince} />}
        {showActive && <WorkingBadge />}
        <SessionTypeBadge kind={session.shellOnly ? 'shell' : (session.provider ?? 'claude') === 'codex' ? 'codex' : 'claude'} />
        <WatchdogBadge watchdog={session.watchdog} />
        {/* Graceful-fail: show effort ONLY once a live tick (statusline / hooks)
            has confirmed it. A spawn-time or persisted guess (e.g. a default
            xhigh) is suppressed until effortLive flips, so the card never shows
            a stale/wrong level. */}
        {session.effortLive && session.effortLevel && <EffortPill level={session.effortLevel} />}
        {/* Fast Mode bolt -- only on a LIVE statusline fast_mode:true (verified
            per-session). Grouped with the effort pill as the model's run-mode
            indicators; clears automatically when /fast is toggled off. */}
        {session.fastMode === true && <FastBolt />}
      </span>

      {/* Line 2: model meta + right-aligned context %. One grid child spanning
          the full 2-column grid (1 / 3) so it aligns under the name in column 1.
          The meter is NOT here: it used to sit between the meta and the % as a
          flex-basis-0 item, so a long model name ("Opus 5 (1M context)") filled
          the row's natural width, left no positive free space to grow into, and
          the bar rendered 0px wide — it only ever showed for short model names.
          It now lives on its own full-width bottom row (below). */}
      <div className="relative z-10 row-start-2 flex items-center gap-2" style={{ gridColumn: '1 / 3', opacity: asleep ? 0.7 : undefined }} data-testid="card-line2">
        <span className="meta truncate flex-1 min-w-0" title={metaLine}>{metaLine}</span>
        {/* Context % is Claude-session telemetry. Terminal-only (shell)
            sessions don't have a reliable context signal — the statusline bridge
            can leak a stale/foreign percentage onto them — so hide the % (and the
            meter row below) for shell sessions until there's proper integration.
            The model · mode meta stays. */}
        {!session.shellOnly && (
          <span className="meta w-9 text-right tabular-nums shrink-0">
            {session.contextPercent != null ? `${Math.round(pct)}%` : ''}
          </span>
        )}
      </div>

      {/* Line 3: account on its own row, under the model (spans 1 / 3 so it aligns
          under the name/meta and never clips the way the cramped line-2 chip did).
          Rendered only when accountEmail is set so accountless sessions stay 2 lines. */}
      {accountName && (
        <div className="relative z-10 row-start-3 flex items-center gap-1.5 min-w-0" style={{ gridColumn: '1 / 3', opacity: asleep ? 0.7 : undefined }} data-testid="card-line3">
          {accountDot && (
            <span data-testid="account-dot" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: accountDot }} role="img" aria-label={accountName ? `Account: ${accountName}` : 'Account'} title={session.accountEmail} />
          )}
          <span className="meta truncate min-w-0" style={{ color: 'var(--text-muted)' }} title={session.accountEmail} data-testid="account-name">
            {accountName}
          </span>
        </div>
      )}

      {/* Bottom rule: the context meter on its OWN full-span grid row, under the
          account line when present (row 4; row 3 for accountless cards — set
          explicitly so no empty 2px-gap row appears). Nothing shares the row, so
          no model-name length can squeeze the bar out again. 3px tall + the 2px
          row-gap ≈ 5px of extra card height. Same shell gate as the % above.
          Unknown usage renders the empty track (0% fill), matching the old
          empty-bar behaviour until the first statusline tick. */}
      {!session.shellOnly && (
        <div
          className={`relative z-10 h-[3px] rounded-full overflow-hidden ${accountName ? 'row-start-4' : 'row-start-3'}`}
          style={{ gridColumn: '1 / 3', background: 'var(--surface-sunken)' }}
          data-testid="context-meter-row"
        >
          <div
            className={`meter-fill ${meterClass(pct)}${showActive ? ' meter-active' : ''}`}
            style={{ width: `${pct}%` }}
            data-active={showActive || undefined}
            data-testid="context-meter-fill"
          />
        </div>
      )}
    </button>
  )
}
