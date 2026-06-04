/**
 * Pure unit test (system Node) for LogSupervisor.migrate(). Uses FakeWorkerTransport
 * to simulate the worker: the supervisor posts a 'migrate' op and resolves the
 * returned promise on the matching 'migrate-progress', rejects it on a matching
 * 'migrate-error', and rejects fast when the worker is not listening or exits
 * mid-flight (it can never hang).
 */
import { describe, it, expect, vi } from 'vitest'
import { LogSupervisor } from '../../../src/main/logging/log-supervisor'
import { FakeWorkerTransport } from '../../../src/main/logging/log-worker-transport'
import type { ForkedLogWorker } from '../../../src/main/logging/fork-log-worker'

function makeSup() {
  const transport = new FakeWorkerTransport()
  let exitCb: (() => void) | null = null
  const fork = (): ForkedLogWorker => ({
    transport,
    kill: () => transport.kill(),
    onExit: (cb) => { exitCb = cb },
  })
  const emit = vi.fn()
  const sup = new LogSupervisor({ forkChild: fork, dbPath: ':memory:', emit })
  return { sup, transport, emit, triggerExit: () => exitCb?.() }
}

describe('LogSupervisor.migrate', () => {
  it('rejects fast when the worker is not listening', async () => {
    const { sup } = makeSup()
    await expect(sup.migrate([], 0)).rejects.toThrow(/not available/i)
  })

  it('posts a migrate op and resolves on the matching migrate-progress', async () => {
    const { sup, transport } = makeSup()
    sup.start()
    transport.onWorker((msg) => {
      if (msg.type === 'migrate') {
        transport.emitToMain({ type: 'migrate-progress', id: msg.id, importedSessions: msg.sessions.length, skippedSessions: 0, importedEvents: msg.sessions.length })
      }
    })
    transport.emitToMain({ type: 'ready' })
    const chunk = [{ sessionId: 'a', configLabel: 'L', provider: 'claude', startedAt: 1, events: [{ ts: 1, type: 'data' as const, raw: new Uint8Array([1]), text: 'x' }] }]
    const res = await sup.migrate(chunk, 1)
    expect(res.importedSessions).toBe(1)
    expect(res.importedEvents).toBe(1)
    const posted = transport.workerMessages.find((m) => m.type === 'migrate')
    expect(posted).toBeTruthy()
  })

  it('rejects a pending migrate on a matching migrate-error', async () => {
    const { sup, transport } = makeSup()
    sup.start()
    transport.onWorker((msg) => {
      if (msg.type === 'migrate') {
        transport.emitToMain({ type: 'migrate-error', id: msg.id, message: 'boom' })
      }
    })
    transport.emitToMain({ type: 'ready' })
    await expect(sup.migrate([], 7)).rejects.toThrow(/boom/)
  })

  it('rejects an in-flight migrate when the worker exits', async () => {
    const { sup, transport, triggerExit } = makeSup()
    sup.start()
    transport.emitToMain({ type: 'ready' })
    const p = sup.migrate([], 5)
    triggerExit()
    await expect(p).rejects.toThrow(/exited|shutting down/i)
  })
})
