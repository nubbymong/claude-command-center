// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { sanitizeMemoryHtml } from '../../../src/renderer/utils/markdownSanitizer'

describe('sanitizeMemoryHtml (memory drawer P2.6)', () => {
  it('keeps the themed memory tags and their class attribute', () => {
    const h = sanitizeMemoryHtml(
      '<h2 class="text-blue">Title</h2><p class="mb-2">body <strong>b</strong> <code>c</code></p>',
    )
    expect(h).toContain('<h2')
    expect(h).toContain('class="text-blue"')
    expect(h).toContain('Title')
    expect(h).toContain('<strong>b</strong>')
    expect(h).toContain('<code>c</code>')
  })

  it('strips <script>', () => {
    expect(sanitizeMemoryHtml('<script>alert(1)</script><p>ok</p>')).not.toContain('<script')
  })

  it('strips inline event handlers and style', () => {
    expect(sanitizeMemoryHtml('<p onclick="bad()">x</p>')).not.toMatch(/onclick/i)
    expect(sanitizeMemoryHtml('<p style="position:fixed">x</p>')).not.toMatch(/style=/i)
  })

  it('drops anchors and images entirely (memory markdown emits neither)', () => {
    expect(sanitizeMemoryHtml('<a href="javascript:alert(1)">x</a>')).not.toMatch(/<a|javascript:/i)
    expect(sanitizeMemoryHtml('<img src=x onerror="alert(1)">')).not.toMatch(/<img|onerror/i)
  })

  it('returns empty string for non-string input', () => {
    expect(sanitizeMemoryHtml(undefined as unknown as string)).toBe('')
  })
})
