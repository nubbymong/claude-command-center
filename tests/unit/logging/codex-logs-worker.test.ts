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
import { statSync, unlinkSync, mkdirSync, utimesSync, openSync, readSync, closeSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'

interface Run { runId: number; sessionId: string; configId: string | null; provider: string; projectCwd: string | null; status: string; startedAt: number; endedAt: number | null }
interface Tr { id: number; runId: number; path: string; ord: number; status: string; cursor: number; parserVersion: number; sourceFormat: string; confidence: string; identity: string | null; digest?: string | null }
interface Msg { runId: number; idx: number; ts: number; role: string; kind: string; content: string; toolName?: string; toolMeta?: string }

const fake = vi.hoisted(() => ({ runs: [] as Run[], trs: [] as Tr[], msgs: [] as Msg[], next: 1 }))
// How many times a conversation key is worked out (round 6, Z4).
const keyWork = vi.hoisted(() => ({ calls: 0 }))

vi.mock('../../../src/shared/codex-conversation-key', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/shared/codex-conversation-key')>()
  return { ...actual, codexConversationKey: (p: string) => { keyWork.calls++; return actual.codexConversationKey(p) } }
})

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
      // Round 2 (W8): the same session's earlier runs only, the latest first;
      // P3.16 (M1): of the format asked for.
      priorBindings: (runId: number, name: string, sessionId: string, format: string) => fake.trs
        .filter((t) => t.runId < runId && t.sourceFormat === format && t.path.endsWith(name) && (sessionId === undefined || fake.runs.find((r) => r.runId === t.runId)?.sessionId === sessionId))
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
const { openNotIndexedWindow, closeNotIndexedWindow, releaseNotIndexedWindow, setNotIndexedListener, notIndexedSnapshot, resetIndexingGapsForTests, keepNotIndexedWindow, closeHeldNotIndexedWindow } = await import('../../../src/main/logging/indexing-gaps')
const { claudeFolderKey, claudeProjectsRootKey } = await import('../../../src/main/logging/claude-folder-key')
const { FakeTranscriptsWorkerTransport } = await import('../../../src/main/logging/log-worker-transport')
const { CODEX_PARSER_VERSION } = await import('../../../src/main/logging/codex-rollout-normalizer')
const { PARSER_VERSION } = await import('../../../src/main/logging/transcript-normalizer')
const { codexFolderKey } = await import('../../../src/main/logging/codex-folder-key')
const { watchAndClaimRollout } = await import('../../../src/main/providers/codex/telemetry')
const { makeCodexLogBinder } = await import('../../../src/main/logging/codex-log-binder')
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
  resetIndexingGapsForTests()
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
  // Another file at f's path: made while the first still exists, then renamed
  // over it, so it is another file on every file system. Removing the first and
  // writing the path again is not: ext4 hands the freed inode number straight to
  // the next file, so on Linux that file would carry the first one's identity.
  const putAnotherFileAt = (f: string, content: string) => {
    const before = idOf(f)
    writeFileSync(`${f}.next`, content)
    renameSync(`${f}.next`, f)
    expect(idOf(f)).not.toBe(before)
  }
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

  it('V2, P3.16 (M1): a Claude transcript bound again by a new run of the same session continues from what was indexed, as a Codex one: nothing twice', () => {
    const { w, send } = boot()
    const f = join(dir, 'claude.jsonl')
    writeFileSync(f, claudeLine('once'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Claude', provider: 'claude', startedAt: 1 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact' })
    w.tickNow()
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Claude', provider: 'claude', startedAt: 2 } })
    appendFileSync(f, claudeLine('twice'))
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact' })
    w.tickNow()
    const [r1, r2] = fake.runs.map((r) => r.runId)
    expect(texts(r1)).toEqual(['once'])
    expect(texts(r2)).toEqual(['twice'])
  })

  it('A1: a Codex tail reads only the file it was bound to: another file put at the path is not read, and the tail retires', () => {
    const { w, send } = boot()
    const f = join(dir, 'rollout-2026-09-27T10-00-00-019dd000-0001-7000-8000-00000000000c.jsonl')
    writeFileSync(f, cx.meta + cx.user('own'))
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: idOf(f) })
    w.tickNow()
    putAnotherFileAt(f, cx.meta + cx.user('own') + cx.user('NOT THIS FILE'))
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
    putAnotherFileAt(f, claudeLine('once') + claudeLine('twice'))
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
    putAnotherFileAt(f, cx.meta + cx.user('the new one'))
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
    putAnotherFileAt(f, cx.meta + cx.user('own') + cx.user('NOT THIS FILE'))
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
    putAnotherFileAt(f, cx.meta + cx.user('NEW-FIRST-TURN-XXXX') + cx.user('NEW-SECOND-TURN'))
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

  // ---- round 6: a window opens when the session became not indexed (Z1); a time has a zone (Z3); the key once (Z4) ----

  const metaStamped = (id: string, ms: number) => JSON.stringify({ timestamp: at5(ms), type: 'session_meta', payload: { id, cwd: '/w' } }) + '\n'
  /** A user turn stamped with a text as given (not a time made here). */
  const saidAs = (text: string, timestamp: string) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text }] } } }) + '\n'
  /** A time as a text with no zone designator (the machine's local time), which Date.parse reads as local time. */
  const localIso = (ms: number) => {
    const d = new Date(ms)
    const p = (n: number, w = 2) => String(n).padStart(w, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  }
  /** Main's real record of the windows, told to the worker at each change (as the logging service does). */
  const wire = (send: (m: In) => void) => {
    resetIndexingGapsForTests()
    setNotIndexedListener((u) => send({ type: 'not-indexed-windows', ...u } as unknown as In))
  }

  it('Z1: Codex writes a conversation\'s session_meta and first prompt before the claim: a later reader from the start leaves them out, and what follows the window is kept', () => {
    const { w, send } = boot()
    wire(send)
    const f = file(20)
    // The session was launched not indexed at -300; Codex wrote these before the claim at 2000.
    writeFileSync(f, metaStamped(conv(20), 0) + said('FIRST-PROMPT', 1000) + said('FIRST-REPLY', 1500))
    openNotIndexedWindow('S', f, BASE - 300, BASE + 2000)
    expect(notIndexedSnapshot().conversations[conv(20)]).toEqual([[BASE - 300, null]])
    closeNotIndexedWindow('S', BASE + 4000)
    appendFileSync(f, said('LATER', 5000))
    send(runStart('T', BASE + 6000)); send(bindNI('T', f)); w.tickNow()
    expect(shown5(fake.runs[0].runId)).toEqual(['-- off --', 'LATER'])
  })

  it('Z1: a resumed conversation keeps the turns it had indexed: its window opens when the session became not indexed, after them', () => {
    const { w, send } = boot()
    wire(send)
    const f = file(21)
    writeFileSync(f, metaStamped(conv(21), -86_400_000) + said('EARLIER-INDEXED', -86_000_000) + said('RESUME-PROMPT', 1000) + said('RESUME-REPLY', 1500))
    openNotIndexedWindow('S', f, BASE + 500, BASE + 2000)
    expect(notIndexedSnapshot().conversations[conv(21)]).toEqual([[BASE + 500, null]])
    closeNotIndexedWindow('S', BASE + 4000)
    appendFileSync(f, said('LATER', 5000))
    send(runStart('T', BASE + 6000)); send(bindNI('T', f)); w.tickNow()
    expect(shown5(fake.runs[0].runId)).toEqual(['EARLIER-INDEXED', '-- off --', 'LATER'])
  })

  it('Z3: a timestamp with no zone designator is no time: the record takes the one before it in the read, or is left out when there is none', () => {
    const { w, send } = boot()
    const f = file(22)
    // The window is 2000 to 4000; the stamp reads, as local time, 3000: inside, were it taken for a time.
    writeFileSync(f, meta5(conv(22)) + said('ON-1', 1000) + saidAs('ZONELESS-AFTER-ON', localIso(BASE + 3000)) + said('ON-2', 5000))
    send(windowsFor(22, [[2000, 4000]]))
    send(runStart('s1', BASE + 500)); send(bindNI('s1', f)); w.tickNow()
    expect(words5(fake.runs[0].runId)).toEqual(['ON-1', 'ZONELESS-AFTER-ON', 'ON-2'])
    // With no time before it in the read, it is left out (read as local time it would be 9000, after the window).
    const g = file(23)
    writeFileSync(g, saidAs('ZONELESS-FIRST', localIso(BASE + 9000)) + said('ON-X', 5000))
    send(windowsFor(23, [[2000, 4000]]))
    send(bindNI('s1', g)); w.tickNow()
    expect(words5(fake.runs[0].runId)).not.toContain('ZONELESS-FIRST')
    expect(words5(fake.runs[0].runId).slice(-1)).toEqual(['ON-X'])
  })

  it('Z4: a tail works its conversation key out once, not for every record it reads', () => {
    const { w, send } = boot()
    const f = file(24)
    let body = meta5(conv(24))
    for (let i = 0; i < 40; i++) body += said(`T-${i}`, 100 + i)
    writeFileSync(f, body)
    send(windowsFor(24, [[50_000, null]]))
    keyWork.calls = 0
    send(runStart('s1', BASE + 500)); send(bindNI('s1', f)); w.tickNow()
    expect(words5(fake.runs[0].runId)).toHaveLength(40)
    expect(keyWork.calls).toBeGreaterThan(0)
    expect(keyWork.calls).toBeLessThan(5)
  })

  it('K1: what a killed Codex writes after the kill and before its exit is reported is left out for a reader from the start (a Switch copy, a Restart); what follows the reported exit is read', () => {
    const { w, send } = boot()
    wire(send)
    const f = file(25)
    writeFileSync(f, meta5(conv(25)) + said('BEFORE', 100) + said('ON-1', 1000))
    openNotIndexedWindow('S', f, BASE + 500, BASE + 600)
    // The tab is closed: the session lets go, the window stays open until the process has ended.
    const closeWindow = releaseNotIndexedWindow('S')!
    appendFileSync(f, said('WIND-DOWN', 3000))
    closeWindow(BASE + 4000)
    appendFileSync(f, said('LATER', 5000))
    // A Restart reads the original from its start.
    send(runStart('T', BASE + 6000)); send(bindNI('T', f)); w.tickNow()
    expect(shown5(fake.runs[0].runId)).toEqual(['BEFORE', '-- off --', 'LATER'])
    // A Switch's copy, in the other account's folder under the same rollout id, is read from its start by another run.
    const copy = file(25, 'realm-b')
    writeFileSync(copy, readFileSync(f, 'utf8'))
    send(runStart('U', BASE + 7000)); send(bindNI('U', copy)); w.tickNow()
    expect(shown5(fake.runs.find((r) => r.sessionId === 'U')!.runId)).toEqual(['BEFORE', '-- off --', 'LATER'])
  })
})

