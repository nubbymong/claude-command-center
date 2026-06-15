import { describe, it, expect, vi } from 'vitest'

// P2.3: setupConductorMcpListener / setupChannelListeners must be idempotent
// (mirror the cloudAgent/github/team guard) so a repeated call — React
// StrictMode double-invoke, a remount — never installs duplicate IPC listeners.

describe('listener idempotency (P2.3)', () => {
  it('setupConductorMcpListener registers exactly once across repeated calls', async () => {
    const onStatusChanged = vi.fn().mockReturnValue(() => {})
    ;(window as any).electronAPI = { ...(window as any).electronAPI, vision: { onStatusChanged } }
    const { setupConductorMcpListener } = await import('../../src/renderer/stores/conductorMcpStore')

    setupConductorMcpListener()
    setupConductorMcpListener()
    setupConductorMcpListener()

    expect(onStatusChanged).toHaveBeenCalledTimes(1)
  })

  it('setupChannelListeners registers exactly once across repeated calls', async () => {
    const onLedgerEvent = vi.fn().mockReturnValue(() => {})
    const onAttention = vi.fn().mockReturnValue(() => {})
    const rendererReady = vi.fn().mockResolvedValue(undefined)
    ;(window as any).electronAPI = {
      ...(window as any).electronAPI,
      channels: { onLedgerEvent, onAttention, rendererReady },
    }
    const { setupChannelListeners } = await import('../../src/renderer/stores/channelStore')

    setupChannelListeners()
    setupChannelListeners()

    expect(onLedgerEvent).toHaveBeenCalledTimes(1)
    expect(onAttention).toHaveBeenCalledTimes(1)
  })

  it('setupInsightsListener registers exactly once across repeated calls', async () => {
    const onStatusChanged = vi.fn().mockReturnValue(() => {})
    const getCatalogue = vi.fn().mockResolvedValue({ runs: [] })
    const isRunning = vi.fn().mockResolvedValue(false)
    ;(window as any).electronAPI = {
      ...(window as any).electronAPI,
      insights: { onStatusChanged, getCatalogue, isRunning },
    }
    const { setupInsightsListener } = await import('../../src/renderer/stores/insightsStore')

    setupInsightsListener()
    setupInsightsListener()
    setupInsightsListener()

    expect(onStatusChanged).toHaveBeenCalledTimes(1)
  })
})
