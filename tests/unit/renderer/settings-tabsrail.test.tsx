// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { TabsRail } from '../../../src/renderer/components/SettingsPage'

// Settings visual consistency: the active tab uses the app's ONE interactive
// accent (blue, --color-blue) — the same accent as the toggles, segmented
// controls, links and native controls — not the teal --accent it used before.
describe('Settings tabs rail (U5.4)', () => {
  it('renders the active tab with the unified blue accent (--color-blue)', () => {
    const html = renderToStaticMarkup(<TabsRail activeTab="general" onChange={() => {}} />)
    expect(html).toContain('--color-blue')
    expect(html).not.toContain('--accent')
  })

  it('does not use Tailwind bg-blue/text-blue utilities for the active tab (inline var, theme-aware)', () => {
    const html = renderToStaticMarkup(<TabsRail activeTab="general" onChange={() => {}} />)
    expect(html).not.toContain('bg-blue/15')
    expect(html).not.toContain('text-blue')
  })
})
