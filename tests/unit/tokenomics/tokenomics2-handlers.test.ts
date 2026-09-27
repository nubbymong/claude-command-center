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
    const progressSubs: any[] = []; const completeSubs: any[] = []; const errorSubs: any[] = []
    win.webContents.send.mockClear()
    stubSup = {
      query: vi.fn(async (kind: string) => {
        if (kind === 'summary') return [{ kpis: {} }]
        if (kind === 'sessions') return [{ rows: [{ sessionId: 's1' }], nextCursor: null }]
        if (kind === 'session-detail') return [{ sessionId: 's1' }]
        if (kind === 'index-status') return [{ firstIndexComplete: true, indexing: false, filesDone: 1, filesTotal: 1, eventsTotal: 5, lastIndexAt: 1 }]
        return []
      }),
      getIndexStatus: vi.fn(() => ({ firstIndexComplete: false, indexing: false, filesDone: 0, filesTotal: 0, eventsTotal: 0, lastIndexAt: null, error: 'open failed' })),
      onIndexProgress: (cb: any) => { progressSubs.push(cb); return () => {} },
      onIndexComplete: (cb: any) => { completeSubs.push(cb); return () => {} },
      onIndexError: (cb: any) => { errorSubs.push(cb); return () => {} },
      _progressSubs: progressSubs, _completeSubs: completeSubs, _errorSubs: errorSubs,
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

  it('forwards an uncorrelated worker fault on the INDEX_STATUS channel', () => {
    stubSup._errorSubs[0]({ firstIndexComplete: false, indexing: false, error: 'open failed', filesDone: 0, filesTotal: 0, eventsTotal: 0, lastIndexAt: null })
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.TOKENOMICS2_INDEX_STATUS, expect.objectContaining({ error: 'open failed', indexing: false }))
  })

  it('indexStatus falls back to the supervisor status (with error) when the worker query rejects', async () => {
    stubSup.query = vi.fn(async () => { throw new Error('worker not ready') })
    const r = await handlers.get(IPC.TOKENOMICS2_INDEX_STATUS)!({}, undefined)
    expect(r.error).toBe('open failed')
    expect(r.indexing).toBe(false)
  })
})

// Usage track MP9: the provider and account filters, and the accounts query.
describe('tokenomics2 handlers: provider and account (usage track MP9)', () => {
  beforeEach(() => {
    handlers.clear()
    stubSup = {
      query: vi.fn(async (kind: string) => {
        if (kind === 'summary') return [{ kpis: {} }]
        if (kind === 'sessions') return [{ rows: [], nextCursor: null }]
        if (kind === 'accounts') return [[{ provider: 'codex', accountKey: 'codex:external' }]]
        return []
      }),
      onIndexProgress: () => () => {}, onIndexComplete: () => () => {}, onIndexError: () => () => {},
    }
    registerTokenomics2Handlers(() => win as any)
  })

  it('summary and sessions take a provider and an account key, not recorded included', async () => {
    for (const f of [{ provider: 'codex', accountKey: 'codex:acct-0123abcd' }, { provider: 'claude' }, { accountKey: '' }, { accountKey: 'codex:external' }]) {
      await handlers.get(IPC.TOKENOMICS2_SUMMARY)!({}, f)
      expect(stubSup.query).toHaveBeenLastCalledWith('summary', f)
      await handlers.get(IPC.TOKENOMICS2_SESSIONS)!({}, { ...f, limit: 10 })
      expect(stubSup.query).toHaveBeenLastCalledWith('sessions', { ...f, limit: 10 })
    }
  })

  it('refuses an unknown provider and any account key that is not "" or provider:id, before the worker is asked', async () => {
    const bad: unknown[] = [
      { provider: 'gemini' }, { provider: '' }, { provider: 1 },
      { accountKey: 'codex' }, { accountKey: 'codex:' }, { accountKey: 'gemini:x' }, { accountKey: 'codex:a b' },
      { accountKey: "codex:x' OR 1=1" }, { accountKey: 'codex:' + 'a'.repeat(129) }, { accountKey: null }, { accountKey: 7 },
    ]
    for (const f of bad) {
      await expect(handlers.get(IPC.TOKENOMICS2_SUMMARY)!({}, f), JSON.stringify(f)).rejects.toBeTruthy()
      await expect(handlers.get(IPC.TOKENOMICS2_SESSIONS)!({}, f), JSON.stringify(f)).rejects.toBeTruthy()
    }
    expect(stubSup.query).not.toHaveBeenCalled()
  })

  it('the accounts query takes nothing and answers the list', async () => {
    expect(await handlers.get(IPC.TOKENOMICS2_ACCOUNTS)!({}, {})).toEqual([{ provider: 'codex', accountKey: 'codex:external' }])
    expect(stubSup.query).toHaveBeenLastCalledWith('accounts', {})
    expect(await handlers.get(IPC.TOKENOMICS2_ACCOUNTS)!({}, undefined)).toEqual([{ provider: 'codex', accountKey: 'codex:external' }])
    await expect(handlers.get(IPC.TOKENOMICS2_ACCOUNTS)!({}, { provider: 'codex' })).rejects.toBeTruthy()
    stubSup.query.mockResolvedValueOnce([])
    expect(await handlers.get(IPC.TOKENOMICS2_ACCOUNTS)!({}, {})).toEqual([])
  })
})
