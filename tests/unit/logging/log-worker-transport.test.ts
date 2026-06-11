import type { ToTranscriptsWorker, FromTranscriptsWorker } from '../../../src/main/logging/log-worker-transport'
import { FakeTranscriptsWorkerTransport } from '../../../src/main/logging/log-worker-transport'
import { describe, it, expect } from 'vitest'

describe('log worker transport', () => {
  // --- Transcripts contract (Logs v2) ---

  describe('transcripts message unions', () => {
    it('run-start carries full meta; optional fields may be absent', () => {
      const full: ToTranscriptsWorker = {
        type: 'run-start',
        meta: {
          sessionId: 's1',
          configId: 'cfg1',
          configLabel: 'My Config',
          projectCwd: '/home/user/proj',
          accountEmail: 'user@example.com',
          profileId: 'prof1',
          provider: 'claude',
          startedAt: 1700000000000,
        },
      }
      expect(full.meta.sessionId).toBe('s1')
      const minimal: ToTranscriptsWorker = {
        type: 'run-start',
        meta: { sessionId: 's2', configLabel: 'Min', provider: 'claude', startedAt: 1 },
      }
      if (minimal.type === 'run-start') expect(minimal.meta.configId).toBeUndefined()
    })

    it('run-end / run-account carry session lifecycle fields', () => {
      const end: ToTranscriptsWorker = { type: 'run-end', sessionId: 's1', ts: 5, status: 'exited' }
      const acc: ToTranscriptsWorker = { type: 'run-account', sessionId: 's1', accountEmail: 'a@b.c' }
      expect(end.status).toBe('exited')
      expect(acc.accountEmail).toBe('a@b.c')
    })

    it('transcript-bind carries path + confidence + optional sourceVersion', () => {
      const b: ToTranscriptsWorker = {
        type: 'transcript-bind',
        sessionId: 's1',
        path: 'C:/t/a.jsonl',
        confidence: 'heuristic',
        sourceVersion: '2.1.0',
      }
      expect(b.confidence).toBe('heuristic')
      const minimal: ToTranscriptsWorker = {
        type: 'transcript-bind', sessionId: 's1', path: 'C:/t/b.jsonl', confidence: 'exact',
      }
      if (minimal.type === 'transcript-bind') expect(minimal.sourceVersion).toBeUndefined()
    })

    it('health carries tailing + messagesTotal; new-messages carries scope + count', () => {
      const h: FromTranscriptsWorker = { type: 'health', inFlight: 0, tailing: 2, messagesTotal: 41, dbBytes: 9 }
      if (h.type === 'health') expect(h.tailing).toBe(2)
      const n: FromTranscriptsWorker = { type: 'new-messages', sessionId: 's1', configId: null, count: 3 }
      if (n.type === 'new-messages') {
        expect(n.configId).toBeNull()
        expect(n.count).toBe(3)
      }
    })

    it('error accepts optional id for query correlation', () => {
      const e: FromTranscriptsWorker = { type: 'error', id: 7, message: 'unknown query kind: bogus' }
      if (e.type === 'error') expect(e.id).toBe(7)
    })
  })

  describe('FakeTranscriptsWorkerTransport', () => {
    it('routes post() to the worker handler and records workerMessages', () => {
      const fake = new FakeTranscriptsWorkerTransport()
      const received: ToTranscriptsWorker[] = []
      fake.onWorker((m) => received.push(m))
      fake.post({ type: 'open', dbPath: '/x.db' })
      fake.post({ type: 'shutdown' })
      expect(received.map((m) => m.type)).toEqual(['open', 'shutdown'])
      expect(fake.workerMessages).toHaveLength(2)
    })

    it('asWorkerSide() returns the inverse transport', () => {
      const fake = new FakeTranscriptsWorkerTransport()
      const workerSide = fake.asWorkerSide()
      const received: ToTranscriptsWorker[] = []
      workerSide.onMessage((m) => received.push(m))
      fake.post({ type: 'run-account', sessionId: 's1', accountEmail: 'a@b.c' })
      expect(received[0].type).toBe('run-account')

      const fromWorker: FromTranscriptsWorker[] = []
      fake.onMessage((m) => fromWorker.push(m))
      workerSide.post({ type: 'ready' })
      expect(fromWorker[0].type).toBe('ready')
    })

    it('kill() flips the killed flag', () => {
      const fake = new FakeTranscriptsWorkerTransport()
      fake.kill()
      expect(fake.killed).toBe(true)
    })
  })
})
