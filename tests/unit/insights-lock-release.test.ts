import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// #213: an insights run takes its lock, then does disk work, then enters the
// try whose `finally` releases that lock. Anything that threw in between —
// ensureDir, or the opening catalogue write losing a rename race to a virus
// scanner — stranded the key in `inFlight` for the life of the process, and
// every later run reported "already running" with nothing running. A restart
// was the only way out.

const h = vi.hoisted(() => ({
  resourcesDir: '',
  profileDir: {} as Record<string, string>,
  profiles: [] as Array<{ id: string; name?: string; accountEmail: string; isPrimary?: boolean }>,
  /** renameSync call number that should fail, 1-based. -1 disables. */
  failOnCall: -1,
  callCount: 0
}))

vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {}
}))
vi.mock('../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/account-profiles')>()),
  getProfileConfigDir: (id: string) => h.profileDir[id] ?? '',
  getPrimaryProfileId: () => h.profiles.find((p) => p.isPrimary)?.id ?? h.profiles[0]?.id ?? null,
  setupProfileLinks: () => {},
  listProfiles: () => h.profiles
}))
vi.mock('../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../src/main/pty-manager', () => ({
  resolveClaudeForPty: () => ({ cmd: 'claude' }),
  withProfileHome: (e: unknown) => e
}))
vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: () => {},
    onExit: (cb: (e: { exitCode: number }) => void) => cb({ exitCode: 0 }),
    write: () => {},
    kill: () => {}
  })
}))
vi.mock('../../src/main/claude-headless', () => ({
  spawnClaudeHeadless: async () => ({ code: 0, stdout: JSON.stringify(KPIS), stderr: '' })
}))

// ENOSPC, deliberately: it is NOT one of the transient codes saveCatalogue
// retries, so it models "the write really did fail" rather than the scanner
// race. The lock must be released either way.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return {
    ...real,
    default: real,
    renameSync: (from: string, to: string) => {
      h.callCount++
      if (h.callCount === h.failOnCall) {
        const e = new Error(`ENOSPC: no space left on device, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException
        e.code = 'ENOSPC'
        throw e
      }
      return real.renameSync(from, to)
    }
  }
})

const KPIS = {
  period: { start: '2026-07-01', end: '2026-07-31', days: 31 },
  kpis: { Volume: { sessions: { value: 10, label: 'Sessions', format: 'number', goodDirection: 'up' } } }
}

import { runInsights, runCrossAccountInsights, isRunning, isCrossAccountRunning } from '../../src/main/insights-runner'

let tmpRoot = ''
const getWin = () => null

function seed(id: string, email: string, isPrimary = false): void {
  const dir = join(tmpRoot, 'profiles', id)
  mkdirSync(join(dir, '.claude', 'usage-data'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'usage-data', 'report.html'), '<html><body>r</body></html>')
  h.profileDir[id] = dir
  h.profiles.push({ id, name: `Acct ${id.toUpperCase()}`, accountEmail: email, isPrimary })
}

/** Swallow whatever the run does with the failure; the lock is what is on trial. */
async function attempt(fn: () => Promise<unknown>): Promise<void> {
  try { await fn() } catch { /* the run is allowed to fail */ }
}

describe('a failed catalogue write never strands an insights lock', () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'insights-lock-'))
    h.resourcesDir = join(tmpRoot, 'resources')
    mkdirSync(h.resourcesDir, { recursive: true })
    h.profileDir = {}
    h.profiles = []
    h.failOnCall = -1
    h.callCount = 0
  })
  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('releases the per-account lock when the opening write fails', async () => {
    seed('a', 'a@example.com', true)
    h.failOnCall = 1 // the very first upsertRun, before any awaited work

    await attempt(() => runInsights(getWin, { profileId: 'a' }))

    expect(isRunning('a')).toBe(false)
    // The real symptom was the NEXT run being refused, so prove that directly.
    await expect(runInsights(getWin, { profileId: 'a' })).resolves.toBeTruthy()
  })

  it('releases the aggregate lock when the opening write fails', async () => {
    seed('a', 'a@example.com', true)
    seed('b', 'b@example.com')
    h.failOnCall = 1 // the aggregate's own opening publish()

    await attempt(() => runCrossAccountInsights(getWin))

    expect(isCrossAccountRunning()).toBe(false)
    // Pre-fix this threw "A cross-account report is already being generated"
    // forever, with no run in flight.
    await attempt(() => runCrossAccountInsights(getWin))
    expect(isCrossAccountRunning()).toBe(false)
  })

  it('leaves no lock behind when a member run fails mid-fan-out', async () => {
    seed('a', 'a@example.com', true)
    seed('b', 'b@example.com')
    h.failOnCall = 3 // inside the fan-out, once members are already writing

    await attempt(() => runCrossAccountInsights(getWin))

    expect(isCrossAccountRunning()).toBe(false)
    expect(isRunning('a')).toBe(false)
    expect(isRunning('b')).toBe(false)
  })
})
