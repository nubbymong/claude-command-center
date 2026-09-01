// Sessions panel — the pure half of the two-mode left panel (canvas design
// pass 2026-08-24; supersedes the #362 cards/find views).
//
// The owner's agreed design: the whole left panel switches between two tabs —
// Saved (the launcher) and Running (live sessions). Quick Start is a
// collapsible, LAUNCH-ONLY strip at the top of Running fed by `pinned`
// configs.
//
// REVISED (owner, 2026-08-24 rc.1 install pass): a config is a TEMPLATE — a
// running one may be launched AGAIN, spawning another session. The old locked
// row ("a running config cannot relaunch") was wrong by the owner's own call.
// A config with live sessions shows a COUNT indicator instead, and Quick
// Start keeps showing pinned configs while they run (spawn as many as you
// like). What remains guarded: DELETE while sessions run (removing the
// template under live sessions), and group/section launch-all still fills in
// only what is not already running (bring-up semantics — it never doubles a
// whole group silently; doubling is the single row's deliberate act).
//
// Everything decidable without a DOM lives here so it unit-tests flat.
// Running detection reuses runningConfigCounts from savedConfigsView.ts.

import type { TerminalConfig, ConfigGroup } from '../../stores/configStore'

/** The two modes of the left panel. */
export type PanelTab = 'saved' | 'running'

/** Absent or unknown (older settings file, hand edit) => 'running' (plan Q1). */
export function resolveDefaultPanelTab(value: unknown): PanelTab {
  return value === 'saved' ? 'saved' : 'running'
}

/** Absent or unknown => expanded. Only an explicit true collapses. */
export function resolveQuickStartCollapsed(value: unknown): boolean {
  return value === true
}

/** Remote Resumable (SSH Persistent Phase 3), same rule as Quick Start's:
 *  absent or unknown => expanded, only an explicit true collapses. */
export function resolveRemoteResumableCollapsed(value: unknown): boolean {
  return value === true
}

/** Sidebar width bounds (#461). The floor protects ConfigRow's measured
 *  right-12 hover-strip budget and keeps the Saved⇄Running tabs from hitting
 *  min-content overflow (~170px); the ceiling keeps the terminal usable. */
export const SIDEBAR_WIDTH_DEFAULT = 256
export const SIDEBAR_WIDTH_MIN = 200
export const SIDEBAR_WIDTH_MAX = 420

/** Absent, non-numeric, or out-of-range (hand-edited settings) => clamped or
 *  the default — a bad stored value must never wedge the panel off-screen. */
export function resolveSidebarWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(value)))
}

/**
 * The Quick Start strip: every pinned config, in config order, running or
 * not — a config is a template, and Quick Start may spawn another instance
 * at any time (owner revision 2026-08-24). Existing `pinned` flags carry
 * over as Quick Start pins (plan Q2): the field is reused, no migration.
 */
export function quickStartConfigs(configs: ReadonlyArray<TerminalConfig>): TerminalConfig[] {
  return configs.filter((c) => !!c.pinned)
}

/**
 * The reason shown wherever delete is refused for a running config. The
 * guard itself lives at the two surfaces (ConfigRow's disabled button, the
 * context menu's `running` prop) — deleting the template out from under live
 * sessions would strand the Running rows and any relaunch. Editing while
 * running IS allowed: a template edit shapes future launches — with the
 * caveat that a LIVE session restarting after an SSH/terminal edit re-binds
 * against the saved config (SessionDialog warns; see the 2026-08-24 relaunch
 * fragment).
 */
export const DELETE_WHILE_RUNNING_REASON = 'Running — close its sessions before deleting the config'

/**
 * The pin/unpin label for the context menus (config row AND running session
 * row — both pin the underlying config). `running` only changes the HINT the
 * menu shows, never the action.
 */
export function pinMenuLabel(pinned: boolean | undefined): string {
  return pinned ? 'Unpin from Quick Start' : 'Pin to Quick Start'
}

/** The hint under the pin item when the config's session is live. */
export const PIN_WHILE_RUNNING_HINT = 'Running now — Quick Start can spawn another'

/** The running-count pill's accessible/tooltip text. */
export function runningCountLabel(count: number): string {
  return count === 1 ? '1 session running — click to open it' : `${count} sessions running — click to open the latest`
}

