import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DetachedRemote } from '../../../shared/types'
import { useDetachedRemotesStore } from '../../stores/detachedRemotesStore'
import { useDetachedLivenessStore, verifyOnCardClick, verifyOnResumeSectionOpen, verifyOnWindowFocus } from '../../stores/livenessStore'
import { useHostReachabilityStore, armHostPings, disarmHostPings } from '../../stores/hostReachability'
import { useConfigStore, type TerminalConfig } from '../../stores/configStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useAccountProfilesStore } from '../../stores/accountProfilesStore'
import { useResolvedTheme } from '../../hooks/useThemeController'
import { useLaunchConfig, useLaunchSessionAction } from '../../hooks/useLaunchConfig'
import { useClickOutside } from '../../hooks/useClickOutside'
import { persistSessionState } from '../../session-persistence'
import { configForDetachedEntry, describeDetachedAge, filterLiveEntries } from '../../utils/detachedRemotes'
import { displayLiveness, type EntryDisplayLiveness } from '../../utils/detachedRemotesLiveness'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../../shared/identity-colors'
import { resolveAccountColourKey, resolveAccountNameByEmail } from '../../../shared/account-chip-color'
import { resolveRemoteResumableCollapsed } from './sessionsPanelState'
import { DialogButton, DialogFooter, DialogHeader, DialogOverlay, DialogPanel, useDialogEscape } from '../ui/Dialog'

/**
 * Remote Resumable — the resume surface (SSH Persistent, Phase 3).
 *
 * Docked at the BOTTOM of the Running tab, under Active Sessions: the remotes
 * the user LEFT RUNNING, as a list of dim cards that survive an app restart.
 * One click reattaches; right-click removes.
 *
 * THE TWO-PILL MODEL (owner call on the sidebar-replica canvas). A card carries
 * exactly one state pill and there are only two of them:
 *
 *   - Resumable (success)   — anything we have not CONFIRMED gone.
 *   - Unreachable (danger)  — tier 2 says the tmux target is dead, or tier 1
 *                             says the host stopped answering.
 *
 * There is deliberately NO "Checking" pill. A check is an event, not a state,
 * and a third pill that appeared on every window focus made a stable list look
 * like it was thrashing. While a verify is in flight the card KEEPS its
 * last-known pill and the only hint is a small pulsing dot appended to the host
 * line (`.rr-host-check`, styles.css).
 *
 * FAIL-OPEN, exactly as `offerableEntries` defines it: only a CONFIRMED-dead
 * remote is withheld from resume. 'unverified' (host asleep, auth failed) and
 * 'unreachable' still resume, because a reattach self-heals — a `has-session`
 * miss on the remote turns into a fresh create + `--continue`. Withholding on a
 * merely-unverified probe would strand a live session behind a sleeping laptop.
 *
 * WIRING (the seams Phase 2 built; the policy of "when may we ssh?" lives in
 * livenessStore.ts, not here):
 *   - section mounts / expands  -> verifyOnResumeSectionOpen()
 *   - window regains focus      -> verifyOnWindowFocus()
 *   - a card is clicked         -> verifyOnCardClick(config), before acting
 *   - Running tab visible       -> armHostPings() / disarmHostPings() on hide
 * The tier-2 probe's own in-flight guard collapses a burst, so none of these
 * needs debouncing here.
 */

/** Which pill a folded liveness state shows. Only a CONFIRMED-gone remote goes
 *  red; everything else — including a probe in flight and a never-checked entry
 *  — reads Resumable, matching the fail-open offer rule. */
export function pillForLiveness(state: EntryDisplayLiveness): 'resumable' | 'unreachable' {
  return state === 'dead' || state === 'unreachable' ? 'unreachable' : 'resumable'
}

/** The one liveness verdict that BLOCKS a resume: an authenticated answer that
 *  the tmux target is gone. Tier 1's 'unreachable' is an inference about the
 *  host, not about the session, so it never blocks (see the fail-open note). */
function isConfirmedDead(state: EntryDisplayLiveness): boolean {
  return state === 'dead'
}

type CardModal =
  /** Verified dead: offer Remove / Start new. */
  | { kind: 'dead'; entry: DetachedRemote; config: TerminalConfig | undefined }
  /** The saved config was deleted: nothing to launch, so Remove only. */
  | { kind: 'no-config'; entry: DetachedRemote }

interface ContextMenuState {
  entry: DetachedRemote
  x: number
  y: number
}

