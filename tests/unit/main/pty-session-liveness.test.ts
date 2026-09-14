// THE PTY-LIFECYCLE SIGNAL, and the window a throw could once strand it in.
//
// `session-registry.livePtySessions` is what the Agent Canvas's ownership lease
// gates on (canvas-session-link.isSessionLive): PTY-alive = the owner is
// protected; PTY-dead = the canvas is ownerless and may be resumed, dismissed
// and seen. It has exactly two writers, both in `pty-manager`, and the pairing
// is the whole guarantee — a mark with no eraser armed strands that session's
// canvas as un-resumable, un-dismissable AND invisible for the rest of the run,
// which is the exact failure the signal exists to end.
//
// The mark first sat beside `updateSessionMeta`, ninety-odd lines before
// `ptyProcess.onExit` was registered, with config reads, run registration and
// the data hook in between. `spawnPty` runs from an UNCAUGHT
// `ipcMain.on('pty:spawn')`, so anything throwing in that window left the id
// marked and nothing armed to unmark it. This drives the REAL `spawnPty` and
// throws inside that window on purpose.
//
// Mock stack copied from canvas-worktree-spawn.test.ts, which drives the same
// function; only what `spawnPty` touches on the way to the registration block
// is stubbed.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  /** Make the DATA hook throw — `ptyProcess.onData` is registered inside the
   *  window, immediately before the exit handler, so this is a faithful stand-in
   *  for any of the config reads or registrations that sit there. */
  throwOnDataHook: false,
}))

vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 4242,
    process: 'pwsh',
    onData: () => {
      if (h.throwOnDataHook) throw new Error('something in the spawn window threw')
      return { dispose: () => {} }
    },
    onExit: () => ({ dispose: () => {} }),
    write: () => {},
    resize: () => {},
    kill: () => {},
  }),
}))

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-pty-live-'))
  return {
    getResourcesDirectory: () => dir,
    getDataDirectory: () => dir,
    registerSetupHandlers: () => {},
    writeCliSetupPty: () => {},
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))

vi.mock('../../../src/main/logging/logging-service', () => ({
  getLogSupervisor: () => null,
  getTranscriptBinder: () => null,
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  registerCodexReviewSession: () => {},
  unregisterCodexReviewSession: () => {},
}))
vi.mock('../../../src/main/providers', () => ({
  getProvider: () => ({
    buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: {} }),
    ingestSessionTelemetry: () => ({ stop: () => {} }),
  }),
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({
  resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }),
  resolveHostColorScheme: () => 'dark',
}))
vi.mock('../../../src/main/vision-manager', () => ({
  isGlobalVisionRunning: () => false,
  getGlobalVisionConfig: () => null,
  teardownVisionSession: () => {},
}))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null,
  removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => null,
  removeLocalSessionMcpConfig: () => {},
  removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {},
  clearClaudeAccount: () => {},
  getAccountIdentity: () => null,
  pushAccountIdentity: () => {},
  startWatchingAccountIdentity: () => {},
  stopWatchingAccountIdentity: () => {},
  getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  getConfigDir: () => os.tmpdir(),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  isValidProfileId: () => false,
  getPrimaryProfileId: () => null,
  getProfileConfigDir: () => path.join(os.tmpdir(), 'ccc-no-such-profile'),
  setupProfileLinks: () => {},
  syncPrimaryCredentialsWithGlobal: () => {},
  backupProfileHomeToCanonical: () => {},
}))

// session-registry is REAL. Its set is what is under test.
const registry = await import('../../../src/main/session-registry')
const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const { spawnPty, killPty } = await import('../../../src/main/pty-manager')

const SID = 'ptylive1ptylive1ptylive1'

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => {} },
} as unknown as Parameters<typeof spawnPty>[0]

/** Run the real spawn. It may throw somewhere PAST the registration block (the
 *  mock stack stops well short of a complete session); what matters here is
 *  only whether the id ends up marked, so the throw is captured and reported. */
function spawn(): string {
  try {
    spawnPty(fakeWin, SID, { cwd: os.tmpdir(), cols: 80, rows: 24 } as Parameters<typeof spawnPty>[2])
    return ''
  } catch (err) {
    return ` (spawnPty threw: ${(err as Error)?.message ?? err})`
  }
}

beforeEach(() => {
  h.throwOnDataHook = false
  registry.markPtySessionGone(SID)
  registry.clearSessionMeta(SID)
})

afterAll(() => {
  try {
    killPty(SID)
  } catch {
    /* never spawned, or already gone */
  }
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort temp cleanup */
  }
})

describe('the spawn window cannot strand a session as permanently live', () => {
  it('leaves the id UNMARKED when something in the window throws', () => {
    h.throwOnDataHook = true
    const threw = spawn()
    expect(threw, 'the window must actually have thrown for this test to mean anything').not.toBe('')
    expect(registry.isPtySessionLive(SID)).toBe(false)
  })

  it('DOES mark it once the exit handler is armed', () => {
    // The positive control. Without it the test above would pass just as well
    // against a build that never marked anything at all.
    const threw = spawn()
    expect(registry.isPtySessionLive(SID), `never marked${threw}`).toBe(true)
  })

  it('and the metadata write is not what decides it', () => {
    // The round-2 defect, at its source: `updateSessionMeta` is a shared map
    // that github-handlers also writes for sessions that never spawn, so an
    // entry in it must not read as a running PTY.
    registry.updateSessionMeta({ id: SID, repo: 'me/app', branch: 'main' })
    expect(registry.getSessionMeta(SID)).toBeDefined()
    expect(registry.isPtySessionLive(SID)).toBe(false)
  })
})
