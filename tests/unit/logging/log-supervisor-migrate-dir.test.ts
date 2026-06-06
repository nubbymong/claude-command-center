/**
 * Pure unit test (system Node) for LogSupervisor.migrateDir() — the long-running
 * worker-internal directory migration. The supervisor posts ONE 'migrate-dir' op,
 * routes 'migrate-dir-progress' to the caller's callback (refreshing the
 * inactivity guard), resolves with the final report on 'migrate-dir-done',
 * rejects on a matching 'migrate-error', when the worker is unavailable, and on
 * worker exit mid-flight — like query()/migrate(), it can never hang.
 */
import { describe, it, expect, vi } from 'vitest'
import { LogSupervisor } from '../../../src/main/logging/log-supervisor'
import { FakeWorkerTransport } from '../../../src/main/logging/log-worker-transport'
import type { ForkedLogWorker } from '../../../src/main/logging/fork-log-worker'
import type { DirMigrationReport } from '../../../src/main/logging/log-worker-transport'

const REPORT: DirMigrationReport = {
  totalSessions: 2,
  importedSessions: 2,
  skippedSessions: 0,
  failedSessions: 0,
  importedEvents: 9,
  unparseable: [],
  foldedPartnerDirs: 1,
  noEventDirs: 0,
}

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

describe('LogSupervisor.migrateDir', () => {
  it('rejects fast when the worker is not listening', async () => {
    const { sup } = makeSup()
    await expect(sup.migrateDir('C:/legacy/logs')).rejects.toThrow(/not available/i)
  })

  it('posts migrate-dir, streams progress to the callback, resolves with the done report', async () => {
    const { sup, transport } = makeSup()
    sup.start()
    transport.onWorker((msg) => {
      if (msg.type === 'migrate-dir') {
        expect(msg.logsDir).toBe('C:/legacy/logs')
        transport.emitToMain({ type: 'migrate-dir-progress', id: msg.id, done: 1, total: 2 })
        transport.emitToMain({ type: 'migrate-dir-progress', id: msg.id, done: 2, total: 2 })
        transport.emitToMain({ type: 'migrate-dir-done', id: msg.id, report: REPORT })
      }
    })
    transport.emitToMain({ type: 'ready' })

    const progress: Array<[number, number]> = []
    const report = await sup.migrateDir('C:/legacy/logs', (done, total) => progress.push([done, total]))
    expect(report).toEqual(REPORT)
    expect(progress).toEqual([[1, 2], [2, 2]])
  })

  it('rejects on a matching migrate-error', async () => {
    const { sup, transport } = makeSup()
    sup.start()
    transport.onWorker((msg) => {
      if (msg.type === 'migrate-dir') {
        transport.emitToMain({ type: 'migrate-error', id: msg.id, message: 'already running' })
      }
    })
    transport.emitToMain({ type: 'ready' })
    await expect(sup.migrateDir('C:/legacy/logs')).rejects.toThrow(/already running/)
  })

  it('rejects an in-flight migrateDir when the worker exits', async () => {
    const { sup, transport, triggerExit } = makeSup()
    sup.start()
    transport.emitToMain({ type: 'ready' })
    const p = sup.migrateDir('C:/legacy/logs')
    triggerExit()
    await expect(p).rejects.toThrow(/exited|shutting down/i)
  })

  it('rejects after sustained inactivity (no progress) — but progress refreshes the guard', async () => {
    vi.useFakeTimers()
    try {
      const { sup, transport } = makeSup()
      sup.start()
      transport.emitToMain({ type: 'ready' })

      let dirId = -1
      transport.onWorker((msg) => { if (msg.type === 'migrate-dir') dirId = msg.id })
      const p = sup.migrateDir('C:/legacy/logs')
      const guard = expect(p).rejects.toThrow(/no progress/i)

      // Progress at 100s keeps it alive past the 120s inactivity budget...
      vi.advanceTimersByTime(100_000)
      transport.emitToMain({ type: 'migrate-dir-progress', id: dirId, done: 1, total: 9 })
      vi.advanceTimersByTime(100_000)
      transport.emitToMain({ type: 'migrate-dir-progress', id: dirId, done: 2, total: 9 })
      // ...then sustained silence rejects.
      vi.advanceTimersByTime(121_000)
      await guard
    } finally {
      vi.useRealTimers()
    }
  })
})
