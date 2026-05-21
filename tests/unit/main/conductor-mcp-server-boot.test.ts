/**
 * P7.3 regression: browser auto-starts at CCC boot regardless of any
 * saved GlobalVisionConfig.enabled value. The MCP server itself
 * already auto-started; this pins that the browser-launch path
 * fires unconditionally.
 *
 * The test verifies the BOOT call site in index.ts -- it does NOT
 * spin up a real browser. It mocks startGlobalVision and confirms
 * it's invoked even when visionConfig.enabled is false (or absent).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const startGlobalVisionMock = vi.fn().mockResolvedValue(undefined)
const readConfigMock = vi.fn()

vi.mock('../../../src/main/vision-manager', () => ({
  startGlobalVision: startGlobalVisionMock,
  stopGlobalVision: vi.fn(),
  isGlobalVisionRunning: vi.fn(() => false),
  getGlobalVisionConfig: vi.fn(),
  cleanupLegacyVisionMarkers: vi.fn(),
  getGlobalManager: vi.fn(() => null),
}))

vi.mock('../../../src/main/config-manager', () => ({
  readConfig: readConfigMock,
  // Add empty mocks for other config-manager exports if tsc complains during
  // implementation. The vi.mock factory must be a static object literal, so we
  // can't auto-merge with the real module -- list any missing exports here.
}))

// P7.7: mock isPackagedApp to return false (dev mode) so we can assert
// startBrowserAtBoot uses the dev CDP port (9322).
vi.mock('../../../src/main/update-watcher', () => ({
  isPackagedApp: () => false,
  getProjectRootPath: vi.fn(() => ''),
  hasSourcePath: vi.fn(() => false),
}))

// Import the REAL startBrowserAtBoot. We do NOT mock conductor-mcp-server
// because we want to exercise its actual implementation against the mocked
// vision-manager and config-manager. vi.mock hoisting ensures the mocks
// above intercept the static imports in conductor-mcp-server.ts (P7.7
// swapped dynamic imports for static).
const { startBrowserAtBoot } = await import('../../../src/main/conductor-mcp-server')

describe('conductor-mcp-server browser auto-start (P7.3)', () => {
  beforeEach(() => {
    startGlobalVisionMock.mockClear()
    readConfigMock.mockReset()
  })

  it('launches browser at boot when enabled=false in saved config', async () => {
    readConfigMock.mockReturnValue({ enabled: false, browser: 'chrome', debugPort: 9222 })
    await startBrowserAtBoot(() => null)
    expect(startGlobalVisionMock).toHaveBeenCalledTimes(1)
  })

  it('launches browser at boot when saved config is missing entirely', async () => {
    readConfigMock.mockReturnValue(undefined)
    await startBrowserAtBoot(() => null)
    expect(startGlobalVisionMock).toHaveBeenCalledTimes(1)
  })

  it('launches browser at boot when enabled=true (status-quo path)', async () => {
    readConfigMock.mockReturnValue({ enabled: true, browser: 'chrome', debugPort: 9222 })
    await startBrowserAtBoot(() => null)
    expect(startGlobalVisionMock).toHaveBeenCalledTimes(1)
  })

  it('overrides debugPort with resolveCdpPort in dev mode (P7.7)', async () => {
    // saved config has stale 9222 but dev mode must override to 9322
    readConfigMock.mockReturnValue({ enabled: false, browser: 'chrome', debugPort: 9222 })
    await startBrowserAtBoot(() => null)
    expect(startGlobalVisionMock).toHaveBeenCalledTimes(1)
    const callArg = startGlobalVisionMock.mock.calls[0][0]
    expect(callArg.debugPort).toBe(9322)
  })
})
