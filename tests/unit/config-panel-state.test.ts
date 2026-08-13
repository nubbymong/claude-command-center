import { describe, it, expect } from 'vitest'
import {
  overrideAfterPinChange,
  resolveConfigPanelExpanded,
  toggleConfigPanel,
  type ConfigPanelOverride
} from '../../src/renderer/components/sidebar/configPanelState'

// #217: a pinned Saved Configs panel was invisible after launch until the user
// unpinned and re-pinned it. The panel's height read the LOCAL `configPanelOpen`
// (reset on every mount) while the pin was PERSISTED, so a restored pin rendered
// with the pin lit, aria-expanded="true", and maxHeight 0.

describe('resolveConfigPanelExpanded', () => {
  it('THE BUG: a restored pin is expanded with no session override', () => {
    // First mount after launch: local state is null, the setting says pinned.
    expect(resolveConfigPanelExpanded(null, true)).toBe(true)
  })

  it('is collapsed when not pinned and untouched', () => {
    expect(resolveConfigPanelExpanded(null, false)).toBe(false)
  })

  it('survives the async-hydration ordering that defeats useState(pinned)', () => {
    // Settings hydrate AFTER mount. Seeding useState from the setting would latch
    // the pre-hydration value forever; the derived default re-evaluates, so the
    // same override produces the right answer on both sides of hydration.
    const override: ConfigPanelOverride = null
    expect(resolveConfigPanelExpanded(override, false)).toBe(false) // before
    expect(resolveConfigPanelExpanded(override, true)).toBe(true)   // after
  })

  it('lets an explicit choice beat the pin in both directions', () => {
    expect(resolveConfigPanelExpanded(false, true)).toBe(false) // collapsed while pinned
    expect(resolveConfigPanelExpanded(true, false)).toBe(true)  // hover-opened while unpinned
  })
})

describe('toggleConfigPanel', () => {
  it('collapses a pinned panel — pinned must not mean stuck open', () => {
    // The old handler refused to toggle whenever pinned.
    expect(toggleConfigPanel(null, true)).toBe(false)
  })

  it('re-expands a collapsed pinned panel', () => {
    expect(toggleConfigPanel(false, true)).toBe(true)
  })

  it('opens an untouched unpinned panel', () => {
    expect(toggleConfigPanel(null, false)).toBe(true)
  })

  it('always yields a concrete boolean, never null', () => {
    for (const override of [null, true, false] as ConfigPanelOverride[]) {
      for (const pinned of [true, false]) {
        expect(typeof toggleConfigPanel(override, pinned)).toBe('boolean')
      }
    }
  })
})

describe('overrideAfterPinChange', () => {
  it('clears the override so the new pin value decides', () => {
    expect(overrideAfterPinChange()).toBeNull()
    expect(resolveConfigPanelExpanded(overrideAfterPinChange(), true)).toBe(true)
  })

  it('does not let a stale collapse defeat a fresh pin', () => {
    // Collapse while pinned, unpin, then re-pin. Forcing `true` on pin would look
    // fine here, but keeping the stale `false` would reproduce the original
    // symptom: the pin lights up and nothing appears.
    let override: ConfigPanelOverride = toggleConfigPanel(null, true) // false
    expect(override).toBe(false)
    override = overrideAfterPinChange()
    expect(resolveConfigPanelExpanded(override, true)).toBe(true)
  })
})
