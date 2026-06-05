// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useSettingsStore } from '../../../src/renderer/stores/settingsStore'
import { useLogsStore } from '../../../src/renderer/stores/useLogsStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: LogsButton } = await import('../../../src/renderer/components/LogsButton')

const render = async (el: React.ReactElement) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(el) })
  return { container, cleanup: () => { act(() => { root.unmount() }); container.remove() } }
}

describe('LogsButton', () => {
  beforeEach(() => {
    useLogsStore.setState({ bySessionId: {} })
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, loggingEnabled: true } }))
  })

  it('renders when logging is enabled and toggles the store on click', async () => {
    const { container, cleanup } = await render(<LogsButton sessionId="s1" />)
    const btn = container.querySelector('button')!
    expect(btn).toBeTruthy()
    await act(async () => { btn.click() })
    expect(useLogsStore.getState().bySessionId['s1'].isOpen).toBe(true)
    cleanup()
  })

  it('renders nothing when logging is disabled', async () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, loggingEnabled: false } }))
    const { container, cleanup } = await render(<LogsButton sessionId="s1" />)
    expect(container.querySelector('button')).toBeNull()
    cleanup()
  })
})
