import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'

// Capture ipcMain.handle registrations so we can invoke handlers directly.
const handlers = new Map<string, (...a: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
}))

// Mock the supervisor accessor; the spy records the (kind,args) pairs.
const querySpy = vi.fn()
const getLatestTranscriptPathSpy = vi.fn<(id: string) => string | null>()
vi.mock('../../../src/main/logging/logging-service', () => ({
  getLogSupervisor: () => ({ query: querySpy }),
  getTranscriptBinder: () => ({ getLatestTranscriptPath: getLatestTranscriptPathSpy }),
}))

// Stub the pure resolver so the handler test stays a pure IPC test.
const resolveSpy = vi.fn<(p: string) => { uuid: string; cwd: string } | null>()
vi.mock('../../../src/main/logging/transcript-discovery', () => ({
  resolveResumeTargetFromTranscript: (p: string) => resolveSpy(p),
}))

import { registerLogsdbHandlers } from '../../../src/main/ipc/logsdb-handlers'

const invoke = (ch: string, ...args: any[]) => handlers.get(ch)!({} as any, ...args)

describe('logsdb IPC handlers', () => {
  beforeEach(() => {
    handlers.clear()
    querySpy.mockReset()
    getLatestTranscriptPathSpy.mockReset()
    resolveSpy.mockReset()
    registerLogsdbHandlers()
  })

  it('listSessions forwards offset/limit to query(listSessions)', async () => {
    querySpy.mockResolvedValue([{ sessionId: 's1' }])
    const out = await invoke(IPC.LOGSDB_LIST_SESSIONS, { offset: 10, limit: 50 })
    expect(querySpy).toHaveBeenCalledWith('listSessions', { offset: 10, limit: 50 })
    expect(out).toEqual([{ sessionId: 's1' }])
  })

  it('readEvents forwards sessionId/offset/limit', async () => {
    querySpy.mockResolvedValue([])
    await invoke(IPC.LOGSDB_READ_EVENTS, 's1', 0, 100)
    expect(querySpy).toHaveBeenCalledWith('readEvents', { sessionId: 's1', offset: 0, limit: 100 })
  })

  it('search forwards query/limit', async () => {
    querySpy.mockResolvedValue([])
    await invoke(IPC.LOGSDB_SEARCH, 'needle', 25)
    expect(querySpy).toHaveBeenCalledWith('search', { query: 'needle', limit: 25 })
  })

  it('prune forwards ids and unwraps the single count row', async () => {
    querySpy.mockResolvedValue([{ deletedSessions: 2, deletedEvents: 9 }])
    const out = await invoke(IPC.LOGSDB_PRUNE, ['a', 'b'])
    expect(querySpy).toHaveBeenCalledWith('prune', { ids: ['a', 'b'] })
    expect(out).toEqual({ deletedSessions: 2, deletedEvents: 9 })
  })

  it('clearAll unwraps the single count row', async () => {
    querySpy.mockResolvedValue([{ deletedSessions: 5, deletedEvents: 40 }])
    const out = await invoke(IPC.LOGSDB_CLEAR_ALL)
    expect(querySpy).toHaveBeenCalledWith('clearAll', {})
    expect(out).toEqual({ deletedSessions: 5, deletedEvents: 40 })
  })

  it('rejects-fast (rethrows) when the query rejects (worker down)', async () => {
    querySpy.mockRejectedValue(new Error('logging worker not available (state=down)'))
    await expect(invoke(IPC.LOGSDB_CLEAR_ALL)).rejects.toThrow(/not available/)
  })

  // T8b (bug #5): getResumeTarget --------------------------------------------

  it('getResumeTarget resolves {uuid,cwd} from the latest bound transcript', async () => {
    getLatestTranscriptPathSpy.mockReturnValue('/home/.claude/projects/p/u.jsonl')
    resolveSpy.mockReturnValue({ uuid: 'u', cwd: 'F:/wt' })
    const out = await invoke(IPC.LOGS_GET_RESUME_TARGET, 's1')
    expect(getLatestTranscriptPathSpy).toHaveBeenCalledWith('s1')
    expect(resolveSpy).toHaveBeenCalledWith('/home/.claude/projects/p/u.jsonl')
    expect(out).toEqual({ uuid: 'u', cwd: 'F:/wt' })
  })

  it('getResumeTarget returns null when no transcript is bound', async () => {
    getLatestTranscriptPathSpy.mockReturnValue(null)
    const out = await invoke(IPC.LOGS_GET_RESUME_TARGET, 's1')
    expect(out).toBeNull()
    expect(resolveSpy).not.toHaveBeenCalled()
  })

  it('getResumeTarget is fail-safe (returns null) on an invalid sessionId', async () => {
    const out = await invoke(IPC.LOGS_GET_RESUME_TARGET, '')
    expect(out).toBeNull()
  })
})
