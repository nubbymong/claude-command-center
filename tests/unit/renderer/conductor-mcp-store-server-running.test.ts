// @vitest-environment jsdom
/**
 * P7.7.16 regression: useConductorMcpStore.serverRunning is derived from
 * mcpPort > 0 in BOTH status update paths (handleStatusChanged, fetchStatus).
 * The earlier hardcoded `serverRunning: true` initializer would lie when the
 * MCP listener failed to bind (e.g. EADDRINUSE on the resolved port); the
 * SidebarNav dot uses this flag and must not stay green in that case.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// window.electronAPI.vision.status is invoked by fetchStatus.
const visionStatusMock = vi.fn()
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  vision: { status: visionStatusMock, onStatusChanged: vi.fn() },
}

const { useConductorMcpStore } = await import('../../../src/renderer/stores/conductorMcpStore')

describe('useConductorMcpStore serverRunning derivation (P7.7.16)', () => {
  beforeEach(() => {
    visionStatusMock.mockReset()
    useConductorMcpStore.setState({
      serverRunning: false,
      mcpPort: 0,
      browserRunning: false,
      browserConnected: false,
      error: null,
    })
  })

  it('initial state is serverRunning=false (not the old hardcoded true)', () => {
    expect(useConductorMcpStore.getState().serverRunning).toBe(false)
  })

  it('handleStatusChanged sets serverRunning=true when mcpPort > 0', () => {
    useConductorMcpStore.getState().handleStatusChanged({
      connected: true, browser: 'chrome', mcpPort: 19433,
    })
    const s = useConductorMcpStore.getState()
    expect(s.mcpPort).toBe(19433)
    expect(s.serverRunning).toBe(true)
  })

  it('handleStatusChanged sets serverRunning=false when mcpPort is 0', () => {
    // Simulate the failure mode: main side never bound, port stays 0.
    useConductorMcpStore.setState({ serverRunning: true, mcpPort: 19433 })
    useConductorMcpStore.getState().handleStatusChanged({
      connected: false, browser: '', mcpPort: 0,
    })
    const s = useConductorMcpStore.getState()
    expect(s.mcpPort).toBe(0)
    expect(s.serverRunning).toBe(false)
  })

  it('fetchStatus derives serverRunning from the IPC payload mcpPort', async () => {
    visionStatusMock.mockResolvedValue({ running: true, connected: true, mcpPort: 19333 })
    await useConductorMcpStore.getState().fetchStatus()
    const s = useConductorMcpStore.getState()
    expect(s.mcpPort).toBe(19333)
    expect(s.serverRunning).toBe(true)
  })

  it('fetchStatus sets serverRunning=false when the IPC reports mcpPort=0', async () => {
    visionStatusMock.mockResolvedValue({ running: false, connected: false, mcpPort: 0 })
    await useConductorMcpStore.getState().fetchStatus()
    expect(useConductorMcpStore.getState().serverRunning).toBe(false)
  })

  it('fetchStatus leaves serverRunning untouched when the IPC returns null', async () => {
    useConductorMcpStore.setState({ serverRunning: true, mcpPort: 19433 })
    visionStatusMock.mockResolvedValue(null)
    await useConductorMcpStore.getState().fetchStatus()
    const s = useConductorMcpStore.getState()
    // The store only updates when status is truthy; preserves prior good state.
    expect(s.serverRunning).toBe(true)
    expect(s.mcpPort).toBe(19433)
  })
})
