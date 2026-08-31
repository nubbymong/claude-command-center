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
 * ENABLE-ONLY and idempotent by construction — a config that already carries
 * the flag is filtered out before it is even counted, so the migration can
 * never turn the setting off, and re-running it costs one pass over a handful
 * of records. That is why it needs no one-shot "migrated" flag: it simply runs
 * every start and finds nothing to do.
 */
export function configsToEnableMultiSpawn(
  configs: ReadonlyArray<CountableConfig>,
  sessions: ReadonlyArray<CountableSession>,
  detached: ReadonlyArray<DetachedRemote>,
): string[] {
  return configs
    .filter((c) => c.allowMultiSpawn !== true && multiSpawnCopyCount(c, sessions, detached) > 1)
    .map((c) => c.id)
}