// ── Config-row hover strip: where it parks, and what colour it is ──
//
// The strip is absolutely positioned over the row's tail. Two things about it
// were wrong before phase 6, both visible in the signed-off replica's R1/a1
// note: it painted a `from-surface0` GRADIENT (translucent at every stop), so
// the transport badges underneath ghosted through the buttons; and it parked a
// full 40px clear of the running-count pill, leaving a slice of those same
// half-visible badges showing in the gap. The fix is an OPAQUE core parked
// FLUSH against the pill, with a short fade tongue over the label side only.
//
// No jsdom test can measure layout, so the offset is a pure function pinned by
// unit tests and the constants are named — re-measure if the row's padding,
// gap or the pill's type size moves.

/** The opaque composite of the row's hover background (`hover:bg-surface0/50`)
 *  over the sidebar panel. A SOLID colour, not a translucent tint: it is what
 *  stops badges ghosting through the buttons. */
export const HOVER_STRIP_SOLID = 'color-mix(in srgb, var(--color-surface0) 50%, var(--surface-panel))'

/** The label-side fade tongue: width, and the gradient that dissolves the
 *  opaque core into the row so it does not end on a hard edge. */
export const HOVER_STRIP_FADE_PX = 26
export const HOVER_STRIP_FADE = `linear-gradient(to left, ${HOVER_STRIP_SOLID}, transparent)`

/** The row's own right padding (`px-2`) — where the strip parks with nothing
 *  else holding the right edge. */
export const HOVER_STRIP_EDGE_PX = 8
/** The ×N Multi Spawn control (~69px) plus the row's `gap-1.5` (6px). */
export const HOVER_STRIP_SPAWN_PX = 75

/**
 * The running-count pill's rendered width: `px-1.5` either side (6+6) plus
 * ~5px per digit at `text-[8.5px]`. A fixed px type size, so this does not
 * shift with the UI scale — but a 2- or 3-digit count is genuinely wider and
 * the strip has to clear it, which the old flat 40px only did by leaving a gap.
 */
export function countPillWidthPx(count: number): number {
  const digits = String(Math.max(0, Math.trunc(count))).length
  return 12 + Math.max(1, digits) * 5
}

/**
 * How far from the row's right edge the hover strip parks, in px.
 *
 * With nothing at the right edge it sits on the row's padding (8). A count
 * pill and/or the ×N control push it left by exactly their own width, so the
 * strip's right edge lands FLUSH on the left edge of whatever it must not
 * cover — no sliver of badge between them, and the pill stays fully visible
 * and clickable (the opaque core would otherwise swallow the click).
 */
export function hoverStripRightPx(runningCount: number, spawnControlShown: boolean): number {
  return (
    HOVER_STRIP_EDGE_PX +
    (spawnControlShown ? HOVER_STRIP_SPAWN_PX : 0) +
    (runningCount > 0 ? countPillWidthPx(runningCount) : 0)
  )
}

/**
 * Launch-all targets for a GROUP: its configs minus anything already running.
 * Deliberate even now that relaunch is allowed: launch-all is BRING-UP — it
 * fills in what is missing. Doubling a whole group is never what "launch all"
 * meant; spawning a duplicate is the single row's deliberate act.
 */
export function launchableInGroup(
  configs: ReadonlyArray<TerminalConfig>,
  groupId: string,
  running: ReadonlyMap<string, number>,
): TerminalConfig[] {
  return configs.filter((c) => c.groupId === groupId && !running.get(c.id))
}

/**
 * Launch-all targets for a SECTION: configs in its groups plus its loose
 * configs, minus anything already running (same bring-up rule as the group).
 */
export function launchableInSection(
  configs: ReadonlyArray<TerminalConfig>,
  groups: ReadonlyArray<ConfigGroup>,
  sectionId: string,
  running: ReadonlyMap<string, number>,
): TerminalConfig[] {
  const sectionGroupIds = new Set(groups.filter((g) => g.sectionId === sectionId).map((g) => g.id))
  return configs.filter((c) => {
    if (running.get(c.id)) return false
    if (c.groupId && sectionGroupIds.has(c.groupId)) return true
    if (!c.groupId && c.sectionId === sectionId) return true
    return false
  })
}
