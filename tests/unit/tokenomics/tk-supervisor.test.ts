import { describe, it, expect } from 'vitest'
import { TokenomicsSupervisor } from '../../../src/main/tokenomics/tk-supervisor'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'

function fakeFork() {
  const t = new FakeTkWorkerTransport()
  t.onWorker((m) => {
    if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 })
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
    fork._t.emitToMain({ type: 'index-complete', firstIndex: true, drained: true, filesFailed: 0, eventsTotal: 5 })
    expect(progresses).toHaveLength(1)
    expect(done).toBe(true)
    expect(sup.getIndexStatus().firstIndexComplete).toBe(true)
  })

  it('reports firstIndexComplete after a DRAINED sweep, including a reopen with firstIndex:false', () => {
    const fork = fakeFork()
    const sup = new TokenomicsSupervisor({ forkChild: (() => fork) as any, ...baseOpts() })
    sup.start()
    fork._t.emitToMain({ type: 'index-complete', firstIndex: false, drained: true, filesFailed: 0, eventsTotal: 9 })
    expect(sup.getIndexStatus().firstIndexComplete).toBe(true)
  })

  it('a sweep that finished WITHOUT draining does not count as a first index', () => {
    // This is the one that matters. A sweep finishing is not the same as every
    // file having been read: a per-tick byte budget means a multi-GB rollout
    // needs tens of sweeps. Latching on the message put the dashboard up over a
    // fraction of the user's spend and presented it as the whole figure.
    const fork = fakeFork()
    const sup = new TokenomicsSupervisor({ forkChild: (() => fork) as any, ...baseOpts() })
    sup.start()
    fork._t.emitToMain({ type: 'index-complete', firstIndex: false, drained: false, filesFailed: 0, eventsTotal: 3 })
    expect(sup.getIndexStatus().firstIndexComplete).toBe(false)
    expect(sup.getIndexStatus().indexing).toBe(true)
    // ...and the honest signal still arrives once the tree really is drained.
    fork._t.emitToMain({ type: 'index-complete', firstIndex: true, drained: true, filesFailed: 0, eventsTotal: 20 })
    expect(sup.getIndexStatus().firstIndexComplete).toBe(true)
  })

  it('query timeout rejects without hanging', async () => {
    const t = new FakeTkWorkerTransport()
    t.onWorker((m) => { if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 }) /* never answers queries */ })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts(), queryTimeoutMs: 30 })
    sup.start()
    await expect(sup.query('summary', {})).rejects.toThrow(/timed out/)
  })

  it('surfaces an uncorrelated worker error as a fatal index status (stops indexing)', () => {
    const t = new FakeTkWorkerTransport()
    // Emulate a failed DB open: worker stays alive, never posts `ready`, and
    // posts an UNcorrelated error (no id).
    t.onWorker((m) => { if (m.type === 'open') t.emitToMain({ type: 'error', message: 'open failed: disk I/O error' }) })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts() })
    const errs: any[] = []
    sup.onIndexError((s) => errs.push(s))
    sup.start()
    expect(errs).toHaveLength(1)
    expect(errs[0].error).toMatch(/open failed/)
    const status = sup.getIndexStatus()
    expect(status.error).toMatch(/open failed/)
    expect(status.indexing).toBe(false)          // no perpetual spinner
    expect(status.firstIndexComplete).toBe(false)
  })

  it('a correlated error still rejects its query and is NOT treated as fatal', async () => {
    const t = new FakeTkWorkerTransport()
    t.onWorker((m) => {
      if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 })
      if (m.type === 'query') t.emitToMain({ type: 'error', id: m.id, message: 'bad query' })
    })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts() })
    const errs: any[] = []
    sup.onIndexError((s) => errs.push(s))
    sup.start()
    await expect(sup.query('summary', {})).rejects.toThrow(/bad query/)
    expect(errs).toHaveLength(0)
    expect(sup.getIndexStatus().error ?? null).toBe(null)
  })

  it('takes a completed index from the ready message, before any sweep runs', () => {
    // The supervisor learned this ONLY from a fresh index-complete, so a machine
    // whose index had been complete for months still showed "Indexing usage
    // data" on every launch — and showed it forever if the sweep wedged. The
    // line that fixed it had no test at all: deleting it left the whole suite
    // green, which is the state that lets a fix quietly stop working.
    const t = new FakeTkWorkerTransport()
    t.onWorker((m) => { if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: true, eventsTotal: 4200 }) })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts() })
    sup.start()
    const status = sup.getIndexStatus()
    expect(status.firstIndexComplete).toBe(true)
    expect(status.indexing).toBe(false)
    expect(status.eventsTotal).toBe(4200)
  })

  it('a ready that reports no completed index leaves the page indexing', () => {
    const t = new FakeTkWorkerTransport()
    t.onWorker((m) => { if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 }) })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts() })
    sup.start()
    expect(sup.getIndexStatus().firstIndexComplete).toBe(false)
    expect(sup.getIndexStatus().indexing).toBe(true)
  })

  it('shutdown rejects pending queries and is safe', async () => {
    const t = new FakeTkWorkerTransport()
    t.onWorker((m) => { if (m.type === 'open') t.emitToMain({ type: 'ready', firstIndexComplete: false, eventsTotal: 0 }) })
    const sup = new TokenomicsSupervisor({ forkChild: (() => ({ transport: t, kill: () => {}, onExit: () => {} })) as any, ...baseOpts(), queryTimeoutMs: 5000 })
    sup.start()
    const p = sup.query('summary', {})
    sup.shutdown()
    await expect(p).rejects.toThrow()
    expect(() => sup.shutdown()).not.toThrow()
  })
})
