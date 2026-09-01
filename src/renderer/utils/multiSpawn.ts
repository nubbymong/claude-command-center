/**
 * Allow Multi Spawn — the pure half (phase 4).
 *
 * A saved config is a template, but by default it runs ONE copy at a time: a
 * launch is refused while any session of that config is live. `allowMultiSpawn`
 * opts a config out of that rule and turns its row's start button into the ×N
 * spawn control.
 *
 * Everything decidable without a DOM or a store lives here so it unit-tests
 * flat: the count clamp/step the ×N control uses, and the START-UP MIGRATION
 * that grandfathers configs which demonstrably already run several copies.
 *
 * The blocking RULE itself lives beside `isConfigLaunchBlocked` in
 * hooks/useLaunchConfig.ts — one source of truth for every launch surface AND
 * for the launch action's own backstop.
 */
import type { DetachedRemote } from '../../shared/types'
import type { TerminalConfig } from '../stores/configStore'
import { matchDetachedRemotes, filterLiveEntries } from './detachedRemotes'

/**
 * `allowMultiSpawn` is TRI-STATE on disk, and the third state is the point:
 *
 *   undefined — never chosen. The startup migration may turn it on.
 *   true      — on.
 *   false     — EXPLICITLY DECLINED. The migration must never touch it.
 *
 * Without the third state the migration eats the user's decision: it enables a
 * config that has two copies live, the user opens the editor and turns it back
 * off, an opt-in-only save writes `undefined`, and the next start sees two
 * copies again and re-enables it — every start, until a copy happens to exit.
 *
 * This is the dialog's save rule. Ticked stores `true`. Unticked stores `false`
 * whenever the config ALREADY carried a decision (it was on, or it was already
 * a decline) — turning off something that was on is a decline, and a standing
 * decline must survive an unrelated edit. Unticked on a config that never had
 * the field keeps storing `undefined`, so configs that predate the feature stay
 * clean and stay eligible for grandfathering.
 */
export function resolveAllowMultiSpawnOnSave(
  checked: boolean,
  previous: boolean | undefined,
): boolean | undefined {
  if (checked) return true
  return previous === undefined ? undefined : false
}

/** What the ×N control shows the first time it appears (the approved mockup). */
export const MULTI_SPAWN_DEFAULT_COUNT = 2
export const MULTI_SPAWN_MIN_COUNT = 1
export const MULTI_SPAWN_MAX_COUNT = 9

/**
 * The per-config copy count, defensively resolved. Absent, non-numeric or
 * out-of-range (an older file, a hand edit) => the default or the nearest
 * bound — a bad stored value must never spawn an unbounded number of sessions.
 */
export function resolveMultiSpawnCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MULTI_SPAWN_DEFAULT_COUNT
  return Math.max(MULTI_SPAWN_MIN_COUNT, Math.min(MULTI_SPAWN_MAX_COUNT, Math.round(value)))
}

/** The ▾ step: 1 → 2 → … → 9 → 1. Wraps, so the control never dead-ends. */
export function stepMultiSpawnCount(value: unknown): number {
  const current = resolveMultiSpawnCount(value)
  return current >= MULTI_SPAWN_MAX_COUNT ? MULTI_SPAWN_MIN_COUNT : current + 1
}

/** The needs-Multi-Spawn popover's fixed width (the approved mockup's qtip). */
export const MULTI_SPAWN_POPOVER_WIDTH = 238
/** Height budget used only to decide above/below — the real box is measured by
 *  the browser; this just has to be in the right ballpark. */
const POPOVER_HEIGHT_BUDGET = 116
const POPOVER_GAP = 6
const VIEWPORT_MARGIN = 8

export interface PopoverAnchor { top: number; right: number; bottom: number }
export interface PopoverPlacement { left: number; top: number; above: boolean }

/**
 * Where to park the popover for an anchor rect, in VIEWPORT coordinates (it is
 * rendered `position: fixed`, the same escape hatch ConfigContextMenu uses, so
 * the sidebar's `overflow-y-auto` cannot clip it).
 *
 * Right-aligned to the anchor like the mockup, clamped into the viewport on
 * both axes, and flipped ABOVE the anchor when there is no room below — a
 * config row near the bottom of a full list is the common case, not the edge
 * case. Pure, so the placement is unit-testable without a layout engine.
 */
export function placeMultiSpawnPopover(
  anchor: PopoverAnchor,
  viewport: { width: number; height: number },
): PopoverPlacement {
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - MULTI_SPAWN_POPOVER_WIDTH - VIEWPORT_MARGIN)
  const left = Math.min(maxLeft, Math.max(VIEWPORT_MARGIN, anchor.right - MULTI_SPAWN_POPOVER_WIDTH))
  const below = anchor.bottom + POPOVER_GAP
  const fitsBelow = below + POPOVER_HEIGHT_BUDGET <= viewport.height - VIEWPORT_MARGIN
  if (fitsBelow) return { left, top: below, above: false }
  return {
    left,
    top: Math.max(VIEWPORT_MARGIN, anchor.top - POPOVER_GAP - POPOVER_HEIGHT_BUDGET),
    above: true,
  }
}

/** The session fields the migration counter reads — a narrow view so this
 *  module never depends on the full store record. */
export type CountableSession = { id: string; configId?: string; kind?: string }

/** The config fields the migration counter reads. */
export type CountableConfig = Pick<TerminalConfig, 'id' | 'sessionType' | 'sshConfig' | 'allowMultiSpawn'>

/**
 * How many copies of this config exist right now: live sessions launched from
 * it PLUS detached remotes in the registry that would reattach to it. The
 * registry is filtered against the live ids first (`filterLiveEntries`) so a
 * restored session that is BOTH live and still registered counts once, not
 * twice. The Ask Conductor session is config-less and skipped, exactly as in
 * `runningConfigCounts`.
 */
