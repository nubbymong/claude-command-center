// The first-run setup screen's check (setup:probeCli; owner decision D4 and
// the PATH finding of the first-run test, 2026-10-10; ADR-024): this
// process's PATH is brought up to date from the registry BEFORE Claude Code
// is looked for, and a check that still finds nothing says what helps
// (Anthropic's installer left claude in a folder PATH does not name, or a
// restart would). The REAL handler; the refresh, the probe and the folder
// check are stand-ins, so nothing is started and nothing is read.
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The real module (tests/unit/setup.ts stands it in for every other file).
vi.unmock('../../../src/main/ipc/setup-handlers')

const handlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => unknown>())
const order = vi.hoisted(() => [] as string[])
const state = vi.hoisted(() => ({ installed: false, hint: undefined as unknown }))
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: () => '' },
}))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
vi.mock('../../../src/main/pty-manager', () => ({ resolveClaudeForPty: () => ({ cmd: 'claude', args: [] }) }))
vi.mock('../../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../../src/main/login-shell', () => ({ defaultLoginShell: () => '/bin/zsh' }))
vi.mock('../../../src/main/pty-input-guard', () => ({ guardPtyIo: vi.fn() }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/data-paths', () => ({
  getDataDirectory: () => '', getResourcesDirectory: () => '', setDataDirectory: vi.fn(), setResourcesDirectory: vi.fn(), isDataDirFromRegistry: () => false,
}))
vi.mock('../../../src/main/claude-cli-probe', () => ({
  probeClaudeCli: vi.fn(async () => { order.push('probe'); return state.installed ? { installed: true, path: 'C:\\x\\claude.exe', probe: 'PATH walk' } : { installed: false, probe: 'PATH walk' } }),
}))
vi.mock('../../../src/main/windows-path-refresh', () => ({
  // The real afterPathRefresh's contract, with the refresh recorded.
  afterPathRefresh: vi.fn(async (check: () => Promise<unknown>) => { await Promise.resolve(); order.push('refresh'); return check() }),
}))
vi.mock('../../../src/main/install-folder-path', () => ({
  pathHintFor: vi.fn(async (providerId: string) => { order.push(`hint ${providerId}`); return state.hint }),
}))

import { registerSetupHandlers } from '../../../src/main/ipc/setup-handlers'

const probe = () => handlers.get('setup:probeCli')!({ sender: {} })

beforeEach(() => {
  handlers.clear()
  order.length = 0
  state.installed = false
  state.hint = undefined
  registerSetupHandlers()
})

describe('setup:probeCli, the first-run screen\'s check', () => {
  it('brings PATH up to date from the registry before Claude Code is looked for', async () => {
    state.installed = true
    expect(await probe()).toEqual({ installed: true, path: 'C:\\x\\claude.exe', probe: 'PATH walk' })
    expect(order).toEqual(['refresh', 'probe'])
  })

  it("not found: it says what helps, for Claude Code, and only after the refresh and the check", async () => {
    state.hint = { kind: 'add-to-path', folder: '%USERPROFILE%\\.local\\bin' }
    expect(await probe()).toEqual({ installed: false, probe: 'PATH walk', pathHint: { kind: 'add-to-path', folder: '%USERPROFILE%\\.local\\bin' } })
    expect(order).toEqual(['refresh', 'probe', 'hint claude'])
  })

  it('found: nothing more is looked for; not found with nothing to add: the answer as it was', async () => {
    state.installed = true
    await probe()
    expect(order).not.toContain('hint claude')
    state.installed = false
    expect(await probe()).toEqual({ installed: false, probe: 'PATH walk' })
  })
})
