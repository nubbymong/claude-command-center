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
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tkw-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

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
    createTokenomicsWorker(fake.asWorkerSide(), {})
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
      const w = createTokenomicsWorker(fake.asWorkerSide(), {})
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
    const w = createTokenomicsWorker(fake.asWorkerSide(), {})
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
    createTokenomicsWorker(fake.asWorkerSide(), {})
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
    const w = createTokenomicsWorker(fake.asWorkerSide(), { maxTickBytes: 200 })  // far smaller than the file
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
    const w = createTokenomicsWorker(fake.asWorkerSide(), { watchDebounceMs: 30 })
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
    const w = createTokenomicsWorker(fake.asWorkerSide(), {})
    fake.post({ type: 'open', dbPath: ':memory:', pricing: PRICING, configs: [], claudeProjectsDir: claudeDir, codexSessionsDir: path.join(tmp, 'codex') })
    await new Promise((r) => setTimeout(r, 60))
    expect(() => { w.stop(); w.stop() }).not.toThrow()
  })
})
