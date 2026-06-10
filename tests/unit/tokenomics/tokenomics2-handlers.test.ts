import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (e: any, a: any) => any>()
vi.mock('electron', () => ({ ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn) } }))

let stubSup: any
vi.mock('../../../src/main/tokenomics/tokenomics-service', () => ({ getTokenomicsSupervisor: () => stubSup }))

import { registerTokenomics2Handlers } from '../../../src/main/ipc/tokenomics2-handlers'
import { IPC } from '../../../src/shared/ipc-channels'

const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }

describe('tokenomics2 handlers', () => {
  beforeEach(() => {
    handlers.clear()
    const progressSubs: any[] = []; const completeSubs: any[] = []
    stubSup = {
      query: vi.fn(async (kind: string) => {
        if (kind === 'summary') return [{ kpis: {} }]
        if (kind === 'sessions') return [{ rows: [{ sessionId: 's1' }], nextCursor: null }]
        if (kind === 'session-detail') return [{ sessionId: 's1' }]
        if (kind === 'index-status') return [{ firstIndexComplete: true, indexing: false, filesDone: 1, filesTotal: 1, eventsTotal: 5, lastIndexAt: 1 }]
        return []
      }),
      onIndexProgress: (cb: any) => { progressSubs.push(cb); return () => {} },
      onIndexComplete: (cb: any) => { completeSubs.push(cb); return () => {} },
      _progressSubs: progressSubs, _completeSubs: completeSubs,
    }
    registerTokenomics2Handlers(() => win as any)
  })

  it('summary handler validates + unwraps rows[0]', async () => {
    const r = await handlers.get(IPC.TOKENOMICS2_SUMMARY)!({}, { configId: 'a' })
    expect(r).toEqual({ kpis: {} })
    expect(stubSup.query).toHaveBeenCalledWith('summary', { configId: 'a' })
  })

  it('sessions handler returns the page', async () => {
    const r = await handlers.get(IPC.TOKENOMICS2_SESSIONS)!({}, {})
    expect(r.rows[0].sessionId).toBe('s1')
  })

  it('sessionDetail validates sessionId (rejects when missing)', async () => {
    const r = await handlers.get(IPC.TOKENOMICS2_SESSION_DETAIL)!({}, { sessionId: 's1' })
    expect(r.sessionId).toBe('s1')
    await expect(handlers.get(IPC.TOKENOMICS2_SESSION_DETAIL)!({}, {})).rejects.toBeTruthy()
  })

  it('indexStatus returns worker DB-truth', async () => {
    const r = await handlers.get(IPC.TOKENOMICS2_INDEX_STATUS)!({}, undefined)
    expect(r.firstIndexComplete).toBe(true)
    expect(r.eventsTotal).toBe(5)
  })

  it('rejects malformed summary args (Zod strict)', async () => {
    await expect(handlers.get(IPC.TOKENOMICS2_SUMMARY)!({}, { bogus: 1 })).rejects.toBeTruthy()
  })

  it('forwards index-progress/complete to the window', () => {
    stubSup._progressSubs[0]({ filesDone: 1, filesTotal: 2, eventsIngested: 3, phase: 'initial' })
    stubSup._completeSubs[0]({ firstIndex: true, eventsTotal: 5 })
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.TOKENOMICS2_INDEX_PROGRESS, expect.anything())
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.TOKENOMICS2_INDEX_COMPLETE, expect.anything())
  })
})
