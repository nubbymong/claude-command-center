import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CSP_POLICY } from '../../../src/shared/csp-policy'

/**
 * The packaged renderer loads via file://, where the app's onHeadersReceived
 * CSP header does not apply — so its ONLY CSP is the <meta> in
 * src/renderer/index.html. That meta must stay byte-identical to CSP_POLICY
 * (the same string the dev header uses), or dev and prod drift apart and the
 * packaged build silently loses coverage. This guard fails on any drift.
 */
describe('renderer CSP meta stays in sync with CSP_POLICY', () => {
  const html = readFileSync(join(__dirname, '../../../src/renderer/index.html'), 'utf-8')

  it('index.html carries a CSP meta identical to CSP_POLICY', () => {
    const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i)
    expect(m, 'no Content-Security-Policy <meta> in src/renderer/index.html').not.toBeNull()
    expect(m![1]).toBe(CSP_POLICY)
  })

  it('the policy denies the dangerous script escape hatches', () => {
    // 'wasm-unsafe-eval' is allowed (Excalidraw WASM) but the broad 'unsafe-eval'
    // and inline-script escape hatches must never be present in script-src.
    const scriptSrc = CSP_POLICY.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src')) ?? ''
    expect(scriptSrc).not.toMatch(/'unsafe-eval'/)
    expect(scriptSrc).not.toMatch(/'unsafe-inline'/)
    expect(CSP_POLICY).toContain("default-src 'self'")
  })
})
