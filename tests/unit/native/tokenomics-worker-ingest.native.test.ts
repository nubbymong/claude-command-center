import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createTokenomicsWorker } from '../../../src/main/tokenomics/tokenomics-worker'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'
import type { FromTkWorker } from '../../../src/main/tokenomics/tk-worker-transport'

const PRICING = { 'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }

function writeClaudeFile(dir: string, project: string, name: string, lines: object[]) {
  const pdir = path.join(dir, project)
  fs.mkdirSync(pdir, { recursive: true })
  fs.writeFileSync(path.join(pdir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

describe('tokenomics worker ingest', () => {
  let tmp: string
  let workers: { stop: () => void }[]
  const track = <T extends { stop: () => void }>(w: T): T => { workers.push(w); return w }
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkw-')); workers = [] })
  afterEach(() => {
    // Stop every worker created in the test so its fs.watch watchers release the
    // temp dir before removal. Under Node 24 (Electron 42) an active fs.watch
    // holds the watched directory handle on Windows, so a leaked watcher makes
    // rmSync throw ENOTEMPTY. (Pre-Node-24 the handle was released eagerly.)
    for (const w of workers) { try { w.stop() } catch { /* already stopped */ } }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('initial sweep ingests claude files and answers summary query', async () => {
    const claudeDir = path.join(tmp, 'claude')
    writeClaudeFile(claudeDir, 'F--proj', 's1.jsonl', [
      { type: 'user', cwd: 'F:\\proj', sessionId: 's1' },
      { type: 'assistant', timestamp: '2026-06-01T10:00:00Z', sessionId: 's1', requestId: 'r1',
        message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 0 } } },
    ])
    const fake = new FakeTkWorkerTransport()
    const msgs: FromTkWorker[] = []
    fake.onMessage((m) => msgs.push(m))
    track(createTokenomicsWorker(fake.asWorkerSide(), {}))
    fake.post({ type: 'open', dbPath: ':memory:', pricing: PRICING, configs: [{ configId: 'a', label: 'App', workingDirectory: 'F:\\proj' }], claudeProjectsDir: claudeDir, codexSessionsDir: path.join(tmp, 'codex') })
    await new Promise((r) => setTimeout(r, 60))
    expect(msgs.some((m) => m.type === 'ready')).toBe(true)
    expect(msgs.some((m) => m.type === 'index-complete')).toBe(true)

    fake.post({ type: 'query', id: 1, kind: 'summary', args: {} })
    await new Promise((r) => setTimeout(r, 10))
    const res = msgs.find((m) => m.type === 'query-result' && (m as any).id === 1) as any
    expect(res.rows[0].kpis.lifeToDateCostUsd).toBeCloseTo(5, 5)
    expect(res.rows[0].costByConfig[0]).toMatchObject({ configId: 'a', label: 'App' })
  })

  it('initial sweep ingests NESTED subagent/sidechain transcripts (recursive enumeration)', async () => {
    const claudeDir = path.join(tmp, 'claude')
    // Top-level main session transcript ($5)
    writeClaudeFile(claudeDir, 'F--proj', 's1.jsonl', [
      { type: 'assistant', timestamp: '2026-06-01T10:00:00Z', sessionId: 's1', requestId: 'r1',
        message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 0 } } },
    ])
    // Subagent transcript nested under <project>/<session>/subagents/ ($5) — the
    // real on-disk layout for Task/workflow subagents. Must be enumerated too.
    const subDir = path.join(claudeDir, 'F--proj', 's1', 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(subDir, 'agent-aaa.jsonl'),
      JSON.stringify({ type: 'assistant', isSidechain: true, agentId: 'aaa', timestamp: '2026-06-01T10:05:00Z', sessionId: 's1-sub', requestId: 'r2',
        message: { id: 'm2', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }) + '\n')
    const fake = new FakeTkWorkerTransport()
    const msgs: FromTkWorker[] = []
    fake.onMessage((m) => msgs.push(m))
    track(createTokenomicsWorker(fake.asWorkerSide(), {}))
    fake.post({ type: 'open', dbPath: ':memory:', pricing: PRICING, configs: [], claudeProjectsDir: claudeDir, codexSessionsDir: path.join(tmp, 'codex') })
    await new Promise((r) => setTimeout(r, 80))
    fake.post({ type: 'query', id: 1, kind: 'summary', args: {} })
    await new Promise((r) => setTimeout(r, 10))
    const res = msgs.find((m) => m.type === 'query-result' && (m as any).id === 1) as any
    // Main $5 + nested subagent $5 = $10. Pre-fix (one-level enumeration) this is only $5.
    expect(res.rows[0].kpis.lifeToDateCostUsd).toBeCloseTo(10, 5)
  })

  it('is idempotent: re-open + re-sweep does not double-count (dedup + cursor)', async () => {
    const claudeDir = path.join(tmp, 'claude')
    writeClaudeFile(claudeDir, 'F--proj', 's1.jsonl', [
      { type: 'assistant', timestamp: '2026-06-01T10:00:00Z', sessionId: 's1', requestId: 'r1',
        message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 0 } } },
    ])
    const dbFile = path.join(tmp, 'tk.db')
    for (let i = 0; i < 2; i++) {
      const fake = new FakeTkWorkerTransport()
      const msgs: FromTkWorker[] = []
      fake.onMessage((m) => msgs.push(m))
      const w = track(createTokenomicsWorker(fake.asWorkerSide(), {}))
      fake.post({ type: 'open', dbPath: dbFile, pricing: PRICING, configs: [], claudeProjectsDir: claudeDir, codexSessionsDir: path.join(tmp, 'codex') })
      await new Promise((r) => setTimeout(r, 60))
      fake.post({ type: 'query', id: 1, kind: 'summary', args: {} })
      await new Promise((r) => setTimeout(r, 10))
      const res = msgs.find((m) => m.type === 'query-result' && (m as any).id === 1) as any
      expect(res.rows[0].kpis.lifeToDateCostUsd).toBeCloseTo(5, 5)
      fake.post({ type: 'shutdown' })
    }
  })

  it('appended lines are picked up incrementally via tickNow (tail from cursor)', async () => {
    const claudeDir = path.join(tmp, 'claude')
    const file = path.join(claudeDir, 'F--proj', 's1.jsonl')
    writeClaudeFile(claudeDir, 'F--proj', 's1.jsonl', [
      { type: 'assistant', timestamp: '2026-06-01T10:00:00Z', sessionId: 's1', requestId: 'r1', message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 0 } } },
    ])
    const fake = new FakeTkWorkerTransport(); const msgs: FromTkWorker[] = []
    fake.onMessage((m) => msgs.push(m))
    const w = track(createTokenomicsWorker(fake.asWorkerSide(), {}))
    fake.post({ type: 'open', dbPath: ':memory:', pricing: PRICING, configs: [], claudeProjectsDir: claudeDir, codexSessionsDir: path.join(tmp, 'codex') })
    await new Promise((r) => setTimeout(r, 60))
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T11:00:00Z', sessionId: 's1', requestId: 'r2', message: { id: 'm2', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }) + '\n')
    w.tickNow()
    await new Promise((r) => setTimeout(r, 20))
    fake.post({ type: 'query', id: 2, kind: 'summary', args: {} })
    await new Promise((r) => setTimeout(r, 10))
    const res = msgs.find((m) => m.type === 'query-result' && (m as any).id === 2) as any
    expect(res.rows[0].kpis.lifeToDateCostUsd).toBeCloseTo(10, 5)
  })

  it('index-status query reports firstIndexComplete + eventsTotal', async () => {
    const claudeDir = path.join(tmp, 'claude')
    writeClaudeFile(claudeDir, 'F--proj', 's1.jsonl', [
      { type: 'assistant', timestamp: '2026-06-01T10:00:00Z', sessionId: 's1', requestId: 'r1', message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 0 } } },
    ])
    const fake = new FakeTkWorkerTransport(); const msgs: FromTkWorker[] = []
    fake.onMessage((m) => msgs.push(m))
    track(createTokenomicsWorker(fake.asWorkerSide(), {}))
    fake.post({ type: 'open', dbPath: ':memory:', pricing: PRICING, configs: [], claudeProjectsDir: claudeDir, codexSessionsDir: path.join(tmp, 'codex') })
    await new Promise((r) => setTimeout(r, 60))
    fake.post({ type: 'query', id: 3, kind: 'index-status', args: {} })
    await new Promise((r) => setTimeout(r, 10))
    const res = msgs.find((m) => m.type === 'query-result' && (m as any).id === 3) as any
    expect(res.rows[0].firstIndexComplete).toBe(true)
    expect(res.rows[0].eventsTotal).toBe(1)
  })

  it('fully drains a file larger than the per-tick cap across successive ticks', async () => {
    const claudeDir = path.join(tmp, 'claude')
    // 5 assistant lines, each 1M input tokens ($5). Tiny cap forces multi-tick draining.
    const lines = Array.from({ length: 5 }, (_, i) => ({
      type: 'assistant', timestamp: `2026-06-01T10:0${i}:00Z`, sessionId: 's1', requestId: `r${i}`,
      message: { id: `m${i}`, model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    }))
    writeClaudeFile(claudeDir, 'F--proj', 's1.jsonl', lines)
    const fake = new FakeTkWorkerTransport(); const msgs: FromTkWorker[] = []
    fake.onMessage((m) => msgs.push(m))
    const w = track(createTokenomicsWorker(fake.asWorkerSide(), { maxTickBytes: 200 }))  // far smaller than the file
    fake.post({ type: 'open', dbPath: ':memory:', pricing: PRICING, configs: [], claudeProjectsDir: claudeDir, codexSessionsDir: path.join(tmp, 'codex') })
    await new Promise((r) => setTimeout(r, 60))
    // Drive successive ticks until the cost stops growing (capped at a generous loop bound).
    let last = -1
    for (let k = 0; k < 20; k++) {
      fake.post({ type: 'query', id: 100 + k, kind: 'summary', args: {} })
      await new Promise((r) => setTimeout(r, 5))
      const res = msgs.find((m) => m.type === 'query-result' && (m as any).id === 100 + k) as any
      const cost = res.rows[0].kpis.lifeToDateCostUsd
      if (cost === last) break
      last = cost
      w.tickNow()
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(last).toBeCloseTo(25, 5)  // all 5 lines * $5 ingested, no loss, no double-count
  })

  it('fs-watch debounce triggers incremental ingest on append (no explicit tickNow)', async () => {
    const claudeDir = path.join(tmp, 'claude')
    const file = path.join(claudeDir, 'F--proj', 's1.jsonl')
    writeClaudeFile(claudeDir, 'F--proj', 's1.jsonl', [
      { type: 'assistant', timestamp: '2026-06-01T10:00:00Z', sessionId: 's1', requestId: 'r1', message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 0 } } },
    ])
    const fake = new FakeTkWorkerTransport(); const msgs: FromTkWorker[] = []
    fake.onMessage((m) => msgs.push(m))
    const w = track(createTokenomicsWorker(fake.asWorkerSide(), { watchDebounceMs: 30 }))
    fake.post({ type: 'open', dbPath: ':memory:', pricing: PRICING, configs: [], claudeProjectsDir: claudeDir, codexSessionsDir: path.join(tmp, 'codex') })
    await new Promise((r) => setTimeout(r, 60))
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T11:00:00Z', sessionId: 's1', requestId: 'r2', message: { id: 'm2', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }) + '\n')
    await new Promise((r) => setTimeout(r, 350))   // allow fs.watch event + debounce + ingest
    fake.post({ type: 'query', id: 7, kind: 'summary', args: {} })
    await new Promise((r) => setTimeout(r, 10))
    const res = msgs.find((m) => m.type === 'query-result' && (m as any).id === 7) as any
    expect(res.rows[0].kpis.lifeToDateCostUsd).toBeCloseTo(10, 5)
    w.stop()
  })

  it('stop() closes watchers + timers without throwing and is safe to call twice', async () => {
    const claudeDir = path.join(tmp, 'claude')
    writeClaudeFile(claudeDir, 'F--proj', 's1.jsonl', [
      { type: 'assistant', timestamp: '2026-06-01T10:00:00Z', sessionId: 's1', requestId: 'r1', message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 0 } } },
    ])
    const fake = new FakeTkWorkerTransport()
    const w = track(createTokenomicsWorker(fake.asWorkerSide(), {}))
    fake.post({ type: 'open', dbPath: ':memory:', pricing: PRICING, configs: [], claudeProjectsDir: claudeDir, codexSessionsDir: path.join(tmp, 'codex') })
    await new Promise((r) => setTimeout(r, 60))
    expect(() => { w.stop(); w.stop() }).not.toThrow()
  })
})

