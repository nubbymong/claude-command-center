// Source-text guards for the Agent Canvas security posture (spec §3.2) — the
// same no-boot pattern as csp-policy-sync: cheap, loud, and immune to mocks.
//
// The live-frame proof (no window.require / no preload globals / foreign fetch
// blocked) is the Playwright spec tests/e2e/agent-canvas-frame-security.spec.ts;
// these guards pin the source invariants that make it true.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CSP_POLICY } from '../../../src/shared/csp-policy'

const paneSource = readFileSync(
  join(__dirname, '../../../src/renderer/components/AgentCanvasPane.tsx'),
  'utf8',
)
const protocolSource = readFileSync(
  join(__dirname, '../../../src/main/canvas/ccc-ux-protocol.ts'),
  'utf8',
)

describe('host renderer CSP', () => {
  it('frames ccc-ux: and ONLY ccc-ux:', () => {
    const frameSrc = /frame-src ([^;]+);/.exec(CSP_POLICY)
    expect(frameSrc, 'frame-src directive present').toBeTruthy()
    expect(frameSrc![1].trim()).toBe('ccc-ux:')
  })
})

describe('content iframe attributes', () => {
  const sandboxMatch = /sandbox="([^"]+)"/.exec(paneSource)

  it('is sandboxed with exactly the intended grants', () => {
    expect(sandboxMatch, 'iframe carries a sandbox attribute').toBeTruthy()
    const grants = sandboxMatch![1].split(/\s+/).sort()
    expect(grants).toEqual(['allow-forms', 'allow-same-origin', 'allow-scripts'])
  })

  it('never grants navigation, popups, modals, or downloads', () => {
    for (const forbidden of ['allow-top-navigation', 'allow-popups', 'allow-modals', 'allow-downloads']) {
      expect(paneSource).not.toContain(forbidden)
    }
  })

  it('has no preload and no webview anywhere in the pane', () => {
    expect(paneSource).not.toMatch(/\bpreload\s*=/)
    expect(paneSource).not.toContain('<webview')
    expect(paneSource).toContain('referrerPolicy="no-referrer"')
  })
})

describe('ccc-ux protocol source invariants', () => {
  it('never sets bypassCSP and keeps the privilege set minimal', () => {
    // Property form only — prose may (and does) mention the names.
    expect(protocolSource).not.toMatch(/bypassCSP\s*:/)
    expect(protocolSource).not.toMatch(/allowServiceWorkers\s*:/)
    expect(protocolSource).toContain('standard: true')
    expect(protocolSource).toContain('secure: true')
    expect(protocolSource).toContain('supportFetchAPI: true')
  })

  it('every content CSP keeps egress at self and blocks objects', () => {
    const csps = protocolSource.match(/"connect-src [^"]+"/g) ?? []
    expect(csps.length).toBeGreaterThanOrEqual(2)
    for (const c of csps) expect(c).toBe(`"connect-src 'self'; "`)
    expect(protocolSource).toContain("object-src 'none'")
  })
})
