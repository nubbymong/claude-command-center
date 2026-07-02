import { describe, it, expect } from 'vitest'
import { safeExternalHttpsHref } from '../../../src/shared/safe-url'

describe('safeExternalHttpsHref', () => {
  it('accepts https URLs and returns a normalized href', () => {
    expect(safeExternalHttpsHref('https://example.com')).toBe('https://example.com/')
    expect(safeExternalHttpsHref('https://example.com/path?q=1#h')).toBe('https://example.com/path?q=1#h')
  })

  it('lowercases the scheme (case-insensitive https)', () => {
    expect(safeExternalHttpsHref('HTTPS://example.com')).toBe('https://example.com/')
  })

  it('rejects every non-https scheme', () => {
    for (const u of [
      'http://example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'vbscript:msgbox',
      'data:text/html,<script>alert(1)</script>',
      'ftp://example.com',
      'mailto:a@b.com',
      'ms-msdt:/id PCWDiagnostic',
      'shell:startup',
    ]) {
      expect(safeExternalHttpsHref(u)).toBeNull()
    }
  })

  it('rejects malformed and non-string input', () => {
    expect(safeExternalHttpsHref('not a url')).toBeNull()
    expect(safeExternalHttpsHref('')).toBeNull()
    expect(safeExternalHttpsHref('https://')).toBeNull() // no host
    expect(safeExternalHttpsHref(undefined)).toBeNull()
    expect(safeExternalHttpsHref(null)).toBeNull()
    expect(safeExternalHttpsHref(123)).toBeNull()
  })
})
