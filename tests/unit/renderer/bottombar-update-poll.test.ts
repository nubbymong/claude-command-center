// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__APP_VERSION__ = '9.9.9-test'
;(globalThis as any).__BUILD_TIME__ = '2026-05-25T00:00:00.000Z'

vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = { settings: { updateChannel: 'beta' as const, theme: 'dark' as const } }
  const useSettingsStore: any = (selector: (s: typeof STATE) => unknown) => selector(STATE)
  useSettingsStore.getState = () => STATE
  return { useSettingsStore }
})

const check = vi.fn().mockResolvedValue(false)
;(globalThis as any).window.electronAPI = {
  cli: { check: () => Promise.resolve(true) },
  update: { check, onAvailable: () => () => {}, installAndRestart: vi.fn() },
}

const { default: BottomBar } = await import('../../../src/renderer/components/BottomBar')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  check.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  try { act(() => { root.unmount() }) } catch { /* already unmounted */ }
  container.remove()
  vi.useRealTimers()
})

async function render() {
  await act(async () => {
    root.render(React.createElement(BottomBar, { currentView: 'sessions', onViewChange: vi.fn() }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('BottomBar update polling', () => {
  it('checks once on mount and again after the 30-min interval', async () => {
    await render()
    expect(check).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(30 * 60 * 1000); await Promise.resolve() })
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('re-checks on window focus but not more than once per 5 min', async () => {
    await render()
    expect(check).toHaveBeenCalledTimes(1)
    act(() => { window.dispatchEvent(new Event('focus')) }) // within debounce -> ignored
    expect(check).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(5 * 60 * 1000 + 1); await Promise.resolve() })
    act(() => { window.dispatchEvent(new Event('focus')) }) // past debounce -> fires
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('clears the interval and focus listener on unmount', async () => {
    await render()
    expect(check).toHaveBeenCalledTimes(1)
    act(() => { root.unmount() })
    await act(async () => { vi.advanceTimersByTime(60 * 60 * 1000); await Promise.resolve() })
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(check).toHaveBeenCalledTimes(1)
  })
})
