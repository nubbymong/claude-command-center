// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { CloudRail } from '../../../src/renderer/components/CloudAgentsPage'

describe('Agent Hub rail (U6.4)', () => {
  it('renders the active tab with --accent token', () => {
    const html = renderToStaticMarkup(<CloudRail hubTab="tasks" onChange={() => {}} />)
    expect(html).toContain('--accent')
  })

  it('does not use the old sapphire palette for the active tab', () => {
    const html = renderToStaticMarkup(<CloudRail hubTab="tasks" onChange={() => {}} />)
    expect(html).not.toContain('bg-sapphire/15')
    expect(html).not.toContain('text-sapphire')
  })
})
