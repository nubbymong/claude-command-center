import { describe, it, expect, vi } from 'vitest'
import { createSessionDurability } from '../../../src/main/session-durability'
import type { SessionState } from '../../../src/main/session-state'

// #397: the cross-exit durability core. These pin F1 (a cleared set is never
// resurrected by the exit flush), N3 (an honest log on a latch-refused flush), and
// the fail-safe rules the adversarial-review lead required.

const target = { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd: 'C:/p' }

function make(saveImpl?: (s: SessionState) => boolean, log?: (m: string) => void) {
  const save = vi.fn(saveImpl ?? (() => true))
  const enrichDeps = {
    getLatestTranscriptPath: () => '/x/f.jsonl',
    resolveResumeTargetFromTranscript: () => target,
  }
  const d = createSessionDurability({ enrichDeps, save, log })
  return { d, save }
}

const state = (): SessionState =>
  ({ sessions: [{ id: 's1', provider: 'claude' } as any], activeSessionId: 's1', savedAt: 1 } as SessionState)

describe('createSessionDurability', () => {
  it('saveEnriched enriches from the binder, caches, and returns the save result', () => {
    const { d, save } = make()
    expect(d.saveEnriched(state())).toBe(true)
    expect(save).toHaveBeenCalledOnce()
    expect(d.peek()?.sessions[0]).toMatchObject({ resumeUuid: target.uuid, resumeCwd: target.cwd })
  })

  it('flushOnExit persists the cached state', () => {
    const { d, save } = make()
    d.saveEnriched(state())
    save.mockClear()
    d.flushOnExit('before-quit')
    expect(save).toHaveBeenCalledOnce()
  })

  it('flushOnExit is a no-op before anything was saved this run', () => {
    const { d, save } = make()
    d.flushOnExit('before-quit')
    expect(save).not.toHaveBeenCalled()
  })

  it('F1: flushOnExit does NOT resurrect a set after noteCleared()', () => {
    const { d, save } = make()
    d.saveEnriched(state())
    d.noteCleared()
    save.mockClear()
    d.flushOnExit('before-quit')
    expect(save).not.toHaveBeenCalled()
    expect(d.peek()).toBeNull()
  })

  it('N3: flushOnExit logs REFUSED (not success) when the save is refused by the latch', () => {
    const log = vi.fn()
    const { d } = make(() => false, log)
    d.saveEnriched(state())
    log.mockClear()
    d.flushOnExit('SIGTERM')
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0][0]).toMatch(/REFUSED/)
  })

  it('flushOnExit swallows a save throw and reports it', () => {
    const log = vi.fn()
    let throwNow = false
    const { d } = make(() => { if (throwNow) throw new Error('disk gone'); return true }, log)
    d.saveEnriched(state()) // seeds cache, save returns true
    throwNow = true
    log.mockClear()
    expect(() => d.flushOnExit('before-quit')).not.toThrow()
    expect(log.mock.calls[0][0]).toMatch(/failed/)
  })
})
