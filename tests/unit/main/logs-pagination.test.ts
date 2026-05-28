import { describe, it, expect } from 'vitest'
import { readLogEntries } from '../../../src/main/session-logger'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('logs pagination (U4.2)', () => {
  it('returns { entries, total, hasMore } with limit/offset honoured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'logs-'))
    const lines = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({ ts: i, type: 'data', data: `e${i}` })
    ).join('\n')
    writeFileSync(join(dir, 'session.jsonl'), lines)
    const r = await readLogEntries(dir, 10, 10)
    expect(r.entries.length).toBe(10)
    expect(r.total).toBe(30)
    expect(r.hasMore).toBe(true)
    expect((r.entries[0] as any).data).toBe('e10')
  })

  it('hasMore is false when last page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'logs-'))
    const lines = Array.from({ length: 15 }, (_, i) =>
      JSON.stringify({ ts: i, type: 'data', data: `e${i}` })
    ).join('\n')
    writeFileSync(join(dir, 'session.jsonl'), lines)
    const r = await readLogEntries(dir, 10, 10)
    expect(r.entries.length).toBe(5)
    expect(r.total).toBe(15)
    expect(r.hasMore).toBe(false)
  })

  it('returns hasMore false for empty file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'logs-'))
    const r = await readLogEntries(dir, 0, 500)
    expect(r.entries.length).toBe(0)
    expect(r.total).toBe(0)
    expect(r.hasMore).toBe(false)
  })
})
