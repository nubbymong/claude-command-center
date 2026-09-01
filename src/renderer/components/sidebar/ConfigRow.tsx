import React from 'react'
import { TerminalConfig } from '../../stores/configStore'
import { SessionTypeBadge, SshReattachBadge, TransportBadge } from './Badges'
import { configIsPersistent, containerNameOf, resolveTransportBadge } from './transportBadge'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../../shared/identity-colors'
import { useResolvedTheme } from '../../hooks/useThemeController'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  CODEX_OFF_LAUNCH_REASON,
  alreadyRunningLaunchCopy,
  cannotSelectCopy,
  flattenPopoverCopy,
  isMultiSpawnLaunchBlocked,
} from '../../hooks/useLaunchConfig'
import {
  DELETE_WHILE_RUNNING_REASON,
  HOVER_STRIP_FADE,
  HOVER_STRIP_FADE_PX,
  HOVER_STRIP_SOLID,
  hoverStripRightPx,
  runningCountLabel,
} from './sessionsPanelState'
import { useDetachedRemotesStore } from '../../stores/detachedRemotesStore'
import { useDetachedLivenessStore } from '../../stores/livenessStore'
import { useHostReachabilityStore } from '../../stores/hostReachability'
import { matchDetachedRemotes } from '../../utils/detachedRemotes'
import { verifiedLiveCount } from '../../utils/detachedRemotesLiveness'
import MultiSpawnControl from './MultiSpawnControl'

interface ConfigRowProps {
  config: TerminalConfig
  onLaunch: () => void
  onEdit: () => void
  onDelete: () => void
  onPin?: () => void
  onContextMenu: (e: React.MouseEvent) => void
  /** How many live sessions this config has (owner revision 2026-08-24: a
   *  config is a template — it may relaunch while running, so the row shows a
   *  COUNT pill instead of locking; clicking the pill opens the session). */
  runningCount?: number
  onOpenSession?: () => void
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  isDragOver?: boolean
  /** Allow Multi Spawn (phase 4) — select mode is on for the whole Saved list. */
  selectMode?: boolean
  selected?: boolean
  onToggleSelected?: () => void
  /** Launch `n` copies from the ×N control (Multi Spawn configs only). */
  onLaunchMany?: (n: number) => void
  /** Persist the ×N control's stepped copy count on the config. */
  onSpawnCountChange?: (n: number) => void
  /** Raise the "already running" popover for a refused LAUNCH, anchored here. */
  onBlockedLaunch?: (anchor: HTMLElement) => void
  /** Raise the "can't be selected" popover for a refused SELECTION. */
  onBlockedSelect?: (anchor: HTMLElement) => void
  /** Pointer left a blocked affordance — start the popover's close grace. */
  onPromptHoverOut?: () => void
}