describe('Claude\'s resume continues from what was indexed, with Codex\'s record-time windows (P3.16, M1)', () => {
  const BASE = Date.now() - 600_000
  const at = (ms: number) => new Date(BASE + ms).toISOString()
  const uuid = (n: number) => `7f3e0c1a-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`
  const tfile = (n: number, sub = '') => { const d = sub ? join(dir, sub) : dir; mkdirSync(d, { recursive: true }); return join(d, `${uuid(n)}.jsonl`) }
  /** A Claude record: a user turn (or an assistant one) stamped at BASE + ms, or with no time. */
  const say = (text: string, ms: number | null, type: 'user' | 'assistant' = 'user') =>
    JSON.stringify({ type, ...(ms === null ? {} : { timestamp: at(ms) }), message: { role: type, content: text } }) + '\n'
  const sayAs = (text: string, timestamp: string) => JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content: text } }) + '\n'
  /** Records that give no rows: metadata, and a user record of a tool's result. */
  const meta = (ms: number) => JSON.stringify({ type: 'file-history-snapshot', timestamp: at(ms) }) + '\n'
  const toolResult = (ms: number) => JSON.stringify({ type: 'user', timestamp: at(ms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }] } }) + '\n'
  const runC = (sid: string, startedAt: number): In => ({ type: 'run-start', meta: { sessionId: sid, configLabel: 'Claude', provider: 'claude', startedAt } } as In)
  const bindC = (sid: string, f: string): In => ({ type: 'transcript-bind', sessionId: sid, path: f, confidence: 'exact' } as In)
  const windowsFor = (n: number, list: Array<[number, number | null]>, before: number | null = null): In =>
    ({ type: 'not-indexed-windows', conversations: { [uuid(n)]: list.map(([s0, e0]) => [BASE + s0, e0 === null ? null : BASE + e0]) }, before } as unknown as In)
  const shown = (runId?: number) => fake.msgs.filter((m) => runId === undefined || m.runId === runId).map((m) => m.kind === 'clear' ? (m.content ? '-- off --' : '--') : m.content)
  const runOf = (sid: string, nth = 0) => fake.runs.filter((r) => r.sessionId === sid)[nth].runId
  const localIso = (ms: number) => {
    const d = new Date(ms)
    const p = (n: number, w = 2) => String(n).padStart(w, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  }

  it('a Restart, then another: each run reads on from the one before, and stores what it read with its cursor', () => {
    const { w, send } = boot()
    const f = tfile(1)
    writeFileSync(f, say('ONE', 1000))
    send(runC('s1', BASE)); send(bindC('s1', f)); w.tickNow()
    // (A new run first: its start drains the run before it.)
    send(runC('s1', BASE + 1500)); appendFileSync(f, say('TWO', 2000)); send(bindC('s1', f)); w.tickNow()
    send(runC('s1', BASE + 2500)); appendFileSync(f, say('THREE', 3000)); send(bindC('s1', f)); w.tickNow()
    expect([0, 1, 2].map((n) => shown(runOf('s1', n)))).toEqual([['ONE'], ['TWO'], ['THREE']])
    expect(fake.trs.every((t) => typeof t.digest === 'string' && t.digest.length === 64)).toBe(true)
  })

  it('a file at the path whose first bytes are not what was read is read from its start', () => {
    const { w, send } = boot()
    const f = tfile(2)
    writeFileSync(f, say('ORIGINAL', 1000))
    send(runC('s1', BASE)); send(bindC('s1', f)); w.tickNow()
    writeFileSync(f, say('OTHER-1', 1000) + say('OTHER-2', 2000) + say('OTHER-3', 3000))
    send(runC('s1', BASE + 4000)); send(bindC('s1', f)); w.tickNow()
    expect(shown(runOf('s1', 1))).toEqual(['OTHER-1', 'OTHER-2', 'OTHER-3'])
  })

  it('an earlier binding that kept no digest (indexed by a build before this one) continues from its cursor', () => {
    const { w, send } = boot()
    const f = tfile(3)
    writeFileSync(f, say('ONE', 1000))
    send(runC('s1', BASE)); send(bindC('s1', f)); w.tickNow()
    send(runC('s1', BASE + 1500))
    fake.trs[0].digest = null
    appendFileSync(f, say('TWO', 2000))
    send(bindC('s1', f)); w.tickNow()
    expect(shown(runOf('s1', 1))).toEqual(['TWO'])
  })

  it('with no digest to go on, a file shorter than what was read is read from its start', () => {
    const { w, send } = boot()
    const f = tfile(15)
    writeFileSync(f, say('A-LONG-FIRST-TURN', 1000) + say('ANOTHER', 1500))
    send(runC('s1', BASE)); send(bindC('s1', f)); w.tickNow()
    send(runC('s1', BASE + 2500))
    fake.trs[0].digest = null
    writeFileSync(f, say('SHORT', 2000))
    send(bindC('s1', f)); w.tickNow()
    expect(shown(runOf('s1', 1))).toEqual(['SHORT'])
  })

  it('back to a transcript within a run (A, B, A): it goes on vouching for what it read, so a later file there that is not that is read whole', () => {
    const { w, send } = boot()
    const a = tfile(16)
    const b = tfile(17)
    writeFileSync(a, say('A-1', 1000))
    writeFileSync(b, say('B-1', 1000))
    send(runC('s1', BASE)); send(bindC('s1', a)); w.tickNow()
    send(bindC('s1', b)); w.tickNow()
    appendFileSync(a, say('A-2', 2000))
    send(bindC('s1', a)); w.tickNow()
    expect(fake.trs.find((t) => t.path === a)!.digest).toMatch(/^[0-9a-f]{64}$/)
    send(runC('s1', BASE + 3000))
    writeFileSync(a, say('X-1', 1000) + say('X-2', 2000) + say('X-3', 3000) + say('X-4', 4000))
    send(bindC('s1', a)); w.tickNow()
    expect(shown(runOf('s1', 1))).toEqual(['X-1', 'X-2', 'X-3', 'X-4'])
  })

  it('a file shorter than what was read is read from its start', () => {
    const { w, send } = boot()
    const f = tfile(4)
    writeFileSync(f, say('A-LONG-FIRST-TURN', 1000) + say('ANOTHER', 1500))
    send(runC('s1', BASE)); send(bindC('s1', f)); w.tickNow()
    writeFileSync(f, say('SHORT', 2000))
    send(runC('s1', BASE + 2500)); send(bindC('s1', f)); w.tickNow()
    expect(shown(runOf('s1', 1))).toEqual(['SHORT'])
  })

  it('another session on the same transcript (a resume in a new tab) is not continued: read from its start, in its own slot', () => {
    const { w, send } = boot()
    const f = tfile(5)
    writeFileSync(f, say('ONE', 1000))
    send(runC('s1', BASE)); send(bindC('s1', f)); w.tickNow()
    appendFileSync(f, say('TWO', 2000))
    send(runC('s2', BASE + 1500)); send(bindC('s2', f)); w.tickNow()
    expect(shown(runOf('s2'))).toEqual(['ONE', 'TWO'])
  })

  it('a worker restart keeps vouching for what was read: a later run still continues', () => {
    const f = tfile(6)
    writeFileSync(f, say('ONE', 1000))
    const first = boot()
    first.send(runC('s1', BASE)); first.send(bindC('s1', f)); first.w.tickNow()
    first.w.stop()
    appendFileSync(f, say('TWO', 2000))
    const second = boot()
    second.w.tickNow()
    second.send(runC('s1', BASE + 2500))
    appendFileSync(f, say('THREE', 3000))
    second.send(bindC('s1', f)); second.w.tickNow()
    expect(fake.runs.map((r) => shown(r.runId))).toEqual([['ONE', 'TWO'], ['THREE']])
  })

  it('a Restart after logging was off for the session: the turns written while off are left out, a divider where they were; the turn that came with the resume is kept', () => {
    const { w, send } = boot()
    const f = tfile(7)
    writeFileSync(f, say('ON-1', 1000))
    send(runC('s1', BASE + 500)); send(bindC('s1', f)); w.tickNow()
    send({ type: 'run-end', sessionId: 's1', ts: BASE + 2000, status: 'stopped' } as In)
    appendFileSync(f, say('OFF-1', 3000) + say('OFF-2', 3500, 'assistant'))
    send(windowsFor(7, [[2000, 4000]]))
    appendFileSync(f, say('RESUME-TURN', 4500))
    send(runC('s1', BASE + 4000)); send(bindC('s1', f)); w.tickNow()
    expect(shown()).toEqual(['ON-1', '-- off --', 'RESUME-TURN'])
  })

  it('a new tab reading the conversation from its start: the turns written while not indexed are left out, a divider where they were', () => {
    const { w, send } = boot()
    const f = tfile(8)
    writeFileSync(f, say('ON-1', 1000) + say('OFF-1', 3000) + say('OFF-2', 3500) + say('ON-2', 5000))
    send(windowsFor(8, [[2000, 4000]]))
    send(runC('T', BASE + 6000)); send(bindC('T', f)); w.tickNow()
    expect(shown()).toEqual(['ON-1', '-- off --', 'ON-2'])
  })

  it('a window still open: every record from its start is left out, as it comes; once it closes, records after are read', () => {
    const { w, send } = boot()
    const f = tfile(9)
    writeFileSync(f, say('ON-1', 1000))
    send(windowsFor(9, [[2000, null]]))
    send(runC('s1', BASE + 500)); send(bindC('s1', f)); w.tickNow()
    appendFileSync(f, say('OFF-1', 3000)); w.tickNow()
    send(windowsFor(9, [[2000, 4000]]))
    appendFileSync(f, say('ON-2', 5000)); w.tickNow()
    expect(shown()).toEqual(['ON-1', '-- off --', 'ON-2'])
  })

  it('the edges, and records with no time: at a window\'s start left out, at its end read; no time takes the one before; none before is left out; a zoneless time is no time', () => {
    const { w, send } = boot()
    const f = tfile(10)
    writeFileSync(f, say('BEFORE', 1999) + say('AT-START', 2000) + say('NO-TIME-IN', null) + say('AT-END', 4000) + sayAs('ZONELESS-AFTER-END', localIso(BASE + 3000)))
    send(windowsFor(10, [[2000, 4000]]))
    send(runC('s1', BASE + 500)); send(bindC('s1', f)); w.tickNow()
    expect(shown()).toEqual(['BEFORE', '-- off --', 'AT-END', 'ZONELESS-AFTER-END'])
    const g = tfile(11)
    writeFileSync(g, say('NO-TIME-FIRST', null) + sayAs('ZONELESS-FIRST', localIso(BASE + 9000)) + say('ON-X', 5000))
    send(windowsFor(11, [[2000, 4000]]))
    send(runC('s2', BASE + 600)); send(bindC('s2', g)); w.tickNow()
    expect(shown(runOf('s2'))).toEqual(['-- off --', 'ON-X'])
  })

  it('records that give no rows (metadata, a tool\'s result) left out leave no divider; one that gives rows does', () => {
    const { w, send } = boot()
    const f = tfile(12)
    writeFileSync(f, say('ON-1', 1000) + meta(3000) + toolResult(3200) + say('ON-2', 5000))
    send(windowsFor(12, [[2000, 4000]]))
    send(runC('s1', BASE + 500)); send(bindC('s1', f)); w.tickNow()
    expect(shown()).toEqual(['ON-1', 'ON-2'])
  })

  it('a conversation with no window and no before-time is read whole, records with no time included', () => {
    const { w, send } = boot()
    const f = tfile(13)
    writeFileSync(f, say('NO-TIME', null) + say('ON-1', 1000))
    send(windowsFor(99, [[0, 9000]]))
    send(runC('s1', BASE + 500)); send(bindC('s1', f)); w.tickNow()
    expect(shown()).toEqual(['NO-TIME', 'ON-1'])
  })

  it('main\'s record of the windows, kept by a Claude transcript\'s path, is the one the worker reads by (the conversation\'s id)', () => {
    const { w, send } = boot()
    resetIndexingGapsForTests()
    setNotIndexedListener((u) => send({ type: 'not-indexed-windows', ...u } as unknown as In))
    const f = tfile(14, 'projects/C--w')
    writeFileSync(f, say('BEFORE', 100) + say('FIRST-PROMPT', 1000) + say('FIRST-REPLY', 1500, 'assistant'))
    // A Claude session launched not indexed at 500, its transcript learned at 2000 (its hook).
    openNotIndexedWindow('S', join(dir, 'other-spelling', `${uuid(14).toUpperCase()}.jsonl`), BASE + 500, BASE + 2000)
    expect(notIndexedSnapshot().conversations[uuid(14)]).toEqual([[BASE + 500, null]])
    closeNotIndexedWindow('S', BASE + 4000)
    appendFileSync(f, say('LATER', 5000))
    send(runC('T', BASE + 6000)); send(bindC('T', f)); w.tickNow()
    expect(shown()).toEqual(['BEFORE', '-- off --', 'LATER'])
  })

  // P3.16 round 1 (N1): a session not indexed that named no transcript marks
  // its whole projects folder; a reader of any transcript there leaves out
  // what is stamped in that window (lens A case 1: an indexed exact resume
  // later reading the transcript from its start).
  it('N1: a folder marked while a session named none: every transcript in it leaves out its records in that window; another folder\'s does not', () => {
    const { w, send } = boot()
    resetIndexingGapsForTests()
    setNotIndexedListener((u) => send({ type: 'not-indexed-windows', ...u } as unknown as In))
    const f = tfile(30, 'proj-a')
    const g = tfile(31, 'proj-a')
    const other = tfile(32, 'proj-b')
    for (const p of [f, g, other]) writeFileSync(p, say('BEFORE', 100) + say('WRITTEN-WHILE-NOT-INDEXED', 1000) + say('AFTER', 5000))
    keepNotIndexedWindow('S', claudeFolderKey(dirname(f)), BASE + 500, BASE + 500, { writeNow: true })
    closeNotIndexedWindow('S', BASE + 4000)
    send(runC('R', BASE + 6000)); send(bindC('R', f)); w.tickNow()
    expect(shown(runOf('R'))).toEqual(['BEFORE', '-- off --', 'AFTER'])
    send(runC('T', BASE + 6100)); send(bindC('T', g)); w.tickNow()
    expect(shown(runOf('T'))).toEqual(['BEFORE', '-- off --', 'AFTER'])
    send(runC('U', BASE + 6200)); send(bindC('U', other)); w.tickNow()
    expect(shown(runOf('U'))).toEqual(['BEFORE', 'WRITTEN-WHILE-NOT-INDEXED', 'AFTER'])
  })

  it('N1, N2: a folder window closed at the first name keeps that stretch; the named transcript\'s own window covers it from the start', () => {
    const { w, send } = boot()
    resetIndexingGapsForTests()
    setNotIndexedListener((u) => send({ type: 'not-indexed-windows', ...u } as unknown as In))
    const named = tfile(33, 'proj-c')
    const sibling = tfile(34, 'proj-c')
    writeFileSync(named, say('N-EARLY', 1000) + say('N-LATE', 3000) + say('N-AFTER', 5000))
    writeFileSync(sibling, say('S-EARLY', 1000) + say('S-LATE', 3000))
    keepNotIndexedWindow('S', claudeFolderKey(dirname(named)), BASE + 500, BASE + 500, { writeNow: true })
    keepNotIndexedWindow('S', uuid(33), BASE + 500, BASE + 2000)
    closeHeldNotIndexedWindow('S', claudeFolderKey(dirname(named)), BASE + 2000)
    closeNotIndexedWindow('S', BASE + 4000)
    send(runC('R', BASE + 6000)); send(bindC('R', named)); w.tickNow()
    expect(shown(runOf('R'))).toEqual(['-- off --', 'N-AFTER'])
    send(runC('T', BASE + 6100)); send(bindC('T', sibling)); w.tickNow()
    // The folder's stretch (500 to 2000) is left out; the sibling after it is read.
    expect(shown(runOf('T'))).toEqual(['-- off --', 'S-LATE'])
  })

  // P3.16a round 2 (Q2, Q3): past the most windows a session holds, a name in
  // another projects folder is covered by a window on the projects folders'
  // root: every transcript in a folder directly under it leaves out what is
  // stamped in that window; a transcript elsewhere does not.
  it('Q3: a window on the projects root: every folder under it leaves out its records in that window; a transcript directly in the root, or deeper, does not', () => {
    const { w, send } = boot()
    resetIndexingGapsForTests()
    setNotIndexedListener((u) => send({ type: 'not-indexed-windows', ...u } as unknown as In))
    const a = tfile(40, 'proj-x')
    const b = tfile(41, 'proj-y')
    const loose = tfile(42)
    const deeper = tfile(43, join('proj-z', 'nested'))
    for (const p of [a, b, loose, deeper]) writeFileSync(p, say('BEFORE', 100) + say('WRITTEN-WHILE-NOT-INDEXED', 1000) + say('AFTER', 5000))
    keepNotIndexedWindow('S', claudeProjectsRootKey(dir), BASE + 500, BASE + 500, { writeNow: true })
    closeNotIndexedWindow('S', BASE + 4000)
    send(runC('R', BASE + 6000)); send(bindC('R', a)); w.tickNow()
    expect(shown(runOf('R'))).toEqual(['BEFORE', '-- off --', 'AFTER'])
    send(runC('T', BASE + 6100)); send(bindC('T', b)); w.tickNow()
    expect(shown(runOf('T'))).toEqual(['BEFORE', '-- off --', 'AFTER'])
    send(runC('U', BASE + 6200)); send(bindC('U', loose)); w.tickNow()
    expect(shown(runOf('U'))).toEqual(['BEFORE', 'WRITTEN-WHILE-NOT-INDEXED', 'AFTER'])
    send(runC('V', BASE + 6300)); send(bindC('V', deeper)); w.tickNow()
    expect(shown(runOf('V'))).toEqual(['BEFORE', 'WRITTEN-WHILE-NOT-INDEXED', 'AFTER'])
  })
})

