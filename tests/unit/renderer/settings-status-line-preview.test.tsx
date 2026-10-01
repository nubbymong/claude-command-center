// @vitest-environment jsdom
/**
 * P3.16a (U3): the Status Line settings' Live Preview shows every value at any
 * window width.
 *
 * The mock status line's first row is one flex row of nine values (model, effort,
 * account, tokens, context bar, cost, lines added, lines removed, duration)
 * with 12px gaps: more than the column the Settings page gives it, which is
 * capped at max-w-3xl (768px) less 20px of page padding and 16px of card
 * padding on each side, 696px, at a 1600px window and at every width above
 * about 1200px, and less below it. The preview sits in an overflow-hidden
 * rounded box, so what did not fit was clipped: the last value (the duration)
 * was cut off. Each row now wraps, and each value stays whole.
 *
 * jsdom does no layout, so the test pins the rule that makes it fit: a row that
 * can wrap, whose values do not break inside themselves, with no fixed width or
 * overflow of its own.
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { StatusLinePreview } from '../../../src/renderer/components/SettingsPage'
import { DEFAULT_STATUS_LINE } from '../../../src/renderer/stores/settingsStore'

function previewDom(): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<StatusLinePreview sl={DEFAULT_STATUS_LINE} />)
  return host
}

describe('Settings, Status Line: the Live Preview (P3.16a, U3)', () => {
  it('draws both rows of the mock status line, ending with the duration and the reset time', () => {
    const host = previewDom()
    const rows = host.querySelectorAll('[data-testid="status-line-preview-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('3m 42s')
    expect(rows[1].textContent).toContain('resets 2h 14m')
  })

  it('every row wraps and keeps each value whole, so nothing runs past the box that clips it', () => {
    const host = previewDom()
    const rows = [...host.querySelectorAll('[data-testid="status-line-preview-row"]')]
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      const classes = row.className.split(/\s+/)
      expect(classes, row.className).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'whitespace-nowrap']))
      // Nothing that would fix the row's width or hide what overflows it.
      expect(classes.filter((c) => /^(w-|min-w-|max-w-|overflow-|truncate$|shrink-0$)/.test(c)), row.className).toEqual([])
    }
  })
})