export default function ConfigRow({ config, onLaunch, onEdit, onDelete, onPin, onContextMenu, runningCount = 0, onOpenSession, draggable, onDragStart, onDragOver, onDrop, onDragEnd, isDragOver, selectMode, selected, onToggleSelected, onLaunchMany, onSpawnCountChange, onBlockedLaunch, onBlockedSelect, onPromptHoverOut }: ConfigRowProps) {
  // Row anatomy (phase 6, signed-off replica): IDENTITY DOT far left, then the
  // type badge, then the name. The list is scanned by account colour first and
  // by type second, so the colour must be the leftmost thing on the row — it
  // used to sit BEHIND the type mark, which put a peach/mauve/sky chip between
  // the eye and the identity it was looking for. In select mode the tick box
  // (or its lock) still comes before the dot: it is the row's mode, not its
  // identity.
  const theme = useResolvedTheme()
  const chipColour = resolveIdentityColor(config.identityColorKey ?? bucketLegacyColorToKey(config.color), theme)
  // Codex configs can't launch while the Codex master is off (user decision
  // 2026-07-02): mark the row disabled with the reason instead of a dead play
  // button. Reactive so flipping the master in Settings updates rows live.
  const codexOff = useSettingsStore((s) => s.settings.codexEnabled === false)
  const launchBlocked = codexOff && config.provider === 'codex'

  const typeKind = config.shellOnly ? 'shell' : (config.provider ?? 'claude') === 'codex' ? 'codex' : 'claude'

  // SSH Persistent (resume liveness): amber count of VERIFIED-live detached
  // sessions re-attachable for this config. Recomputed from the registry + the
  // liveness map (refreshed on events only, no SSH poll) and DEMOTED by the
  // tier-1 host map, so the badge stops claiming re-attachable sessions on a box
  // that has stopped answering.
  const detachedEntries = useDetachedRemotesStore((s) => s.entries)
  const livenessMap = useDetachedLivenessStore((s) => s.bySession)
  const hostReach = useHostReachabilityStore((s) => s.byHost)
  const reattachCount = React.useMemo(
    () => verifiedLiveCount(matchDetachedRemotes(detachedEntries, config), livenessMap, hostReach),
    [detachedEntries, livenessMap, hostReach, config],
  )

  // No locked state (owner revision 2026-08-24): a config is a template and
  // may relaunch while running. Live sessions surface as the count pill below;
  // only DELETE stays guarded while any session runs.
  const deleteBlocked = runningCount > 0

  // Allow Multi Spawn (phase 4). ONE rule, asked here exactly as the launch
  // action asks it: a running config that is not Multi Spawn runs one at a
  // time — so it cannot launch again, and cannot be ticked in select mode.
  const multiSpawn = config.allowMultiSpawn === true
  const spawnBlocked = isMultiSpawnLaunchBlocked(config, runningCount)
  // The ×N control steps aside in select mode (a multi-LAUNCH control inside a
  // multi-SELECT mode reads as the same thing and is not); the hover strip's
  // ordinary play button takes over, so no row ever loses its launch entirely.
  const spawnControlShown = multiSpawn && !selectMode
  const launchCopy = alreadyRunningLaunchCopy(config.label)
  const selectCopy = cannotSelectCopy(config.label)

  // ONE transport chip, chosen by the shared truth table: container beats
  // SSH-Persistent beats SSH. A saved config predicts persistence from its own
  // `detachable` (the session's reported wrap does not exist yet).
  const transport = resolveTransportBadge({
    isSsh: config.sessionType === 'ssh',
    ssh: config.sshConfig,
    persistent: configIsPersistent(config.sshConfig),
  })

  return (
    <div
      className={`relative flex items-center gap-1.5 rounded py-1 px-2 group transition-colors hover:bg-surface0/50 ${isDragOver ? 'border-t-2 border-blue' : ''}`}
      style={selected ? { background: 'color-mix(in srgb, var(--brand) 8%, transparent)' } : undefined}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      data-testid="config-row"
    >
      {/* Select mode: the tick box sits FAR LEFT, ahead of every identity mark.
          A running one-at-a-time config gets a muted LOCK in its place instead
          — there is nothing to tick, and the popover says why. */}
      {selectMode && (spawnBlocked ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onBlockedSelect?.(e.currentTarget) }}
          onMouseEnter={(e) => onBlockedSelect?.(e.currentTarget)}
          onFocus={(e) => onBlockedSelect?.(e.currentTarget)}
          onMouseLeave={onPromptHoverOut}
          aria-label={flattenPopoverCopy(selectCopy)}
          title={flattenPopoverCopy(selectCopy)}
          data-testid="config-row-select-lock"
          className="w-3.5 h-3.5 flex items-center justify-center shrink-0 text-[var(--text-muted)] focus-ring rounded"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          role="checkbox"
          aria-checked={!!selected}
          onClick={(e) => { e.stopPropagation(); onToggleSelected?.() }}
          aria-label={`${selected ? 'Deselect' : 'Select'} ${config.label}`}
          data-testid="config-row-select-checkbox"
          className={`w-3.5 h-3.5 rounded shrink-0 flex items-center justify-center p-0 border focus-ring ${
            selected
              ? 'bg-[var(--brand)] border-[var(--brand)] text-white'
              : 'bg-transparent border-[var(--border-strong)] text-transparent'
          }`}
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
      ))}
      <span
        className="w-2 h-2 rounded-[3px] shrink-0"
        style={{ backgroundColor: chipColour }}
        data-testid="config-row-identity-dot"
        aria-hidden
      />
      <SessionTypeBadge kind={typeKind} />
      {/* Dimmed while select mode has this row locked — the name must read as
          "not available to tick", not as an ordinary row you keep missing. */}
      <span className={`text-xs truncate flex-1 ${launchBlocked || (selectMode && spawnBlocked) ? 'text-overlay0' : 'text-text'}`}>{config.label}</span>
      {launchBlocked && (
        <span
          className="text-[9px] text-overlay0 border border-surface1 rounded-full px-1.5 shrink-0"
          title={CODEX_OFF_LAUNCH_REASON}
        >
          Codex off
        </span>
      )}
      {/* Transport badge stays at the tail — the type leads the row. Three-way:
          a container config shows the container mark INSTEAD of an SSH chip; a
          persistent config (detachable, the SSH default) reads SSH-Persistent,
          matching the running-session badge; a standard one reads SSH. So the
          three remote kinds are told apart before launch, not after. */}
      <TransportBadge kind={transport} container={containerNameOf(config.sshConfig)} />
      {config.sessionType === 'ssh' && <SshReattachBadge count={reattachCount} />}
      {runningCount > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); onOpenSession?.() }}
          className="flex items-center text-[8.5px] font-semibold text-green bg-green/15 hover:bg-green/25 rounded-full px-1.5 py-0.5 shrink-0 focus-ring transition-colors"
          title={runningCountLabel(runningCount)}
          aria-label={runningCountLabel(runningCount)}
          data-testid="config-row-running-count"
        >
          {runningCount}
        </button>
      )}
      {/* ×N spawn control — Multi Spawn configs only, and visible at REST (the
          approved mockup): it is this row's launch affordance, so it replaces
          the hover strip's plain play button rather than doubling it. Hidden in
          select mode, where the row's job is to be ticked, not to launch. */}
      {spawnControlShown && (
        <MultiSpawnControl
          label={config.label}
          count={config.multiSpawnCount}
          onLaunch={(n) => onLaunchMany?.(n)}
          onCountChange={(n) => onSpawnCountChange?.(n)}
          disabled={launchBlocked}
          disabledReason={launchBlocked ? CODEX_OFF_LAUNCH_REASON : undefined}
          testId="config-row-multi-spawn"
        />
      )}
      {/* Overlaid on hover rather than held in the row's flex line. As
          layout children these buttons reserved their width permanently, even
          at opacity-0 -- so every label truncated against a strip of blank
          space that only exists for controls the user cannot see. Absolute
          positioning gives the label the full row at rest and still avoids the
          reflow that display:none would cause on hover. The backdrop keeps the
          buttons legible over the tail of a long label. */}
      {/* When the count pill (and/or the ×N control) occupies the right edge,
          the hover strip parks FLUSH against it — its right edge on the pill's
          left edge, so the pill stays visible and clickable (the opaque core
          would otherwise swallow every click aimed at it) and no sliver of
          badge shows between the two. The offset is `hoverStripRightPx`, a
          pure function pinned by unit tests: no jsdom test can measure layout.
          Phase 6 also replaces the old `from-surface0` gradient core with the
          OPAQUE hover composite — the gradient was translucent at every stop,
          so the transport badges ghosted through the buttons (replica R1/a1).
          Only the label side still fades, via the tongue below. */}
      <div
        className="absolute flex gap-0.5 items-center rounded pl-2 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity"
        style={{ right: hoverStripRightPx(runningCount, spawnControlShown), background: HOVER_STRIP_SOLID }}
        data-testid="config-row-hover-actions"
        data-parked={runningCount > 0 || spawnControlShown ? 'clear' : 'edge'}
      >
        {/* The fade tongue: the only translucent part, and it sits over the
            label tail where there is nothing to ghost through. A sibling span
            rather than a ::before so it needs no global stylesheet rule. */}
        <span
          aria-hidden
          className="absolute top-0 h-full pointer-events-none"
          style={{ right: '100%', width: HOVER_STRIP_FADE_PX, background: HOVER_STRIP_FADE }}
        />
        {/* The plain play button. Three states now: Codex-off (inert, as
            before), Multi-Spawn-blocked (inert, but it EXPLAINS itself and
            offers the way out), and normal. A Multi Spawn config has no play
            button here at all — its ×N control is the launch. */}
        {!spawnControlShown && (spawnBlocked ? (
          <button
            onClick={(e) => { e.stopPropagation(); onBlockedLaunch?.(e.currentTarget) }}
            onMouseEnter={(e) => onBlockedLaunch?.(e.currentTarget)}
            onFocus={(e) => onBlockedLaunch?.(e.currentTarget)}
            onMouseLeave={onPromptHoverOut}
            /* aria-disabled, NOT `disabled`: a disabled button fires no pointer
               events, and this one's whole job is to explain itself on hover. */
            aria-disabled
            data-testid="config-row-launch-blocked"
            className="p-1 rounded border border-[var(--border-subtle)] bg-[var(--surface-raised)] text-[var(--text-muted)] cursor-not-allowed focus-ring"
            title={flattenPopoverCopy(launchCopy)}
            aria-label={flattenPopoverCopy(launchCopy)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden><polygon points="3,1 10,6 3,11" /></svg>
          </button>
        ) : (
          <button
            onClick={launchBlocked ? undefined : onLaunch}
            disabled={launchBlocked}
            aria-disabled={launchBlocked}
            className={
              launchBlocked
                ? 'p-1 rounded text-overlay0/50 cursor-not-allowed'
                : 'p-1 rounded hover:bg-surface1 text-overlay1 hover:text-text focus-ring'
            }
            title={launchBlocked ? CODEX_OFF_LAUNCH_REASON : 'Launch'}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><polygon points="3,1 10,6 3,11" /></svg>
          </button>
        ))}
        {onPin && (
          <button
            onClick={onPin}
            className={`p-1 rounded hover:bg-surface1 transition-colors focus-ring ${config.pinned ? 'text-yellow' : 'text-overlay1 hover:text-text'}`}
            title={config.pinned ? 'Unpin from Quick Start' : 'Pin to Quick Start'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M13 2L3 14h7l-1 8 11-13h-8z" />
            </svg>
          </button>
        )}
        <button
          onClick={onEdit}
          className="p-1 rounded hover:bg-surface1 text-overlay1 hover:text-text focus-ring"
          title="Edit"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8.5 1.5l2 2-7 7H1.5v-2z"/></svg>
        </button>
        <button
          onClick={deleteBlocked ? undefined : onDelete}
          disabled={deleteBlocked}
          aria-disabled={deleteBlocked}
          className={
            deleteBlocked
              ? 'p-1 rounded text-overlay0/50 cursor-not-allowed'
              : 'p-1 rounded hover:bg-surface1 text-overlay1 hover:text-red focus-ring'
          }
          title={deleteBlocked ? DELETE_WHILE_RUNNING_REASON : 'Delete'}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        </button>
      </div>
    </div>
  )
}
