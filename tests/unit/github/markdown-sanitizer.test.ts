// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderCommentMarkdown } from '../../../src/renderer/utils/markdownSanitizer'

describe('renderCommentMarkdown', () => {
  it('renders basic markdown', () => {
    const h = renderCommentMarkdown('**b** and `c`')
    expect(h).toContain('<strong>b</strong>')
    expect(h).toContain('<code>c</code>')
  })
  it('strips <script>', () => {
    expect(renderCommentMarkdown('<script>alert(1)</script>x')).not.toContain('<script')
  })
  it('strips javascript: hrefs', () => {
    expect(renderCommentMarkdown('[x](javascript:alert(1))')).not.toMatch(/javascript:/i)
  })
  it('strips <img onerror>', () => {
    const h = renderCommentMarkdown('<img src=x onerror="alert(1)">')
    expect(h).not.toMatch(/onerror/i)
  })
  it('strips inline onclick', () => {
    expect(renderCommentMarkdown('<a onclick="bad()">x</a>')).not.toContain('onclick')
  })
  it('keeps https: links', () => {
    expect(renderCommentMarkdown('[x](https://example.com)')).toContain('href="https://example.com"')
  })
  it('strips <img> entirely (CSP img-src does not allow https:)', () => {
    const h = renderCommentMarkdown('![alt](https://a/b.png)')
    expect(h).not.toMatch(/<img/i)
  })
  it('strips http: links (https only)', () => {
    expect(renderCommentMarkdown('[x](http://example.com)')).not.toMatch(/href="http:/i)
  })
  it('strips mailto: links (navigation would be inert under app CSP)', () => {
    expect(renderCommentMarkdown('[x](mailto:a@b)')).not.toMatch(/href="mailto:/i)
  })
  it('strips bare fragment # links', () => {
    expect(renderCommentMarkdown('[x](#anchor)')).not.toMatch(/href="#/i)
  })
  it('strips data: URIs', () => {
    const h = renderCommentMarkdown('[x](data:text/html,<script>bad</script>)')
    expect(h).not.toMatch(/data:/i)
  })
  it('returns empty string for non-string input', () => {
    // @ts-expect-error runtime guard
    expect(renderCommentMarkdown(null)).toBe('')
    // @ts-expect-error runtime guard
    expect(renderCommentMarkdown(undefined)).toBe('')
    // @ts-expect-error runtime guard
    expect(renderCommentMarkdown(42)).toBe('')
  })
})
