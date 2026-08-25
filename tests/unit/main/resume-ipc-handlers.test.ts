import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'

// Capture ipcMain.handle registrations so we can invoke handlers directly.
const handlers = new Map<string, (...a: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
}))

// #480: the handler now prefers the durable session_conversation record (via the
// supervisor query) and falls back to the live EXACT bind — never a heuristic
// guess. Mock both accessors.
const getExactResumeTargetSpy = vi.fn<(id: string) => string | null>()
const getLatestTranscriptPathSpy = vi.fn<(id: string) => string | null>()
const querySpy = vi.fn<(kind: string, args: Record<string, unknown>) => Promise<unknown[]>>()
vi.mock('../../../src/main/logging/logging-service', () => ({
  getTranscriptBinder: () => ({
    getExactResumeTarget: getExactResumeTargetSpy,
    getLatestTranscriptPath: getLatestTranscriptPathSpy,
  }),
  getLogSupervisor: () => ({ query: querySpy }),
}))

// #480: the hooks-off fallback gate — exact-only when hooks are active.
const isExactBindSourceActiveSpy = vi.fn<() => boolean>()
vi.mock('../../../src/main/hooks', () => ({
  isExactBindSourceActive: () => isExactBindSourceActiveSpy(),
}))
vi.mock('../../../src/main/debug-logger', () => ({ logWarn: () => {} }))

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
    getExactResumeTargetSpy.mockReset()
    getLatestTranscriptPathSpy.mockReset()
    getLatestTranscriptPathSpy.mockReturnValue(null)
    querySpy.mockReset()
    querySpy.mockResolvedValue([]) // durable miss by default
    isExactBindSourceActiveSpy.mockReset()
    isExactBindSourceActiveSpy.mockReturnValue(true) // hooks active => exact-only, no fallback
    resolveSpy.mockReset()
    registerResumeHandlers()
  })

  it('prefers the LIVE exact bind (freshest during a live session)', async () => {
    getExactResumeTargetSpy.mockReturnValue('/home/.claude/projects/p/u.jsonl')
    resolveSpy.mockReturnValue({ uuid: 'u', cwd: 'F:/wt' })
    const out = await invoke(IPC.LOGS_GET_RESUME_TARGET, 's1')
    expect(getExactResumeTargetSpy).toHaveBeenCalledWith('s1')
    // The live hit means we never consult the durable table.
    expect(querySpy).not.toHaveBeenCalled()
    expect(resolveSpy).toHaveBeenCalledWith('/home/.claude/projects/p/u.jsonl')
    expect(out).toEqual({ uuid: 'u', cwd: 'F:/wt' })
  })

  it('falls back to the durable record after a restart (no live bind)', async () => {
    getExactResumeTargetSpy.mockReturnValue(null)
    querySpy.mockResolvedValue([{ uuid: 'u', path: '/home/.claude/projects/p/u.jsonl' }])
    resolveSpy.mockReturnValue({ uuid: 'u', cwd: 'F:/wt' })
    const out = await invoke(IPC.LOGS_GET_RESUME_TARGET, 's1')
    expect(querySpy).toHaveBeenCalledWith('session-conversation', { sessionId: 's1' })
    expect(resolveSpy).toHaveBeenCalledWith('/home/.claude/projects/p/u.jsonl')
    expect(out).toEqual({ uuid: 'u', cwd: 'F:/wt' })
  })

  it('returns null when neither the live bind nor the durable record exists', async () => {
    getExactResumeTargetSpy.mockReturnValue(null)
    querySpy.mockResolvedValue([])
    const out = await invoke(IPC.LOGS_GET_RESUME_TARGET, 's1')
    expect(out).toBeNull()
    expect(resolveSpy).not.toHaveBeenCalled()
  })

  it('survives a durable-query rejection (returns fresh, never throws)', async () => {
    getExactResumeTargetSpy.mockReturnValue(null)
    querySpy.mockRejectedValue(new Error('worker down'))
    const out = await invoke(IPC.LOGS_GET_RESUME_TARGET, 's1')
    expect(out).toBeNull()
  })

  it('hooks-off: falls back to the heuristic bind and still resolves', async () => {
    isExactBindSourceActiveSpy.mockReturnValue(false)
    getExactResumeTargetSpy.mockReturnValue(null)
    querySpy.mockResolvedValue([])
    getLatestTranscriptPathSpy.mockReturnValue('/home/.claude/projects/p/u.jsonl')
    resolveSpy.mockReturnValue({ uuid: 'u', cwd: 'F:/wt' })
    const out = await invoke(IPC.LOGS_GET_RESUME_TARGET, 's1')
    expect(getLatestTranscriptPathSpy).toHaveBeenCalledWith('s1')
    expect(out).toEqual({ uuid: 'u', cwd: 'F:/wt' })
  })

  it('hooks-on: never falls back to the heuristic (exact-only, no cross)', async () => {
    isExactBindSourceActiveSpy.mockReturnValue(true)
    getExactResumeTargetSpy.mockReturnValue(null)
    querySpy.mockResolvedValue([])
    getLatestTranscriptPathSpy.mockReturnValue('/home/.claude/projects/p/sibling.jsonl')
    const out = await invoke(IPC.LOGS_GET_RESUME_TARGET, 's1')
    expect(getLatestTranscriptPathSpy).not.toHaveBeenCalled()
    expect(out).toBeNull()
  })

  it('is fail-safe (returns null) on an invalid sessionId', async () => {
    const out = await invoke(IPC.LOGS_GET_RESUME_TARGET, '')
    expect(out).toBeNull()
  })
})
