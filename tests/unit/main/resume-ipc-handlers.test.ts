import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'

// Capture ipcMain.handle registrations so we can invoke handlers directly.
const handlers = new Map<string, (...a: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
}))

// Mock the binder accessor; the spy records the sessionId it is asked about.
const getLatestTranscriptPathSpy = vi.fn<(id: string) => string | null>()
vi.mock('../../../src/main/logging/logging-service', () => ({
  getTranscriptBinder: () => ({ getLatestTranscriptPath: getLatestTranscriptPathSpy }),
}))

// Stub the pure resolver so the handler test stays a pure IPC test.
const resolveSpy = vi.fn<(p: string) => { uuid: string; cwd: string } | null>()
vi.mock('../../../src/main/logging/transcript-discovery', () => ({
  resolveResumeTargetFromTranscript: (p: string) => resolveSpy(p),
}))

import { registerResumeHandlers } from '../../../src/main/ipc/resume-handlers'

const invoke = (ch: string, ...args: any[]) => handlers.get(ch)!({} as any, ...args)

describe('resume IPC handler (getResumeTarget)', () => {
  beforeEach(() => {
    handlers.clear()
    getLatestTranscriptPathSpy.mockReset()
    resolveSpy.mockReset()
    registerResumeHandlers()
  })

  it('resolves {uuid,cwd} from the latest bound transcript', async () => {
    getLatestTranscriptPathSpy.mockReturnValue('/home/.claude/projects/p/u.jsonl')
    resolveSpy.mockReturnValue({ uuid: 'u', cwd: 'F:/wt' })
    const out = await invoke(IPC.LOGS_GET_RESUME_TARGET, 's1')
    expect(getLatestTranscriptPathSpy).toHaveBeenCalledWith('s1')
    expect(resolveSpy).toHaveBeenCalledWith('/home/.claude/projects/p/u.jsonl')
    expect(out).toEqual({ uuid: 'u', cwd: 'F:/wt' })
  })

  it('returns null when no transcript is bound', async () => {
    getLatestTranscriptPathSpy.mockReturnValue(null)
    const out = await invoke(IPC.LOGS_GET_RESUME_TARGET, 's1')
    expect(out).toBeNull()
    expect(resolveSpy).not.toHaveBeenCalled()
  })

  it('is fail-safe (returns null) on an invalid sessionId', async () => {
    const out = await invoke(IPC.LOGS_GET_RESUME_TARGET, '')
    expect(out).toBeNull()
  })
})
