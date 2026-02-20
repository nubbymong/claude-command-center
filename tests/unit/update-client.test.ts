import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Mock registry
vi.mock('../../src/main/registry', () => ({
  readRegistry: vi.fn(() => null),
  writeRegistry: vi.fn(() => true),
}))

// Track ws instances and their handlers
let wsInstances: any[] = []

vi.mock('ws', () => {
  class MockWS {
    on = vi.fn()
    close = vi.fn()
    readyState = 1
    constructor() {
      wsInstances.push(this)
    }
    static OPEN = 1
    static CLOSED = 3
  }
  return { default: MockWS, WebSocket: MockWS }
})

import {
  startUpdateClient,
  stopUpdateClient,
  isServerConnected,
  getServerHash,
  getInstallerPath,
  setLocalHash,
} from '../../src/main/update-client'

// Helper to get the latest ws instance's event handler
function getHandler(eventName: string) {
  const ws = wsInstances[wsInstances.length - 1]
  if (!ws) return undefined
  const call = ws.on.mock.calls.find((c: any[]) => c[0] === eventName)
  return call?.[1]
}

describe('update-client', () => {
  let mockWindow: any

  beforeEach(() => {
    vi.clearAllMocks()
    wsInstances = []
    mockWindow = {
      webContents: { send: vi.fn() },
      isDestroyed: vi.fn(() => false),
    }
    stopUpdateClient()
  })

  afterEach(() => {
    stopUpdateClient()
  })

  describe('startUpdateClient', () => {
    it('creates a WebSocket connection', () => {
      startUpdateClient(() => mockWindow)
      expect(wsInstances.length).toBeGreaterThan(0)
    })

    it('registers event handlers on WebSocket', () => {
      startUpdateClient(() => mockWindow)
      const ws = wsInstances[wsInstances.length - 1]
      expect(ws.on).toHaveBeenCalledWith('open', expect.any(Function))
      expect(ws.on).toHaveBeenCalledWith('message', expect.any(Function))
      expect(ws.on).toHaveBeenCalledWith('close', expect.any(Function))
      expect(ws.on).toHaveBeenCalledWith('error', expect.any(Function))
    })
  })

  describe('stopUpdateClient', () => {
    it('closes WebSocket and resets state', () => {
      startUpdateClient(() => mockWindow)
      const ws = wsInstances[wsInstances.length - 1]
      stopUpdateClient()
      expect(ws.close).toHaveBeenCalled()
    })
  })

  describe('isServerConnected', () => {
    it('returns false initially', () => {
      expect(isServerConnected()).toBe(false)
    })
  })

  describe('getServerHash', () => {
    it('returns null initially', () => {
      expect(getServerHash()).toBeNull()
    })
  })

  describe('getInstallerPath', () => {
    it('returns null initially', () => {
      expect(getInstallerPath()).toBeNull()
    })
  })

  describe('message handling', () => {
    it('handles connected message and detects update via hash mismatch', () => {
      startUpdateClient(() => mockWindow, 'local-hash-123')

      // Simulate open
      getHandler('open')?.()

      // Simulate connected message with different hash
      getHandler('message')?.(JSON.stringify({
        type: 'connected',
        hash: 'server-hash-456',
        timestamp: Date.now(),
      }))

      // Should have at least one update:available(true, ...) call
      const updateTrueCalls = mockWindow.webContents.send.mock.calls.filter(
        (c: any[]) => c[0] === 'update:available' && c[1] === true
      )
      expect(updateTrueCalls.length).toBeGreaterThan(0)
    })

    it('handles update_available push message', () => {
      startUpdateClient(() => mockWindow)
      getHandler('open')?.()

      getHandler('message')?.(JSON.stringify({
        type: 'update_available',
        hash: 'new-hash',
        version: '1.2.130',
        installerPath: 'C:\\installers\\app.exe',
        timestamp: Date.now(),
      }))

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'update:available',
        true,
        '1.2.130'
      )
    })

    it('ignores heartbeat messages', () => {
      startUpdateClient(() => mockWindow)
      getHandler('open')?.()
      mockWindow.webContents.send.mockClear()

      getHandler('message')?.(JSON.stringify({
        type: 'heartbeat',
        timestamp: Date.now(),
      }))

      const updateCalls = mockWindow.webContents.send.mock.calls.filter(
        (c: any[]) => c[0] === 'update:available'
      )
      expect(updateCalls).toHaveLength(0)
    })

    it('handles invalid JSON gracefully', () => {
      startUpdateClient(() => mockWindow)
      expect(() => getHandler('message')?.('not json')).not.toThrow()
    })
  })

  describe('setLocalHash', () => {
    it('notifies no update when local hash matches server hash', () => {
      startUpdateClient(() => mockWindow)
      getHandler('open')?.()

      // Set server hash via connected message
      getHandler('message')?.(JSON.stringify({
        type: 'connected',
        hash: 'matching-hash',
        timestamp: Date.now(),
      }))

      mockWindow.webContents.send.mockClear()

      setLocalHash('matching-hash')
      // Should have an update:available(false, ...) call
      const updateFalseCalls = mockWindow.webContents.send.mock.calls.filter(
        (c: any[]) => c[0] === 'update:available' && c[1] === false
      )
      expect(updateFalseCalls.length).toBeGreaterThan(0)
    })
  })
})
