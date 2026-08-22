/**
 * Settings -> General carries the ONE Saved Configs layout choice (#362) and
 * writes it through the same `save` path as its neighbours, so it round-trips
 * like every other setting. Source-level: SettingsPage needs the whole app
 * shell to mount, and the behaviour under test is the wiring, not the markup.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { SAVED_CONFIGS_VIEW_OPTIONS } from '../../../src/renderer/components/sidebar/savedConfigsView'

const src = readFileSync(resolve(__dirname, '../../../src/renderer/components/SettingsPage.tsx'), 'utf8')

describe('Settings: Saved Configs layout', () => {
  it('offers the three layouts from one list, list first', () => {
    expect(SAVED_CONFIGS_VIEW_OPTIONS.map((o) => o.value)).toEqual(['list', 'cards', 'find'])
    expect(src).toContain('SAVED_CONFIGS_VIEW_OPTIONS.map')
  })
  it('reads through resolveSavedConfigsView and saves savedConfigsView', () => {
    expect(src).toMatch(/value=\{resolveSavedConfigsView\(settings\.savedConfigsView\)\}/)
    expect(src).toMatch(/save\(\{ savedConfigsView: e\.target\.value as SavedConfigsView \}\)/)
  })
  it('sits in the General section next to the other sidebar settings', () => {
    const ask = src.indexOf('Show Ask Conductor')
    const select = src.indexOf('data-ux-id="settings-saved-configs-view"')
    const security = src.indexOf('<Section title="Security"')
    expect(ask).toBeGreaterThan(-1)
    expect(select).toBeGreaterThan(ask)
    expect(select).toBeLessThan(security)
  })
})
