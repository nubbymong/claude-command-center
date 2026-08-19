import { describe, it, expect } from 'vitest'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'
import type { ToTkWorker, FromTkWorker } from '../../../src/main/tokenomics/tk-worker-transport'

describe('FakeTkWorkerTransport', () => {
  it('records posts and round-trips worker<->main', () => {
    const t = new FakeTkWorkerTransport()
    const fromMain: ToTkWorker[] = []
    const fromWorker: FromTkWorker[] = []
    t.onWorker((m) => fromMain.push(m))
    t.onMessage((m) => fromWorker.push(m))
    t.post({ type: 'open', dbPath: ':memory:', pricing: {}, configs: [], claudeProjectsDir: '/c', codexSessionsDir: '/x' })
    expect(t.workerMessages).toHaveLength(1)
    expect(fromMain[0].type).toBe('open')
    t.emitToMain({ type: 'ready', firstIndexComplete: true, eventsTotal: 7 })
    expect(fromWorker[0]).toEqual({ type: 'ready', firstIndexComplete: true, eventsTotal: 7 })
  })
  it('kill() flips killed', () => {
    const t = new FakeTkWorkerTransport(); t.kill(); expect(t.killed).toBe(true)
  })
})
