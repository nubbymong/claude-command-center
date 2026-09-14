// tests/unit/channel-ledger.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
const lines: string[] = []
const dirFiles: string[] = []
vi.mock('../../src/main/channel-storage', () => ({
  appendLine: (_n: string, line: string) => { lines.push(line) },
  listFiles: () => dirFiles,
  deleteFile: (n: string) => { const i = dirFiles.indexOf(n); if (i >= 0) dirFiles.splice(i, 1) },
  // rotateLedgers now also reaps attachments/ (#487 audit); channel-attachments.ts
  // reads channelsDir() to find that dir. Point it at a path that never exists so
  // reapAttachments's existsSync guard no-ops -- attachment reaping itself is
  // covered by its own dedicated test.
  channelsDir: () => '/mock/nonexistent/conductor-channels',
}))
vi.mock('../../src/main/hooks/hook-payload-redactor', () => ({
  redactHookPayload: <T>(v: T): T => v,
}))
const { appendLedger, rotateLedgers, ledgerFileForDate } = await import('../../src/main/channel-ledger')

describe('channel-ledger', () => {
  beforeEach(() => { lines.length = 0; dirFiles.length = 0 })
  it('appends a redacted one-line JSON record and returns the record id', () => {
    const id = appendLedger({ source: 'github', target: 'frontend', transport: 'pty', kind: 'bus-fire', summary: 'PR #48 merged' })
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.kind).toBe('bus-fire')
    expect(parsed.id).toBe(id)
    expect(typeof parsed.ts).toBe('string')
  })
  it('ledgerFileForDate uses the UTC day', () => {
    expect(ledgerFileForDate(new Date('2026-05-27T23:30:00Z'))).toBe('2026-05-27.jsonl')
  })
  it('rotateLedgers deletes ledger files older than 30 days', () => {
    dirFiles.push('2026-01-01.jsonl', '2026-05-27.jsonl', 'rules.json')
    rotateLedgers(new Date('2026-05-27T00:00:00Z'), 30)
    expect(dirFiles).toContain('2026-05-27.jsonl')
    expect(dirFiles).toContain('rules.json')          // non-ledger files untouched
    expect(dirFiles).not.toContain('2026-01-01.jsonl') // >30 days old
  })
})
