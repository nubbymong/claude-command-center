import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// #213: catalogue.json is written tmp-then-rename. On Windows that rename fails
// with EPERM/EACCES/EBUSY whenever another process (Defender, the Search
// indexer, a backup agent) holds a momentary handle on either path. It threw
// often enough under CPU load to abort whichever insights run was mid-flight,
// which surfaced as an unrelated flaky unit test.

const h = vi.hoisted(() => ({
  resourcesDir: '',
  /** Error codes renameSync should throw, one per call, before it succeeds. */
  failCodes: [] as string[],
  /** Every `from` path rename was asked to move, in order. */
  renameFrom: [] as string[]
}))

vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {}
}))
vi.mock('../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../src/main/pty-manager', () => ({ resolveClaudeForPty: () => ({ cmd: 'claude' }), withProfileHome: (e: unknown) => e }))
vi.mock('../../src/main/claude-headless', () => ({ spawnClaudeHeadless: async () => ({ code: 0, stdout: '', stderr: '' }) }))
vi.mock('node-pty', () => ({ spawn: () => ({ onData: () => {}, onExit: () => {}, write: () => {}, kill: () => {} }) }))

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return {
    ...real,
    default: real,
    renameSync: (from: string, to: string) => {
      h.renameFrom.push(String(from))
      const code = h.failCodes.shift()
      if (code) {
        const err = new Error(`${code}: simulated, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException
        err.code = code
        throw err
      }
      return real.renameSync(from, to)
    }
  }
})

import { cleanupStuckRuns, getCatalogue } from '../../src/main/insights-runner'

let tmpRoot = ''
let insightsDir = ''

/** Seed a catalogue holding one run that cleanupStuckRuns will want to rewrite. */
function seedStuckCatalogue(): void {
  writeFileSync(
    join(insightsDir, 'catalogue.json'),
    JSON.stringify({ runs: [{ id: 'r1', timestamp: 1, status: 'running' }] })
  )
}

function stagingFiles(): string[] {
  return readdirSync(insightsDir).filter((f) => f.endsWith('.tmp'))
}

describe('catalogue persistence survives a transient Windows rename failure', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'insights-catwrite-'))
    h.resourcesDir = join(tmpRoot, 'resources')
    insightsDir = join(h.resourcesDir, 'insights')
    mkdirSync(insightsDir, { recursive: true })
    h.failCodes = []
    h.renameFrom = []
  })
  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('retries a rename that loses to a scanner and still lands the write', () => {
    seedStuckCatalogue()
    h.failCodes = ['EPERM', 'EACCES', 'EBUSY']

    expect(() => cleanupStuckRuns()).not.toThrow()

    // All three simulated losses were consumed, then a later attempt landed.
    // Not an exact count: the real filesystem underneath can lose the race too,
    // and a retry-tolerant fix deserves a retry-tolerant assertion.
    expect(h.failCodes).toEqual([])
    expect(h.renameFrom.length).toBeGreaterThanOrEqual(4)
    // The write is the point — not merely that it stopped throwing.
    expect(getCatalogue().runs[0].status).toBe('failed')
    expect(JSON.parse(readFileSync(join(insightsDir, 'catalogue.json'), 'utf-8')).runs[0].error)
      .toMatch(/Interrupted by app restart/)
    expect(stagingFiles()).toEqual([])
  })

  it('gives up on a real permission problem instead of retrying forever', () => {
    seedStuckCatalogue()
    // Longer than the retry budget, so the last attempt still fails.
    h.failCodes = ['EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM']

    expect(() => cleanupStuckRuns()).toThrow(/EPERM/)
    // Five delays plus the first try = six attempts, then it stops.
    expect(h.renameFrom).toHaveLength(6)
    // A failed write must not leave its staging file for the next writer.
    expect(stagingFiles()).toEqual([])
  })

  it('does not retry an error that a retry cannot fix', () => {
    seedStuckCatalogue()
    h.failCodes = ['ENOSPC', 'ENOSPC']

    expect(() => cleanupStuckRuns()).toThrow(/ENOSPC/)
    expect(h.renameFrom).toHaveLength(1)
    expect(stagingFiles()).toEqual([])
  })

  it('stages each write under its own name so a stranded tmp is never adopted', () => {
    seedStuckCatalogue()
    cleanupStuckRuns()
    // Re-seed and write again; the two writes must not share a staging path.
    seedStuckCatalogue()
    cleanupStuckRuns()

    // Distinct paths, not attempt count: a retry reuses its own staging path, so
    // a real EPERM underneath adds attempts without adding staging names.
    const staged = [...new Set(h.renameFrom)]
    expect(staged).toHaveLength(2)
    expect(staged.every((p) => !/[/\\]catalogue\.json\.tmp$/.test(p))).toBe(true)
  })
})
