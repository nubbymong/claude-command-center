// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { Toggle } from '../../../src/renderer/components/SettingsPage'

describe('Settings Toggle uses --status-success when on (U5.3)', () => {
  it('uses --status-success when on', () => {
    const html = renderToStaticMarkup(<Toggle on={true} onClick={() => {}} />)
    expect(html).toContain('--status-success')
  })
  it('uses --surface-overlay when off', () => {
    const html = renderToStaticMarkup(<Toggle on={false} onClick={() => {}} />)
    expect(html).toContain('--surface-overlay')
  })
})
