// The x-ray hover mode itself (#367): what each mode means, and that the choice
// survives as a PER-USER setting rather than as canvas state.
//
// The persistence half drives the REAL settings store and the REAL hydrate(),
// with only the config writer stubbed — the failure this is here to catch is a
// preference that looks right in the pane and is gone on the next launch, and a
// re-spread of hydrate() in the test would never catch it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const saveConfigNow = vi.fn(async () => true)
vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: (...a: unknown[]) => saveConfigNow(...(a as [])) }))

import {
  CANVAS_XRAY_MODES,
  CANVAS_XRAY_MODE_OPTIONS,
  resolveCanvasXrayMode,
  xrayClickSelects,
  xrayDrawsOnPage,
  xrayHoverIsLive,
  xrayHoverResolves,
  xrayReadsOutInPanel,
} from '../../../src/renderer/canvas/xray-mode'
import { useSettingsStore, DEFAULT_SETTINGS } from '../../../src/renderer/stores/settingsStore'

beforeEach(() => {
  saveConfigNow.mockClear()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
})

describe('resolveCanvasXrayMode', () => {
  it('round-trips all three modes', () => {
    for (const mode of CANVAS_XRAY_MODES) expect(resolveCanvasXrayMode(mode)).toBe(mode)
  })

  it('falls back to ON for an absent value — an install that predates the setting is unchanged', () => {
    expect(resolveCanvasXrayMode(undefined)).toBe('on')
    expect(resolveCanvasXrayMode(null)).toBe('on')
  })

  it('falls back to ON for anything a hand-edited or corrupt config might hold', () => {
    // Deliberately not "fail closed to off": a mode that silently disables the
    // feature leaves the user hunting for a switch they cannot see the effect of.
    for (const v of ['stealthy', 'On', 'OFF', '', 0, 1, true, false, {}, []] as unknown[]) {
      expect(resolveCanvasXrayMode(v), String(v)).toBe('on')
    }
  })

  it('offers exactly the three modes, off first, in the order the header shows them', () => {
    expect(CANVAS_XRAY_MODE_OPTIONS.map((o) => o.value)).toEqual(['off', 'stealth', 'on'])
    for (const o of CANVAS_XRAY_MODE_OPTIONS) expect(o.title.length).toBeGreaterThan(20)
  })
})

describe('what each mode does', () => {
  it('OFF resolves nothing, draws nothing, reads out nothing, and selects nothing on click', () => {
    expect(xrayHoverIsLive('off')).toBe(false)
    expect(xrayDrawsOnPage('off')).toBe(false)
    expect(xrayReadsOutInPanel('off')).toBe(false)
    // The design point the issue left open, pinned so a later "temporarily arms
    // a note" is a deliberate change and not a drift.
    expect(xrayClickSelects('off')).toBe(false)
  })

  it('STEALTH resolves and reads out in the panel, but draws nothing on the page', () => {
    expect(xrayHoverIsLive('stealth')).toBe(true)
    expect(xrayDrawsOnPage('stealth')).toBe(false)
    expect(xrayReadsOutInPanel('stealth')).toBe(true)
    expect(xrayClickSelects('stealth')).toBe(true)
  })

  it('ON is what shipped: resolved and drawn on the page, nothing in the panel', () => {
    expect(xrayHoverIsLive('on')).toBe(true)
    expect(xrayDrawsOnPage('on')).toBe(true)
    expect(xrayReadsOutInPanel('on')).toBe(false)
    expect(xrayClickSelects('on')).toBe(true)
  })

  it('exactly one mode draws on the page, and only a drawing-free mode reads out', () => {
    expect(CANVAS_XRAY_MODES.filter(xrayDrawsOnPage)).toEqual(['on'])
    for (const mode of CANVAS_XRAY_MODES) {
      if (xrayReadsOutInPanel(mode)) expect(xrayDrawsOnPage(mode)).toBe(false)
      if (!xrayHoverIsLive(mode)) expect(xrayReadsOutInPanel(mode)).toBe(false)
    }
  })
})

describe('the mode is remembered per USER', () => {
  it('is unset by default, which reads as ON', () => {
    expect(DEFAULT_SETTINGS.canvasXrayMode).toBeUndefined()
    expect(resolveCanvasXrayMode(useSettingsStore.getState().settings.canvasXrayMode)).toBe('on')
  })

  it('writes the chosen mode to the settings config, not to canvas state', async () => {
    await useSettingsStore.getState().updateSettings({ canvasXrayMode: 'stealth' })
    expect(useSettingsStore.getState().settings.canvasXrayMode).toBe('stealth')
    expect(saveConfigNow).toHaveBeenCalledTimes(1)
    const [key, data] = saveConfigNow.mock.calls[0] as unknown as [string, { canvasXrayMode?: string }]
    // The `settings` config is the per-user one; a per-canvas store would have
    // put this somewhere the next canvas could not see it.
    expect(key).toBe('settings')
    expect(data.canvasXrayMode).toBe('stealth')
  })

  it('round-trips every mode through the store', async () => {
    for (const mode of CANVAS_XRAY_MODES) {
      await useSettingsStore.getState().updateSettings({ canvasXrayMode: mode })
      expect(resolveCanvasXrayMode(useSettingsStore.getState().settings.canvasXrayMode)).toBe(mode)
    }
  })

  // Plan hover gate (owner 2026-08-31): a PLAN corrupts/flashes on live hover
  // resolution, so it resolves no hover regardless of mode — but a click still
  // selects (note anchoring), and NON-plan surfaces are untouched.
  it('xrayHoverResolves: a plan never resolves hover, in any mode', () => {
    for (const m of CANVAS_XRAY_MODES) {
      expect(xrayHoverResolves(m, { isPlan: true })).toBe(false)
    }
  })
  it('xrayHoverResolves: a non-plan surface follows the mode (unchanged behaviour)', () => {
    expect(xrayHoverResolves('off')).toBe(false)
    expect(xrayHoverResolves('stealth')).toBe(true)
    expect(xrayHoverResolves('on')).toBe(true)
    expect(xrayHoverResolves('stealth', { isPlan: false })).toBe(true)
  })
  it('xrayHoverResolves: click-select is independent — a plan still selects on click', () => {
    // The plan gate touches hover only; xrayClickSelects is unchanged, so a
    // click still anchors a note on a plan.
    expect(xrayClickSelects('stealth')).toBe(true)
  })

  it('survives hydrate() — the mode is read back from a stored config on next launch', () => {
    useSettingsStore.getState().hydrate({ canvasXrayMode: 'off' } as never)
    expect(resolveCanvasXrayMode(useSettingsStore.getState().settings.canvasXrayMode)).toBe('off')
    // A genuine merge, not a wholesale replacement.
    expect(useSettingsStore.getState().settings.defaultModel).toBe(DEFAULT_SETTINGS.defaultModel)
  })

  it('hydrating a config that predates the setting leaves it ON', () => {
    useSettingsStore.getState().hydrate({} as never)
    expect(resolveCanvasXrayMode(useSettingsStore.getState().settings.canvasXrayMode)).toBe('on')
  })

  it('hydrating a corrupt stored value reads as ON rather than a broken mode', () => {
    useSettingsStore.getState().hydrate({ canvasXrayMode: 'x-ray' } as never)
    expect(resolveCanvasXrayMode(useSettingsStore.getState().settings.canvasXrayMode)).toBe('on')
  })
})
