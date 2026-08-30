// @vitest-environment jsdom
// #570 — the docked SSH host pill (canvas v4, approved 2026-08-30).
// Placement (main terminal PaneFade only — never canvas/browser/logs/partner)
// is structural in App.tsx; what a unit can pin is the component's contract:
// SSH-only, the host verbatim, decorative, and click-transparent by class.

import React from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import SshHostPill from '../../../src/renderer/components/SshHostPill'

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(host: string | undefined) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<SshHostPill host={host} />))
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('SshHostPill (#570)', () => {
  it('renders nothing for a local session', () => {
    render(undefined)
    expect(container!.querySelector('[data-testid="ssh-host-pill"]')).toBeNull()
  })

  it('shows the host verbatim for an SSH session, decorative and click-transparent', () => {
    render('192.168.50.201')
    const pill = container!.querySelector<HTMLElement>('[data-testid="ssh-host-pill"]')
    expect(pill).not.toBeNull()
    expect(pill!.textContent).toBe('192.168.50.201')
    // Decorative: the session header already announces "SSH: user@host".
    expect(pill!.getAttribute('aria-hidden')).toBe('true')
    // The class carries position + pointer-events: none (styles.css) — pinned
    // by name so a rename cannot silently detach the pill from its rules.
    expect(pill!.className).toContain('ssh-host-pill')
  })
})
