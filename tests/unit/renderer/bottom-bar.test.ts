// @vitest-environment jsdom
/**
 * UAT R2: BottomBar is now a slim GLOBAL runtime footer -- one left-aligned
 * band: CLI status dot + "CLI" + version + Beta pill + Update pill. The
 * per-session telemetry and the Mode/Model/Compact/Restart controls moved up
 * into SessionStatusStrip (covered by session-status-strip.test.ts). The big
 * green sidebar Update toast was removed; the footer Update pill is the single
 * update affordance and pulses (via the .footer-update-pulse class) when an
 * update is available.
 *
 * Uses React.createElement (not JSX) so the file stays a *.test.ts under the
 * vitest include glob.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// __APP_VERSION__/__BUILD_TIME__ are esbuild `define` globals at build time.
;(globalThis as any).__APP_VERSION__ = '9.9.9-test'
;(globalThis as any).__BUILD_TIME__ = '2026-05-25T00:00:00.000Z'

// --- settings store: selector form + getState, beta channel ---
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = {
    settings: { updateChannel: 'beta' as const, theme: 'dark' as const },
  }
  const useSettingsStore: any = (selector: (s: typeof STATE) => unknown) => selector(STATE)
  useSettingsStore.getState = () => STATE
  return { useSettingsStore }
})

// --- electronAPI surface the footer touches ---
let updateAvailableResolved = false
const updateInstall = vi.fn()
;(globalThis as any).window.electronAPI = {
  cli: { check: () => Promise.resolve(true) },
  update: {
    check: () => Promise.resolve(updateAvailableResolved),
    onAvailable: () => () => {},
    installAndRestart: updateInstall,
  },
}

const { default: BottomBar } = await import('../../../src/renderer/components/BottomBar')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  updateInstall.mockReset()
  updateAvailableResolved = false
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

async function render(over: { onUpdateRequested?: () => void } = {}): Promise<void> {
  await act(async () => {
    root.render(React.createElement(BottomBar, { currentView: 'sessions', onViewChange: vi.fn(), ...over }))
    // Flush the cli.check()/update.check() promises that resolve after the
    // initial paint, so their setState lands inside an act() boundary.
    await Promise.resolve()
    await Promise.resolve()
  })
}

function buttonByTitle(title: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.getAttribute('title') === title,
  )
}
function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => (b.textContent ?? '').includes(text),
  )
}

describe('BottomBar -- slim runtime footer', () => {
  it('renders version + CLI affordance + a status dot', async () => {
    await render()
    expect(container.textContent).toContain('9.9.9-test')
    expect(container.textContent).toContain('CLI')
    expect(container.querySelector('.rounded-full')).toBeTruthy()
  })

  it('shows the Beta chip on the beta channel', async () => {
    await render()
    expect(buttonByText('Beta')).toBeTruthy()
  })

  it('does NOT render any session controls (they moved to SessionStatusStrip)', async () => {
    await render()
    expect(buttonByTitle('Permission mode')).toBeUndefined()
    expect(buttonByTitle('Model')).toBeUndefined()
    expect(buttonByTitle('Compact the conversation')).toBeUndefined()
    expect(buttonByTitle('Restart session')).toBeUndefined()
  })

  it('does NOT render the Update pill when no update is available', async () => {
    updateAvailableResolved = false
    await render()
    expect(buttonByText('Update')).toBeUndefined()
  })

  it('renders a pulsing Update pill when an update is available', async () => {
    updateAvailableResolved = true
    await render()
    const pill = buttonByText('Update')
    expect(pill).toBeTruthy()
    // Pulse driven by the footer-update-pulse class (CSS handles reduced-motion).
    expect(pill!.classList.contains('footer-update-pulse')).toBe(true)
  })

  it('Update pill defers to onUpdateRequested when provided (graceful close path)', async () => {
    updateAvailableResolved = true
    const onUpdateRequested = vi.fn()
    await render({ onUpdateRequested })
    act(() => { buttonByText('Update')!.click() })
    expect(onUpdateRequested).toHaveBeenCalledTimes(1)
    expect(updateInstall).not.toHaveBeenCalled()
  })

  it('Update pill installs directly when no onUpdateRequested handler is given', async () => {
    updateAvailableResolved = true
    await render()
    act(() => { buttonByText('Update')!.click() })
    expect(updateInstall).toHaveBeenCalledTimes(1)
  })
})