// P3.16 final-head VM finding D1 (row 31): Claude Code names a new
// conversation's transcript (its status line at startup, its hooks) before it
// writes the file, which it creates at the first message; the exact bind comes
// first. A tail whose file was never there waits for it until its run ends; a
// file that was there and is gone still fails the tail.
describe('a new Claude conversation bound before Claude Code writes its file (P3.16 final-head VM finding D1, row 31)', () => {
  const BASE = Date.now() - 600_000
  const at = (ms: number) => new Date(BASE + ms).toISOString()
  const uuid = (n: number) => `7f3e0c1a-0000-4000-8000-0000000003${String(n).padStart(2, '0')}`
  const tfile = (n: number, sub = '') => { const d = sub ? join(dir, sub) : dir; mkdirSync(d, { recursive: true }); return join(d, `${uuid(n)}.jsonl`) }
  const say = (text: string, ms: number) => JSON.stringify({ type: 'user', timestamp: at(ms), message: { role: 'user', content: text } }) + '\n'
  const runC = (sid: string, startedAt: number): In => ({ type: 'run-start', meta: { sessionId: sid, configLabel: 'Claude', provider: 'claude', startedAt } } as In)
  const bindC = (sid: string, f: string): In => ({ type: 'transcript-bind', sessionId: sid, path: f, confidence: 'exact' } as In)
  const windowsFor = (key: string, list: Array<[number, number]>): In =>
    ({ type: 'not-indexed-windows', conversations: { [key]: list.map(([s0, e0]) => [BASE + s0, BASE + e0]) }, before: null } as unknown as In)
  const shown = (runId?: number) => fake.msgs.filter((m) => runId === undefined || m.runId === runId).map((m) => m.kind === 'clear' ? (m.content ? '-- off --' : '--') : m.content)
  const runOf = (sid: string) => fake.runs.find((r) => r.sessionId === sid)!.runId
  const statusOf = (f: string) => fake.trs.find((t) => t.path === f)!.status
  const missingWarns = (out: Out[]) => out.filter((m) => m.type === 'log' && m.entry.level === 'warn' && /missing/.test(m.entry.message))

  it('the file written after the bind is read from its first message, and the tail goes on', () => {
    const { w, out, send } = boot()
    const f = tfile(1)
    send(runC('s1', BASE)); send(bindC('s1', f))
    w.tickNow(); w.tickNow()
    expect(statusOf(f)).toBe('tailing')
    writeFileSync(f, say('FIRST', 1000)); w.tickNow()
    appendFileSync(f, say('SECOND', 2000)); w.tickNow()
    expect(shown()).toEqual(['FIRST', 'SECOND'])
    expect(statusOf(f)).toBe('tailing')
    expect(missingWarns(out)).toEqual([])
  })

  it('a file that was read and is then gone still fails the tail, with one warning; so does one first written after the bind', () => {
    const { w, out, send } = boot()
    const f = tfile(2)
    writeFileSync(f, say('KEPT', 1000))
    send(runC('s1', BASE)); send(bindC('s1', f)); w.tickNow()
    unlinkSync(f); w.tickNow(); w.tickNow()
    expect(statusOf(f)).toBe('failed')
    expect(shown(runOf('s1'))).toEqual(['KEPT'])
    expect(missingWarns(out)).toHaveLength(1)
    const g = tfile(3)
    send(runC('s2', BASE + 100)); send(bindC('s2', g)); w.tickNow()
    writeFileSync(g, say('LATE', 1500)); w.tickNow()
    unlinkSync(g); w.tickNow()
    expect(statusOf(g)).toBe('failed')
    expect(shown(runOf('s2'))).toEqual(['LATE'])
    expect(missingWarns(out)).toHaveLength(2)
  })

  it('a window on the conversation, kept before the bind: what the file holds in it is left out when the file comes', () => {
    const { w, send } = boot()
    const f = tfile(4)
    send(windowsFor(uuid(4), [[2000, 4000]]))
    send(runC('s1', BASE)); send(bindC('s1', f)); w.tickNow()
    writeFileSync(f, say('WRITTEN-WHILE-NOT-INDEXED', 3000) + say('AFTER', 5000)); w.tickNow()
    expect(shown()).toEqual(['-- off --', 'AFTER'])
  })

  it('a window on the projects folder, kept before the bind: what the file holds in it is left out when the file comes', () => {
    const { w, send } = boot()
    const f = tfile(5, 'proj-a')
    send(windowsFor(claudeFolderKey(dirname(f)), [[2000, 4000]]))
    send(runC('s1', BASE)); send(bindC('s1', f)); w.tickNow()
    writeFileSync(f, say('WRITTEN-WHILE-NOT-INDEXED', 3000) + say('AFTER', 5000)); w.tickNow()
    expect(shown()).toEqual(['-- off --', 'AFTER'])
  })

  it('a window kept while the tail waits (after the bind, before the file): what the file holds in it is left out too', () => {
    const { w, send } = boot()
    const f = tfile(6)
    send(runC('s1', BASE)); send(bindC('s1', f)); w.tickNow()
    send(windowsFor(uuid(6), [[2000, 4000]])); w.tickNow()
    writeFileSync(f, say('WRITTEN-WHILE-NOT-INDEXED', 3000) + say('AFTER', 5000)); w.tickNow()
    expect(shown()).toEqual(['-- off --', 'AFTER'])
  })

  it('a worker restart while the tail waits: the new worker waits too, and reads the file when it comes', () => {
    const f = tfile(7)
    const first = boot()
    first.send(runC('s1', BASE)); first.send(bindC('s1', f)); first.w.tickNow()
    first.w.stop()
    const second = boot()
    second.w.tickNow()
    writeFileSync(f, say('FIRST', 1000)); second.w.tickNow()
    expect(shown()).toEqual(['FIRST'])
    expect(statusOf(f)).toBe('tailing')
  })

  it('the run ends while the tail waits: it is retired complete, and a file written after is not read', () => {
    const { w, send } = boot()
    const f = tfile(8)
    send(runC('s1', BASE)); send(bindC('s1', f)); w.tickNow()
    send({ type: 'run-end', sessionId: 's1', ts: BASE + 500, status: 'exited' } as In)
    writeFileSync(f, say('AFTER-THE-END', 1000)); w.tickNow()
    expect(statusOf(f)).toBe('complete')
    expect(shown()).toEqual([])
  })

  it('/clear: the next conversation\'s file, named before it is written, is read after the divider', () => {
    const { w, send } = boot()
    const a = tfile(9)
    const b = tfile(10)
    writeFileSync(a, say('A-1', 1000))
    send(runC('s1', BASE)); send(bindC('s1', a)); w.tickNow()
    send(bindC('s1', b)); w.tickNow(); w.tickNow()
    writeFileSync(b, say('B-1', 2000)); w.tickNow()
    expect(shown()).toEqual(['A-1', '--', 'B-1'])
    expect([statusOf(a), statusOf(b)]).toEqual(['complete', 'tailing'])
  })

  it('Codex unchanged: a claimed rollout gone before its first read fails the tail (its watcher saw the file)', () => {
    const { w, out, send } = boot()
    const f = join(dir, 'rollout-2026-09-27T10-00-00-019dd000-0001-7000-8000-00000000003f.jsonl')
    writeFileSync(f, cx.meta + cx.user('own'))
    const st = statSync(f, { bigint: true })
    send({ type: 'run-start', meta: { sessionId: 's1', configLabel: 'Codex', provider: 'codex', startedAt: 1 } })
    send({ type: 'transcript-bind', sessionId: 's1', path: f, confidence: 'exact', sourceFormat: 'codex-rollout', sourceIdentity: `${st.dev}:${st.ino}` })
    unlinkSync(f); w.tickNow()
    expect(statusOf(f)).toBe('failed')
    expect(missingWarns(out)).toHaveLength(1)
  })

  // Fixer 8b (review Q4): a file never seen that cannot be read for another
  // reason than not being written yet (no right to it, say, or a scanner
  // holding a new file) is waited for too, and the log says so once.
  it('a file never seen that cannot be read for another reason: the tail waits, and logs that once (info); one not written yet logs nothing', () => {
    let blocked = true
    const f = tfile(11)
    const port = {
      statSync: (p: string) => {
        if (blocked && p === f) throw Object.assign(new Error('denied'), { code: 'EACCES' })
        return statSync(p)
      },
      openSync: (p: string, flags: string) => openSync(p, flags),
      readSync: (fd: number, b: Buffer, o: number, l: number, pos: number) => readSync(fd, b, o, l, pos),
      closeSync: (fd: number) => closeSync(fd),
    }
    const t = new FakeTranscriptsWorkerTransport()
    const out: Out[] = []
    t.onMessage((m) => out.push(m))
    const w = createTranscriptsWorker(t.asWorkerSide(), port)
    workers.push(w)
    const send = (m: In) => t.post(m)
    send({ type: 'open', dbPath: ':memory:' })
    const waitNotes = () => out.filter((m): m is Extract<Out, { type: 'log' }> => m.type === 'log' && m.entry.level === 'info' && /not readable yet/.test(m.entry.message))
    send(runC('s1', BASE)); send(bindC('s1', f))
    w.tickNow(); w.tickNow(); w.tickNow()
    expect(statusOf(f)).toBe('tailing')
    expect(waitNotes()).toHaveLength(1)
    expect(waitNotes()[0].entry.message).toMatch(/EACCES/)
    blocked = false
    writeFileSync(f, say('FIRST', 1000)); w.tickNow()
    expect(shown()).toEqual(['FIRST'])
    const g = tfile(12)
    send(runC('s2', BASE + 100)); send(bindC('s2', g)); w.tickNow(); w.tickNow()
    expect(waitNotes()).toHaveLength(1)
    expect(missingWarns(out)).toEqual([])
  })
})

