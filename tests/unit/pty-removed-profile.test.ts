// A session whose chosen Claude account has been removed says so instead of
// starting on another account.
//
// A Claude session names its account (profileId). When that account is no
// longer set up here (its folder is gone, or the name is not an account id at
// all), the session starts nothing and says why in one fixed sentence that
// names no id and no path: on a direct start the pty:spawn call is refused with
// it, and on a start that waited (a credential refresh) it is written to the
// terminal before the exit. The primary account is used only when no account
// is named. A terminal tab (shell only) pinned to a removed account still
// opens, as before. The real spawnPty; an account is a folder under the test's
// own root; node-pty records, nothing is started.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SENTENCE = 'This session\'s Claude account is no longer set up here. Choose an account for it and start it again.'

const h = vi.hoisted(() => ({ root: '', attempts: 0, primaryAsked: 0, primary: null as string | null }))
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  app: { getPath: () => process.env.TEMP, getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
}))
vi.mock('node-pty', () => ({ spawn: () => {
  h.attempts++
  return { pid: 4343, cols: 80, rows: 24, process: 'sh',
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
    write() {}, resize() {}, kill() {}, pause() {}, resume() {}, clear() {} }
} }))
// An account is a folder under the test's root, named by an id of the real
// shape; the primary lookup is counted. Homes pass through as they are (the
// owner-only folder work is the account store's own, tested there).
vi.mock('../../src/main/account-profiles', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/account-profiles')>()
  const nodePath = require('path') as typeof import('path')
  return {
    ...real,
    getProfileConfigDir: (id: string) => {
      if (!real.isValidProfileId(id)) throw new Error('invalid profile id')
      return nodePath.join(h.root, 'profiles', id)
    },
    getPrimaryProfileId: () => { h.primaryAsked++; return h.primary },
    setupProfileLinks: () => {}, syncPrimaryCredentialsWithGlobal: () => {}, backupProfileHomeToCanonical: () => {},
    withProfileHome: (env: Record<string, string>) => ({ ...env }),
  }
})
vi.mock('../../src/main/managed-launch-diagnostics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/managed-launch-diagnostics')>()),
  gateManagedLaunchDirs: async () => ({ status: 'clean' }),
}))
vi.mock('../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.root, getDataDirectory: () => h.root, registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
vi.mock('../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../src/main/conductor-mcp-server', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/main/conductor-mcp-server')>()), getConductorMcpPort: () => 0 }))
vi.mock('../../src/main/providers', () => ({
  getProvider: () => ({ resolveBinary: () => ({ cmd: 'claude', source: 'system' }), buildSpawnCommand: () => ({ cmd: 'sh', args: [], env: {} }), ingestSessionTelemetry: () => ({ stop: () => {} }) }),
}))
vi.mock('../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null, removeLocalSessionSettings: () => {}, writeLocalSessionMcpConfig: () => null, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null,
}))
vi.mock('../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {}, isPtySessionLive: () => true }))
vi.mock('../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/config-manager')>()),
  readConfig: () => ({}),
  readConfigChecked: () => ({ value: {}, outcome: 'ok' }),
  getConfigDir: () => h.root,
}))

const consumers = await import('../../src/main/profile-consumers')
const { spawnPty, killPty } = await import('../../src/main/pty-manager')

const payloads: Array<[string, unknown]> = []
const win = {
  webContents: { send: (channel: string, payload?: unknown) => { payloads.push([channel, payload]) } },
  isDestroyed: () => false,
} as never
const sent = (channel: string): unknown[] => payloads.filter(([c]) => c === channel).map(([, p]) => p)
const until = async (cond: () => boolean, why: string): Promise<void> => {
  const deadline = Date.now() + 5000
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  if (!cond()) throw new Error(`timed out waiting: ${why}`)
}

let project = ''
let seq = 0
const ids = ['gone-direct', 'gone-not-an-id', 'no-pin', 'tab-gone', 'gone-waited']

/** An account set up here: its folder exists. */
const account = (): string => {
  const id = `profile-test${String(++seq).padStart(4, '0')}-abcdef`
  fs.mkdirSync(path.join(h.root, 'profiles', id), { recursive: true })
  return id
}
/** An account that was set up and then removed: its folder is gone. */
const removedAccount = (): string => {
  const id = account()
  fs.rmSync(path.join(h.root, 'profiles', id), { recursive: true, force: true })
  return id
}

beforeEach(() => {
  h.root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pty-removed-profile-')))
  project = path.join(h.root, 'project')
  fs.mkdirSync(project, { recursive: true })
  consumers._resetProfileConsumersForTest()
  h.attempts = 0; h.primaryAsked = 0; h.primary = null; payloads.length = 0
})
afterEach(() => {
  for (const id of ids) { try { killPty(id) } catch { /* not started */ } }
  consumers._resetProfileConsumersForTest()
  fs.rmSync(h.root, { recursive: true, force: true })
})

describe('a Claude session whose account is no longer set up', () => {
  // Mutation to prove this can fail: restore the fall-back to the primary account.
  it('says so and starts nothing; the primary account is never consulted', () => {
    h.primary = account()
    const gone = removedAccount()
    expect(() => spawnPty(win, 'gone-direct', { profileId: gone, cwd: project })).toThrow(SENTENCE)
    expect(h.attempts).toBe(0)
    expect(h.primaryAsked).toBe(0)
  })

  it('the sentence names no account and no folder', () => {
    const gone = removedAccount()
    let message = ''
    try { spawnPty(win, 'gone-direct', { profileId: gone, cwd: project }) } catch (e) { message = (e as Error).message }
    expect(message).toBe(SENTENCE)
    expect(message).not.toContain(gone)
    expect(message).not.toContain(h.root)
  })

  it('a name that is not an account id is refused the same way', () => {
    h.primary = account()
    expect(() => spawnPty(win, 'gone-not-an-id', { profileId: '../x', cwd: project })).toThrow(SENTENCE)
    expect(h.attempts).toBe(0)
    expect(h.primaryAsked).toBe(0)
  })

  it('a start that waited, whose account went meanwhile, writes the sentence before the exit', async () => {
    const id = account()
    let settle!: () => void
    consumers.noteProfileRefreshInFlight(id, new Promise<void>((resolve) => { settle = resolve }))
    expect(() => spawnPty(win, 'gone-waited', { profileId: id, cwd: project })).not.toThrow()
    fs.rmSync(path.join(h.root, 'profiles', id), { recursive: true, force: true })
    settle()
    await until(() => sent('pty:exit:gone-waited').length > 0, 'the waited start to report')
    expect(h.attempts).toBe(0)
    expect(sent('pty:data:gone-waited').map(String).join('')).toContain(SENTENCE)
    expect(payloads.findIndex(([c]) => c === 'pty:data:gone-waited')).toBeLessThan(payloads.findIndex(([c]) => c === 'pty:exit:gone-waited'))
  })
})

describe('what is unchanged', () => {
  it('with no account named, the session runs on the primary account', async () => {
    h.primary = account()
    expect(() => spawnPty(win, 'no-pin', { cwd: project })).not.toThrow()
    expect(h.primaryAsked).toBeGreaterThan(0)
    await until(() => h.attempts === 1, 'the primary account\'s session to start')
  })

  it('a terminal tab pinned to a removed account still opens', () => {
    const gone = removedAccount()
    expect(() => spawnPty(win, 'tab-gone', { shellOnly: true, profileId: gone, cwd: project })).not.toThrow()
    expect(h.attempts).toBe(1)
  })
})
