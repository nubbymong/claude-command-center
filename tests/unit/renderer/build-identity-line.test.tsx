// @vitest-environment jsdom
/**
 * #384 — Settings → About shows the same build identity line as the splash.
 * BuildIdentityLine reads the esbuild defines (__APP_VERSION__, __BUILD_SHA__,
 * __BUILD_TIME__) and renders formatBuildIdentity() of them in muted text.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { formatBuildIdentity } from '../../../src/shared/build-identity'
import { splashBuildQuery } from '../../../src/main/splash-info'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Build-time defines, stubbed the way the other renderer tests do.
;(globalThis as any).__APP_VERSION__ = '2.1.0-beta.17'
;(globalThis as any).__BUILD_SHA__ = '3a1b2e2'
;(globalThis as any).__BUILD_TIME__ = '2026-08-22T14:03:00.000Z'

const { BuildIdentityLine, currentBuildIdentity } = await import('../../../src/renderer/components/BuildIdentityLine')

function render(ui: React.ReactElement): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => { root.render(ui) })
  return { container, unmount: () => { act(() => { root.unmount() }); container.remove() } }
}

describe('BuildIdentityLine (Settings → About) (#384)', () => {
  let cleanup: (() => void) | null = null
  beforeEach(() => { cleanup = null })
  afterEach(() => { cleanup?.() })

  it('renders "v<version> · <channel> · build <sha> · <date>" from the defines', () => {
    const { container, unmount } = render(<BuildIdentityLine />)
    cleanup = unmount
    const el = container.querySelector('[data-testid="build-identity-line"]') as HTMLElement
    expect(el).toBeTruthy()
    expect(el.textContent).toBe('v2.1.0-beta.17 · beta · build 3a1b2e2 · 2026-08-22')
  })

  it('is muted text (readable in both themes via the --text-muted token)', () => {
    const { container, unmount } = render(<BuildIdentityLine />)
    cleanup = unmount
    const el = container.querySelector('[data-testid="build-identity-line"]') as HTMLElement
    expect(el.style.color).toBe('var(--text-muted)')
  })

  it('is byte-identical to what main hands the splash for the same build', () => {
    const splash = splashBuildQuery({ version: '2.1.0-beta.17', sha: '3a1b2e2', buildTime: '2026-08-22T14:03:00.000Z' }).build
    expect(currentBuildIdentity()).toBe(splash)
    expect(currentBuildIdentity()).toBe(formatBuildIdentity({ version: '2.1.0-beta.17', sha: '3a1b2e2', buildTime: '2026-08-22T14:03:00.000Z' }))
  })

  it('degrades to "build dev" when the sha define is missing (dev/test context)', () => {
    const saved = (globalThis as any).__BUILD_SHA__
    delete (globalThis as any).__BUILD_SHA__
    try {
      expect(currentBuildIdentity()).toBe('v2.1.0-beta.17 · beta · build dev · 2026-08-22')
    } finally {
      ;(globalThis as any).__BUILD_SHA__ = saved
    }
  })
})
