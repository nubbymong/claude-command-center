import React, { useMemo, useState } from 'react'
import { useConfigStore, type ConfigGroup, type TerminalConfig } from '../stores/configStore'
import { useSessionStore } from '../stores/sessionStore'
import { useDetachedRemotesStore } from '../stores/detachedRemotesStore'
import { useDetachedLivenessStore } from '../stores/livenessStore'
import { useHostReachabilityStore } from '../stores/hostReachability'
import { matchDetachedRemotes } from '../utils/detachedRemotes'
import { verifiedLiveCount } from '../utils/detachedRemotesLiveness'
import {
  multiSpawnStartupRowState,
  resolveStartupRowSave,
  resumingSessionCount,
  type MultiSpawnRowState,
} from '../utils/multiSpawn'
import { markMultiSpawnIntroSeen } from '../onboarding/multi-spawn-intro-gate'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../shared/identity-colors'
import { useResolvedTheme } from '../hooks/useThemeController'
import { SessionTypeBadge, SshBadge, SshPersistentBadge, SshReattachBadge, DockerBadge } from './sidebar/Badges'
import { DialogOverlay, DialogPanel, DialogBody, DialogFooter, DialogButton, DialogCallout } from './ui/Dialog'

/**
 * The Allow Multi Spawn post-install page (phase 5) — a full-screen takeover
 * shown ONCE per upgrade, immediately after the release notes.
 *
 * Why a page and not a changelog line: phase 4 gave every saved config a limit
 * it never had (one copy at a time), and phase 4.1 gave the user a way to say
 * "not this one" that the migration must respect forever. Between those two
 * facts sits a decision only the user can make, on configs only they can
 * recognise — so it is asked once, in a list, with the evidence beside each
 * row, rather than discovered later as a refused launch.
 *
 * Three properties are load-bearing:
 *
 *  1. SKIPPING IS SAFE, and the note says so. The App-level migration has
 *     already enabled (or will enable, within a frame) every config that
 *     demonstrably runs several copies — this page does not perform that
 *     migration, it SHOWS it and offers the opt-out. Skip loses nothing.
 *  2. TURNING A ROW OFF IS A DECLINE. An auto-enabled row still holds
 *     `undefined` on disk, so un-ticking it has to store an explicit `false` or
 *     the next start's migration switches it straight back on. That
 *     substitution lives in `resolveStartupRowSave`, next to the save rule it
 *     wraps.
 *  3. UNTOUCHED IS UNTOUCHED. A row nobody has ever decided about, with a
 *     single copy, is left at `undefined` — still clean, still eligible for
 *     grandfathering later. Continue writes only the rows whose value actually
 *     changes.
 *
 * The layout is the approved canvas (`.ccc-canvas/multispawn-startup.html`):
 * SetupDialog's opaque `--surface-base` takeover behind a `>_` hero and a
 * single raised panel, with rows built from the SAME badge components the
 * sidebar's Saved list uses so a config is recognisable by eye rather than by
 * reading its name.
 */

/** The first-run takeover replaces the whole app, so the backdrop is the opaque
 *  app base rather than a scrim — there is nothing behind it to dim.
 *  (SetupDialog's OPAQUE_BACKDROP, same reasoning.) */
const OPAQUE_BACKDROP: React.CSSProperties = { background: 'var(--surface-base)' }

export interface StartupConfigGroup {
  /** The group's id, or null for the trailing "Ungrouped" bucket. */
  id: string | null
  name: string
  configs: TerminalConfig[]
}

/**
 * Saved configs under their group headings, in the sidebar's order and by the
 * sidebar's rule: a config whose `groupId` is missing OR points at a group that
 * no longer exists is loose, and loose configs land in one "Ungrouped" bucket at
 * the end. Empty groups are dropped — a heading with nothing under it is noise
 * on a page whose whole job is a list of decisions.
 *
 * Sections (the level above groups) are deliberately flattened: the page is a
 * one-screen list, and a two-level hierarchy of headings over a dozen rows
 * reads as structure where there is only a list.
 */
export function groupConfigsForStartup(
  configs: ReadonlyArray<TerminalConfig>,
  groups: ReadonlyArray<ConfigGroup>,
): StartupConfigGroup[] {
  const out: StartupConfigGroup[] = []
  for (const g of groups) {
    const members = configs.filter((c) => c.groupId === g.id)
    if (members.length > 0) out.push({ id: g.id, name: g.name, configs: members })
  }
  const loose = configs.filter((c) => !c.groupId || !groups.some((g) => g.id === c.groupId))
  if (loose.length > 0) out.push({ id: null, name: 'Ungrouped', configs: loose })
  return out
}

/**
 * The row toggle. Written here rather than reused from
 * `github/config/ToggleSwitch` because that one is painted in the Catppuccin
 * palette classes the dialog primitives were moved off (#360); this page is
 * token-only, like the panel it sits in.
 */
function MultiSpawnToggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      data-testid="multi-spawn-startup-toggle"
      className="relative w-[30px] h-[17px] rounded-full shrink-0 border p-0 transition-colors focus-ring"
      style={{
        background: checked ? 'color-mix(in srgb, var(--brand) 55%, var(--surface-sunken))' : 'var(--surface-sunken)',
        borderColor: checked ? 'color-mix(in srgb, var(--brand) 70%, transparent)' : 'var(--border-strong)',
      }}
    >
      <span
        className="absolute top-px left-px w-[13px] h-[13px] rounded-full transition-transform"
        style={{
          background: checked ? '#fff' : 'var(--text-muted)',
          transform: checked ? 'translateX(13px)' : 'translateX(0)',
        }}
      />
    </button>
  )
}

/** The refresh glyph the resume strip and the reattach badge share. */
function ResumeGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}

interface RowProps {
  config: TerminalConfig
  state: MultiSpawnRowState
  checked: boolean
  onToggle: () => void
}

function StartupConfigRow({ config, state, checked, onToggle }: RowProps) {
  const theme = useResolvedTheme()
  const chipColour = resolveIdentityColor(config.identityColorKey ?? bucketLegacyColorToKey(config.color), theme)
  const typeKind = config.shellOnly ? 'shell' : (config.provider ?? 'claude') === 'codex' ? 'codex' : 'claude'

  // The amber counter, from exactly the inputs the sidebar row uses: registry
  // entries matched to this config, filtered to VERIFIED-live and demoted by the
  // tier-1 host map. No second definition of "re-attachable" on this page.
  const detachedEntries = useDetachedRemotesStore((s) => s.entries)
  const livenessMap = useDetachedLivenessStore((s) => s.bySession)
  const hostReach = useHostReachabilityStore((s) => s.byHost)
  const reattachCount = useMemo(
    () => verifiedLiveCount(matchDetachedRemotes(detachedEntries, config), livenessMap, hostReach),
    [detachedEntries, livenessMap, hostReach, config],
  )

  const container = config.sshConfig?.runtime?.container || config.sshConfig?.dockerContainer

  return (
    <div
      className="flex items-center gap-1.5 rounded py-1.5 px-2 transition-colors hover:bg-surface0/50"
      data-testid="multi-spawn-startup-row"
      data-config-id={config.id}
    >
      {/* Identity FAR LEFT on this page (the approved canvas), ahead of the type
          mark — the list is read by identity colour first, then by type. */}
      <span className="w-2 h-2 rounded-[3px] shrink-0" style={{ backgroundColor: chipColour }} aria-hidden />
      <SessionTypeBadge kind={typeKind} />
      <span className="text-xs truncate flex-1 min-w-0" style={{ color: 'var(--text-primary)' }}>{config.label}</span>
      {config.sessionType === 'ssh' && (config.sshConfig?.detachable !== false ? <SshPersistentBadge /> : <SshBadge />)}
      {config.sessionType === 'ssh' && !!container && <DockerBadge container={container} />}
      {config.sessionType === 'ssh' && <SshReattachBadge count={reattachCount} />}
      {state.auto && (
        <span
          className="shrink-0 rounded-full px-[7px] py-[3px] text-[8.5px] font-semibold leading-none"
          style={{ color: 'var(--status-success)', background: 'color-mix(in srgb, var(--status-success) 12%, transparent)' }}
          title={`Multi Spawn was enabled automatically: ${state.count} copies of this config were found. Sessions left running on a host count as copies.`}
          data-testid="multi-spawn-startup-autochip"
          data-config-id={config.id}
        >
          auto · {state.count} copies found
        </span>
      )}
      <MultiSpawnToggle checked={checked} label={`Multi Spawn for ${config.label}`} onChange={onToggle} />
    </div>
  )
}

export interface MultiSpawnStartupPageProps {
  /** Configs the App-level migration turned on THIS START — the rows that get
   *  the green chip even though their stored value now reads a plain `true`. */
  autoEnabledIds?: string[]
  /** Both buttons land here, after the page has done its own persisting and
   *  stamped the seen marker. The caller only has to close the gate. */
  onDone: () => void
}

