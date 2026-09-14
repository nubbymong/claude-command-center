/**
 * Settings -> General carries the ONE Sessions-panel choice — the default tab
 * (design pass 2026-08-24, supersedes the #362 layout picker) — and writes it
 * through the same `save` path as its neighbours, so it round-trips like
 * every other setting. Source-level: SettingsPage needs the whole app shell
 * to mount, and the behaviour under test is the wiring, not the markup.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const src = readFileSync(resolve(__dirname, '../../../src/renderer/components/SettingsPage.tsx'), 'utf8')

describe('Settings: Sessions panel default tab', () => {
  it('offers Running (the default) and Saved', () => {
    expect(src).toMatch(/option value="running"/)
    expect(src).toMatch(/option value="saved"/)
    // Running is listed first — it is the absent-value default (plan Q1).
    expect(src.indexOf('option value="running"')).toBeLessThan(src.indexOf('option value="saved"'))
  })
  it('reads through resolveDefaultPanelTab and saves sessionsPanelDefaultTab', () => {
    expect(src).toMatch(/value=\{resolveDefaultPanelTab\(settings\.sessionsPanelDefaultTab\)\}/)
    expect(src).toMatch(/save\(\{ sessionsPanelDefaultTab: e\.target\.value as PanelTab \}\)/)
  })
  it('sits in the General section next to the other sidebar settings', () => {
    const ask = src.indexOf('Show Ask Conductor')
    const select = src.indexOf('data-ux-id="settings-sessions-panel-default-tab"')
    const security = src.indexOf('<Section title="Security"')
    expect(ask).toBeGreaterThan(-1)
    expect(select).toBeGreaterThan(ask)
    expect(select).toBeLessThan(security)
  })
  it('the retired #362 layout picker is gone', () => {
    expect(src).not.toContain('savedConfigsView')
    expect(src).not.toContain('SAVED_CONFIGS_VIEW_OPTIONS')
  })
})
