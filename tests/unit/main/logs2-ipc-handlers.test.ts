import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'

// Capture ipcMain.handle registrations so we can invoke handlers directly.
const handlers = new Map<string, (...a: any[]) => any>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
}))

// Mock the supervisor accessor; the spy records the (kind,args) pairs and the
// new-messages subscription so we can drive the push forwarder.
const querySpy = vi.fn()
let newMessagesCb: ((e: { sessionId: string; configId: string | null; count: number }) => void) | null = null
const onNewMessagesSpy = vi.fn((cb: (e: { sessionId: string; configId: string | null; count: number }) => void) => {
  newMessagesCb = cb
  return () => { newMessagesCb = null }
})
let supervisorPresent = true
let exactPathForRename: string | null = null
const renameRunSpy = vi.fn()
vi.mock('../../../src/main/logging/logging-service', () => ({
  getLogSupervisor: () => (supervisorPresent ? { query: querySpy, onNewMessages: onNewMessagesSpy, renameRun: renameRunSpy } : null),
  getTranscriptBinder: () => ({ getExactResumeTarget: (_sid: string) => exactPathForRename }),
}))

// Spy on the sidecar module so the rename handler's write/remember/forget calls
// are observable (#536).
const sidecar = vi.hoisted(() => ({
  rememberSessionName: vi.fn(),
  forgetSessionName: vi.fn(),
  writeNameSidecar: vi.fn(),
  nodeNameSidecarDeps: {},
  writeRealmNameSidecar: vi.fn(),
  nodeRealmNameFs: {},
}))
vi.mock('../../../src/main/logging/session-name-sidecar', () => sidecar)

// P3.12 (row 32): the Codex log binder a Codex session's rename is routed to.
const codex = vi.hoisted(() => ({ binder: null as null | { knows: (sid: string) => boolean; exactRollout: (sid: string) => { path: string; sessionsDir: string } | null } }))
vi.mock('../../../src/main/logging/codex-log-binder', () => ({ getCodexLogBinder: () => codex.binder }))

import { registerLogs2Handlers } from '../../../src/main/ipc/logs2-handlers'

const invoke = (ch: string, ...args: any[]) => handlers.get(ch)!({} as any, ...args)

