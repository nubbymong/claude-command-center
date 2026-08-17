// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { Section } from '../../../src/renderer/components/SettingsPage'

// Settings visual consistency: every settings card is the shared `.settings-card`
// surface (blue-tinted --surface-raised + --border-subtle, defined once in
// styles.css), so tabs no longer diverge between --surface-raised, bg-surface0/30
// and the GitHub tab's bg-mantle. The token lives in the class now, not inline.
describe('Settings Section helper (U5.1)', () => {
  it('uses the shared .settings-card surface, not a per-tab bg-surface0/mantle', () => {
    const html = renderToStaticMarkup(<Section title="X" icon={null}>body</Section>)
    expect(html).toContain('settings-card')
    expect(html).not.toContain('bg-surface0')
    expect(html).not.toContain('bg-mantle')
  })
  it('draws its header divider with the shared .settings-divider token', () => {
    const html = renderToStaticMarkup(<Section title="X" icon={null}>body</Section>)
    expect(html).toContain('settings-divider')
  })
})
