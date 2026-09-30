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
import { statSync, unlinkSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'

interface Run { runId: number; sessionId: string; configId: string | null; provider: string; projectCwd: string | null; status: string; startedAt: number; endedAt: number | null }
interface Tr { id: number; runId: number; path: string; ord: number; status: string; cursor: number; parserVersion: number; sourceFormat: string; confidence: string; identity: string | null; digest?: string | null }
interface Msg { runId: number; idx: number; ts: number; role: string; kind: string; content: string; toolName?: string; toolMeta?: string }

const fake = vi.hoisted(() => ({ runs: [] as Run[], trs: [] as Tr[], msgs: [] as Msg[], next: 1 }))

vi.mock('../../../src/main/logging/transcripts-db', () => ({
  openTranscriptsDb: () => {
    const latestOpen = (sid: string) => [...fake.runs].reverse().find((r) => r.sessionId === sid && r.status === 'running')
    return {
      closeDanglingRuns: () => { let n = 0; for (const r of fake.runs) if (r.status === 'running') { r.status = 'crashed'; n++ } return n },
      listResumableTranscripts: () => fake.trs.filter((t) => t.status === 'tailing').map((t) => ({ transcriptId: t.id, runId: t.runId, path: t.path, ingestCursor: t.cursor, parserVersion: t.parserVersion, sourceFormat: t.sourceFormat, sourceIdentity: t.identity, readDigest: t.digest ?? null })),
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
      bindTranscript: (runId: number, path: string, opts: { confidence: string; parserVersion: number; sourceFormat?: string; sourceIdentity?: string }) => {
        const existing = fake.trs.find((t) => t.runId === runId && t.path === path)
        if (existing) {
          const status = existing.status
          existing.confidence = opts.confidence; existing.parserVersion = opts.parserVersion
          let identityChanged = false
          if (opts.sourceIdentity && existing.identity && existing.identity !== opts.sourceIdentity) { existing.cursor = 0; identityChanged = true }
          if (opts.sourceIdentity) existing.identity = opts.sourceIdentity
          return { transcriptId: existing.id, ord: existing.ord, isNew: false, cursor: existing.cursor, sourceFormat: existing.sourceFormat, status, identityChanged, readDigest: identityChanged ? null : existing.digest ?? null }
        }
        const ord = fake.trs.filter((t) => t.runId === runId).length
        const t: Tr = { id: fake.next++, runId, path, ord, status: 'pending', cursor: 0, parserVersion: opts.parserVersion, sourceFormat: opts.sourceFormat ?? 'claude-jsonl', confidence: opts.confidence, identity: opts.sourceIdentity ?? null }
        fake.trs.push(t)
        return { transcriptId: t.id, ord, isNew: true, cursor: 0, sourceFormat: t.sourceFormat, status: 'pending', identityChanged: false }
      },
      // Round 2 (W8): the same session's earlier runs only, the latest first.
      priorCodexBindings: (runId: number, name: string, sessionId: string) => fake.trs
        .filter((t) => t.runId < runId && t.sourceFormat === 'codex-rollout' && t.path.endsWith(name) && (sessionId === undefined || fake.runs.find((r) => r.runId === t.runId)?.sessionId === sessionId))
        .sort((x, y) => y.runId - x.runId || y.cursor - x.cursor)
        .map((t) => ({ transcriptId: t.id, path: t.path, ingestCursor: t.cursor, sourceIdentity: t.identity, runStartedAt: fake.runs.find((r) => r.runId === t.runId)!.startedAt, readDigest: t.digest ?? null })),
      advanceCursor: (id: number, cursor: number, digest?: string | null) => { const t = fake.trs.find((x) => x.id === id); if (t) { t.cursor = cursor; if (digest !== undefined) t.digest = digest } },
      findTranscript: (runId: number, path: string) => { const t = fake.trs.find((x) => x.runId === runId && x.path === path); return t ? { transcriptId: t.id } : null },
      setTranscriptStatus: (id: number, status: string) => { const t = fake.trs.find((x) => x.id === id); if (t) t.status = status },
      appendMessages: (runId: number, msgs: Msg[]) => { for (const m of msgs) fake.msgs.push({ ...m, runId }) },
      appendBatch: (runId: number, id: number, msgs: Msg[], cursor: number, digest?: string | null) => { for (const m of msgs) fake.msgs.push({ ...m, runId }); const t = fake.trs.find((x) => x.id === id); if (t) { t.cursor = cursor; if (digest !== undefined) t.digest = digest } },
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
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(f) })
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
    a.send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'heuristic', sourceFormat: 'codex-rollout', sourceIdentity: idOf(f) })
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
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'heuristic', sourceFormat: 'codex-rollout', sourceIdentity: idOf(f) })
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
    // The same claim again: tailed on from the cursor, nothing twice, after a divider (round 1, Q2).
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(f) })
    w.tickNow()
    expect(rows()).toEqual([['user', 'message', 'kept'], ['assistant', 'message', 'drained at the unbind'], ['system', 'clear', ''], ['user', 'message', 'not this session\'s']])
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

  // ---- P3.12 round 1 ----------------------------------------------------------------------------------------------

  const idOf = (f: string) => { const st = statSync(f, { bigint: true }); return `${st.dev}:${st.ino}` }
  const texts = (runId: number) => fake.msgs.filter((m) => m.runId === runId).map((m) => m.content)

  it('V2: a new run binding a rollout the index already holds (the same file) continues from what was indexed: nothing twice', () => {
    const { w, send } = boot()
    const f = join(dir, 'rollout-2026-09-27T10-00-00-019dd000-0001-7000-8000-00000000000a.jsonl')
    writeFileSync(f, cx.meta + cx.user('first') + cx.agent('first answer'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(f) })
    w.tickNow()
    // A Restart (or an app restart) resumes it: a new run on the same file.
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 2 } })
    appendFileSync(f, cx.user('second'))
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(f) })
    w.tickNow()
    const [r1, r2] = fake.runs.map((r) => r.runId)
    expect(texts(r1)).toEqual(['first', 'first answer'])
    expect(texts(r2)).toEqual(['second'])
  })

  it('V2: after a Switch the conversation\'s copy in the other account (the same name, the same bytes and more) continues too; a copy that went its own way is read whole', () => {
    const { w, send } = boot()
    const name = 'rollout-2026-09-27T10-00-00-019dd000-0001-7000-8000-00000000000b.jsonl'
    const a = join(dir, 'realm-a', name)
    const b = join(dir, 'realm-b', name)
    const c = join(dir, 'realm-c', name)
    for (const d of [dirname(a), dirname(b), dirname(c)]) mkdirSync(d, { recursive: true })
    writeFileSync(a, cx.meta + cx.user('before the switch'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: a, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(a) })
    w.tickNow()
    writeFileSync(b, cx.meta + cx.user('before the switch') + cx.user('after the switch'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 2 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: b, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(b) })
    w.tickNow()
    writeFileSync(c, cx.meta + cx.user('a different history') + cx.user('more'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 3 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: c, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(c) })
    w.tickNow()
    const [r1, r2, r3] = fake.runs.map((r) => r.runId)
    expect(texts(r1)).toEqual(['before the switch'])
    expect(texts(r2)).toEqual(['after the switch'])
    expect(texts(r3)).toEqual(['a different history', 'more'])
  })

  it('V2: a Claude transcript bound again by a new run is read as before (Claude unchanged)', () => {
    const { w, send } = boot()
    const f = join(dir, 'claude.jsonl')
    writeFileSync(f, claudeLine('once'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Claude', provider: 'claude', startedAt: 1 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact' })
    w.tickNow()
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Claude', provider: 'claude', startedAt: 2 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact' })
    w.tickNow()
    const [r1, r2] = fake.runs.map((r) => r.runId)
    expect(texts(r1)).toEqual(['once'])
    expect(texts(r2)).toEqual(['once'])
  })

  it('A1: a Codex tail reads only the file it was bound to: another file put at the path is not read, and the tail retires', () => {
    const { w, send } = boot()
    const f = join(dir, 'rollout-2026-09-27T10-00-00-019dd000-0001-7000-8000-00000000000c.jsonl')
    writeFileSync(f, cx.meta + cx.user('own'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(f) })
    w.tickNow()
    unlinkSync(f)
    writeFileSync(f, cx.meta + cx.user('own') + cx.user('NOT THIS FILE'))
    w.tickNow()
    expect(texts(fake.runs[0].runId)).toEqual(['own'])
    expect(fake.trs[0].status).toBe('failed')
    // and an unbind of it drains nothing from the file now there
    send({ type: 'transcript-unbind', sessionId: 's1', path: f })
    expect(texts(fake.runs[0].runId)).toEqual(['own'])
  })

  it('A1: Codex only: a Claude transcript\'s tail takes no identity; the file at its path is read on, as before', () => {
    const { w, send } = boot()
    const f = join(dir, 'claude-same-path.jsonl')
    writeFileSync(f, claudeLine('once'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Claude', provider: 'claude', startedAt: 1 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact', sourceIdentity: idOf(f) })
    w.tickNow()
    unlinkSync(f)
    writeFileSync(f, claudeLine('once') + claudeLine('twice'))
    w.tickNow()
    expect(texts(fake.runs[0].runId)).toEqual(['once', 'twice'])
    expect(fake.trs[0].status).not.toBe('failed')
  })

  it('A1: the same path bound again with another file before its tail noticed: a divider, and that file read from its start', () => {
    const { w, send } = boot()
    const f = join(dir, 'rollout-2026-09-27T10-00-00-019dd000-0001-7000-8000-00000000000e.jsonl')
    writeFileSync(f, cx.meta + cx.user('own'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(f) })
    w.tickNow()
    unlinkSync(f)
    writeFileSync(f, cx.meta + cx.user('the new one'))
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(f) })
    w.tickNow()
    expect(fake.msgs.map((m) => m.kind === 'clear' ? '--' : m.content)).toEqual(['own', '--', 'the new one'])
    expect(fake.trs[0].status).not.toBe('failed')
  })

  it('A1: a worker restart keeps the identity: the resumed tail refuses another file at the path', () => {
    const a = boot()
    const f = join(dir, 'rollout-2026-09-27T10-00-00-019dd000-0001-7000-8000-00000000000d.jsonl')
    writeFileSync(f, cx.meta + cx.user('own'))
    a.send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
    a.send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(f) })
    a.w.tickNow()
    a.w.stop()
    unlinkSync(f)
    writeFileSync(f, cx.meta + cx.user('own') + cx.user('NOT THIS FILE'))
    const b = boot()
    b.w.tickNow()
    expect(texts(fake.runs[0].runId)).toEqual(['own'])
  })

  it('Q2: a run that goes back to a transcript it held before (A, B, A) marks it with a divider and retires B\'s tail', () => {
    const { w, send } = boot()
    const a = join(dir, 'rollout-a.jsonl')
    const b = join(dir, 'rollout-b.jsonl')
    writeFileSync(a, cx.meta + cx.user('a1'))
    writeFileSync(b, cx.meta + cx.user('b1'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: a, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(a) })
    w.tickNow()
    send({ type: 'transcript-bind', sessionId: 's1', path: b, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(b) })
    w.tickNow()
    send({ type: 'transcript-bind', sessionId: 's1', path: a, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(a) })
    appendFileSync(a, cx.user('a2'))
    appendFileSync(b, cx.user('b2 not read'))
    w.tickNow()
    expect(fake.msgs.map((m) => m.kind === 'clear' ? '--' : m.content)).toEqual(['a1', '--', 'b1', '--', 'a2'])
  })

  it('B3: an unbind retires only the sending session\'s tail: another session on the same rollout keeps its own', () => {
    const { w, send } = boot()
    const f = join(dir, 'rollout-shared.jsonl')
    writeFileSync(f, cx.meta + cx.user('one'))
    for (const sid of ['s1', 's2']) {
      send({ type: 'run-start', meta: { sessionId: sid, configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
      send({ type: 'transcript-bind', sessionId: sid, path: f, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(f) })
    }
    w.tickNow()
    send({ type: 'transcript-unbind', sessionId: 's1', path: f })
    appendFileSync(f, cx.user('two'))
    w.tickNow()
    const [r1, r2] = fake.runs.map((r) => r.runId)
    expect(texts(r1)).toEqual(['one'])
    expect(texts(r2)).toEqual(['one', 'two'])
  })

  // ---- round 2 ----

  const at = (ms: number) => new Date(ms).toISOString()
  const metaAt = (ms: number) => JSON.stringify({ timestamp: at(ms), type: 'session_meta', payload: { id: '019dd000-0001-7000-8000-00000000000f', cwd: '/w' } }) + '\n'
  const shown = () => fake.msgs.map((m) => m.kind === 'clear' ? (m.content ? `-- ${m.content} --` : '--') : m.content)
  const GAP = 'Not indexed while logging was off'

  it('W5: another file at a path an earlier run indexed is read from its start', () => {
    const { w, send } = boot()
    const f = join(dir, 'rollout-2026-09-30T10-00-00-019dd000-0001-7000-8000-000000000021.jsonl')
    writeFileSync(f, cx.meta + cx.user('OLD-CONTENT-INDEXED'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(f) })
    w.tickNow()
    unlinkSync(f)
    writeFileSync(f, cx.meta + cx.user('NEW-FIRST-TURN-XXXX') + cx.user('NEW-SECOND-TURN'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 2 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(f) })
    w.tickNow()
    const [r1, r2] = fake.runs.map((r) => r.runId)
    expect(texts(r1)).toEqual(['OLD-CONTENT-INDEXED'])
    expect(texts(r2)).toEqual(['NEW-FIRST-TURN-XXXX', 'NEW-SECOND-TURN'])
  })

  it('R4: an earlier account\'s file changed after it was indexed: the copy is read whole, nothing of it hidden', () => {
    const { w, send } = boot()
    const name = 'rollout-2026-09-30T10-00-00-019dd000-0001-7000-8000-000000000022.jsonl'
    const a = join(dir, 'realm-a', name)
    const b = join(dir, 'realm-b', name)
    for (const d of [dirname(a), dirname(b)]) mkdirSync(d, { recursive: true })
    writeFileSync(a, cx.meta + cx.user('INDEXED-IN-A0000'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: a, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(a) })
    w.tickNow()
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 2 } })
    writeFileSync(b, cx.meta + cx.user('HIDDEN-FROM-INDX') + cx.user('after'))
    // The same size as what was read: only its modification time tells.
    writeFileSync(a, cx.meta + cx.user('HIDDEN-FROM-INDX'))
    utimesSync(a, new Date(), new Date(Date.now() + 5000))
    send({ type: 'transcript-bind', sessionId: 's1', path: b, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(b) })
    w.tickNow()
    expect(texts(fake.runs[1].runId)).toEqual(['HIDDEN-FROM-INDX', 'after'])
  })

  it('W6: a Codex bind without the claimed file\'s identity binds and reads nothing', () => {
    const { w, send } = boot()
    const f = join(dir, 'rollout-2026-09-30T10-00-00-019dd000-0001-7000-8000-000000000023.jsonl')
    writeFileSync(f, cx.meta + cx.user('own-1'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact', sourceFormat: 'codex-rollout' })
    w.tickNow()
    expect(fake.trs).toEqual([])
    expect(fake.msgs).toEqual([])
  })

  it('W6: a Codex transcript kept without its claimed identity is not read again after a worker restart', () => {
    const f = join(dir, 'rollout-2026-09-30T10-00-00-019dd000-0001-7000-8000-000000000030.jsonl')
    writeFileSync(f, cx.meta + cx.user('own-1'))
    fake.runs.push({ runId: 90, sessionId: 's9', configId: null, provider: 'codex', projectCwd: null, status: 'running', startedAt: 1, endedAt: null })
    fake.trs.push({ id: 91, runId: 90, path: f, ord: 0, status: 'tailing', cursor: 0, parserVersion: CODEX_PARSER_VERSION, sourceFormat: 'codex-rollout', confidence: 'exact', identity: null })
    fake.next = 100
    const { w } = boot()
    w.tickNow()
    expect(fake.msgs).toEqual([])
    expect(fake.trs[0].status).toBe('complete')
  })

  it('V2: a conversation read only by the final drain of its run still continues in its copy after a Switch', () => {
    const { w, send } = boot()
    const name = 'rollout-2026-09-30T10-00-00-019dd000-0001-7000-8000-000000000031.jsonl'
    const a = join(dir, 'realm-a', name)
    const b = join(dir, 'realm-b', name)
    for (const d of [dirname(a), dirname(b)]) mkdirSync(d, { recursive: true })
    writeFileSync(a, cx.meta + cx.user('before the switch'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: a, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(a) })
    writeFileSync(b, cx.meta + cx.user('before the switch') + cx.user('after the switch'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 2 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: b, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(b) })
    w.tickNow()
    expect(texts(fake.runs[0].runId)).toEqual(['before the switch'])
    expect(texts(fake.runs[1].runId)).toEqual(['after the switch'])
  })

  it('W8: the same file name indexed by another session is not continued: read from its start', () => {
    const { w, send } = boot()
    const name = 'rollout-2026-09-30T10-00-00-019dd000-0001-7000-8000-000000000024.jsonl'
    const a = join(dir, 'realm-a', name)
    const b = join(dir, 'realm-b', name)
    for (const d of [dirname(a), dirname(b)]) mkdirSync(d, { recursive: true })
    writeFileSync(a, cx.meta + cx.user('one'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: a, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(a) })
    w.tickNow()
    writeFileSync(b, cx.meta + cx.user('one') + cx.user('two'))
    send({ type: 'run-start', meta: { sessionId: 's2', configLabel: 'Codex', provider: 'codex', startedAt: 2 } })
    send({ type: 'transcript-bind', sessionId: 's2', path: b, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(b) })
    w.tickNow()
    expect(texts(fake.runs[1].runId)).toEqual(['one', 'two'])
  })

  // ---- round 3: the not-indexed rule by conversation (X1, X2), the copy by what was read (X4) ----

  const bindNI = (sid: string, f: string, notIndexed?: { since?: number; ifBegunBefore?: number }): In =>
    ({ type: 'transcript-bind', sessionId: sid, path: f, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(f), ...(notIndexed ? { notIndexed } : {}) } as In)
  const runStart = (sid: string, startedAt: number): In => ({ type: 'run-start', meta: { sessionId: sid, configLabel: 'Codex', provider: 'codex', startedAt } } as In)

  it('X4: an earlier account\'s file rewritten in place after it was read (the same size, a tick between): the copy is read whole', () => {
    const { w, send } = boot()
    const name = 'rollout-2026-09-30T10-00-00-019dd000-0001-7000-8000-000000000047.jsonl'
    const a = join(dir, 'realm-a', name)
    const b = join(dir, 'realm-b', name)
    for (const d of [dirname(a), dirname(b)]) mkdirSync(d, { recursive: true })
    writeFileSync(a, cx.meta + cx.user('INDEXED-IN-A0000'))
    send(runStart('s1', 1)); send(bindNI('s1', a)); w.tickNow()
    writeFileSync(a, cx.meta + cx.user('HIDDEN-FROM-INDX'))
    w.tickNow()
    writeFileSync(b, cx.meta + cx.user('HIDDEN-FROM-INDX') + cx.user('after'))
    send(runStart('s1', 2)); send(bindNI('s1', b)); w.tickNow()
    expect(texts(fake.runs[1].runId)).toEqual(['HIDDEN-FROM-INDX', 'after'])
  })

  it('X4: rewritten in place and grown, then read by the final drain: the copy is read whole', () => {
    const { w, send } = boot()
    const name = 'rollout-2026-09-30T10-00-00-019dd000-0001-7000-8000-000000000048.jsonl'
    const a = join(dir, 'realm-a', name)
    const b = join(dir, 'realm-b', name)
    for (const d of [dirname(a), dirname(b)]) mkdirSync(d, { recursive: true })
    writeFileSync(a, cx.meta + cx.user('INDEXED-IN-A'))
    send(runStart('s1', 1)); send(bindNI('s1', a)); w.tickNow(); w.tickNow()
    writeFileSync(b, cx.meta + cx.user('HIDDEN-FROM-INDEX') + cx.user('after'))
    writeFileSync(a, cx.meta + cx.user('HIDDEN-FROM-INDEX'))
    send(runStart('s1', 2)); send(bindNI('s1', b)); w.tickNow()
    expect(texts(fake.runs[1].runId)).toContain('HIDDEN-FROM-INDEX')
  })

  it('X4: a Restart then a Switch: the copy continues from what the Restart\'s run read (nothing twice)', () => {
    const { w, send } = boot()
    const name = 'rollout-2026-09-30T10-00-00-019dd000-0001-7000-8000-000000000049.jsonl'
    const a = join(dir, 'realm-a', name)
    const b = join(dir, 'realm-b', name)
    for (const d of [dirname(a), dirname(b)]) mkdirSync(d, { recursive: true })
    writeFileSync(a, cx.meta + cx.user('one'))
    send(runStart('s1', 1)); send(bindNI('s1', a)); w.tickNow()
    send(runStart('s1', 2)); send(bindNI('s1', a))
    appendFileSync(a, cx.user('two')); w.tickNow()
    writeFileSync(b, cx.meta + cx.user('one') + cx.user('two') + cx.user('three'))
    send(runStart('s1', 3)); send(bindNI('s1', b)); w.tickNow()
    expect(fake.runs.map((r) => texts(r.runId))).toEqual([['one'], ['two'], ['three']])
  })

  // ---- round 4 ----

  it('(2) the digest of what was read is stored with the cursor: after a worker restart, a copy after a Switch still continues', () => {
    const name = 'rollout-2026-09-30T10-00-00-019dd000-0001-7000-8000-000000000055.jsonl'
    const a = join(dir, 'realm-a', name)
    const b = join(dir, 'realm-b', name)
    for (const d of [dirname(a), dirname(b)]) mkdirSync(d, { recursive: true })
    writeFileSync(a, cx.meta + cx.user('before the switch'))
    const first = boot()
    first.send(runStart('s1', 1)); first.send(bindNI('s1', a)); first.w.tickNow()
    first.send({ type: 'run-end', sessionId: 's1', ts: 2, status: 'exited' } as In)
    first.w.stop()
    writeFileSync(b, cx.meta + cx.user('before the switch') + cx.user('after the switch'))
    const second = boot()
    second.send(runStart('s1', 3)); second.send(bindNI('s1', b)); second.w.tickNow()
    expect(texts(fake.runs[1].runId)).toEqual(['after the switch'])
  })

  it('(2) after a worker restart, a copy whose first bytes are not what was read is read whole', () => {
    const name = 'rollout-2026-09-30T10-00-00-019dd000-0001-7000-8000-000000000056.jsonl'
    const a = join(dir, 'realm-a', name)
    const b = join(dir, 'realm-b', name)
    for (const d of [dirname(a), dirname(b)]) mkdirSync(d, { recursive: true })
    writeFileSync(a, cx.meta + cx.user('INDEXED-IN-A0000'))
    const first = boot()
    first.send(runStart('s1', 1)); first.send(bindNI('s1', a)); first.w.tickNow()
    first.send({ type: 'run-end', sessionId: 's1', ts: 2, status: 'exited' } as In)
    first.w.stop()
    writeFileSync(b, cx.meta + cx.user('HIDDEN-FROM-INDX') + cx.user('after'))
    const second = boot()
    second.send(runStart('s1', 3)); second.send(bindNI('s1', b)); second.w.tickNow()
    expect(texts(fake.runs[1].runId)).toEqual(['HIDDEN-FROM-INDX', 'after'])
  })

  it('(2) a tail resumed after a worker restart goes on vouching for what it read: a later copy continues', () => {
    const name = 'rollout-2026-09-30T10-00-00-019dd000-0001-7000-8000-000000000057.jsonl'
    const a = join(dir, 'realm-a', name)
    const b = join(dir, 'realm-b', name)
    for (const d of [dirname(a), dirname(b)]) mkdirSync(d, { recursive: true })
    writeFileSync(a, cx.meta + cx.user('one'))
    const first = boot()
    first.send(runStart('s1', 1)); first.send(bindNI('s1', a)); first.w.tickNow()
    first.w.stop()
    appendFileSync(a, cx.user('two'))
    const second = boot()
    second.w.tickNow()
    writeFileSync(b, cx.meta + cx.user('one') + cx.user('two') + cx.user('three'))
    second.send(runStart('s1', 3)); second.send(bindNI('s1', b)); second.w.tickNow()
    expect(fake.runs.map((r) => texts(r.runId))).toEqual([['one', 'two'], ['three']])
  })

  // ---- round 5: the not-indexed rule by record time (Y1) ----

  const BASE = Date.now() - 600_000
  const at5 = (ms: number) => new Date(BASE + ms).toISOString()
  const meta5 = (id: string) => JSON.stringify({ timestamp: at5(0), type: 'session_meta', payload: { id, cwd: '/w' } }) + '\n'
  const said = (text: string, ms: number | null) => JSON.stringify({ ...(ms === null ? {} : { timestamp: at5(ms) }), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text }] } } }) + '\n'
  const conv = (n: number) => `019dd000-0001-7000-8000-0000000001${String(n).padStart(2, '0')}`
  const file = (n: number, sub = '') => { const d = sub ? join(dir, sub) : dir; mkdirSync(d, { recursive: true }); return join(d, `rollout-2026-09-30T10-00-00-${conv(n)}.jsonl`) }
  const windowsFor = (n: number, list: Array<[number, number | null]>, before: number | null = null): In =>
    ({ type: 'not-indexed-windows', conversations: { [conv(n)]: list.map(([s0, e0]) => [BASE + s0, e0 === null ? null : BASE + e0]) }, before } as unknown as In)
  const words5 = (runId: number) => fake.msgs.filter((m) => m.runId === runId && m.kind === 'message').map((m) => m.content)
  const shown5 = (runId?: number) => fake.msgs.filter((m) => runId === undefined || m.runId === runId).map((m) => m.kind === 'clear' ? (m.content ? '-- off --' : '--') : m.content)

  it('F1: back after indexing was off (a Restart), the turn that came with the resume is kept; the ones written while off are not', () => {
    const { w, send } = boot()
    const f = file(1)
    writeFileSync(f, meta5(conv(1)) + said('ON-1', 1000))
    send(runStart('s1', BASE + 500)); send(bindNI('s1', f)); w.tickNow()
    send({ type: 'run-end', sessionId: 's1', ts: BASE + 2000, status: 'stopped' } as In)
    appendFileSync(f, said('OFF-1', 3000))
    send(windowsFor(1, [[2000, 4000]]))
    appendFileSync(f, said('RESUME-TURN', 4500))
    send(runStart('s1', BASE + 4000)); send(bindNI('s1', f, { since: BASE + 2000 })); w.tickNow()
    expect(shown5()).toEqual(['ON-1', '-- off --', 'RESUME-TURN'])
  })

  it('F2a: a Switch after a stretch not indexed (its copy continuing from what was read): the turns written while off are not indexed', () => {
    const { w, send } = boot()
    const a = file(2, 'realm-a')
    const b = file(2, 'realm-b')
    writeFileSync(a, meta5(conv(2)) + said('ON-1', 1000))
    send(runStart('s1', BASE + 500)); send(bindNI('s1', a)); w.tickNow()
    send({ type: 'run-end', sessionId: 's1', ts: BASE + 2000, status: 'stopped' } as In)
    appendFileSync(a, said('OFF-1', 3000))
    send(windowsFor(2, [[2000, 4000]]))
    send(runStart('s1', BASE + 4000)); send(bindNI('s1', a, { since: BASE + 2000 }))
    appendFileSync(a, said('ON-2', 5000)); w.tickNow()
    writeFileSync(b, readFileSync(a, 'utf8') + said('ON-3', 7000))
    send(runStart('s1', BASE + 6000)); send(bindNI('s1', b)); w.tickNow()
    expect(fake.msgs.map((m) => m.content)).not.toContain('OFF-1')
    expect(texts(fake.runs[2].runId)).toEqual(['ON-3'])
  })

  it('F2a: the same with no digest to go on (the copy read from its start): the turns written while off are not indexed', () => {
    const { w, send } = boot()
    const a = file(3, 'realm-a')
    const b = file(3, 'realm-b')
    writeFileSync(a, meta5(conv(3)) + said('ON-1', 1000))
    send(runStart('s1', BASE + 500)); send(bindNI('s1', a)); w.tickNow()
    send({ type: 'run-end', sessionId: 's1', ts: BASE + 2000, status: 'stopped' } as In)
    appendFileSync(a, said('OFF-1', 3000))
    send(windowsFor(3, [[2000, 4000]]))
    // The copy begins with other bytes than were read (no digest to go on): read from its start.
    writeFileSync(b, meta5(conv(3)).replace('"/w"', '"/w2"') + said('ON-1', 1000) + said('OFF-1', 3000) + said('ON-2', 5000))
    send(runStart('s1', BASE + 4000)); send(bindNI('s1', b)); w.tickNow()
    expect(shown5(fake.runs[1].runId)).toEqual(['ON-1', '-- off --', 'ON-2'])
  })

  it('F2b: a new tab later reading the conversation from its start: the turns written while off are not indexed, a divider where they were', () => {
    const { w, send } = boot()
    const f = file(4)
    writeFileSync(f, meta5(conv(4)) + said('ON-1', 1000))
    send(runStart('S', BASE + 500)); send(bindNI('S', f)); w.tickNow()
    send({ type: 'run-end', sessionId: 'S', ts: BASE + 2000, status: 'stopped' } as In)
    appendFileSync(f, said('OFF-1', 3000) + said('OFF-2', 3500))
    send(windowsFor(4, [[2000, 4000]]))
    appendFileSync(f, said('ON-2', 5000))
    send(runStart('T', BASE + 6000)); send(bindNI('T', f)); w.tickNow()
    expect(shown5(fake.runs.find((r) => r.sessionId === 'T')!.runId)).toEqual(['ON-1', '-- off --', 'ON-2'])
  })

  it('A, B, A: back to a conversation, the turns written while off are not indexed', () => {
    const { w, send } = boot()
    const a = file(5)
    const b = file(6)
    writeFileSync(a, meta5(conv(5)) + said('A-1', 1000))
    writeFileSync(b, meta5(conv(6)) + said('B-1', 1000))
    send(runStart('s1', BASE + 500)); send(bindNI('s1', a)); w.tickNow()
    send(bindNI('s1', b)); w.tickNow()
    appendFileSync(a, said('A-OFF', 3000))
    send(windowsFor(5, [[2000, 4000]]))
    appendFileSync(a, said('A-2', 5000))
    send(bindNI('s1', a, { since: BASE + 2000 })); w.tickNow()
    expect(shown5()).toEqual(['A-1', '--', 'B-1', '--', '-- off --', 'A-2'])
  })

  it('a window still open: every record from its start is left out, as it comes; once it closes, records after are read', () => {
    const { w, send } = boot()
    const f = file(7)
    writeFileSync(f, meta5(conv(7)) + said('ON-1', 1000))
    send(windowsFor(7, [[2000, null]]))
    send(runStart('s1', BASE + 500)); send(bindNI('s1', f)); w.tickNow()
    appendFileSync(f, said('OFF-1', 3000)); w.tickNow()
    send(windowsFor(7, [[2000, 4000]]))
    appendFileSync(f, said('ON-2', 5000)); w.tickNow()
    expect(shown5()).toEqual(['ON-1', '-- off --', 'ON-2'])
  })

  it('the edges: a record stamped at a window\'s start is left out; one at its end is read', () => {
    const { w, send } = boot()
    const f = file(8)
    writeFileSync(f, meta5(conv(8)) + said('BEFORE', 1999) + said('AT-START', 2000) + said('AT-END', 4000))
    send(windowsFor(8, [[2000, 4000]]))
    send(runStart('s1', BASE + 500)); send(bindNI('s1', f)); w.tickNow()
    expect(words5(fake.runs[0].runId)).toEqual(['BEFORE', 'AT-END'])
  })

  it('a record with no time of its own takes the one before it in the read; with none before, it is left out when the conversation has a window', () => {
    const { w, send } = boot()
    const f = file(9)
    writeFileSync(f, meta5(conv(9)) + said('ON-1', 1000) + said('OFF-1', 3000) + said('NO-TIME-AFTER-OFF', null) + said('ON-2', 5000) + said('NO-TIME-AFTER-ON', null))
    send(windowsFor(9, [[2000, 4000]]))
    send(runStart('s1', BASE + 500)); send(bindNI('s1', f)); w.tickNow()
    expect(words5(fake.runs[0].runId)).toEqual(['ON-1', 'ON-2', 'NO-TIME-AFTER-ON'])
    const g = file(10)
    writeFileSync(g, said('NO-TIME-FIRST', null) + said('ON-X', 5000))
    send(windowsFor(10, [[2000, 4000]]))
    send(bindNI('s1', g)); w.tickNow()
    expect(words5(fake.runs[0].runId)).not.toContain('NO-TIME-FIRST')
    expect(words5(fake.runs[0].runId).slice(-1)).toEqual(['ON-X'])
  })

  it('a record the not-indexed record cannot vouch for (stamped before its before-time) is left out; a replace drops earlier windows', () => {
    const { w, send } = boot()
    const f = file(11)
    writeFileSync(f, meta5(conv(11)) + said('OLD', 1000) + said('NEW', 5000))
    send({ type: 'not-indexed-windows', conversations: { [conv(12)]: [[BASE, BASE + 9000]] }, before: BASE + 2000 } as unknown as In)
    send(runStart('s1', BASE + 500)); send(bindNI('s1', f)); w.tickNow()
    expect(words5(fake.runs[0].runId)).toEqual(['NEW'])
    const g = file(12)
    writeFileSync(g, meta5(conv(12)) + said('IN-DROPPED-WINDOW', 3000))
    send({ type: 'not-indexed-windows', conversations: {}, before: null, replace: true } as unknown as In)
    send(bindNI('s1', g)); w.tickNow()
    expect(words5(fake.runs[0].runId)).toContain('IN-DROPPED-WINDOW')
  })
})
