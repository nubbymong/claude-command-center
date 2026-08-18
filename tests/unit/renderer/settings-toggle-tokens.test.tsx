// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { Toggle } from '../../../src/renderer/components/SettingsPage'

// Settings visual consistency: the Toggle "on" state uses the app's ONE
// interactive accent (blue, --color-blue), matching the github ToggleSwitch,
// segmented controls and links — not the green --status-success it used before
// (which is now reserved for SEMANTIC success/positive data). Theme-aware.
describe('Settings Toggle uses the unified blue accent when on (U5.3)', () => {
  it('uses --color-blue when on (not the green success token)', () => {
    const html = renderToStaticMarkup(<Toggle on={true} onClick={() => {}} />)
    expect(html).toContain('--color-blue')
    expect(html).not.toContain('--status-success')
  })
  it('uses --surface-overlay when off', () => {
    const html = renderToStaticMarkup(<Toggle on={false} onClick={() => {}} />)
    expect(html).toContain('--surface-overlay')
  })
})
