// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { Section } from '../../../src/renderer/components/SettingsPage'

describe('Settings Section helper (U5.1)', () => {
  it('uses --surface-raised, not bg-surface0', () => {
    const html = renderToStaticMarkup(<Section title="X" icon={null}>body</Section>)
    expect(html).toContain('--surface-raised')
  })
})
