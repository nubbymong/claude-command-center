import type { ToWorker, FromWorker, ToTranscriptsWorker, FromTranscriptsWorker } from '../../../src/main/logging/log-worker-transport'
import { FakeWorkerTransport, FakeTranscriptsWorkerTransport } from '../../../src/main/logging/log-worker-transport'
import { describe, it, expect } from 'vitest'

describe('log worker transport', () => {
  // --- Type-level construction tests (prove the union shapes compile + runtime fields) ---

  it('batch message carries sessionId + chunks', () => {
    const m: ToWorker = {
      type: 'batch',
      sessions: [
        {
          sessionId: 's1',
          chunks: [{ ts: 1, type: 'data', raw: new Uint8Array([104, 105]) }],
        },
      ],
    }
    expect(m.sessions[0].sessionId).toBe('s1')
    expect(m.sessions[0].chunks[0].raw[0]).toBe(104)
  })

  it('batch message carries optional dropped field', () => {
    const m: ToWorker = {
      type: 'batch',
      sessions: [
        {
          sessionId: 's2',
          chunks: [],
          dropped: 8192,
        },
      ],
    }
    expect(m.sessions[0].dropped).toBe(8192)
  })

  it('discriminates a FromWorker health message', () => {
    const h: FromWorker = { type: 'health', inFlight: 0, eventsTotal: 5, dropsTotal: 0, dbBytes: 1024 }
    if (h.type === 'health') expect(h.eventsTotal).toBe(5)
  })

  it('open message carries dbPath', () => {
    const m: ToWorker = { type: 'open', dbPath: '/tmp/logs.db' }
    expect(m.dbPath).toBe('/tmp/logs.db')
  })

  it('query message carries id + kind + args', () => {
    const m: ToWorker = { type: 'query', id: 42, kind: 'sessions-list', args: { limit: 10 } }
    expect(m.id).toBe(42)
    expect(m.kind).toBe('sessions-list')
    expect(m.args['limit']).toBe(10)
  })

  it('query-result message carries id + rows', () => {
    const r: FromWorker = { type: 'query-result', id: 42, rows: [{ sessionId: 's1' }] }
    if (r.type === 'query-result') {
      expect(r.id).toBe(42)
      expect(r.rows).toHaveLength(1)
    }
  })

  it('session-start message carries full meta', () => {
    const m: ToWorker = {
      type: 'session-start',
      meta: {
        sessionId: 's3',
        configId: 'cfg1',
        configLabel: 'My Config',
        projectCwd: '/home/user/proj',
        accountEmail: 'user@example.com',
        profileId: 'prof1',
        provider: 'anthropic',
        startedAt: 1700000000000,
      },
    }
    expect(m.meta.sessionId).toBe('s3')
    expect(m.meta.provider).toBe('anthropic')
  })

  it('session-start allows optional fields to be absent', () => {
    const m: ToWorker = {
      type: 'session-start',
      meta: {
        sessionId: 's4',
        configLabel: 'Minimal',
        provider: 'anthropic',
        startedAt: 1700000000001,
      },
    }
    expect(m.meta.configId).toBeUndefined()
    expect(m.meta.accountEmail).toBeUndefined()
  })

  it('session-end message carries sessionId + ts + status', () => {
    const m: ToWorker = { type: 'session-end', sessionId: 's3', ts: 1700000001000, status: 'exited' }
    expect(m.sessionId).toBe('s3')
    expect(m.status).toBe('exited')
  })

  it('reconcile and shutdown are sentinel messages', () => {
    const r: ToWorker = { type: 'reconcile' }
    const s: ToWorker = { type: 'shutdown' }
    expect(r.type).toBe('reconcile')
    expect(s.type).toBe('shutdown')
  })

  it('ready message discriminates correctly', () => {
    const r: FromWorker = { type: 'ready' }
    expect(r.type).toBe('ready')
  })

  it('error message carries message string', () => {
    const e: FromWorker = { type: 'error', message: 'db open failed' }
    if (e.type === 'error') expect(e.message).toBe('db open failed')
  })

  it('error message accepts optional id for query correlation', () => {
    const e: FromWorker = { type: 'error', id: 7, message: 'unknown query kind: bogus' }
    if (e.type === 'error') {
      expect(e.id).toBe(7)
      expect(e.message).toMatch(/unknown/)
    }
  })

  it('log entry carries level + message', () => {
    const l: FromWorker = { type: 'log', entry: { level: 'warn', message: 'slow write' } }
    if (l.type === 'log') {
      expect(l.entry.level).toBe('warn')
      expect(l.entry.message).toBe('slow write')
    }
  })

  it('chunk type union includes all valid event types', () => {
    const types: ToWorker = {
      type: 'batch',
      sessions: [
        {
          sessionId: 's5',
          chunks: [
            { ts: 1, type: 'start', raw: new Uint8Array(0) },
            { ts: 2, type: 'data', raw: new Uint8Array(0) },
            { ts: 3, type: 'restart', raw: new Uint8Array(0) },
            { ts: 4, type: 'switch', raw: new Uint8Array(0) },
            { ts: 5, type: 'end', raw: new Uint8Array(0) },
          ],
        },
      ],
    }
    expect(types.sessions[0].chunks).toHaveLength(5)
  })

  // --- Runtime helper tests ---

  describe('FakeWorkerTransport', () => {
    it('routes post() to child handler', () => {
      const fake = new FakeWorkerTransport()
      const received: ToWorker[] = []
      fake.onWorker((m) => received.push(m))
      fake.post({ type: 'open', dbPath: '/x.db' })
      expect(received).toHaveLength(1)
      expect(received[0].type).toBe('open')
    })

    it('routes emitToMain() to main handler', () => {
      const fake = new FakeWorkerTransport()
      const received: FromWorker[] = []
      fake.onMessage((m) => received.push(m))
      fake.emitToMain({ type: 'ready' })
      expect(received).toHaveLength(1)
      expect(received[0].type).toBe('ready')
    })

    it('records workerMessages sent from main', () => {
      const fake = new FakeWorkerTransport()
      fake.post({ type: 'reconcile' })
      fake.post({ type: 'shutdown' })
      expect(fake.workerMessages).toHaveLength(2)
    })

    it('asWorkerSide() returns inverse transport', () => {
      const fake = new FakeWorkerTransport()
      const workerSide = fake.asWorkerSide()
      const received: ToWorker[] = []
      workerSide.onMessage((m) => received.push(m))
      fake.post({ type: 'shutdown' })
      expect(received[0].type).toBe('shutdown')

      const fromWorker: FromWorker[] = []
      fake.onMessage((m) => fromWorker.push(m))
      workerSide.post({ type: 'ready' })
      expect(fromWorker[0].type).toBe('ready')
    })
  })

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