export function MultiSpawnStartupPage({ autoEnabledIds = [], onDone }: MultiSpawnStartupPageProps) {
  const configs = useConfigStore((s) => s.configs)
  const groups = useConfigStore((s) => s.groups)
  const sessions = useSessionStore((s) => s.sessions)
  const detached = useDetachedRemotesStore((s) => s.entries)

  /** User flips only. Everything else is derived, so a session that finishes
   *  restoring while the page is open updates the row it belongs to without
   *  discarding a decision already made. */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  const rowStates = useMemo(() => {
    const map = new Map<string, MultiSpawnRowState>()
    for (const c of configs) map.set(c.id, multiSpawnStartupRowState(c, sessions, detached, autoEnabledIds))
    return map
  }, [configs, sessions, detached, autoEnabledIds])

  const grouped = useMemo(() => groupConfigsForStartup(configs, groups), [configs, groups])
  const resuming = useMemo(() => resumingSessionCount(sessions, detached), [sessions, detached])

  const isChecked = (id: string) => overrides[id] ?? rowStates.get(id)?.enabled ?? false

  const skip = () => {
    // Nothing to write. The migration has already applied (or will), so a skip
    // never loses an enablement — it only declines to make the extra decisions.
    markMultiSpawnIntroSeen()
    onDone()
  }

  const persistAndClose = () => {
    const { updateConfig } = useConfigStore.getState()
    for (const config of configs) {
      const state = rowStates.get(config.id)
      if (!state) continue
      const next = resolveStartupRowSave(isChecked(config.id), state, config.allowMultiSpawn)
      // Only write a row whose stored value actually moves: an untouched
      // never-chosen row must stay `undefined` on disk, not be rewritten with
      // the same value and a fresh save.
      if (next === config.allowMultiSpawn) continue
      updateConfig(config.id, { allowMultiSpawn: next })
    }
    markMultiSpawnIntroSeen()
    onDone()
  }

  return (
    <DialogOverlay style={OPAQUE_BACKDROP} testId="multi-spawn-startup">
      <div className="w-[560px] max-w-[94vw] max-h-full flex flex-col">
        {/* Hero — SetupDialog's first-run pattern: the `>_` brand mark, a real
            <h1> (this page IS the app at this moment, so it owns the h1) and a
            muted subtitle. */}
        <div className="text-center mb-[18px]">
          <div className="text-3xl mb-2 font-mono" style={{ color: 'var(--brand)' }} aria-hidden>&gt;_</div>
          <h1 id="multi-spawn-startup-title" className="text-xl font-bold mb-1.5" style={{ color: 'var(--text-primary)' }}>
            Enable Multi Spawn
          </h1>
          <p className="text-[13px] max-w-[440px] mx-auto" style={{ color: 'var(--text-muted)' }}>
            New in this update: launch several copies of a saved config at once. It&apos;s{' '}
            <b className="font-semibold" style={{ color: 'var(--text-secondary)' }}>off by default</b>{' '}
            so a stray double-launch can&apos;t happen — turn it on only where you want it. You can change this any
            time in a config&apos;s settings.
          </p>
        </div>

        <DialogPanel labelledBy="multi-spawn-startup-title" width="w-full" style={{ maxHeight: '70vh' }}>
          {/* Rendered IF AND ONLY IF something is resuming: with no sessions
              back there are no counts and no auto-enables, so a strip claiming
              they came from somewhere would be claiming it about nothing. */}
          {resuming > 0 && (
            <div
              className="flex items-center gap-[7px] px-[14px] py-[9px] text-[10.5px] shrink-0"
              style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
              data-testid="multi-spawn-startup-resume-note"
            >
              <span style={{ color: 'var(--peach)' }}><ResumeGlyph /></span>
              <span>
                Counts and auto-enabled configs are based on the{' '}
                <b className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {resuming} session{resuming === 1 ? '' : 's'} about to resume
                </b>.
              </span>
            </div>
          )}

          {/* Tighter than the dialog gutter (the canvas's 6/14), set inline
              rather than by a competing padding class — two padding utilities
              on one element are decided by stylesheet order, not class order. */}
          <DialogBody className="flex-1" style={{ padding: '6px 14px' }} testId="multi-spawn-startup-list">
            {grouped.map((group) => (
              <div key={group.id ?? '__ungrouped__'}>
                <div className="flex items-center gap-1 px-1 pt-2 pb-0.5" data-testid="multi-spawn-startup-group" data-group-name={group.name}>
                  <span
                    className="text-[11px] font-semibold uppercase tracking-[0.05em]"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {group.name}
                  </span>
                </div>
                {group.configs.map((config) => (
                  <StartupConfigRow
                    key={config.id}
                    config={config}
                    state={rowStates.get(config.id)!}
                    checked={isChecked(config.id)}
                    onToggle={() => setOverrides((prev) => ({ ...prev, [config.id]: !isChecked(config.id) }))}
                  />
                ))}
              </div>
            ))}
          </DialogBody>

          <div className="px-[14px] pt-2.5 shrink-0">
            <DialogCallout tone="info" testId="multi-spawn-startup-note">
              <b className="font-semibold" style={{ color: 'var(--text-primary)' }}>Skipping is safe.</b> Any config
              that already has several copies running or resumable gets Multi Spawn enabled automatically — with or
              without this page.
            </DialogCallout>
          </div>

          <DialogFooter
            left={
              <span className="text-[10.5px] min-w-0" style={{ color: 'var(--text-muted)' }}>
                Per config · change any time in the config&apos;s settings
              </span>
            }
          >
            <DialogButton variant="secondary" onClick={skip} testId="multi-spawn-startup-skip">
              Skip for now
            </DialogButton>
            <DialogButton variant="primary" autoFocus onClick={persistAndClose} testId="multi-spawn-startup-continue">
              Continue
            </DialogButton>
          </DialogFooter>
        </DialogPanel>
      </div>
    </DialogOverlay>
  )
}
