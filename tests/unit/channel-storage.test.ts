// tests/unit/channel-storage.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const files = new Map<string, string>()
vi.mock('fs', () => ({
  existsSync: (p: string) => files.has(p),
  readFileSync: (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)! },
  writeFileSync: (p: string, d: string) => { files.set(p, d) },
  mkdirSync: vi.fn(),
  renameSync: (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a) },
  copyFileSync: (a: string, b: string) => { files.set(b, files.get(a)!) },
  unlinkSync: (p: string) => { files.delete(p) },
  readdirSync: () => [] as string[],
}))
vi.mock('path', () => ({ join: (...p: string[]) => p.join('/') }))
vi.mock('../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res' }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

const { readJsonFile, writeJsonFile } = await import('../../src/main/channel-storage')

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
  })

  it('on missing file: returns seeded defaults without writing', () => {
    const result = readJsonFile('standing-approvals.json', () => ({ schemaVersion: 1, approvals: [] }))
    expect(result).toEqual({ schemaVersion: 1, approvals: [] })
  })
})