// PR-level ADR-009 round 1 (C1): a Codex session not indexed also marks the
// folder it was launched in from the moment it became not indexed until it
// ends, as a Claude session marks its projects folder. A reader of any rollout
// whose session_meta records that folder (round 2, K2: in any realm) leaves
// out what is stamped in that window: the rollouts the session's own watcher
// never claimed (another tab took one by folder and time; Codex began one
// inside the session with no hook to say so). Fails closed: an indexed tab's
// own turns in that folder meanwhile, of any account, are left out too.
describe('a Codex launch folder marked while a session not indexed ran (PR-level ADR-009 round 1, C1)', () => {
  const BASE = Date.now() - 600_000
  const at = (ms: number) => new Date(BASE + ms).toISOString()
  const cid = (n: number) => `019dd000-0001-7000-8000-0000000003${String(n).padStart(2, '0')}`
  const realmOf = (realm: string) => join(dir, realm, 'sessions')
  const dayOf = (sessions: string, d = new Date()) => {
    const p = (n: number) => String(n).padStart(2, '0')
    const day = join(sessions, String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate()))
    mkdirSync(day, { recursive: true })
    return day
  }
  const rolloutIn = (sessions: string, n: number) => join(dayOf(sessions), `rollout-2026-10-02T10-00-00-${cid(n)}.jsonl`)
  const metaFor = (n: number, cwd: string, iso = at(0)) => JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id: cid(n), cwd, cli_version: '0.155.1' } }) + '\n'
  const turn = (text: string, iso: string) => JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text }] } } }) + '\n'
  const idOf = (f: string) => { const st = statSync(f, { bigint: true }); return `${st.dev}:${st.ino}` }
  const runX = (sid: string, startedAt: number): In => ({ type: 'run-start', meta: { sessionId: sid, configLabel: 'Codex', provider: 'codex', startedAt } } as In)
  const bindX = (sid: string, f: string): In => ({ type: 'transcript-bind', sessionId: sid, path: f, confidence: 'heuristic', sourceFormat: 'codex-rollout', sourceIdentity: idOf(f) } as In)
  const words = (sid: string) => fake.msgs.filter((m) => m.runId === fake.runs.find((r) => r.sessionId === sid)?.runId && m.kind === 'message').map((m) => m.content)
  const wire = (send: (m: In) => void) => {
    resetIndexingGapsForTests()
    setNotIndexedListener((u) => send({ type: 'not-indexed-windows', ...u } as unknown as In))
  }
  /** The Codex log binder as main wires it, its binds sent to the worker as the supervisor sends them. */
  const binderTo = (send: (m: In) => void) => makeCodexLogBinder({
    supervisor: {
      bindTranscript: (sessionId, path, confidence, sourceVersion, sourceFormat, sourceIdentity) =>
        send({ type: 'transcript-bind', sessionId, path, confidence, sourceVersion, sourceFormat, ...(sourceIdentity ? { sourceIdentity } : {}) } as In),
      unbindTranscript: (sessionId, path) => send({ type: 'transcript-unbind', sessionId, path } as In),
    },
    writeName: () => {}, rememberedName: () => null, forgetName: () => {},
  })
  /** A session not indexed from `since`: its folder window, opened as pty-manager opens it. */
  const notIndexedFolder = (sid: string, cwd: string, since: number) =>
    keepNotIndexedWindow(sid, codexFolderKey(cwd), since, since, { cover: true, writeNow: true })
  afterEach(() => { vi.useRealTimers() })

  it('C1: every rollout recording that folder (an indexed tab\'s own too: the known limit; round 2, K2: in any realm) leaves out its records in the window; another folder does not', () => {
    const { w, send } = boot()
    wire(send)
    const mine = rolloutIn(realmOf('realm-a'), 1)
    const otherFolder = rolloutIn(realmOf('realm-a'), 2)
    const otherRealm = rolloutIn(realmOf('realm-b'), 3)
    writeFileSync(mine, metaFor(1, '/p/demo') + turn('BEFORE', at(100)) + turn('WRITTEN-WHILE-NOT-INDEXED', at(1000)) + turn('AFTER', at(5000)))
    writeFileSync(otherFolder, metaFor(2, '/p/other') + turn('BEFORE', at(100)) + turn('WRITTEN-WHILE-NOT-INDEXED', at(1000)) + turn('AFTER', at(5000)))
    writeFileSync(otherRealm, metaFor(3, '/p/demo') + turn('BEFORE', at(100)) + turn('WRITTEN-WHILE-NOT-INDEXED', at(1000)) + turn('AFTER', at(5000)))
    notIndexedFolder('S', '/p/demo', BASE + 500)
    closeNotIndexedWindow('S', BASE + 4000)
    send(runX('R', BASE + 6000)); send(bindX('R', mine)); w.tickNow()
    send(runX('T', BASE + 6100)); send(bindX('T', otherFolder)); w.tickNow()
    send(runX('U', BASE + 6200)); send(bindX('U', otherRealm)); w.tickNow()
    expect(words('R')).toEqual(['BEFORE', 'AFTER'])
    expect(words('T')).toEqual(['BEFORE', 'WRITTEN-WHILE-NOT-INDEXED', 'AFTER'])
    expect(words('U')).toEqual(['BEFORE', 'AFTER'])
  })

  it('C1: a rollout whose first line records no folder is left out wherever a Codex folder window covers the time; with none kept it is read whole', () => {
    const { w, send } = boot()
    wire(send)
    const noMeta = rolloutIn(realmOf('realm-a'), 4)
    writeFileSync(noMeta, turn('BEFORE', at(100)) + turn('WRITTEN-WHILE-NOT-INDEXED', at(1000)) + turn('AFTER', at(5000)))
    send(runX('R', BASE + 6000)); send(bindX('R', noMeta)); w.tickNow()
    expect(words('R')).toEqual(['BEFORE', 'WRITTEN-WHILE-NOT-INDEXED', 'AFTER'])
    notIndexedFolder('S', '/elsewhere', BASE + 500)
    closeNotIndexedWindow('S', BASE + 4000)
    send(runX('T', BASE + 6100)); send(bindX('T', noMeta)); w.tickNow()
    expect(words('T')).toEqual(['BEFORE', 'AFTER'])
  })

  it('C1 (round 2, K5): a rollout whose first line records no folder, tailed before any folder window was kept: a window kept later still leaves out what is written in it', () => {
    const { w, send } = boot()
    wire(send)
    const noMeta = rolloutIn(realmOf('realm-a'), 5)
    writeFileSync(noMeta, turn('BEFORE', at(100)))
    send(runX('R', BASE + 6000)); send(bindX('R', noMeta)); w.tickNow()
    expect(words('R')).toEqual(['BEFORE'])
    notIndexedFolder('S', '/elsewhere', BASE + 500)
    appendFileSync(noMeta, turn('WRITTEN-WHILE-NOT-INDEXED', at(1000)))
    closeNotIndexedWindow('S', BASE + 4000)
    appendFileSync(noMeta, turn('AFTER', at(5000)))
    w.tickNow()
    expect(words('R')).toEqual(['BEFORE', 'AFTER'])
  })

  it('round 2 (K2, lens C G2): a Sign in again copies the history into a new realm; resumed there, a rollout read from its start leaves out what was written while its folder was marked, as the original does', () => {
    const { w, send } = boot()
    wire(send)
    const oldRealm = realmOf('realm-old')
    const newRealm = realmOf('realm-new')
    const body = metaFor(6, '/p/demo') + turn('BEFORE', at(100)) + turn('WRITTEN-WHILE-NOT-INDEXED', at(1000)) + turn('AFTER', at(5000))
    const orig = rolloutIn(oldRealm, 6)
    writeFileSync(orig, body)
    notIndexedFolder('B', '/p/demo', BASE + 500)
    closeNotIndexedWindow('B', BASE + 4000)
    // Sign in again: the replacement's sessions folder gets the same day folders and files.
    const copy = rolloutIn(newRealm, 6)
    writeFileSync(copy, body)
    const resume = (sid: string, f: string): In => ({ ...bindX(sid, f), confidence: 'exact' } as In)
    send(runX('O', BASE + 6000)); send(resume('O', orig)); w.tickNow()
    send(runX('N', BASE + 6100)); send(resume('N', copy)); w.tickNow()
    expect(words('O')).toEqual(['BEFORE', 'AFTER'])
    expect(words('N')).toEqual(['BEFORE', 'AFTER'])
  })

  it('C1 (round 2, F1 F6): on Windows, main\'s key and the worker\'s are one however each side spells the folder (case, slashes, a trailing separator)', () => {
    const key = codexFolderKey('C:\\Work\\Demo', 'win32')
    for (const folder of ['c:/work/demo', 'C:\\Work\\Demo\\', 'c:\\WORK\\demo', 'C:/WORK/DEMO/']) expect(codexFolderKey(folder, 'win32'), folder).toBe(key)
    // Another folder is another key.
    expect(codexFolderKey('C:\\Work\\Other', 'win32')).not.toBe(key)
    // Off Windows a folder's case is its own; a trailing separator is not.
    expect(codexFolderKey('/work/Demo', 'linux')).not.toBe(codexFolderKey('/work/demo', 'linux'))
    expect(codexFolderKey('/work/demo/', 'linux')).toBe(codexFolderKey('/work/demo', 'linux'))
  })

  it('C1-1: two new sessions in one folder, the one not indexed launched second: the indexed tab that took its rollout by folder and time leaves out what was written while it ran', async () => {
    vi.useFakeTimers()
    const { w, send } = boot()
    wire(send)
    const sessions = realmOf('realm-c1')
    const binder = binderTo(send)
    const t0 = Date.now()
    send(runX('A', t0)); binder.beginLaunch('A'); binder.startRun('A', true)
    const a = watchAndClaimRollout('A', '/p/demo', t0, () => {}, sessions, undefined, { onRollout: (r) => binder.noteRollout('A', r) })
    await vi.advanceTimersByTimeAsync(100)
    const sinceB = Date.now()
    notIndexedFolder('B', '/p/demo', sinceB)
    const b = watchAndClaimRollout('B', '/p/demo', sinceB, () => {}, sessions, undefined, { onRollout: (r) => { if (r) openNotIndexedWindow('B', r.path, sinceB, Date.now()) } })
    try {
      // B's Codex writes its rollout first; A's a moment later.
      const rB = rolloutIn(sessions, 11)
      writeFileSync(rB, metaFor(11, '/p/demo', new Date(Date.now() + 50).toISOString()) + turn('B-PROMPT', new Date(Date.now() + 60).toISOString()))
      await vi.advanceTimersByTimeAsync(600)
      const rA = rolloutIn(sessions, 10)
      writeFileSync(rA, metaFor(10, '/p/demo', new Date(Date.now() + 50).toISOString()) + turn('A-PROMPT', new Date(Date.now() + 60).toISOString()))
      await vi.advanceTimersByTimeAsync(600)
      // The swap: A took B's rollout by folder and time.
      expect(fake.trs.filter((t) => t.runId === fake.runs.find((r) => r.sessionId === 'A')!.runId).map((t) => basename(t.path))).toEqual([basename(rB)])
      appendFileSync(rB, turn('B-LATER', new Date(Date.now()).toISOString()))
      w.tickNow()
      expect(words('A')).toEqual([])
      // B ends: what is stamped after is read.
      closeNotIndexedWindow('B', Date.now())
      await vi.advanceTimersByTimeAsync(1000)
      appendFileSync(rB, turn('AFTER-B-ENDED', new Date(Date.now()).toISOString()))
      w.tickNow()
      expect(words('A')).toEqual(['AFTER-B-ENDED'])
    } finally {
      a.stop(); b.stop()
    }
  })

  it('C1-2: a new conversation Codex began inside a session not indexed with no hook (its /new): the rollout it never claimed, taken by an indexed tab in the folder, leaves out what was written while it ran', async () => {
    vi.useFakeTimers()
    const { w, send } = boot()
    wire(send)
    const sessions = realmOf('realm-c2')
    const binder = binderTo(send)
    const sinceB = Date.now()
    notIndexedFolder('B', '/p/demo', sinceB)
    const b = watchAndClaimRollout('B', '/p/demo', sinceB, () => {}, sessions, undefined, { onRollout: (r) => { if (r) openNotIndexedWindow('B', r.path, sinceB, Date.now()) } })
    let a: { stop(): void } | null = null
    try {
      const r1 = rolloutIn(sessions, 20)
      writeFileSync(r1, metaFor(20, '/p/demo', new Date(Date.now() + 50).toISOString()) + turn('B-FIRST', new Date(Date.now() + 60).toISOString()))
      await vi.advanceTimersByTimeAsync(600)
      // A: an indexed tab launched later in the same folder, its Codex yet to write a rollout.
      const tA = Date.now()
      send(runX('A', tA)); binder.beginLaunch('A'); binder.startRun('A', true)
      a = watchAndClaimRollout('A', '/p/demo', tA, () => {}, sessions, undefined, { onRollout: (r) => binder.noteRollout('A', r) })
      await vi.advanceTimersByTimeAsync(100)
      // B types /new: its Codex starts another conversation in a new rollout, and no hook says so.
      const r2 = rolloutIn(sessions, 21)
      writeFileSync(r2, metaFor(21, '/p/demo', new Date(Date.now() + 50).toISOString()) + turn('B-AFTER-NEW', new Date(Date.now() + 60).toISOString()))
      await vi.advanceTimersByTimeAsync(600)
      expect(fake.trs.filter((t) => t.runId === fake.runs.find((r) => r.sessionId === 'A')!.runId).map((t) => basename(t.path))).toEqual([basename(r2)])
      w.tickNow()
      expect(words('A')).toEqual([])
      expect(fake.msgs.map((m) => m.content)).not.toContain('B-AFTER-NEW')
      void r1
    } finally {
      a?.stop(); b.stop()
    }
  })
})
