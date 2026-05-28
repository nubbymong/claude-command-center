// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { ShortcutRow } from '../../../src/renderer/components/SettingsPage'

describe('Settings shortcuts use Kbd (U5.2)', () => {
  it('renders shortcut keys with the Kbd JetBrains Mono treatment', () => {
    const html = renderToStaticMarkup(<ShortcutRow keys="Ctrl+1-9" action="Jump" />)
    expect(html).toContain('JetBrains Mono')
  })
})
