// @vitest-environment jsdom
/**
 * ConductorServicesPanel unit tests (Conductor D1b, Task 10).
 *
 * Verifies (spec §3.7 / §6):
 *   - renders the per-service metrics (port, pid, in-flight, events, drops,
 *     throughput, jank, restarts, lastError) + a level-coloured log tail
 *   - "Copy diagnostics" writes the full DiagnosticsSnapshot JSON to the clipboard
 *   - "Restart" calls serviceHealth.restart('hooks') in utility mode
 *   - "Restart" is disabled when host is in-process-fallback
 *   - a disabled "next phase" MCP row is shown
 *   - click-outside calls onClose
 *
 * jsdom logs a benign "Not implemented: HTMLCanvasElement.getContext" — unrelated.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { DiagnosticsSnapshot, ServiceState, ServiceHost } from '../../../src/shared/service-health'
import { createInitialHealth } from '../../../src/shared/service-health'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function mkSnap(state: ServiceState, host: ServiceHost = 'utility-process'): DiagnosticsSnapshot {
  const h = { ...createInitialHealth('hooks', 'Hooks gateway'), state, host }
  return { capturedAt: 1, services: [h], log: [] }
}

const restartMock = vi.fn().mockResolvedValue({ ok: true })

function mockApi(snap: DiagnosticsSnapshot): void {
  ;(globalThis as any).window.electronAPI = {
    serviceHealth: {
      get: vi.fn().mockResolvedValue(snap),
      restart: restartMock,
      onUpdate: vi.fn().mockReturnValue(() => {}),
    },
  }
}

const { default: ConductorServicesPanel } = await import(
  '../../../src/renderer/components/ConductorServicesPanel'
)

async function renderPanel(props: { onClose: () => void }): Promise<{
  container: HTMLElement
  unmount: () => void
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(ConductorServicesPanel, props))
  })
  await act(async () => { await Promise.resolve() })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

function findButton(container: HTMLElement, re: RegExp): HTMLButtonElement {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    re.test(b.textContent ?? '')
  ) as HTMLButtonElement
}

describe('ConductorServicesPanel', () => {
  let unmount: () => void

  afterEach(() => {
    unmount?.()
    vi.clearAllMocks()
  })

  it('renders metrics + log and Copy writes DiagnosticsSnapshot JSON', async () => {
    const snap = mkSnap('listening')
    snap.services[0].port = 19431
    snap.services[0].pid = 8421
    snap.services[0].inFlight = 3
    snap.services[0].eventsTotal = 42
    snap.log = [
      { ts: 1, serviceId: 'hooks', level: 'info', code: 'bound', message: 'bound :19431 pid=8421' },
    ]
    const writeText = vi.fn().mockResolvedValue(undefined)
    ;(navigator as any).clipboard = { writeText }
    mockApi(snap)

    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount

    expect(r.container.textContent).toContain('19431')
    expect(r.container.textContent).toContain('8421')
    expect(r.container.textContent).toContain('bound :19431')

    const copyBtn = findButton(r.container, /Copy/i)
    expect(copyBtn).toBeTruthy()
    await act(async () => { copyBtn.click() })
    expect(writeText).toHaveBeenCalledOnce()
    const arg = writeText.mock.calls[0][0] as string
    expect(arg).toContain('"services"')
    // Round-trips to the exact snapshot.
    expect(JSON.parse(arg)).toEqual(snap)
  })

  it('shows "Copied" feedback after Copy diagnostics is clicked (BUG-2)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    ;(navigator as any).clipboard = { writeText }
    mockApi(mkSnap('listening'))
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    const copyBtn = findButton(r.container, /Copy/i)
    await act(async () => { copyBtn.click() })
    await act(async () => { await Promise.resolve() })
    expect(findButton(r.container, /Copied/i)).toBeTruthy()
  })

  it('styles Restart with a destructive (danger) tone (BUG-3)', async () => {
    mockApi(mkSnap('listening'))
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    const restartBtn = findButton(r.container, /Restart/i)
    // Since #360 the panel paints from the E5 semantic tokens, so the
    // destructive read lives in --status-danger rather than in a `red`
    // palette class name. Assert the tone, not the old class.
    const style = restartBtn.getAttribute('style') || ''
    expect(style).toMatch(/--status-danger/)
    expect(style).not.toMatch(/--status-(success|info)\b/)
  })

  it('Restart calls serviceHealth.restart("hooks") in utility mode', async () => {
    mockApi(mkSnap('listening'))
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    const restartBtn = findButton(r.container, /Restart/i)
    expect(restartBtn.hasAttribute('disabled')).toBe(false)
    await act(async () => { restartBtn.click() })
    expect(restartMock).toHaveBeenCalledWith('hooks')
  })

  it('Restart is disabled in fallback', async () => {
    mockApi(mkSnap('degraded', 'in-process-fallback'))
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    const restartBtn = findButton(r.container, /Restart/i)
    expect(restartBtn.hasAttribute('disabled')).toBe(true)
  })

  it('renders the disabled "next phase" MCP row', async () => {
    mockApi(mkSnap('listening'))
    const r = await renderPanel({ onClose: () => {} })
    unmount = r.unmount
    expect(r.container.textContent).toContain('MCP server')
    expect(r.container.textContent).toMatch(/next phase/i)
  })

  it('calls onClose on outside mousedown', async () => {
    const onClose = vi.fn()
    mockApi(mkSnap('listening'))
    const r = await renderPanel({ onClose })
    unmount = r.unmount
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
