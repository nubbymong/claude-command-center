import { describe, it, expect } from 'vitest'
import { TokenomicsSupervisor } from '../../../src/main/tokenomics/tk-supervisor'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'

function fakeFork() {
  const t = new FakeTkWorkerTransport()
  t.onWorker((m) => {
    if (m.type === 'open') t.emitToMain({ type: 'ready' })
    if (m.type === 'query') t.emitToMain({ type: 'query-result', id: m.id, rows: [{ ok: m.kind }] })
  })
  return { transport: t, kill: () => t.kill(), onExit: () => {}, _t: t }
}

const baseOpts = () => ({ dbPath: ':memory:', pricing: {}, configs: [], claudeProjectsDir: '/c', codexSessionsDir: '/x', emit: () => {} })

describe('TokenomicsSupervisor', () => {
  it('starts, opens, and resolves queries', async () => {
    const sup = new TokenomicsSupervisor({ forkChild: fakeFork as any, ...baseOpts() })
    sup.start()
    const rows = await sup.query('summary', {})
    expect(rows).toEqual([{ ok: 'summary' }])
  })

  it('query rejects (never hangs) when worker not listening', async () => {
    const sup = new TokenomicsSupervisor({ forkChild: (() => { const t = new FakeTkWorkerTransport(); return { transport: t, kill: () => {}, onExit: () => {} } }) as any, ...baseOpts() })
    // not started -> not listening
    await expect(sup.query('summary', {})).rejects.toThrow()
  })

  it('forwards index-progress + index-complete to subscribers + tracks status', async () => {
    const fork = fakeFork()
    const sup = new TokenomicsSupervisor({ forkChild: (() => fork) as any, ...baseOpts() })
    let done = false
    const progresses: any[] = []
    sup.onIndexProgress((p) => progresses.push(p))
    sup.onIndexComplete(() => { done = true })
    sup.start()
    fork._t.emitToMain({ type: 'index-progress', filesDone: 1, filesTotal: 2, eventsIngested: 3, phase: 'initial' })
    fork._t.emitToMain({ type: 'index-complete', firstIndex: true, eventsTotal: 5 })
    expect(progresses).toHaveLength(1)
    expect(done).toBe(true)
    expect(sup.getIndexStatus().firstIndexComplete).toBe(true)
  })

  it('getIndexStatus reports firstIndexComplete true after ANY index-complete (incl. reopen firstIndex:false)', () => {
    const fork = fakeFork()
    const sup = new TokenomicsSupervisor({ forkChild: (() => fork) as any, ...baseOpts() })
    sup.start()
    fork._t.emitToMain({ type: 'index-complete', firstIndex: false, eventsTotal: 9 })
    expect(sup.getIndexStatus().firstIndexComplete).toBe(true)
  })

  it('query timeout rejects without hanging', async () => {
    const t = new FakeTkWorkerTransport()
    t.onWorker((m) => { if (m.type === 'open') t.emitToMain({ type: 'ready' }) /* never answers queries */ })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts(), queryTimeoutMs: 30 })
    sup.start()
    await expect(sup.query('summary', {})).rejects.toThrow(/timed out/)
  })

  it('shutdown rejects pending queries and is safe', async () => {
    const t = new FakeTkWorkerTransport()
    t.onWorker((m) => { if (m.type === 'open') t.emitToMain({ type: 'ready' }) })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts(), queryTimeoutMs: 5000 })
    sup.start()
    const p = sup.query('summary', {})
    sup.shutdown()
    await expect(p).rejects.toThrow()
    expect(() => sup.shutdown()).not.toThrow()
  })
})