describe('codex rollouts are streamed, not slurped', () => {
  // A real ~/.codex/sessions held 80 GB across 320 files, several 1.8-2.5 GB
  // each. readFileSync on those hit Node's string ceiling, the catch swallowed
  // it without writing a cursor, and every sweep re-read the same unreadable
  // file: Tokenomics sat on "Indexing 1700/1997" for hours over a database that
  // had been complete since July, and the Codex spend in it was undercounted.
  let tmp: string
  let workers: { stop: () => void }[]
  const track = <T extends { stop: () => void }>(w: T): T => { workers.push(w); return w }
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkc-')); workers = [] })
  afterEach(() => { for (const w of workers) { try { w.stop() } catch { /* */ } } fs.rmSync(tmp, { recursive: true, force: true }) })

  const CODEX_PRICING = { 'gpt-5.5': { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 } }

  /** A rollout with `turns` token_count lines, each separated by `padBytes` of
   *  tool-output filler on its own line, so the file is large but the parser
   *  wants almost none of it. */
  function writeRollout(dir: string, name: string, turns: number, padBytes: number): string {
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, name)
    const fd = fs.openSync(p, 'w')
    fs.writeSync(fd, JSON.stringify({ type: 'session_meta', timestamp: '2026-08-01T00:00:00Z', payload: { id: 'cx-1', cwd: 'F:\\proj', model: 'gpt-5.5' } }) + '\n')
    fs.writeSync(fd, JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }) + '\n')
    const pad = 'x'.repeat(padBytes)
    for (let i = 0; i < turns; i++) {
      fs.writeSync(fd, JSON.stringify({ type: 'event_msg', payload: { type: 'tool_output', output: pad } }) + '\n')
      fs.writeSync(fd, JSON.stringify({ type: 'event_msg', timestamp: '2026-08-01T00:00:0' + (i % 10) + 'Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 10 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } } } }) + '\n')
    }
    fs.closeSync(fd)
    return p
  }

  /** Sweep repeatedly until two consecutive COMPLETED sweeps report the same
   *  total. Waits for each sweep to finish before asking for the next, since a
   *  reindex posted mid-sweep is dropped (`sweeping` guard). */
  async function sweepUntilStable(fake: FakeTkWorkerTransport, msgs: FromTkWorker[]): Promise<number> {
    const completions = () => msgs.filter((m) => m.type === 'index-complete') as Array<{ eventsTotal: number }>
    const waitForCompletion = async (n: number) => {
      for (let i = 0; i < 500; i++) { await new Promise((r) => setTimeout(r, 10)); if (completions().length >= n) return }
      throw new Error('sweep did not complete')
    }
    await waitForCompletion(1)
    let last = completions()[0].eventsTotal
    for (let round = 1; round < 60; round++) {
      fake.post({ type: 'reindex' })
      await waitForCompletion(round + 1)
      const now = completions()[round].eventsTotal
      if (now === last) return now
      last = now
    }
    return last
  }

  it('drains a rollout far larger than one tick across sweeps, and finds every turn', async () => {
    // 40 turns with 200 KB of filler each = ~8 MB; a 1 MB tick needs several
    // sweeps to reach the end. Every token_count must be found regardless.
    const codexDir = path.join(tmp, 'codex')
    writeRollout(path.join(codexDir, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-abc.jsonl', 40, 200 * 1024)
    const fake = new FakeTkWorkerTransport()
    const msgs: FromTkWorker[] = []
    fake.onMessage((m) => msgs.push(m))
    track(createTokenomicsWorker(fake.asWorkerSide(), { maxTickBytes: 1024 * 1024 }))
    fake.post({ type: 'open', dbPath: ':memory:', pricing: CODEX_PRICING, configs: [], claudeProjectsDir: path.join(tmp, 'claude'), codexSessionsDir: codexDir })
    const total = await sweepUntilStable(fake, msgs)
    expect(total).toBe(40)
  })

  it('never re-reads the whole file: the cursor advances every tick', async () => {
    const codexDir = path.join(tmp, 'codex')
    const file = writeRollout(path.join(codexDir, '2026', '08', '01'), 'rollout-2026-08-01T00-00-00-abc.jsonl', 10, 200 * 1024)
    // A tracing fs: count how many bytes are actually read from the rollout.
    let bytesRead = 0
    const tracing = new Proxy(fs, {
      get(t, k) {
        if (k === 'readSync') return (fd: number, buf: Buffer, off: number, len: number, pos: number) => { const n = fs.readSync(fd, buf, off, len, pos); bytesRead += n; return n }
        return (t as unknown as Record<PropertyKey, unknown>)[k]
      },
    })
    const fake = new FakeTkWorkerTransport()
    const msgs: FromTkWorker[] = []
    fake.onMessage((m) => msgs.push(m))
    track(createTokenomicsWorker(fake.asWorkerSide(), { fs: tracing as unknown as typeof fs, maxTickBytes: 1024 * 1024 }))
    fake.post({ type: 'open', dbPath: ':memory:', pricing: CODEX_PRICING, configs: [], claudeProjectsDir: path.join(tmp, 'claude'), codexSessionsDir: codexDir })
    await sweepUntilStable(fake, msgs)
    const size = fs.statSync(file).size
    // Read once, plus the 64 KB head re-read on each resumed tick — nowhere
    // near a whole-file read per sweep. Old behaviour: size * (sweeps + 1).
    expect(bytesRead).toBeLessThan(size * 1.5)
    expect(bytesRead).toBeGreaterThanOrEqual(size)
  })

  it('reports firstIndexComplete on ready when the DB already has it', async () => {
    // The supervisor used to learn this only from a fresh index-complete, so
    // every launch showed "Indexing" until a whole sweep finished, or forever.
    const dbPath = path.join(tmp, 'tk.db')
    const claudeDir = path.join(tmp, 'claude')
    writeClaudeFile(claudeDir, 'F--proj', 's1.jsonl', [
      { type: 'assistant', timestamp: '2026-06-01T10:00:00Z', sessionId: 's1', requestId: 'r1',
        message: { id: 'm1', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 0 } } },
    ])
    // Run 1: index completes and persists the flag.
    const f1 = new FakeTkWorkerTransport()
    const m1: FromTkWorker[] = []
    f1.onMessage((m) => m1.push(m))
    const w1 = track(createTokenomicsWorker(f1.asWorkerSide(), {}))
    f1.post({ type: 'open', dbPath, pricing: PRICING, configs: [], claudeProjectsDir: claudeDir, codexSessionsDir: path.join(tmp, 'codex') })
    await new Promise((r) => setTimeout(r, 80))
    expect((m1.find((m) => m.type === 'ready') as { firstIndexComplete: boolean }).firstIndexComplete).toBe(false)
    expect(m1.some((m) => m.type === 'index-complete')).toBe(true)
    w1.stop()
    // Run 2: a fresh worker on the same DB says so ON READY, before any sweep.
    const f2 = new FakeTkWorkerTransport()
    const m2: FromTkWorker[] = []
    f2.onMessage((m) => m2.push(m))
    track(createTokenomicsWorker(f2.asWorkerSide(), {}))
    f2.post({ type: 'open', dbPath, pricing: PRICING, configs: [], claudeProjectsDir: claudeDir, codexSessionsDir: path.join(tmp, 'codex') })
    await new Promise((r) => setTimeout(r, 30))
    const ready = m2.find((m) => m.type === 'ready') as { firstIndexComplete: boolean; eventsTotal: number }
    expect(ready.firstIndexComplete).toBe(true)
    expect(ready.eventsTotal).toBe(1)
  })
})
