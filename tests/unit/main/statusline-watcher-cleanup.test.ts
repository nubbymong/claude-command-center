// tests/unit/main/statusline-watcher-cleanup.test.ts
// R-009 minor: per-session status files must be reapable (cleanupStatusFile) and
// the watcher must sweep stale status files at boot so the 5s poll fan-out can't
// grow unbounded for the life of the install.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// statusline-watcher imports electron + several main-process modules at load.
// None are exercised by cleanupStatusFile / sweepStaleStatusFiles, so stub the
// heavy ones so the module resolves in a unit context.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../../src/main/account-color', () => ({ decorateStatuslineWithColour: (d: unknown) => d }))
vi.mock('../../../src/main/providers/claude/telemetry', () => ({ notifyClaudeTelemetry: () => {} }))
vi.mock('../../../src/main/sentinel/index', () => ({ sentinelObserve: () => {} }))

let tmp: string
vi.mock('../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => tmp,
}))

import { cleanupStatusFile, sweepStaleStatusFiles } from '../../../src/main/statusline-watcher'

function statusDir(): string { return path.join(tmp, 'status') }
function writeStatus(sessionId: string, ageMs: number): string {
  fs.mkdirSync(statusDir(), { recursive: true })
  const f = path.join(statusDir(), `${sessionId}.json`)
  fs.writeFileSync(f, JSON.stringify({ sessionId }))
  const t = (Date.now() - ageMs) / 1000
  fs.utimesSync(f, t, t)
  return f
}

// getStatusDir() caches the status dir on first call (module-level), so the whole
// file must share one `tmp`; reset only the status dir contents between tests.
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slw-')) })
beforeEach(() => { fs.rmSync(statusDir(), { recursive: true, force: true }); fs.mkdirSync(statusDir(), { recursive: true }) })
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('cleanupStatusFile', () => {
  it('removes the per-session status file', () => {
    const f = writeStatus('sess-a', 0)
    expect(fs.existsSync(f)).toBe(true)
    cleanupStatusFile('sess-a')
    expect(fs.existsSync(f)).toBe(false)
  })
  it('is a no-op when the file is absent', () => {
    expect(() => cleanupStatusFile('does-not-exist')).not.toThrow()
  })
})

describe('sweepStaleStatusFiles (boot-time reaper)', () => {
  it('deletes status files older than the cutoff but keeps fresh ones', () => {
    const old = writeStatus('old', 1000 * 60 * 60 * 24 * 10) // 10 days
    const fresh = writeStatus('fresh', 1000 * 60) // 1 minute
    const removed = sweepStaleStatusFiles(1000 * 60 * 60 * 24 * 3) // 3 day cutoff
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
    expect(removed).toBe(1)
  })
  it('does not throw when the status dir is missing', () => {
    fs.rmSync(statusDir(), { recursive: true, force: true })
    expect(() => sweepStaleStatusFiles(1)).not.toThrow()
  })
})