describe('logs2 IPC handlers', () => {
  let sent: Array<{ channel: string; payload: unknown }>
  let getWindow: () => any

  beforeEach(() => {
    handlers.clear()
    querySpy.mockReset()
    onNewMessagesSpy.mockClear()
    newMessagesCb = null
    supervisorPresent = true
    exactPathForRename = null
    renameRunSpy.mockReset()
    sidecar.rememberSessionName.mockReset()
    sidecar.forgetSessionName.mockReset()
    sidecar.writeNameSidecar.mockReset()
    sidecar.writeRealmNameSidecar.mockReset()
    codex.binder = null
    sent = []
    const win = {
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    }
    getWindow = () => win
    registerLogs2Handlers(getWindow)
  })

  // -------------------------------------------------------------------------
  // Happy paths — route to the correct worker query kind with mapped args
  // -------------------------------------------------------------------------

  it('listSlots routes to query(list-slots) with empty args', async () => {
    querySpy.mockResolvedValue([{ slotKey: 's' }])
    const out = await invoke(IPC.LOGS2_LIST_SLOTS)
    expect(querySpy).toHaveBeenCalledWith('list-slots', {})
    expect(out).toEqual([{ slotKey: 's' }])
  })

  it('readMessages (configId scope, tail) routes to query(read-messages)', async () => {
    querySpy.mockResolvedValue([])
    await invoke(IPC.LOGS2_READ_MESSAGES, { scope: { configId: 'c1' }, anchor: 'tail', dir: 'older', limit: 200 })
    expect(querySpy).toHaveBeenCalledWith('read-messages', { configId: 'c1', anchor: 'tail', dir: 'older', limit: 200 })
  })

  it('readMessages (sessionId scope, pair anchor, newer) routes correctly', async () => {
    querySpy.mockResolvedValue([])
    await invoke(IPC.LOGS2_READ_MESSAGES, {
      scope: { sessionId: 'sess' },
      anchor: { runId: 3, idx: 12 },
      dir: 'newer',
      limit: 50,
    })
    expect(querySpy).toHaveBeenCalledWith('read-messages', {
      sessionId: 'sess',
      anchor: { runId: 3, idx: 12 },
      dir: 'newer',
      limit: 50,
    })
  })

  it('readMessages defaults anchor/dir/limit when omitted', async () => {
    querySpy.mockResolvedValue([])
    await invoke(IPC.LOGS2_READ_MESSAGES, { scope: { configId: 'c1' } })
    expect(querySpy).toHaveBeenCalledWith('read-messages', { configId: 'c1', anchor: 'tail', dir: 'older', limit: 200 })
  })

  it('turnSummary routes to query(turn-summary) with the scope', async () => {
    querySpy.mockResolvedValue([])
    await invoke(IPC.LOGS2_TURN_SUMMARY, { scope: { configId: 'c1' } })
    expect(querySpy).toHaveBeenCalledWith('turn-summary', { configId: 'c1' })
  })

  it('search routes to query(search) with query/limit', async () => {
    querySpy.mockResolvedValue([])
    await invoke(IPC.LOGS2_SEARCH, { query: 'needle', limit: 25 })
    expect(querySpy).toHaveBeenCalledWith('search', { query: 'needle', limit: 25 })
  })

  it('search defaults limit when omitted', async () => {
    querySpy.mockResolvedValue([])
    await invoke(IPC.LOGS2_SEARCH, { query: 'needle' })
    expect(querySpy).toHaveBeenCalledWith('search', { query: 'needle', limit: 50 })
  })

  it('deleteSlot routes to query(delete-slot) and unwraps the single row', async () => {
    querySpy.mockResolvedValue([{ deletedRuns: 2, deletedMessages: 9 }])
    const out = await invoke(IPC.LOGS2_DELETE_SLOT, { scope: { sessionId: 'sess' } })
    expect(querySpy).toHaveBeenCalledWith('delete-slot', { sessionId: 'sess' })
    expect(out).toEqual({ deletedRuns: 2, deletedMessages: 9 })
  })

  it('clearAll routes to query(clear-all) and unwraps the single row', async () => {
    querySpy.mockResolvedValue([{ deletedRuns: 5, deletedMessages: 40 }])
    const out = await invoke(IPC.LOGS2_CLEAR_ALL)
    expect(querySpy).toHaveBeenCalledWith('clear-all', {})
    expect(out).toEqual({ deletedRuns: 5, deletedMessages: 40 })
  })

  it('ingestStatus routes to query(ingest-stats) and unwraps the single row (or null)', async () => {
    querySpy.mockResolvedValue([{ transcripts: [], messageCount: 0 }])
    const out = await invoke(IPC.LOGS2_INGEST_STATUS, { sessionId: 'sess' })
    expect(querySpy).toHaveBeenCalledWith('ingest-stats', { sessionId: 'sess' })
    expect(out).toEqual({ transcripts: [], messageCount: 0 })
  })

  it('ingestStatus returns null when the worker has no row for the session', async () => {
    querySpy.mockResolvedValue([])
    const out = await invoke(IPC.LOGS2_INGEST_STATUS, { sessionId: 'sess' })
    expect(out).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Validation — bad args REJECT before the supervisor is ever called
  // -------------------------------------------------------------------------

  it('readMessages rejects a scope with NEITHER configId nor sessionId', async () => {
    await expect(invoke(IPC.LOGS2_READ_MESSAGES, { scope: {}, anchor: 'tail', dir: 'older', limit: 10 })).rejects.toThrow()
    expect(querySpy).not.toHaveBeenCalled()
  })

  it('readMessages rejects a scope with BOTH configId and sessionId', async () => {
    await expect(
      invoke(IPC.LOGS2_READ_MESSAGES, { scope: { configId: 'c', sessionId: 's' }, anchor: 'tail', dir: 'older', limit: 10 }),
    ).rejects.toThrow()
    expect(querySpy).not.toHaveBeenCalled()
  })

  it('readMessages rejects a bad dir', async () => {
    await expect(
      invoke(IPC.LOGS2_READ_MESSAGES, { scope: { configId: 'c' }, anchor: 'tail', dir: 'sideways', limit: 10 }),
    ).rejects.toThrow()
    expect(querySpy).not.toHaveBeenCalled()
  })

  it('readMessages rejects a limit over the bound', async () => {
    await expect(
      invoke(IPC.LOGS2_READ_MESSAGES, { scope: { configId: 'c' }, anchor: 'tail', dir: 'older', limit: 100000 }),
    ).rejects.toThrow()
    expect(querySpy).not.toHaveBeenCalled()
  })

  it('readMessages rejects a malformed pair anchor (missing idx)', async () => {
    await expect(
      invoke(IPC.LOGS2_READ_MESSAGES, { scope: { configId: 'c' }, anchor: { runId: 1 }, dir: 'older', limit: 10 }),
    ).rejects.toThrow()
    expect(querySpy).not.toHaveBeenCalled()
  })

  it('turnSummary rejects an invalid scope', async () => {
    await expect(invoke(IPC.LOGS2_TURN_SUMMARY, { scope: {} })).rejects.toThrow()
    expect(querySpy).not.toHaveBeenCalled()
  })

  it('search rejects an empty query', async () => {
    await expect(invoke(IPC.LOGS2_SEARCH, { query: '' })).rejects.toThrow()
    expect(querySpy).not.toHaveBeenCalled()
  })

  it('search rejects a limit over the bound', async () => {
    await expect(invoke(IPC.LOGS2_SEARCH, { query: 'x', limit: 99999 })).rejects.toThrow()
    expect(querySpy).not.toHaveBeenCalled()
  })

  it('deleteSlot rejects an invalid scope', async () => {
    await expect(invoke(IPC.LOGS2_DELETE_SLOT, { scope: {} })).rejects.toThrow()
    expect(querySpy).not.toHaveBeenCalled()
  })

  it('ingestStatus rejects a missing sessionId', async () => {
    await expect(invoke(IPC.LOGS2_INGEST_STATUS, {})).rejects.toThrow()
    expect(querySpy).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Supervisor unavailable -> reject (renderer never hangs)
  // -------------------------------------------------------------------------

  it('rejects when the logging supervisor is not running', async () => {
    supervisorPresent = false
    await expect(invoke(IPC.LOGS2_LIST_SLOTS)).rejects.toThrow(/not running/)
  })

  it('rethrows when the underlying query rejects (worker down)', async () => {
    querySpy.mockRejectedValue(new Error('logging worker not available (state=down)'))
    await expect(invoke(IPC.LOGS2_LIST_SLOTS)).rejects.toThrow(/not available/)
  })

  // -------------------------------------------------------------------------
  // new-messages push forwarder
  // -------------------------------------------------------------------------

  it('subscribes to the supervisor new-messages fan-out at registration', () => {
    expect(onNewMessagesSpy).toHaveBeenCalledTimes(1)
    expect(typeof newMessagesCb).toBe('function')
  })

  it('forwards a new-messages event to the window over LOGS2_NEW_MESSAGES', () => {
    newMessagesCb!({ sessionId: 'sess', configId: 'c1', count: 3 })
    expect(sent).toEqual([{ channel: IPC.LOGS2_NEW_MESSAGES, payload: { sessionId: 'sess', configId: 'c1', count: 3 } }])
  })

  it('does not throw when the window is gone during a push', () => {
    const win = getWindow()
    win.isDestroyed = () => true
    expect(() => newMessagesCb!({ sessionId: 'sess', configId: null, count: 1 })).not.toThrow()
    expect(sent).toEqual([])
  })

  it('does not subscribe when the supervisor is absent at registration', () => {
    handlers.clear()
    onNewMessagesSpy.mockClear()
    supervisorPresent = false
    registerLogs2Handlers(getWindow)
    expect(onNewMessagesSpy).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // #536 — rename carries the name onto the transcript via the sidecar
  // -------------------------------------------------------------------------

  it('rename while BOUND writes the sidecar with customName and RETIRES the pending entry (no /clear bleed)', async () => {
    exactPathForRename = 'C:\\p\\aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'
    await invoke(IPC.LOGS2_RENAME_SESSION, { sessionId: 's1', configLabel: 'Config A', customName: 'Auth Bug' })
    expect(renameRunSpy).toHaveBeenCalledWith('s1', 'Config A')
    expect(sidecar.writeNameSidecar).toHaveBeenCalledWith(exactPathForRename, 'Auth Bug', sidecar.nodeNameSidecarDeps)
    // The critical regression guard: an already-bound rename must NOT leave a
    // pending entry, or it bleeds onto the next conversation after a /clear.
    expect(sidecar.forgetSessionName).toHaveBeenCalledWith('s1')
    expect(sidecar.rememberSessionName).not.toHaveBeenCalled()
  })

  it('rename while NOT bound remembers the name (onExactBind writes it later), no direct write', async () => {
    exactPathForRename = null
    await invoke(IPC.LOGS2_RENAME_SESSION, { sessionId: 's2', configLabel: 'Config A', customName: 'Docs sweep' })
    expect(sidecar.rememberSessionName).toHaveBeenCalledWith('s2', 'Docs sweep')
    expect(sidecar.writeNameSidecar).not.toHaveBeenCalled()
  })

  it('a blank customName is the cleared signal (empty string, not the config label)', async () => {
    exactPathForRename = 'C:\\p\\aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'
    await invoke(IPC.LOGS2_RENAME_SESSION, { sessionId: 's3', configLabel: 'Config A', customName: '' })
    expect(sidecar.writeNameSidecar).toHaveBeenCalledWith(exactPathForRename, '', sidecar.nodeNameSidecarDeps)
  })

  it('back-compat: an omitted customName falls back to configLabel', async () => {
    exactPathForRename = null
    await invoke(IPC.LOGS2_RENAME_SESSION, { sessionId: 's4', configLabel: 'Config A' })
    expect(sidecar.rememberSessionName).toHaveBeenCalledWith('s4', 'Config A')
  })

  // -------------------------------------------------------------------------
  // P3.12 (row 32): a Codex session's rename writes the name file next to its
  // exactly claimed rollout, in its realm; else it is remembered
  // -------------------------------------------------------------------------

  const ROLLOUT = { path: 'C:\\r\\sessions\\2026\\09\\29\\rollout-2026-09-29T10-00-00-019dd000-0001-7000-8000-00000000000a.jsonl', sessionsDir: 'C:\\r\\sessions' }

  it('P3.12: a Codex session exactly on a rollout: the name file is written there (the realm writer), the pending entry retired; never Claude\'s sidecar', async () => {
    exactPathForRename = 'C:\\claude\\aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'
    codex.binder = { knows: (sid) => sid === 'cx1', exactRollout: () => ROLLOUT }
    await invoke(IPC.LOGS2_RENAME_SESSION, { sessionId: 'cx1', configLabel: 'Codex A', customName: 'Auth Bug' })
    expect(renameRunSpy).toHaveBeenCalledWith('cx1', 'Codex A')
    expect(sidecar.writeRealmNameSidecar).toHaveBeenCalledWith(ROLLOUT.path, ROLLOUT.sessionsDir, 'Auth Bug', sidecar.nodeRealmNameFs)
    expect(sidecar.forgetSessionName).toHaveBeenCalledWith('cx1')
    expect(sidecar.writeNameSidecar).not.toHaveBeenCalled()
    expect(sidecar.rememberSessionName).not.toHaveBeenCalled()
  })

  it('P3.12: a Codex session not yet exactly on a rollout: remembered for its exact claim, nothing written', async () => {
    exactPathForRename = 'C:\\claude\\aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'
    codex.binder = { knows: (sid) => sid === 'cx2', exactRollout: () => null }
    await invoke(IPC.LOGS2_RENAME_SESSION, { sessionId: 'cx2', configLabel: 'Codex A', customName: 'Docs' })
    expect(sidecar.rememberSessionName).toHaveBeenCalledWith('cx2', 'Docs')
    expect(sidecar.writeRealmNameSidecar).not.toHaveBeenCalled()
    expect(sidecar.writeNameSidecar).not.toHaveBeenCalled()
  })

  it('P3.12: a session the Codex binder does not know takes Claude\'s path, as before', async () => {
    exactPathForRename = 'C:\\p\\aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'
    codex.binder = { knows: () => false, exactRollout: () => ROLLOUT }
    await invoke(IPC.LOGS2_RENAME_SESSION, { sessionId: 's9', configLabel: 'Config A', customName: 'X' })
    expect(sidecar.writeNameSidecar).toHaveBeenCalledWith(exactPathForRename, 'X', sidecar.nodeNameSidecarDeps)
    expect(sidecar.writeRealmNameSidecar).not.toHaveBeenCalled()
  })
})
