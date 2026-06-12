/**
 * memory-recent-sessions-ipc.test.ts
 *
 * Tests for the memory:recentSessions IPC handler (Task 4, Memory Page Rebuild).
 * Mirrors the sentinel-handlers.test.ts idiom: vi.mock('electron') captures
 * ipcMain.handle registrations; vi.mock the logging-service to control supervisor.
 *
 * Also covers logs2:sessionConfig registration as a channel-registration check.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Capture ipcMain.handle calls for inspection
const handleCalls: Array<[string, Function]> = []
const ipcMainHandleMock = vi.fn((channel: string, fn: Function) => {
  handleCalls.push([channel, fn])
})

vi.mock('electron', () => ({
  ipcMain: { handle: ipcMainHandleMock },
}))

// We control the supervisor via this module-level ref
let mockSupervisor: { query: ReturnType<typeof vi.fn> } | null = null

vi.mock('../../src/main/logging/logging-service', () => ({
  getLogSupervisor: vi.fn(() => mockSupervisor),
}))

// Helper: fresh import of memory-handlers + logs2-handlers after resetModules
async function importHandlers() {
  const memMod = await import('../../src/main/ipc/memory-handlers')
  const logs2Mod = await import('../../src/main/ipc/logs2-handlers')
  return { registerMemoryHandlers: memMod.registerMemoryHandlers, registerLogs2Handlers: logs2Mod.registerLogs2Handlers }
}

// Helper: invoke a registered handler by channel name
async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const entry = handleCalls.find(([c]) => c === channel)
  if (!entry) throw new Error(`No handler registered for channel: ${channel}`)
  return entry[1]({} /* _event */, ...args)
}

describe('memory:recentSessions IPC handler', () => {
  beforeEach(() => {
    handleCalls.length = 0
    mockSupervisor = null
    vi.resetModules()
  })

  it('registers both new channels', async () => {
    const { registerMemoryHandlers } = await importHandlers()
    const { registerLogs2Handlers } = await importHandlers()
    registerMemoryHandlers()
    // registerLogs2Handlers needs a getWindow fn
    registerLogs2Handlers(() => null)
    const registered = handleCalls.map(([c]) => c)
    expect(registered).toContain('memory:recentSessions')
    expect(registered).toContain('logs2:sessionConfig')
  })

  it('returns [] (fail-open) when getLogSupervisor returns null', async () => {
    mockSupervisor = null
    const { registerMemoryHandlers } = await importHandlers()
    registerMemoryHandlers()
    const result = await invokeHandler('memory:recentSessions', 'F--X')
    expect(result).toEqual([])
  })

  it('routes through sup.query("recent-sessions", { projectDir, limit: 5 }) and returns rows', async () => {
    const rows = [
      { sessionId: 'abc', lastActive: 1000 },
      { sessionId: 'def', lastActive: 2000 },
    ]
    mockSupervisor = { query: vi.fn(() => Promise.resolve(rows)) }
    const { registerMemoryHandlers } = await importHandlers()
    registerMemoryHandlers()
    const result = await invokeHandler('memory:recentSessions', 'F--X')
    expect(mockSupervisor.query).toHaveBeenCalledWith('recent-sessions', { projectDir: 'F--X', limit: 5 })
    expect(result).toEqual(rows)
  })

  it('returns [] (fail-open) when sup.query rejects', async () => {
    mockSupervisor = { query: vi.fn(() => Promise.reject(new Error('worker crash'))) }
    const { registerMemoryHandlers } = await importHandlers()
    registerMemoryHandlers()
    const result = await invokeHandler('memory:recentSessions', 'F--X')
    expect(result).toEqual([])
  })

  it('returns [] without calling supervisor when projectDir is not a string', async () => {
    mockSupervisor = { query: vi.fn() }
    const { registerMemoryHandlers } = await importHandlers()
    registerMemoryHandlers()
    const result = await invokeHandler('memory:recentSessions', 42)
    expect(result).toEqual([])
    expect(mockSupervisor.query).not.toHaveBeenCalled()
  })

  it('returns [] without calling supervisor when projectDir is an empty string', async () => {
    mockSupervisor = { query: vi.fn() }
    const { registerMemoryHandlers } = await importHandlers()
    registerMemoryHandlers()
    const result = await invokeHandler('memory:recentSessions', '')
    expect(result).toEqual([])
    expect(mockSupervisor.query).not.toHaveBeenCalled()
  })

  it('returns [] without calling supervisor when projectDir is undefined', async () => {
    mockSupervisor = { query: vi.fn() }
    const { registerMemoryHandlers } = await importHandlers()
    registerMemoryHandlers()
    const result = await invokeHandler('memory:recentSessions', undefined)
    expect(result).toEqual([])
    expect(mockSupervisor.query).not.toHaveBeenCalled()
  })
})
