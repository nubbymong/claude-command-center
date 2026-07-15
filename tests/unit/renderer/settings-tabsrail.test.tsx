// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { TabsRail } from '../../../src/renderer/components/SettingsPage'

describe('Settings tabs rail (U5.4)', () => {
  it('renders the active tab with --accent token treatment', () => {
    const html = renderToStaticMarkup(<TabsRail activeTab="general" onChange={() => {}} />)
    expect(html).toContain('--accent')
  })

  it('does not use the old bg-blue palette for the active tab', () => {
    const html = renderToStaticMarkup(<TabsRail activeTab="general" onChange={() => {}} />)
    expect(html).not.toContain('bg-blue/15')
    expect(html).not.toContain('text-blue')
  })
})
