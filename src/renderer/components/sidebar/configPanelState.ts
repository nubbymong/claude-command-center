// Whether the Saved Configs panel is expanded.
//
// Two states with DIFFERENT LIFETIMES drive this, and conflating them was #217:
//
//   configPanelPinned  persisted in settings, restored on launch
//   configPanelOpen    local component state, reset on every mount
//
// The panel's height used to read `configPanelOpen` alone, so a pinned panel came
// back from a restart with the pin lit, `aria-expanded="true"`, and a height of 0 —
// pinned and invisible. Pinning had never actually opened it; the pin handler
// opened it as a side effect, and that side effect does not run when the value is
// restored from disk. Unpin/re-pin was the user manually re-triggering it.
//
// The fix is a DERIVED default with an explicit override rather than seeding the
// local state from the setting. `useState(configPanelPinned)` would capture the
// value at first render, and settings hydrate ASYNCHRONOUSLY AFTER MOUNT, so it
// would latch `false` and the bug would survive. `??` re-evaluates every render, so
// the panel opens by itself the moment the setting arrives — no effect, no race.

/** No explicit user choice yet — fall back to the persisted pin. */
export type ConfigPanelOverride = boolean | null

/**
 * The expanded state actually rendered.
 *
 * `null` override means "the user has not chosen in this session", so a pinned
 * panel is expanded. Once the user collapses or expands it by hand, that choice
 * wins for the rest of the session.
 */
export function resolveConfigPanelExpanded(override: ConfigPanelOverride, pinned: boolean): boolean {
  return override ?? pinned
}

/**
 * The next override when the user clicks the chevron. Always returns a concrete
 * boolean — from here on the user's choice is explicit.
 *
 * Deliberately works while pinned: a pinned panel stays collapsible. The previous
 * code blocked the toggle whenever the panel was pinned, so "pinned" also meant
 * "stuck open".
 */
export function toggleConfigPanel(override: ConfigPanelOverride, pinned: boolean): boolean {
  return !resolveConfigPanelExpanded(override, pinned)
}

/**
 * The next override when the user pins or unpins.
 *
 * Clearing to `null` hands control back to the derived default, so pinning always
 * opens the panel. Forcing `true` instead would look identical until the user had
 * previously collapsed it — then the stale `false` would win and pinning would
 * appear to do nothing, which is the original bug with extra steps.
 */
export function overrideAfterPinChange(): ConfigPanelOverride {
  return null
}
