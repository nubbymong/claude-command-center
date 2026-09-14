import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Unit 3 W6: per-account in-flight lock. Two DIFFERENT accounts may run
// concurrently; the SAME account can't double-run. Catalogue integrity across
// concurrent runs is covered too (both runs' entries must survive) — proving the
// synchronous upsertRun read-modify-write is safe without a write-queue.

// Shared, hoisted state the module mocks read from (populated per-test).
const h = vi.hoisted(() => ({
  resourcesDir: '',
  profileDir: {} as Record<string, string>,
  primary: 'profile-a',
}))

vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {},
}))
// isValidProfileId comes from the REAL module via importOriginal rather than being
// retyped here. resolveInsightsAccount validates the id before the path join, so a
// stub of `true` would hide a regression in that guard — but a hand-copied mirror of
// the predicate is only correct until PROFILE_ID_RE or the length cap changes, at
// which point the mock silently diverges and the test keeps passing against a stale
// rule. Importing the real one cannot drift.
vi.mock('../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/account-profiles')>()),
  getProfileConfigDir: (id: string) => h.profileDir[id] ?? '',
  getPrimaryProfileId: () => h.primary,
  setupProfileLinks: () => {},
  listProfiles: () => [
    { id: 'profile-a', accountEmail: 'a@example.com' },
    { id: 'profile-b', accountEmail: 'b@example.com' },
  ],
}))
vi.mock('../../src/main/update-watcher', () => ({
  getInstallPath: () => '',
  getProjectRootPath: () => '',
}))
vi.mock('../../src/main/pty-manager', () => ({
  resolveClaudeForPty: () => ({ cmd: 'claude' }),
  withProfileHome: (env: unknown) => env,
}))
// A PTY that never exits, so runInsights stays in flight at step 1 (await).
vi.mock('node-pty', () => ({
  spawn: () => ({ onData: () => {}, onExit: () => {}, write: () => {}, kill: () => {} }),
}))

import { runInsights, isRunning, getCatalogue } from '../../src/main/insights-runner'

const getWin = () => null

describe('insights per-account run lock', () => {
  let tmpRoot = ''
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'insights-lock-'))
    h.resourcesDir = join(tmpRoot, 'resources')
    mkdirSync(h.resourcesDir, { recursive: true })
    for (const id of ['profile-a', 'profile-b']) {
      const d = join(tmpRoot, 'profiles', id)
      mkdirSync(d, { recursive: true })
      h.profileDir[id] = d
    }
    h.primary = 'profile-a'
    // Fake timers so the PTY's setTimeout/setInterval never schedule real
    // handles; the runInsights promises stay pending (we never await them).
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('locks per account: same account blocked, different account allowed, both runs persist', async () => {
    const p1 = runInsights(getWin, { profileId: 'profile-a' })
    p1.catch(() => {}) // intentionally left in flight; never settles

    expect(isRunning('profile-a')).toBe(true)
    expect(isRunning('profile-b')).toBe(false)
    expect(isRunning()).toBe(true) // "any in flight"

    // Same account while A is in flight -> rejected.
    await expect(runInsights(getWin, { profileId: 'profile-a' })).rejects.toThrow(/already running/i)

    // Different account -> allowed, runs concurrently.
    const p2 = runInsights(getWin, { profileId: 'profile-b' })
    p2.catch(() => {})
    expect(isRunning('profile-b')).toBe(true)

    // Both concurrent runs are present in the catalogue (no lost update) with
    // distinct ids (unique run-id generation under same-second concurrency).
    const cat = getCatalogue()
    expect(cat.runs.map((r) => r.profileId).sort()).toEqual(['profile-a', 'profile-b'])
    expect(new Set(cat.runs.map((r) => r.id)).size).toBe(2)
  })
})
