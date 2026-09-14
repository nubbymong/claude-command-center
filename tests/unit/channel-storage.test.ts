// tests/unit/channel-storage.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const files = new Map<string, string>()
vi.mock('fs', () => ({
  existsSync: (p: string) => files.has(p),
  readFileSync: (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)! },
  writeFileSync: (p: string, d: string) => { files.set(p, d) },
  appendFileSync: (p: string, d: string) => { files.set(p, (files.get(p) ?? '') + d) },
  mkdirSync: vi.fn(),
  renameSync: (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a) },
  copyFileSync: (a: string, b: string) => { files.set(b, files.get(a)!) },
  unlinkSync: (p: string) => { files.delete(p) },
  readdirSync: () => [] as string[],
}))
// Real module + a join override. A partial 'path' silently undefines whatever the
// code under test picks up later — dirname/basename, once staging moved into the
// shared atomic write.
vi.mock('path', async (importOriginal) => {
  const real = await importOriginal<typeof import('path')>()
  const join = (...p: string[]): string => p.join('/')
  return { ...real, default: { ...real, join }, join }
})
vi.mock('../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res' }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

const { readJsonFile, writeJsonFile, appendLine } = await import('../../src/main/channel-storage')

describe('channel-storage', () => {
  beforeEach(() => files.clear())

  it('writes then reads back JSON under conductor-channels/', () => {
    writeJsonFile('rules.json', { schemaVersion: 1, rules: [] })
    expect(files.has('/res/conductor-channels/rules.json')).toBe(true)
    expect(readJsonFile('rules.json', () => ({ schemaVersion: 1, rules: ['DEFAULT'] }))).toEqual({ schemaVersion: 1, rules: [] })
  })

  it('on corrupt JSON: renames to .corrupt-<ts> and returns seeded defaults', () => {
    files.set('/res/conductor-channels/rules.json', '{ not json')
    const result = readJsonFile('rules.json', () => ({ schemaVersion: 1, rules: ['SEED'] }))
    expect(result).toEqual({ schemaVersion: 1, rules: ['SEED'] })
    const corrupt = [...files.keys()].find(k => k.includes('rules.json.corrupt-'))
    expect(corrupt).toBeTruthy()
    expect(files.has('/res/conductor-channels/rules.json')).toBe(false)
  })

  it('on missing file: returns seeded defaults without writing', () => {
    const result = readJsonFile('standing-approvals.json', () => ({ schemaVersion: 1, approvals: [] }))
    expect(result).toEqual({ schemaVersion: 1, approvals: [] })
  })

  it('appendLine appends newline-delimited records (true append, preserves prior lines)', () => {
    appendLine('2026-06-12.jsonl', '{"a":1}')
    appendLine('2026-06-12.jsonl', '{"b":2}')
    appendLine('2026-06-12.jsonl', '{"c":3}')
    expect(files.get('/res/conductor-channels/2026-06-12.jsonl')).toBe('{"a":1}\n{"b":2}\n{"c":3}\n')
  })

  it('appendLine is back-compatible with a file written by the old read+rewrite path', () => {
    // Simulate an existing day-file from the previous implementation.
    files.set('/res/conductor-channels/2026-06-12.jsonl', '{"old":1}\n')
    appendLine('2026-06-12.jsonl', '{"new":2}')
    expect(files.get('/res/conductor-channels/2026-06-12.jsonl')).toBe('{"old":1}\n{"new":2}\n')
  })
})