interface RemoteResumableSectionProps {
  /** Ids of the sessions that are CURRENTLY live. An entry whose id is already
   *  open must never be offered — resuming it would collide with a running
   *  tile (filterLiveEntries). */
  liveSessionIds: string[]
  /** Reveal a session that was just resumed or launched: select it, put the
   *  panel on Running, and switch the main view to sessions. */
  onRevealSession: (sessionId: string) => void
}

export default function RemoteResumableSection({ liveSessionIds, onRevealSession }: RemoteResumableSectionProps) {
  const theme = useResolvedTheme()
  const entries = useDetachedRemotesStore((s) => s.entries)
  const removeEntry = useDetachedRemotesStore((s) => s.remove)
  const livenessMap = useDetachedLivenessStore((s) => s.bySession)
  const hostReach = useHostReachabilityStore((s) => s.byHost)
  const configs = useConfigStore((s) => s.configs)
  const collapsed = resolveRemoteResumableCollapsed(useSettingsStore((s) => s.settings.remoteResumableCollapsed))
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const accountAliases = useSettingsStore((s) => s.settings.accountAliases)
  const accountColourOverrides = useSettingsStore((s) => s.settings.accountColourOverrides)
  // Two launch paths on purpose. `reattach` reuses the detached remote's id and
  // asks for reconnect (the resume). `launchFresh` is the ORDINARY launch every
  // other surface uses — gated (Codex off) and always a new id — so "Start new"
  // means exactly what pressing Start on the config would.
  const reattach = useLaunchSessionAction()
  const launchFresh = useLaunchConfig()

  const [modal, setModal] = useState<CardModal | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  /** Session ids whose CLICK-verify is in flight — drives the host-line dot.
   *  A Set, not a single id: a fast user can click two cards. */
  const [clickChecking, setClickChecking] = useState<ReadonlySet<string>>(() => new Set())

  // Newest first: "left running 12m ago" reads better descending, and the
  // registry's own array order is append-on-detach (oldest first).
  const visible = useMemo(
    () => [...filterLiveEntries(entries, liveSessionIds)].sort((a, b) => b.detachedAt - a.detachedAt),
    [entries, liveSessionIds],
  )
  const hasEntries = visible.length > 0

  // ── The verify seams ──────────────────────────────────────────────────────

  // Section became visible (mount, or expanded after being collapsed): verify
  // everything it is about to show. Keyed on `collapsed` so it fires once per
  // OPEN, not on every render or every registry change.
  useEffect(() => {
    if (collapsed) return
    void verifyOnResumeSectionOpen()
  }, [collapsed])

  // Window regained focus — the user was away, so re-verify. Section-level (not
  // app-level) on purpose: the listener exists exactly while the surface that
  // consumes the answer is on screen, following the same
  // add-on-mount/remove-on-unmount shape as BottomBar's and TerminalView's.
  useEffect(() => {
    const onFocus = () => { void verifyOnWindowFocus() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // Tier-1 pings run only while this surface is mounted (the Running tab is
  // rendered) AND there is something to ping. The Sidebar unmounts the whole
  // Running tabpanel on a tab switch, so the cleanup IS the "tab hidden" case.
  useEffect(() => {
    if (!hasEntries) return
    armHostPings()
    return () => disarmHostPings()
  }, [hasEntries])

  // ── Actions ───────────────────────────────────────────────────────────────

  /** Drop an entry from the persisted registry and flush, so the removal
   *  survives an immediate app close (the debounced autosave may not fire). */
  const dropEntry = useCallback((sessionId: string) => {
    removeEntry(sessionId)
    void persistSessionState()
  }, [removeEntry])

  /** Reattach: the ORIGINAL session id + reconnect, so the tmux target
   *  `ccc-<sessionId>` matches again and TerminalView spawns a reconnect. The
   *  registry entry is consumed by the resume — it is live now, not detached. */
  const resume = useCallback((entry: DetachedRemote, config: TerminalConfig) => {
    const id = reattach(config, { sessionId: entry.sessionId, reconnect: true })
    if (!id) return
    dropEntry(entry.sessionId)
    onRevealSession(id)
  }, [reattach, dropEntry, onRevealSession])

  /** "Start new": a PLAIN launch of the same config — fresh id, no reconnect.
   *  The entry is dropped EITHER WAY (the remote it named is confirmed gone, so
   *  the card must not survive even a launch the Codex gate blocks). */
  const startNew = useCallback((entry: DetachedRemote, config: TerminalConfig) => {
    dropEntry(entry.sessionId)
    const id = launchFresh(config)
    if (id) onRevealSession(id)
  }, [launchFresh, dropEntry, onRevealSession])

  /**
   * Remove: kill the remote first when it MIGHT still be live, then drop the
   * entry. A kill failure never blocks the drop — the user asked for the card
   * to go, and a host that cannot be reached now is exactly the case where
   * leaving the card forever is the worse outcome.
   *
   * KNOWN GAP (reported with this phase, not fixed here): `ssh:endRemote` keys
   * off `sshTargetBySession`, a MAIN-process map captured at spawn and cleared
   * by `killPty` — which "Leave running" calls. So for a detached entry the
   * handler resolves 'no-target' and the remote tmux session survives. The call
   * is made anyway (it is correct for the one case that still has a target, and
   * harmless otherwise); closing the gap needs a main-side target rebuilt from
   * the saved config, the way `ssh:checkDetachedLive` already does — an
   * IPC/credential change that is its own ADR-009 pass.
   */
  const removeRemote = useCallback(async (entry: DetachedRemote, mightBeLive: boolean) => {
    if (mightBeLive) {
      try {
        await window.electronAPI?.ssh?.endRemote?.(entry.sessionId)
      } catch {
        /* best-effort: the remote is at worst still detached, and the card goes */
      }
    }
    dropEntry(entry.sessionId)
  }, [dropEntry])

  /** The whole-card action: verify THIS config, then resume or explain. */
  const activateCard = useCallback(async (entry: DetachedRemote) => {
    const config = configForDetachedEntry(entry, configs)
    if (!config) {
      // The saved config was deleted. Nothing to launch and nothing to reattach
      // into — say so and offer Remove.
      setModal({ kind: 'no-config', entry })
      return
    }
    setClickChecking((prev) => new Set(prev).add(entry.sessionId))
    try {
      await verifyOnCardClick(config)
    } finally {
      setClickChecking((prev) => {
        const next = new Set(prev)
        next.delete(entry.sessionId)
        return next
      })
    }
    // Read the FRESH map: the state captured at render is pre-verify.
    const state = displayLiveness(
      entry,
      useDetachedLivenessStore.getState().bySession,
      useHostReachabilityStore.getState().byHost,
    )
    if (isConfirmedDead(state)) {
      setModal({ kind: 'dead', entry, config })
      return
    }
    resume(entry, config)
  }, [configs, resume])

  // Nothing left running: no header, no empty state. The section is evidence of
  // a thing that happened, and an empty one is noise on every other launch.
  //
  // The DIALOGS are rendered outside this (below), and that is load-bearing:
  // confirming a remote dead PRUNES its entry from the registry, so the very
  // click that opens the dead-remote dialog can empty the section. Nesting the
  // dialog inside would unmount the explanation at the instant the card
  // vanished, leaving the user with a list that changed and no reason why.
  const section = !hasEntries ? null : (
    <div
      className="shrink-0 mt-auto px-2 pb-2"
      style={{ borderTop: '1px solid var(--border-subtle)' }}
      data-testid="remote-resumable"
    >
      <button
        onClick={() => void updateSettings({ remoteResumableCollapsed: !collapsed })}
        aria-expanded={!collapsed}
        className="w-full px-1 pt-2 pb-1 flex items-center gap-1.5 focus-ring rounded"
        title={collapsed ? 'Expand Remote Resumable' : 'Collapse Remote Resumable'}
        data-testid="remote-resumable-header"
      >
        <svg
          width="9" height="9" viewBox="0 0 10 10" fill="currentColor"
          className="transition-transform"
          style={{ color: 'var(--text-muted)', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
          aria-hidden
        >
          <polygon points="2,2 8,5 2,8" />
        </svg>
        <span className="text-[10.5px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
          Remote Resumable
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }} data-testid="remote-resumable-count">
          {visible.length}
        </span>
      </button>

      {!collapsed && visible.map((entry) => {
        const config = configForDetachedEntry(entry, configs)
        const state = displayLiveness(entry, livenessMap, hostReach)
        const pill = pillForLiveness(state)
        const gone = pill === 'unreachable'
        // A check is "in flight" either because this card was clicked or because
        // a section-open/focus/recovery probe put it in 'checking'. Read off the
        // RAW tier-2 map, not the folded state: a demoted host resolves to
        // 'unreachable' and would hide the dot on exactly the card whose
        // in-flight check the user most wants to see.
        const checking = clickChecking.has(entry.sessionId) || livenessMap[entry.sessionId] === 'checking'
        const identity = config
          ? resolveIdentityColor(config.identityColorKey ?? bucketLegacyColorToKey(config.color), theme)
          : 'var(--text-muted)'
        const accountDot = entry.accountEmail
          ? resolveIdentityColor(resolveAccountColourKey(entry.accountEmail, accountColourOverrides, undefined), theme)
          : null
        const accountName = entry.accountEmail
          ? resolveAccountNameByEmail(entry.accountEmail, profiles, accountAliases)
          : null
        const hostLine = `${entry.username}@${entry.host} · left ${describeDetachedAge(entry.detachedAt, Date.now())}`
        const label = entry.label || entry.sessionId

        return (
          <button
            key={entry.sessionId}
            type="button"
            onClick={() => void activateCard(entry)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu({ entry, x: e.clientX, y: e.clientY }) }}
            aria-label={
              config
                ? `Resume ${label} on ${entry.username}@${entry.host}`
                : `${label} — saved config deleted; open options`
            }
            title={
              config
                ? `Click to resume on ${entry.username}@${entry.host} · right-click: Resume / Remove`
                : `${label} — its saved config was deleted. Right-click to remove.`
            }
            className="rr-card relative w-full my-0.5 px-2.5 py-[7px] rounded-[9px] overflow-hidden text-left focus-ring"
            style={{
              // The card's base fill, read back by `.rr-card:hover` so the lift
              // works from whichever base this card has. A gone one is tinted
              // 5% danger — faint enough to read as a mood, not an alert.
              '--rr-card-bg': gone
                ? 'color-mix(in srgb, var(--status-danger) 5%, var(--surface-base))'
                : 'var(--surface-base)',
              // Identity reads as a DIM inset bar (30% mix), not a border: the
              // whole section sits at a lower weight than the live cards above
              // it, so a full-strength identity edge would out-shout them.
              boxShadow: `inset 3px 0 0 color-mix(in srgb, ${identity} 30%, transparent)`,
            } as React.CSSProperties}
            data-testid="remote-resumable-card"
            data-session-id={entry.sessionId}
            data-liveness={state}
          >
            <span className="flex items-center gap-2">
              <span
                className="text-[13px] font-semibold flex-1 min-w-0 truncate"
                style={{ color: 'var(--text-secondary)' }}
              >
                {label}
              </span>
              <span
                className="inline-flex items-center gap-[5px] text-[8.5px] font-bold leading-none px-[7px] py-[3px] rounded-full shrink-0"
                style={
                  gone
                    ? { background: 'color-mix(in srgb, var(--status-danger) 15%, transparent)', color: 'var(--status-danger)' }
                    : { background: 'color-mix(in srgb, var(--status-success) 16%, transparent)', color: 'var(--status-success)' }
                }
                data-testid={gone ? 'rr-pill-unreachable' : 'rr-pill-resumable'}
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'currentColor' }} aria-hidden />
                {gone ? 'Unreachable' : 'Resumable'}
              </span>
            </span>
            <span className="mt-1 flex items-center gap-1.5 min-w-0">
              {accountDot && (
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: accountDot }}
                  role="img"
                  aria-label={accountName ? `Account: ${accountName}` : 'Account'}
                  title={entry.accountEmail}
                  data-testid="rr-account-dot"
                />
              )}
              <span
                className="font-mono text-[10px] min-w-0 truncate"
                style={{ color: 'var(--text-muted)' }}
                title={hostLine}
              >
                {hostLine}
              </span>
              {checking && (
                <span
                  className="rr-host-check w-[5px] h-[5px] rounded-full shrink-0"
                  style={{ background: 'var(--text-muted)' }}
                  role="img"
                  aria-label="Checking with the host"
                  title="Checking with the host..."
                  data-testid="rr-host-checking"
                />
              )}
            </span>
          </button>
        )
      })}

      {contextMenu && (
        <RemoteResumableContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          canResume={!!configForDetachedEntry(contextMenu.entry, configs)}
          onResume={() => { const e = contextMenu.entry; setContextMenu(null); void activateCard(e) }}
          onRemove={() => {
            const e = contextMenu.entry
            setContextMenu(null)
            const state = displayLiveness(e, livenessMap, hostReach)
            // "Might be live" is everything except a CONFIRMED-dead target —
            // there is nothing to kill on one we know is gone.
            void removeRemote(e, !isConfirmedDead(state))
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )

  return (
    <>
      {section}

      {modal?.kind === 'dead' && (
        <DeadRemoteDialog
          label={modal.entry.label || modal.entry.sessionId}
          canStartNew={!!modal.config}
          onRemove={() => { dropEntry(modal.entry.sessionId); setModal(null) }}
          onStartNew={() => { if (modal.config) startNew(modal.entry, modal.config); setModal(null) }}
          onCancel={() => setModal(null)}
        />
      )}

      {modal?.kind === 'no-config' && (
        <MissingConfigDialog
          label={modal.entry.label || modal.entry.sessionId}
          host={`${modal.entry.username}@${modal.entry.host}`}
          onRemove={() => {
            const e = modal.entry
            setModal(null)
            void removeRemote(e, !isConfirmedDead(displayLiveness(e, livenessMap, hostReach)))
          }}
          onCancel={() => setModal(null)}
        />
      )}
    </>
  )
}

/* ── context menu ─────────────────────────────────────────────────────────── */

/** Resume / Remove, on the ConfigContextMenu shape (fixed-position card, click
 *  outside or Escape closes — `useClickOutside`). */
function RemoteResumableContextMenu({ x, y, canResume, onResume, onRemove, onClose }: {
  x: number
  y: number
  canResume: boolean
  onResume: () => void
  onRemove: () => void
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  useClickOutside(menuRef, onClose)
  return (
    <div
      ref={menuRef}
      className="fixed z-50 rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ left: x, top: y, background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
      data-testid="rr-context-menu"
    >
      <button
        onClick={onResume}
        disabled={!canResume}
        className="w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 hover:bg-[var(--surface-overlay)] disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ color: 'var(--text-primary)' }}
        title={canResume ? 'Reattach to the remote session' : 'The saved config for this remote was deleted'}
        data-testid="rr-ctx-resume"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" />
        </svg>
        Resume
      </button>
      <button
        onClick={onRemove}
        className="w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 hover:bg-[var(--surface-overlay)]"
        style={{ color: 'var(--status-danger)' }}
        title="Ends the remote session and forgets it"
        data-testid="rr-ctx-remove"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
          <line x1="2" y1="2" x2="10" y2="10" /><line x1="10" y1="2" x2="2" y2="10" />
        </svg>
        Remove
      </button>
    </div>
  )
}

/* ── dialogs ──────────────────────────────────────────────────────────────── */

const DEAD_GLYPH = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" /><path d="M12 7v6" /><path d="M12 16.5v.01" />
  </svg>
)

/** The remote is CONFIRMED gone. Both exits drop the registry entry — the whole
 *  point is that the card must not come back — and Start new additionally
 *  launches the same config fresh. */
function DeadRemoteDialog({ label, canStartNew, onRemove, onStartNew, onCancel }: {
  label: string
  canStartNew: boolean
  onRemove: () => void
  onStartNew: () => void
  onCancel: () => void
}) {
  useDialogEscape(onCancel)
  return (
    <DialogOverlay testId="rr-dead-dialog">
      <DialogPanel labelledBy="rr-dead-title" testId="rr-dead-panel" role="alertdialog">
        <DialogHeader
          title={`${label} — the remote session has ended.`}
          titleId="rr-dead-title"
          subtitle="Nothing is left to reattach to on the host."
          glyph={DEAD_GLYPH}
          glyphAccent="var(--status-danger)"
          onClose={onCancel}
          closeTestId="rr-dead-close"
        />
        <DialogFooter>
          <DialogButton onClick={onRemove} testId="rr-dead-remove">Remove</DialogButton>
          {canStartNew && (
            <DialogButton variant="primary" onClick={onStartNew} testId="rr-dead-start-new">Start new</DialogButton>
          )}
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}

/** The saved config was deleted while the remote was left running. There is no
 *  template to relaunch, so the only offer is to forget it (killing the remote
 *  first if it might still be up). */
function MissingConfigDialog({ label, host, onRemove, onCancel }: {
  label: string
  host: string
  onRemove: () => void
  onCancel: () => void
}) {
  useDialogEscape(onCancel)
  return (
    <DialogOverlay testId="rr-missing-config-dialog">
      <DialogPanel labelledBy="rr-missing-title" testId="rr-missing-config-panel" role="alertdialog">
        <DialogHeader
          title={`${label} — its saved config was deleted.`}
          titleId="rr-missing-title"
          subtitle={`There is no template left to resume ${host} with. Removing it ends the remote session and forgets the card.`}
          glyph={DEAD_GLYPH}
          glyphAccent="var(--status-warning)"
          onClose={onCancel}
          closeTestId="rr-missing-close"
        />
        <DialogFooter>
          <DialogButton onClick={onCancel} testId="rr-missing-cancel">Cancel</DialogButton>
          <DialogButton variant="danger" onClick={onRemove} testId="rr-missing-remove">Remove</DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
