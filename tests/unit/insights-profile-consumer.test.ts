// #48/#49 (rc.14 review F4/F5): an Insights run spawns `claude` twice under the
// account's credential home (the interactive /insights PTY, then the headless
// KPI extraction) and registered as a consumer for neither. The run now holds
// the profile from its first read to its `finally`, and waits out a rotation
// that is already in flight before that first read.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const h = vi.hoisted(() => ({
  resourcesDir: '',
  profileDir: {} as Record<string, string>,
  profiles: [] as Array<{ id: string; name?: string; accountEmail: string; isPrimary?: boolean }>,
  /** What the in-use guard said at the moment the /insights PTY exited. */
  heldDuringPty: null as boolean | null,
  ptySpawns: 0,
  /** Set by the test: the probe the PTY mock consults. */
  probe: (() => false) as () => boolean,
}))

vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {},
}))
vi.mock('../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/account-profiles')>()),
  getProfileConfigDir: (id: string) => h.profileDir[id] ?? '',
  getPrimaryProfileId: () => h.profiles.find((p) => p.isPrimary)?.id ?? h.profiles[0]?.id ?? null,
  setupProfileLinks: () => {},
  listProfiles: () => h.profiles,
}))
vi.mock('../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../src/main/pty-manager', () => ({
  resolveClaudeForPty: () => ({ cmd: 'claude' }),
  withProfileHome: (e: unknown) => e,
}))
vi.mock('node-pty', () => ({
  spawn: () => {
    h.ptySpawns++
    return {
      onData: () => {},
      onExit: (cb: (e: { exitCode: number }) => void) => {
        // Observe the guard WHILE the PTY step is alive, from inside the run.
        h.heldDuringPty = h.probe()
        cb({ exitCode: 0 })
      },
      write: () => {},
      kill: () => {},
    }
  },
}))
vi.mock('../../src/main/claude-headless', () => ({
  spawnClaudeHeadless: async () => ({ code: 0, stdout: JSON.stringify(KPIS), stderr: '' }),
}))

const KPIS = {
  period: { start: '2026-07-01', end: '2026-07-31', days: 31 },
  kpis: { Volume: { sessions: { value: 10, label: 'Sessions', format: 'number', goodDirection: 'up' } } },
}

import { runInsights, isRunning } from '../../src/main/insights-runner'
import {
  hasTransientProfileConsumer,
  noteProfileRefreshInFlight,
  _resetProfileConsumersForTest,
} from '../../src/main/profile-consumers'

let tmpRoot = ''
const getWin = () => null
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await Promise.resolve() }

function seed(id: string, email: string, isPrimary = false): void {
  const dir = join(tmpRoot, 'profiles', id)
  mkdirSync(join(dir, '.claude', 'usage-data'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'usage-data', 'report.html'), '<html><body>r</body></html>')
  h.profileDir[id] = dir
  h.profiles.push({ id, name: `Acct ${id.toUpperCase()}`, accountEmail: email, isPrimary })
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'insights-consumer-'))
  h.resourcesDir = join(tmpRoot, 'resources')
  mkdirSync(h.resourcesDir, { recursive: true })
  h.profileDir = {}
  h.profiles = []
  h.heldDuringPty = null
  h.ptySpawns = 0
  h.probe = () => hasTransientProfileConsumer('a')
  _resetProfileConsumersForTest()
})
afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('an Insights run holds its account as a profile consumer (#48)', () => {
  it('is in use while the /insights PTY runs, and released once the run settles', async () => {
    seed('a', 'a@example.com', true)
    const id = await runInsights(getWin, { profileId: 'a' })
    expect(id).toBeTruthy()
    expect(h.heldDuringPty).toBe(true)
    expect(hasTransientProfileConsumer('a')).toBe(false)
    expect(isRunning('a')).toBe(false)
  })

  it('is released even when the run fails (the finally releases with the lock)', async () => {
    seed('a', 'a@example.com', true)
    // No report file: copyReportToArchive fails and the run ends 'failed'.
    rmSync(join(h.profileDir['a'], '.claude', 'usage-data', 'report.html'))
    await runInsights(getWin, { profileId: 'a' })
    expect(h.heldDuringPty).toBe(true)
    expect(hasTransientProfileConsumer('a')).toBe(false)
  })
})

describe('an Insights run starting mid-rotation waits for the refresh (#49)', () => {
  it('does not spawn the PTY until the in-flight refresh settles', async () => {
    seed('a', 'a@example.com', true)
    let settle!: (v: unknown) => void
    noteProfileRefreshInFlight('a', new Promise((resolve) => { settle = resolve }))

    const run = runInsights(getWin, { profileId: 'a' })
    await tick()
    expect(h.ptySpawns).toBe(0)
    expect(isRunning('a')).toBe(true) // the lock is taken first, so a second run is still refused

    settle({ accessToken: 'new' })
    await run
    expect(h.ptySpawns).toBe(1)
    expect(h.heldDuringPty).toBe(true)
    expect(hasTransientProfileConsumer('a')).toBe(false)
  })
})