export function multiSpawnCopyCount(
  config: CountableConfig,
  sessions: ReadonlyArray<CountableSession>,
  detached: ReadonlyArray<DetachedRemote>,
): number {
  const live = sessions.filter((s) => s.kind !== 'ask' && !!s.configId && s.configId === config.id)
  const liveIds = new Set(sessions.map((s) => s.id))
  const remotes = filterLiveEntries(matchDetachedRemotes([...detached], config), liveIds)
  return live.length + remotes.length
}

/**
 * The startup migration's decision: the ids of configs that demonstrably run
 * MORE THAN ONE copy but are not yet marked Allow Multi Spawn.
 *
 * ENABLE-ONLY and idempotent by construction — a config that already carries a
 * decision is filtered out before it is even counted, so the migration can
 * never turn the setting off, and re-running it costs one pass over a handful
 * of records. That is why it needs no one-shot "migrated" flag: it simply runs
 * every start and finds nothing to do.
 *
 * The filter is `=== undefined`, NOT `!== true`, and that difference is the
 * whole of phase 4.1: an explicit `false` is a user who turned this OFF, and
 * `!== true` would re-enable it on every start for as long as two copies
 * happened to be live. Only a config that has never been asked is grandfathered.
 */
export function configsToEnableMultiSpawn(
  configs: ReadonlyArray<CountableConfig>,
  sessions: ReadonlyArray<CountableSession>,
  detached: ReadonlyArray<DetachedRemote>,
): string[] {
  return configs
    .filter((c) => c.allowMultiSpawn === undefined && multiSpawnCopyCount(c, sessions, detached) > 1)
    .map((c) => c.id)
}

// ── The post-install startup page (phase 5) ──────────────────────────────────

/**
 * How many sessions this start is bringing back: restored sessions plus detached
 * remotes still waiting in the registry.
 *
 * Counted exactly as `multiSpawnCopyCount` counts one config's copies — the Ask
 * Conductor session is config-less and skipped, and a remote whose session is
 * already live counts ONCE, not twice — because this number is the page's claim
 * about where its per-row counts came from. If the two disagreed, the strip
 * would say "based on 3 sessions" over rows that add up to four.
 *
 * Zero means the page shows no strip, no chips and no counts: with nothing
 * resuming there is nothing for them to be derived FROM.
 */
export function resumingSessionCount(
  sessions: ReadonlyArray<CountableSession>,
  detached: ReadonlyArray<DetachedRemote>,
): number {
  const live = sessions.filter((s) => s.kind !== 'ask')
  const liveIds = new Set(sessions.map((s) => s.id))
  return live.length + filterLiveEntries([...detached], liveIds).length
}

/** One row of the startup page, decided from the stored value and the copies found. */
export interface MultiSpawnRowState {
  /** Copies found right now: live sessions + resumable remotes. */
  count: number
  /** Where the toggle starts — the EFFECTIVE value, not the stored one. */
  enabled: boolean
  /** The migration turned this on (or is about to) — drives the green chip. */
  auto: boolean
}

/**
 * The startup page's initial state for one config — the "effective" value, which
 * is the stored one only when the migration has nothing to say.
 *
 * Three inputs, and each off-state means something different:
 *
 *   stored `true`       → ON. The chip appears only if THIS START's migration is
 *                         what turned it on (`autoEnabledIds`); a config the user
 *                         switched on last week is not an automatic enable.
 *   stored `undefined`  → the migration's own predicate decides. More than one
 *                         copy found ⇒ ON + chip, because the App-level migration
 *                         will write exactly that within a frame or two; the page
 *                         must not show OFF for a row that is about to be ON.
 *   stored `false`      → OFF, and NEVER a chip, however many copies are live.
 *                         That is a decline, and the migration has already
 *                         promised not to touch it (phase 4.1) — a page that
 *                         re-enabled it here would break the same promise one
 *                         surface later.
 *
 * Anything else stored (a hand-edited `"yes"`) fails closed to OFF, matching
 * both the launch rule and the migration filter.
 *
 * The chip is withheld when the count has since dropped to one — a copy exited
 * between the migration writing and the page mounting. The row stays ON (the
 * write happened) but "auto · 1 copies found" would be a lie.
 */
export function multiSpawnStartupRowState(
  config: CountableConfig,
  sessions: ReadonlyArray<CountableSession>,
  detached: ReadonlyArray<DetachedRemote>,
  autoEnabledIds: ReadonlyArray<string> = [],
): MultiSpawnRowState {
  const count = multiSpawnCopyCount(config, sessions, detached)
  const stored = config.allowMultiSpawn
  if (stored === true) {
    return { count, enabled: true, auto: autoEnabledIds.includes(config.id) && count > 1 }
  }
  if (stored === undefined) {
    const wouldEnable = count > 1
    return { count, enabled: wouldEnable, auto: wouldEnable }
  }
  return { count, enabled: false, auto: false }
}

/**
 * What to store for one row when the user presses Continue.
 *
 * The `previous` handed to `resolveAllowMultiSpawnOnSave` is the EFFECTIVE value,
 * not the stored one, and that substitution is the whole point: an auto-enabled
 * row still holds `undefined` on disk, so passing the stored value would resolve
 * an un-tick to `undefined` — "never chosen" — and the migration would switch it
 * straight back on at the next start. Turning off something that is ON is a
 * decline whether the user or the migration put it there.
 */
export function resolveStartupRowSave(
  checked: boolean,
  row: MultiSpawnRowState,
  stored: boolean | undefined,
): boolean | undefined {
  return resolveAllowMultiSpawnOnSave(checked, row.enabled ? true : stored)
}
