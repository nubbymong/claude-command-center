/**
 * P3.12 (row 31): the transcripts worker tails a Codex rollout with the Codex
 * normalizer, by the format its binding was made (and stored) with, including
 * after a worker restart; a claim let go retires its tail (transcript-unbind);
 * the Memory page's rail keeps to Claude runs.
 *
 * Host-safe: the SQLite layer (transcripts-db, better-sqlite3 built for
 * Electron) is replaced by an in-memory fake with the same contract, so the
 * worker's own logic runs under plain Node. The SQL itself is covered by the
 * native tests (npm run test:unit:native). The transcript files are real, in a
 * fresh temp folder per test that only this test removes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'

interface Run { runId: number; sessionId: string; configId: string | null; provider: string; projectCwd: string | null; status: string; startedAt: number; endedAt: number | null }
interface Tr { id: number; runId: number; path: string; ord: number; status: string; cursor: number; parserVersion: number; sourceFormat: string; confidence: string }
interface Msg { runId: number; idx: number; ts: number; role: string; kind: string; content: string; toolName?: string; toolMeta?: string }

const fake = vi.hoisted(() => ({ runs: [] as Run[], trs: [] as Tr[], msgs: [] as Msg[], next: 1 }))

vi.mock('../../../src/main/logging/transcripts-db', () => ({
  openTranscriptsDb: () => {
    const latestOpen = (sid: string) => [...fake.runs].reverse().find((r) => r.sessionId === sid && r.status === 'running')
    return {
      closeDanglingRuns: () => { let n = 0; for (const r of fake.runs) if (r.status === 'running') { r.status = 'crashed'; n++ } return n },
      listResumableTranscripts: () => fake.trs.filter((t) => t.status === 'tailing').map((t) => ({ transcriptId: t.id, runId: t.runId, path: t.path, ingestCursor: t.cursor, parserVersion: t.parserVersion, sourceFormat: t.sourceFormat })),
      getRunScope: (runId: number) => { const r = fake.runs.find((x) => x.runId === runId); return r ? { sessionId: r.sessionId, configId: r.configId } : null },
      reopenRun: (runId: number) => { const r = fake.runs.find((x) => x.runId === runId); if (r) { r.status = 'running'; r.endedAt = null } },
      getOpenRunId: (sid: string) => latestOpen(sid)?.runId ?? null,
      insertRun: (m: { sessionId: string; configId?: string; provider: string; projectCwd?: string; startedAt: number }) => {
        const runId = fake.next++
        fake.runs.push({ runId, sessionId: m.sessionId, configId: m.configId ?? null, provider: m.provider, projectCwd: m.projectCwd ?? null, status: 'running', startedAt: m.startedAt, endedAt: null })
        return runId
      },
      closeRun: (sid: string, ts: number, status: string) => { const r = latestOpen(sid); if (r) { r.status = status; r.endedAt = ts } },
      closeAllOpenRuns: () => [],
      setRunAccount: () => {},
      renameRun: () => {},
      bindTranscript: (runId: number, path: string, opts: { confidence: string; parserVersion: number; sourceFormat?: string }) => {
        const existing = fake.trs.find((t) => t.runId === runId && t.path === path)
        if (existing) { existing.confidence = opts.confidence; existing.parserVersion = opts.parserVersion; return { transcriptId: existing.id, ord: existing.ord, isNew: false, cursor: existing.cursor, sourceFormat: existing.sourceFormat } }
        const ord = fake.trs.filter((t) => t.runId === runId).length
        const t: Tr = { id: fake.next++, runId, path, ord, status: 'pending', cursor: 0, parserVersion: opts.parserVersion, sourceFormat: opts.sourceFormat ?? 'claude-jsonl', confidence: opts.confidence }
        fake.trs.push(t)
        return { transcriptId: t.id, ord, isNew: true, cursor: 0, sourceFormat: t.sourceFormat }
      },
      findTranscript: (runId: number, path: string) => { const t = fake.trs.find((x) => x.runId === runId && x.path === path); return t ? { transcriptId: t.id } : null },
      setTranscriptStatus: (id: number, status: string) => { const t = fake.trs.find((x) => x.id === id); if (t) t.status = status },
      appendMessages: (runId: number, msgs: Msg[]) => { for (const m of msgs) fake.msgs.push({ ...m, runId }) },
      appendBatch: (runId: number, id: number, msgs: Msg[], cursor: number) => { for (const m of msgs) fake.msgs.push({ ...m, runId }); const t = fake.trs.find((x) => x.id === id); if (t) t.cursor = cursor },
      nextIdx: (runId: number) => { const own = fake.msgs.filter((m) => m.runId === runId); return own.length ? Math.max(...own.map((m) => m.idx)) + 1 : 0 },
      lastMessageTs: () => null,
      sessionActivity: () => fake.runs.map((r) => ({ sessionId: r.sessionId, lastActive: r.startedAt, projectCwd: r.projectCwd, provider: r.provider })),
      close: () => {},
    }
  },
}))

const { createTranscriptsWorker } = await import('../../../src/main/logging/transcripts-worker')
const { FakeTranscriptsWorkerTransport } = await import('../../../src/main/logging/log-worker-transport')
const { CODEX_PARSER_VERSION } = await import('../../../src/main/logging/codex-rollout-normalizer')
const { PARSER_VERSION } = await import('../../../src/main/logging/transcript-normalizer')
type Out = import('../../../src/main/logging/log-worker-transport').FromTranscriptsWorker
type In = import('../../../src/main/logging/log-worker-transport').ToTranscriptsWorker

const T = '2026-09-27T10:00:00.000Z'
const cx = {
  meta: JSON.stringify({ timestamp: T, type: 'session_meta', payload: { id: '019dd000-0001-7000-8000-00000000000a', cwd: '/w' } }) + '\n',
  user: (text: string) => JSON.stringify({ timestamp: T, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text }] } } }) + '\n',
  agent: (text: string) => JSON.stringify({ timestamp: T, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'a', content: [{ type: 'Text', text }] } } }) + '\n',
  injected: JSON.stringify({ timestamp: T, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } }) + '\n',
}
const claudeLine = (text: string) => JSON.stringify({ type: 'user', timestamp: T, message: { role: 'user', content: text } }) + '\n'

let dir: string
const workers: Array<{ stop: () => void }> = []
function boot() {
  const t = new FakeTranscriptsWorkerTransport()
  const out: Out[] = []
  t.onMessage((m) => out.push(m))
  const w = createTranscriptsWorker(t.asWorkerSide())
  workers.push(w)
  const send = (m: In) => t.post(m)
  send({ type: 'open', dbPath: ':memory:' })
  return { w, out, send }
}
const rows = (runId?: number) => fake.msgs.filter((m) => runId === undefined || m.runId === runId).map((m) => [m.role, m.kind, m.kind === 'tool_call' ? m.toolName : m.content])

beforeEach(() => {
  fake.runs = []; fake.trs = []; fake.msgs = []; fake.next = 1
  dir = mkdtempSync(join(tmpdir(), 'ccc-p312-worker-'))
})
afterEach(() => {
  for (const w of workers.splice(0)) w.stop()
  // Only the folder this test made, by its own prefix, in the folder it was made in.
  if (basename(dir).startsWith('ccc-p312-worker-') && dirname(dir) === tmpdir()) rmSync(dir, { recursive: true, force: true })
})

describe('the transcripts worker and a Codex rollout (P3.12, row 31)', () => {
  it('a codex-rollout bind is tailed with the Codex normalizer and stored as that format', () => {
    const { w, send } = boot()
    send({ type: 'run-start', meta: { sessionId: 's1', configId: 'c1', configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
    const f = join(dir, 'rollout-2026-09-27T10-00-00-019dd000-0001-7000-8000-00000000000a.jsonl')
    writeFileSync(f, cx.meta + cx.injected + cx.user('hello codex') + cx.agent('hi'))
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact', sourceFormat: 'codex-rollout' })
    w.tickNow()
    expect(rows()).toEqual([['user', 'message', 'hello codex'], ['assistant', 'message', 'hi']])
    expect(fake.trs[0]).toMatchObject({ sourceFormat: 'codex-rollout', parserVersion: CODEX_PARSER_VERSION, status: 'tailing', confidence: 'exact' })
  })

  it('a bind with no format is Claude\'s, as before: Claude\'s normalizer, stored claude-jsonl', () => {
    const { w, send } = boot()
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Claude', provider: 'claude', startedAt: 1 } })
    const f = join(dir, 'a.jsonl')
    writeFileSync(f, claudeLine('hello claude'))
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact' })
    w.tickNow()
    expect(rows()).toEqual([['user', 'message', 'hello claude']])
    expect(fake.trs[0]).toMatchObject({ sourceFormat: 'claude-jsonl', parserVersion: PARSER_VERSION })
  })

  it('a worker restart resumes a Codex tail with the Codex normalizer, from its cursor', () => {
    const a = boot()
    a.send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
    const f = join(dir, 'rollout-x.jsonl')
    writeFileSync(f, cx.meta + cx.user('one'))
    a.send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'heuristic', sourceFormat: 'codex-rollout' })
    a.w.tickNow()
    a.w.stop()
    appendFileSync(f, cx.agent('two'))
    const b = boot()
    b.w.tickNow()
    expect(rows()).toEqual([['user', 'message', 'one'], ['assistant', 'message', 'two']])
  })

  it('transcript-unbind drains what was written, retires the tail (later lines not taken), keeps the rows; a re-bind resumes at its cursor', () => {
    const { w, send } = boot()
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
    const f = join(dir, 'rollout-y.jsonl')
    writeFileSync(f, cx.meta + cx.user('kept'))
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'heuristic', sourceFormat: 'codex-rollout' })
    w.tickNow()
    appendFileSync(f, cx.agent('drained at the unbind'))
    send({ type: 'transcript-unbind', sessionId: 's1', path: f })
    expect(fake.trs[0].status).toBe('complete')
    appendFileSync(f, cx.user('not this session\'s'))
    w.tickNow()
    expect(rows()).toEqual([['user', 'message', 'kept'], ['assistant', 'message', 'drained at the unbind']])
    // Unknown session or path: nothing happens.
    send({ type: 'transcript-unbind', sessionId: 'nobody', path: f })
    send({ type: 'transcript-unbind', sessionId: 's1', path: join(dir, 'other.jsonl') })
    expect(fake.trs[0].status).toBe('complete')
    // The same claim again: tailed on from the cursor, nothing twice.
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact', sourceFormat: 'codex-rollout' })
    w.tickNow()
    expect(rows()).toEqual([['user', 'message', 'kept'], ['assistant', 'message', 'drained at the unbind'], ['user', 'message', 'not this session\'s']])
    expect(readFileSync(f, 'utf8').length).toBe(fake.trs[0].cursor)
  })

  it('the Memory page\'s recent sessions keep to Claude runs', () => {
    const { send, out } = boot()
    send({ type: 'run-start', meta: { sessionId: 'claude-1', configLabel: 'A', provider: 'claude', projectCwd: 'F:\\proj', startedAt: 1 } })
    send({ type: 'run-start', meta: { sessionId: 'codex-1', configLabel: 'B', provider: 'codex', projectCwd: 'F:\\proj', startedAt: 2 } })
    send({ type: 'query', id: 5, kind: 'recent-sessions', args: { projectDir: 'F--proj', limit: 5 } })
    const res = out.find((m) => m.type === 'query-result' && m.id === 5) as Extract<Out, { type: 'query-result' }>
    expect((res.rows as Array<{ sessionId: string }>).map((r) => r.sessionId)).toEqual(['claude-1'])
  })
})
