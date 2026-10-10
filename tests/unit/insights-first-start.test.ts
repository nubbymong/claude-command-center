// [host] ADR-025: an Insights report starts Claude Code itself in a terminal
// (/insights is a slash command), which can be the first start of a Claude
// Code that updated itself. The run awaits the first-start warm-up of the
// Claude Code main resolved, with Claude's --version environment, before
// node-pty starts it. The harness is insights-project-gate-refusal's: the
// PTY, the KPI extraction and the profile roots are faked, and so is the
// warm-up; nothing is started.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
vi.mock('../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const RESOLVED = 'C:\\Users\\A\\.local\\bin\\claude.exe'
const h = vi.hoisted(() => ({
  resourcesDir: '',
  installPath: '',
  profileDir: {} as Record<string, string>,
  profiles: [] as Array<{ id: string; name?: string; accountEmail: string; isPrimary?: boolean }>,
  order: [] as string[],
  warm: [] as Array<{ program: string; env: () => unknown }>,
  gate: null as null | Promise<void>,
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
vi.mock('../../src/main/update-watcher', () => ({ getInstallPath: () => h.installPath, getProjectRootPath: () => '' }))
vi.mock('../../src/main/pty-manager', async () => ({
  resolveClaudeForPty: () => ({ cmd: RESOLVED, args: [] }),
  withProfileHome: (await vi.importActual<typeof import('../../src/main/account-profiles')>('../../src/main/account-profiles')).withProfileHome,
}))
vi.mock('node-pty', () => ({
  spawn: (file: string) => {
    h.order.push(`pty ${file}`)
    return {
      onData: () => {},
      onExit: (cb: (e: { exitCode: number }) => void) => { cb({ exitCode: 0 }) },
      write: () => {},
      kill: () => {},
    }
  },
}))
vi.mock('../../src/main/claude-headless', () => ({
  spawnClaudeHeadless: async () => ({ code: 0, stdout: '{}', stderr: '' }),
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../src/main/first-start-warmup', () => ({
  warmFirstStart: async (program: string, env: () => unknown) => {
    h.warm.push({ program, env })
    h.order.push(`warm ${program}`)
    if (h.gate) await h.gate
    return { outcome: 'ran', exitCode: 0, timedOut: false }
  },
}))

import { runInsights } from '../../src/main/insights-runner'
import { composeProviders } from '../../src/main/providers/compose'
import { _resetProfileConsumersForTest } from '../../src/main/profile-consumers'
import { _resetProjectScanStateForTest } from '../../src/main/managed-launch-diagnostics'

let tmpRoot = ''
beforeAll(() => { composeProviders() })
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'insights-first-start-'))
  h.resourcesDir = join(tmpRoot, 'resources')
  mkdirSync(h.resourcesDir, { recursive: true })
  h.installPath = join(tmpRoot, 'install')
  mkdirSync(h.installPath, { recursive: true })
  h.profileDir = {}
  h.profiles = []
  h.order.length = 0
  h.warm.length = 0
  h.gate = null
  _resetProfileConsumersForTest()
  _resetProjectScanStateForTest()
  const dir = join(tmpRoot, 'profiles', 'a')
  mkdirSync(join(dir, '.claude', 'usage-data'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'usage-data', 'report.html'), '<html><body>r</body></html>')
  h.profileDir.a = dir
  h.profiles.push({ id: 'a', name: 'Acct A', accountEmail: 'a@example.com', isPrimary: true })
})
afterEach(() => {
  _resetProjectScanStateForTest()
  delete process.env.CCC_FIRST_START_MARK
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('the /insights terminal (ADR-025)', () => {
  it('awaits the warm-up of the Claude Code main resolved, with Claude\'s --version environment, before node-pty starts it', async () => {
    process.env.CCC_FIRST_START_MARK = 'never reaches a CLI run'
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const run = runInsights(() => null, { profileId: 'a' })
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 20))
    expect(h.order).toEqual([`warm ${RESOLVED}`])
    release()
    await run
    await vi.waitFor(() => expect(h.order).toEqual([`warm ${RESOLVED}`, `pty ${RESOLVED}`]))
    const env = (await (h.warm[0].env as () => Promise<{ env: Record<string, string> }> | { env: Record<string, string> })()).env
    expect(Object.keys(env).some((k) => k.toUpperCase().startsWith('CCC_'))).toBe(false)
  })
})
