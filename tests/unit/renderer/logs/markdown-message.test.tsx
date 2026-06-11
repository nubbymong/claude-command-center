// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import MarkdownMessage from '../../../../src/renderer/components/logs/MarkdownMessage'
import { renderTranscriptMarkdown } from '../../../../src/renderer/utils/markdownSanitizer'

describe('renderTranscriptMarkdown', () => {
  it('renders basic markdown like renderCommentMarkdown', () => {
    const h = renderTranscriptMarkdown('**b** and `c`')
    expect(h).toContain('<strong>b</strong>')
    expect(h).toContain('<code>c</code>')
  })
  it('strips <script> (same hardened pipeline)', () => {
    expect(renderTranscriptMarkdown('<script>alert(1)</script>x')).not.toContain('<script')
  })
  it('strips javascript: hrefs', () => {
    expect(renderTranscriptMarkdown('[x](javascript:alert(1))')).not.toMatch(/javascript:/i)
  })
  it('strips <img> entirely (same allowlist — no <img>)', () => {
    expect(renderTranscriptMarkdown('![alt](https://a/b.png)')).not.toMatch(/<img/i)
  })
  it('strips http: links (https only — same allowlist)', () => {
    expect(renderTranscriptMarkdown('[x](http://example.com)')).not.toMatch(/href="http:/i)
  })
  it('returns empty string for non-string input', () => {
    // @ts-expect-error runtime guard
    expect(renderTranscriptMarkdown(null)).toBe('')
    // @ts-expect-error runtime guard
    expect(renderTranscriptMarkdown(undefined)).toBe('')
  })
})

describe('MarkdownMessage', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders markdown (bold) through the sanitizer', () => {
    act(() => root.render(React.createElement(MarkdownMessage, { content: 'hello **world**' })))
    expect(container.querySelector('strong')?.textContent).toBe('world')
  })

  it('strips a <script> tag from untrusted transcript content', () => {
    act(() =>
      root.render(
        React.createElement(MarkdownMessage, { content: 'safe<script>alert(1)</script>' }),
      ),
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.innerHTML).not.toContain('<script')
    expect(container.textContent).toContain('safe')
  })

  it('does not re-render on equal props (React.memo stable identity)', () => {
    // Render once, capture the rendered DOM node, re-render with an equal-but-new
    // props object, and assert the inner node is the SAME instance (memo bailed
    // out → React kept the existing DOM rather than reconciling a new tree).
    act(() => root.render(React.createElement(MarkdownMessage, { content: 'stable text' })))
    const first = container.firstElementChild
    expect(first).toBeTruthy()
    act(() => root.render(React.createElement(MarkdownMessage, { content: 'stable text' })))
    const second = container.firstElementChild
    expect(second).toBe(first)
  })

  it('shows a "show more" expander past the clamp and reveals full content on click', () => {
    // 200 lines forces the clamp (default ~80).
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n\n')
    act(() => root.render(React.createElement(MarkdownMessage, { content: long })))
    const expander = Array.from(container.querySelectorAll('button')).find((b) =>
      /show more/i.test(b.textContent || ''),
    )
    expect(expander).toBeTruthy()
    // Collapsed: a clamp is applied to the body (max height present).
    const bodyBefore = container.querySelector('[data-clamped]')
    expect(bodyBefore?.getAttribute('data-clamped')).toBe('true')
    act(() => expander!.click())
    const bodyAfter = container.querySelector('[data-clamped]')
    expect(bodyAfter?.getAttribute('data-clamped')).toBe('false')
    // The toggle now offers "show less".
    const less = Array.from(container.querySelectorAll('button')).find((b) =>
      /show less/i.test(b.textContent || ''),
    )
    expect(less).toBeTruthy()
  })

  it('does not show an expander for short content', () => {
    act(() => root.render(React.createElement(MarkdownMessage, { content: 'just one line' })))
    const expander = Array.from(container.querySelectorAll('button')).find((b) =>
      /show more/i.test(b.textContent || ''),
    )
    expect(expander).toBeUndefined()
  })
})
