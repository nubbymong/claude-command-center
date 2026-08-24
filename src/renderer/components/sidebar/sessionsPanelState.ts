// Sessions panel — the pure half of the two-mode left panel (canvas design
// pass 2026-08-24; supersedes the #362 cards/find views).
//
// The owner's agreed design: the whole left panel switches between two tabs —
// Saved (the launcher) and Running (live sessions). Quick Start is a
// collapsible, LAUNCH-ONLY strip at the top of Running fed by `pinned`
// configs; a pinned config whose session is live simply is not shown there
// until it closes (that is what killed the old duplicate-pinned-at-top bug).
// In Saved, a config with a live session stays visible but LOCKED — greyed,
// not editable, click jumps to the session — so a running config can never be
// edited by accident.
//
// Everything decidable without a DOM lives here so it unit-tests flat.
// Running detection reuses runningConfigIds from savedConfigsView.ts.

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

/**
 * The Quick Start strip: pinned configs WITHOUT a live session, in config
 * order. Launch-only by design — a pinned config that is running is omitted
 * entirely (it lives in the sessions list just below) and returns when its
 * session closes. Existing `pinned` flags carry over as Quick Start pins
 * (plan Q2): the field is reused, so there is no data migration.
 */
export function quickStartConfigs(
  configs: ReadonlyArray<TerminalConfig>,
  running: ReadonlySet<string>,
): TerminalConfig[] {
  return configs.filter((c) => !!c.pinned && !running.has(c.id))
}

/** How many pinned configs are hidden from Quick Start because they run now. */
export function quickStartRunningCount(
  configs: ReadonlyArray<TerminalConfig>,
  running: ReadonlySet<string>,
): number {
  return configs.filter((c) => !!c.pinned && running.has(c.id)).length
}

/**
 * Whether a config may be EDITED (or deleted) right now. A config with a live
 * session is locked — the dialog writes template fields the session already
 * consumed at spawn, so an edit mid-run is at best confusing and at worst a
 * divergence between what runs and what is saved. The row's affordance for a
 * locked config is "jump to session", not the editor.
 */
export function canEditConfig(configId: string, running: ReadonlySet<string>): boolean {
  return !running.has(configId)
}

/**
 * The pin/unpin label for the context menus (config row AND running session
 * row — both pin the underlying config). `running` only changes the HINT the
 * menu shows, never the action: pinning a running config is allowed and takes
 * effect in Quick Start when the session closes.
 */
export function pinMenuLabel(pinned: boolean | undefined): string {
  return pinned ? 'Unpin from Quick Start' : 'Pin to Quick Start'
}

/** The hint under the pin item when the config's session is live. */
export const PIN_WHILE_RUNNING_HINT = 'Running now — will quick-start when this session closes'

/**
 * Launch-all targets for a GROUP: its configs minus anything already running.
 * Launch-all must never spawn the duplicate the locked row exists to prevent
 * (the retired cards/find views filtered the same way via launchAllTargets).
 */
export function launchableInGroup(
  configs: ReadonlyArray<TerminalConfig>,
  groupId: string,
  running: ReadonlySet<string>,
): TerminalConfig[] {
  return configs.filter((c) => c.groupId === groupId && !running.has(c.id))
}

/**
 * Launch-all targets for a SECTION: configs in its groups plus its loose
 * configs, minus anything already running.
 */
export function launchableInSection(
  configs: ReadonlyArray<TerminalConfig>,
  groups: ReadonlyArray<ConfigGroup>,
  sectionId: string,
  running: ReadonlySet<string>,
): TerminalConfig[] {
  const sectionGroupIds = new Set(groups.filter((g) => g.sectionId === sectionId).map((g) => g.id))
  return configs.filter((c) => {
    if (running.has(c.id)) return false
    if (c.groupId && sectionGroupIds.has(c.groupId)) return true
    if (!c.groupId && c.sectionId === sectionId) return true
    return false
  })
}
